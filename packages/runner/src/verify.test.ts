import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mustExec } from "./git.ts";
import { runVerify, type VerifySpec, verifyText } from "./verify.ts";

/** A repository with one committed test file; the agent's edits stay uncommitted. */
function workingRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "mork-verify-"));
  const git = (...a: string[]) => mustExec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", dir, ...a]);
  git("init", "-q");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "math.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(dir, "test", "math.test.mjs"), "test('x', () => {});\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { dir, base: git("rev-parse", "HEAD").trim() };
}

const spec = (base: string, dir: string, config: Partial<VerifySpec["config"]> = {}): VerifySpec => ({
  repo: { full_name: "o/r", default_branch: "main", base_sha: base },
  config: { test: "true", checks: [], test_paths: ["test/"], protected_paths: [], ...config },
  setupMarker: join(dir, ".setup-done"),
});

describe("verify", () => {
  test("passes when the tests, checks and policy pass, uncommitted edits included", async () => {
    const { dir, base } = workingRepo();
    writeFileSync(join(dir, "math.mjs"), "export const add = (a, b) => a + b;\n");
    writeFileSync(join(dir, "test", "add.test.mjs"), "test('new', () => {});\n");
    const result = await runVerify(spec(base, dir, { checks: ["true"] }), dir);
    expect(result.passed).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["test", "check"]);
  });
  test("reports a failing check with its output tail", async () => {
    const { dir, base } = workingRepo();
    const result = await runVerify(spec(base, dir, { checks: ["echo 'lint: unused variable x' && exit 1"] }), dir);
    expect(result.passed).toBe(false);
    const text = verifyText(result);
    expect(text).toContain("verify: FAILED");
    expect(text).toContain("FAILED (exit 1)");
    expect(text).toContain("lint: unused variable x");
  });
  test("previews the policy on the working tree: editing an existing test fails", async () => {
    const { dir, base } = workingRepo();
    writeFileSync(join(dir, "test", "math.test.mjs"), "test.skip('x', () => {});\n");
    const result = await runVerify(spec(base, dir), dir);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("modifies existing test test/math.test.mjs"))).toBe(true);
    expect(verifyText(result)).toContain("revert that part");
  });
  test("runs setup once per container", async () => {
    const { dir, base } = workingRepo();
    const counter = join(dir, "..", `setup-count-${Date.now()}`);
    const s = spec(base, dir, { setup: `echo x >> ${counter}` });
    await runVerify(s, dir);
    await runVerify(s, dir);
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(s.setupMarker)).toBe(true);
  });
  test("a failing setup stops before the tests", async () => {
    const { dir, base } = workingRepo();
    const result = await runVerify(spec(base, dir, { setup: "exit 3" }), dir);
    expect(result.passed).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual(["setup"]);
  });
});
