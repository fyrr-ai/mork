import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDiff } from "./gate.ts";
import { mustExec } from "./git.ts";

function repoWith(change: (dir: string) => void): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "mork-gate-"));
  const git = (...a: string[]) => mustExec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", dir, ...a]);
  git("init", "-q");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "math.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(dir, "test", "math.test.mjs"), "test('x', () => {});\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  change(dir);
  git("add", "-A");
  git("commit", "-qm", "change");
  return { dir, base };
}

const spec = (base: string) => ({
  kind: "gate" as const,
  run_id: "r",
  mode: "after" as const,
  branch: "mork/x",
  allow_test_change: false,
  hidden_tests: [],
  repo: { full_name: "o/r", default_branch: "main", base_sha: base },
  config: {
    test: "npm test",
    hidden_tests: { dir: "test/hidden", command: "node --test {file}", file_suffix: ".test.mjs" },
    protected_paths: ["migrations/"],
    test_paths: ["test/"],
  },
});

describe("diff policy", () => {
  test("a clean change has no violations", () => {
    const { dir, base } = repoWith((d) => writeFileSync(join(d, "math.mjs"), "export const add = (a, b) => a + b;\n"));
    const r = checkDiff(dir, spec(base));
    expect(r.violations).toEqual([]);
    expect(r.changed_files).toEqual(["math.mjs"]);
  });
  test("modifying an existing test is a violation, adding one is not", () => {
    const { dir, base } = repoWith((d) => {
      writeFileSync(join(d, "test", "math.test.mjs"), "// weakened\n");
      writeFileSync(join(d, "test", "new.test.mjs"), "test('y', () => {});\n");
    });
    expect(checkDiff(dir, spec(base)).violations).toEqual(["modifies existing test test/math.test.mjs (M)"]);
  });
  test("skip markers, platform paths and protected paths are caught", () => {
    const { dir, base } = repoWith((d) => {
      writeFileSync(join(d, "test", "other.test.mjs"), "test.skip('z', () => {});\n");
      mkdirSync(join(d, ".mork"));
      writeFileSync(join(d, ".mork", "config.toml"), "x\n");
      mkdirSync(join(d, "migrations"));
      writeFileSync(join(d, "migrations", "1.sql"), "drop table x;\n");
    });
    const r = checkDiff(dir, spec(base));
    expect(r.violations.some((v) => v.includes("skip marker"))).toBe(true);
    expect(r.violations).toContain("changes platform-managed path .mork/config.toml");
    expect(r.protected_hits).toEqual(["migrations/1.sql"]);
  });
  test("a changed test script is flagged, not a violation", () => {
    const { dir, base } = repoWith((d) => writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "true" } })));
    const r = checkDiff(dir, spec(base));
    expect(r.violations).toEqual([]);
    expect(r.flags[0]).toContain("test script changed");
  });
});

describe("diff policy with unusual file names", () => {
  test("a quoted (non-ASCII) path is still matched against protected and test paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "mork-gate-quoted-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    git("init", "-q");
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "ünit.test.mjs"), "old\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(join(dir, ".github", "wörkflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "wörkflows", "a.yml"), "x\n");
    writeFileSync(join(dir, "test", "ünit.test.mjs"), "new\n");
    git("add", ".");
    git("commit", "-qm", "change");
    const policy = checkDiff(dir, {
      repo: { full_name: "o/r", default_branch: "main", base_sha: base },
      allow_test_change: false,
      config: { test_paths: ["test/"], protected_paths: [] },
    });
    expect(policy.violations).toContain("changes platform-managed path .github/wörkflows/a.yml");
    expect(policy.violations).toContain("modifies existing test test/ünit.test.mjs (M)");
  });
});
