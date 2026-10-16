import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULES_MARKER } from "../src/dir-rules.ts";
import dirRules from "./dir-rules.ts";

type Handler = (event: Record<string, unknown>) => Promise<unknown>;

/** A checkout whose base commit carries dagster/AGENTS.md, like the stations get. */
function repo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "mork-dir-rules-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
    });
  git("init", "-q");
  mkdirSync(join(dir, "dagster", "tests"), { recursive: true });
  writeFileSync(join(dir, "dagster", "AGENTS.md"), "# Dagster\nAutomation must ship stopped.\n");
  writeFileSync(join(dir, "dagster", "tests", "test_policy.py"), 'DEFAULT_STATUS = {"a": "RUNNING"}\n\n\ndef test_x():\n    assert True\n');
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

describe("dir-rules extension", () => {
  test("a read result keeps the file's content byte-identical; the rules arrive once, as a separately marked block", async () => {
    const { dir, sha } = repo();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      process.env.MORK_BASE_SHA = sha;
      const handlers: Record<string, Handler> = {};
      dirRules({
        on: (name: string, handler: Handler) => {
          handlers[name] = handler;
        },
      });
      const path = join(dir, "dagster", "tests", "test_policy.py");
      const content = readFileSync(path, "utf8");
      const first = (await handlers.tool_result?.({ toolName: "read", input: { path }, content: [{ type: "text", text: content }] })) as
        | { content: Array<{ type: string; text: string }> }
        | undefined;
      expect(first?.content).toHaveLength(2);
      expect(first?.content[0]).toEqual({ type: "text", text: content });
      expect(Buffer.from(first?.content[0]?.text ?? "").equals(Buffer.from(content))).toBe(true);
      expect(first?.content[1]?.text.trim().startsWith(RULES_MARKER)).toBe(true);
      expect(first?.content[1]?.text).toContain("dagster/tests/test_policy.py");
      expect(first?.content[1]?.text).toContain("Automation must ship stopped.");
      // Provenance of the rules block: which file at which base commit, so it can never be mistaken for the read file.
      expect(first?.content[1]?.text).toContain(`source: dagster/AGENTS.md at base commit ${sha.slice(0, 12)}`);
      // The same file read again in this session: the result is exactly what the tool produced.
      const second = await handlers.tool_result?.({ toolName: "read", input: { path }, content: [{ type: "text", text: content }] });
      expect(second).toBeUndefined();
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("the first write under unseen rules is blocked with a reason that says it is a block, not a file", async () => {
    const { dir, sha } = repo();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      process.env.MORK_BASE_SHA = sha;
      const handlers: Record<string, Handler> = {};
      dirRules({
        on: (name: string, handler: Handler) => {
          handlers[name] = handler;
        },
      });
      const path = join(dir, "dagster", "tests", "new_test.py");
      const blocked = (await handlers.tool_call?.({ toolName: "write", input: { path, content: "x" } })) as
        | { block: boolean; reason: string }
        | undefined;
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason.startsWith("Blocked by Mork (directory rules)")).toBe(true);
      expect(blocked?.reason).toContain("repeat the same write call");
      expect(await handlers.tool_call?.({ toolName: "write", input: { path, content: "x" } })).toBeUndefined();
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
