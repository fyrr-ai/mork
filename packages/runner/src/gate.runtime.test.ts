import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoConfig } from "@mork/contracts";
import { runGate } from "./gate.ts";
import { mustExec } from "./git.ts";
import { gatePassed } from "./rules.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    mustExec("chmod", ["-R", "u+rwX", dir]);
    mustExec("rm", ["-rf", dir]);
  }
});
function fixture(setup?: string) {
  const dir = mkdtempSync(join(tmpdir(), "mork-gate-runtime-"));
  chmodSync(dir, 0o755);
  dirs.push(dir);
  const source = join(dir, "source");
  mkdirSync(source);
  const git = (...args: string[]) => mustExec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, ...args]);
  git("init", "-q");
  writeFileSync(join(source, "value"), "broken\n");
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested", "tracked"), "tracked\n");
  mkdirSync(join(source, ".mork"));
  writeFileSync(
    join(source, ".mork", "config.toml"),
    `setup = ${JSON.stringify(setup ?? "mkdir generated")}\ntest = "test -f value"\nchecks = ["test -d generated"]\n[hidden_tests]\ndir = "hidden"\ncommand = "bash {file}"\nfile_suffix = ".sh"\n`,
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("switch", "-qc", "mork/runtime");
  writeFileSync(join(source, "value"), "correct\n");
  git("add", ".");
  git("commit", "-qm", "change");
  const head = git("rev-parse", "HEAD").trim();
  const config = RepoConfig.parse({
    setup,
    test: "test -f value",
    checks: ["test -d generated"],
    hidden_tests: { dir: "hidden", command: "bash {file}", file_suffix: ".sh" },
  });
  const work = join(dir, "work");
  mkdirSync(work);
  const job = {
    mode: "after" as const,
    repo: { full_name: "fixture/repo", default_branch: "main", base_sha: base },
    branch: "mork/runtime",
    localRepo: source,
    config,
    hidden_tests: [{ file: "acceptance.sh", content: "grep -qx correct value\n", criteria: ["AC1"] }],
    allow_test_change: false,
  };
  return { dir, source, work, job, head };
}
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", CI: "1" };

test("the real gate fetches, sets up, runs checks and hidden tests against the branch SHA", async () => {
  const { job, work, head } = fixture("mkdir generated");
  const result = await runGate(job, "", work, { env });
  expect(result.head_sha).toBe(head);
  expect(result.setup?.exit_code).toBe(0);
  expect(result.checks?.[0]?.exit_code).toBe(0);
  expect(result.hidden[0]?.passed).toBe(true);
  expect(gatePassed(result)).toBe(true);
});
test("setup cannot silently change the tracked tree under the recorded SHA", async () => {
  const { job, work } = fixture("printf tampered > value; mkdir generated");
  await expect(runGate(job, "", work, { env })).rejects.toThrow("changed the tested checkout: value");
});
test("repository tests changing a tracked file fail integrity even with exit zero", async () => {
  const { job, work } = fixture("mkdir generated");
  job.config.test = "printf tampered > value";
  await expect(runGate(job, "", work, { env })).rejects.toThrow("changed the tested checkout: value");
});
test("a setup-supplied ancestor symlink is removed before placing hidden tests", async () => {
  const { job, work, dir } = fixture("ln -s ../outside hidden; mkdir generated");
  mkdirSync(join(work, "outside"));
  writeFileSync(join(work, "outside", "acceptance.sh"), "outside stays intact");
  const result = await runGate(job, "", work, { env });
  expect(gatePassed(result)).toBe(true);
  expect(mustExec("cat", [join(dir, "work", "outside", "acceptance.sh")])).toBe("outside stays intact");
});
test("hidden-test placement cannot destroy the repository root or metadata", async () => {
  for (const path of [".", "/tmp", "hidden/../other", ".git/tests", ""]) {
    const { job, work } = fixture();
    job.config.hidden_tests.dir = path;
    await expect(runGate(job, "", work, { env })).rejects.toThrow("hidden_tests.dir");
  }
});

// Run these in the runner image, where root can drop privileges just as it does on Fargate.
const privileged = process.getuid?.() === 0 ? test : test.skip;
privileged("the sandbox cannot rewrite, chmod or replace tracked entries, but can generate outputs", async () => {
  const { job, work } = fixture(
    "! sh -c 'echo tampered > value' && ! chmod u+w value && ! rm value && ! mv value moved && ! rm -rf .git && ! rm -rf nested && ! mv nested renamed && ! mv ../repo ../moved && git describe --always && mkdir generated",
  );
  const result = await runGate(job, "", work, { uid: 10002, gid: 10002, env });
  expect(result.setup?.exit_code).toBe(0);
  expect(gatePassed(result)).toBe(true);
});

privileged("an unprotected writable checkout ancestor is rejected", async () => {
  const { job, work } = fixture("mkdir generated");
  chmodSync(work, 0o777);
  await expect(runGate(job, "", work, { uid: 10002, gid: 10002, env })).rejects.toThrow("ancestor is writable");
});
test("multiple hidden tests are restored and run independently", async () => {
  const { job, work } = fixture("mkdir generated");
  job.hidden_tests.push({ file: "another.sh", content: "grep -qx tracked nested/tracked\n", criteria: ["AC2"] });
  const result = await runGate(job, "", work, { env });
  expect(result.hidden).toHaveLength(2);
  expect(gatePassed(result)).toBe(true);
});

const local = process.getuid?.() === 0 ? test.skip : test;
local("the local CLI verifies the actual before/after commits without AWS", async () => {
  const { job, source, dir, head } = fixture("mkdir generated");
  const hiddenFile = join(dir, "hidden.json");
  writeFileSync(hiddenFile, JSON.stringify(job.hidden_tests));
  const cli = join(import.meta.dir, "gate-cli.ts");
  for (const mode of ["before", "after"]) {
    const output = mustExec(process.execPath, [cli, "--repo", source, "--base", job.repo.base_sha, "--hidden", hiddenFile, "--mode", mode]);
    const result = JSON.parse(output);
    expect(result.passed).toBe(true);
    expect(result.gate.hidden[0].passed).toBe(mode === "after");
    if (mode === "after") expect(result.gate.head_sha).toBe(head);
  }
});
privileged("a tracked symlink cannot be replaced by the sandbox", async () => {
  const { job, work, source } = fixture("! rm linked && mkdir generated");
  symlinkSync("value", join(source, "linked"));
  mustExec("git", ["-C", source, "add", "linked"]);
  mustExec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, "commit", "-qm", "symlink"]);
  const result = await runGate(job, "", work, { uid: 10002, gid: 10002, env });
  expect(gatePassed(result)).toBe(true);
});
