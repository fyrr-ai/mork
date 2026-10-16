import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
    join(source, "adapter.sh"),
    'bash "$1"\ncode=$?\nif [ "$code" = 0 ]; then status=pass; elif [ "$code" = 1 ]; then status=behavior_failure; else status=execution_failure; code=3; fi\nprintf \'MORK_RESULT {"status":"%s","reason":"value comparison","tests":{"readiness":{"ready":true},"cases":[{"id":"value","criteria":["AC1"],"status":"%s"}]}}\\n\' "$status" "$status"\nexit "$code"\n',
  );
  writeFileSync(
    join(source, ".mork", "config.toml"),
    `setup = ${JSON.stringify(setup ?? "mkdir generated")}\ntest = "test -f value"\nchecks = ["test -d generated"]\n[hidden_tests]\ndir = "hidden"\ncommand = "bash adapter.sh {file}"\nfile_suffix = ".sh"\nprotocol = "mork-v1"\nruntime_paths = ["adapter.sh"]\n`,
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

test("an arbitrary nonzero hidden script is an execution failure, not a valid red", async () => {
  const { job, work } = fixture();
  job.hidden_tests[0].content = "echo 'AssertionError: missing environment'; exit 1\n";
  const report = await runGate({ ...job, mode: "before" }, "", work, { env });
  expect(report.hidden[0]).toMatchObject({ passed: false, status: "execution_failure" });
});

test("legacy success cannot stand in for certified baseline behavior", async () => {
  const { job, work } = fixture();
  job.hidden_tests[0].content = "true\n";
  const report = await runGate({ ...job, mode: "before" }, "", work, { env });
  expect(report.hidden[0]).toMatchObject({ passed: false, status: "inconclusive" });
});

test.each([
  [1, "behavior_failure", "behavior_failure"],
  [3, "execution_failure", "execution_failure"],
  [4, "inconclusive", "inconclusive"],
  [0, "behavior_failure", "execution_failure"],
  [1, "pass", "execution_failure"],
])("the pinned adapter protocol binds exit %i to status %s", async (code, status, expected) => {
  const { job, work } = fixture();
  job.config.hidden_tests = { ...job.config.hidden_tests, protocol: "mork-v1", runtime_paths: ["nested/tracked"] };
  job.hidden_tests[0].content = `echo 'MORK_RESULT ${JSON.stringify({ status, reason: "fixture", tests: { readiness: { ready: true }, cases: [{ id: "one", criteria: ["AC1"], status }] } })}'; exit ${code}\n`;
  const report = await runGate({ ...job, mode: "before" }, "", work, { env });
  expect(report.hidden[0]).toMatchObject({ passed: false, status: expected });
});

test("a malformed protocol result fails closed even with exit zero", async () => {
  const { job, work } = fixture();
  job.config.hidden_tests = { ...job.config.hidden_tests, protocol: "mork-v1", runtime_paths: ["nested/tracked"] };
  job.hidden_tests[0].content = "echo 'MORK_RESULT broken'\n";
  const report = await runGate(job, "", work, { env });
  expect(report.hidden[0]).toMatchObject({ passed: false, status: "execution_failure" });
});

test.each([
  { readiness: { ready: false }, cases: [{ id: "one", criteria: ["AC1"], status: "behavior_failure" }] },
  { readiness: { ready: true }, cases: [] },
  { readiness: { ready: true }, cases: [{ id: "one", criteria: ["AC2"], status: "behavior_failure" }] },
  {
    readiness: { ready: true },
    cases: [
      { id: "one", criteria: ["AC1"], status: "behavior_failure" },
      { id: "two", criteria: ["AC2"], status: "inconclusive" },
    ],
  },
])("declared file coverage cannot replace complete adapter case evidence: %j", async (tests) => {
  const { job, work } = fixture();
  job.config.hidden_tests = { ...job.config.hidden_tests, protocol: "mork-v1", runtime_paths: ["nested/tracked"] };
  job.hidden_tests[0].content = `echo 'MORK_RESULT ${JSON.stringify({ status: "behavior_failure", reason: "fixture", tests })}'; exit 1`;
  const report = await runGate({ ...job, mode: "before" }, "", work, { env });
  expect(report.hidden[0]?.status).toBe("execution_failure");
});

test("the adapter result is parsed before diagnostic display truncation", async () => {
  const { job, work } = fixture();
  job.config.hidden_tests = { ...job.config.hidden_tests, protocol: "mork-v1", runtime_paths: ["nested/tracked"] };
  const tests = {
    readiness: { ready: true },
    cases: Array.from({ length: 40 }, (_, i) => ({ id: `case-${i}`, criteria: ["AC1"], status: "behavior_failure", reason: "details".repeat(30) })),
  };
  job.hidden_tests[0].content = `echo 'MORK_RESULT ${JSON.stringify({ status: "behavior_failure", reason: "fixture", tests })}'; exit 1`;
  const report = await runGate({ ...job, mode: "before" }, "", work, { env });
  expect(report.hidden[0]?.status).toBe("behavior_failure");
});

test("a candidate cannot alter a configured verification runtime", async () => {
  const { job, work, source } = fixture();
  job.config.hidden_tests = { ...job.config.hidden_tests, protocol: "mork-v1", runtime_paths: ["nested/tracked"] };
  writeFileSync(join(source, "nested/tracked"), "weakened\n");
  mustExec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", source, "commit", "-qam", "change oracle"]);
  await expect(runGate(job, "", work, { env })).rejects.toThrow("verification runtime");
});

test("equal runtime blob bytes cannot hide a file-to-symlink change", async () => {
  const { job, work, source } = fixture();
  job.config.hidden_tests = { ...job.config.hidden_tests, protocol: "mork-v1", runtime_paths: ["nested/tracked"] };
  mustExec("rm", [join(source, "nested/tracked")]);
  symlinkSync("tracked\n", join(source, "nested/tracked"));
  mustExec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", source, "commit", "-qam", "replace runtime with symlink"]);
  await expect(runGate(job, "", work, { env })).rejects.toThrow("verification runtime");
});

test("full redacted diagnostics retain the first cause outside the output tail", async () => {
  const { job, work } = fixture();
  job.config.test = "echo 'ROOT_CAUSE secret-fixture'; seq 1 3000; exit 1";
  const saved: { output: string; command: string; head_sha: string }[] = [];
  const result = await runGate(
    {
      ...job,
      secrets: ["secret-fixture"],
      saveDiagnostic: async (record) => {
        saved.push(record);
        return "diagnostics/run.json";
      },
    },
    "",
    work,
    { env },
  );
  expect(saved.some((record) => record.output.includes("ROOT_CAUSE [redacted]"))).toBe(true);
  expect(saved.every((record) => !record.output.includes("secret-fixture"))).toBe(true);
  expect(result.repo_tests?.artifact).toBe("diagnostics/run.json");
});
test("a documentation gate runs the real repository checks without hidden tests", async () => {
  const { job, work, head } = fixture("mkdir generated");
  job.hidden_tests = [];
  const result = await runGate(job, "", work, { env });
  expect(result.head_sha).toBe(head);
  expect(result.repo_tests?.exit_code).toBe(0);
  expect(result.checks?.[0]?.exit_code).toBe(0);
  expect(result.hidden).toEqual([]);
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

test.skipIf(process.platform === "linux" && process.arch === "arm64")(
  "an incompatible native worker fails before repository setup or model execution",
  async () => {
    const runtime = {
      image: `registry.example/app@sha256:${"1".repeat(64)}`,
      platform: "linux/arm64" as const,
      repository_runtime: false,
      task_definitions: {
        plan: "arn:aws:ecs:eu-west-1:123456789012:task-definition/mork_plan:7",
        build: "arn:aws:ecs:eu-west-1:123456789012:task-definition/mork_build:7",
        check: "arn:aws:ecs:eu-west-1:123456789012:task-definition/mork_check:7",
      },
    };
    const f = fixture(`touch ${JSON.stringify("SETUP_MUST_NOT_RUN")}`);
    await expect(runGate({ ...f.job, runtime }, "", f.work, { env })).rejects.toThrow(/Pinned runtime requires linux\/arm64/);
    expect(existsSync(join(f.work, "repo", "SETUP_MUST_NOT_RUN"))).toBe(false);
  },
);
