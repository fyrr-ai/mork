import { describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Published } from "../src/verify.ts";

mock.module("typebox", () => ({ Type: { Object: (v: unknown) => v, String: (v: unknown) => v } }));
const { default: verify, keepVerifyArtifacts, publishedSidecar, verifyLogDir } = await import("./verify.ts");

type Tool = {
  name: string;
  execute: () => Promise<{ content: Array<{ text: string }>; details: { passed: boolean; artifacts: Array<string | undefined> } }>;
};

function repo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "mork-verify-ext-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

describe("verify extension", () => {
  test("the model gets the tail and a file path; the whole output, including the cause before the tail, is kept with its provenance", async () => {
    const { dir, sha } = repo();
    const cwd = process.cwd();
    try {
      const logs = join(dir, "logs");
      const specFile = join(dir, "verify.json");
      // The cause is printed first (from a file, so the command text does not carry it), then 6 KB of durations push it out of any tail.
      writeFileSync(join(dir, "cause.txt"), "FAILED tests/test_x.py::test_y - AssertionError: unexpected STOPPED\n");
      const test = `cat cause.txt; for i in $(seq 1 300); do echo "0.01s call tests/test_other.py::case_$i"; done; exit 1`;
      writeFileSync(
        specFile,
        JSON.stringify({
          repo: { base_sha: sha },
          config: { test, checks: [], test_paths: [], protected_paths: [] },
          setupMarker: join(dir, "marker"),
        }),
      );
      process.chdir(dir);
      process.env.MORK_VERIFY = specFile;
      process.env.MORK_VERIFY_LOG_DIR = logs;
      const tools: Tool[] = [];
      verify({ registerTool: (t: Tool) => tools.push(t) });
      const tool = tools[0];
      if (!tool) throw new Error("verify not registered");
      const result = await tool.execute();
      const text = result.content[0]?.text ?? "";
      expect(result.details.passed).toBe(false);
      expect(text).toContain("verify: FAILED");
      expect(text).not.toContain("AssertionError: unexpected STOPPED");
      const artifact = result.details.artifacts[0];
      expect(artifact).toBeDefined();
      expect(text).toContain(artifact as string);
      expect(readFileSync(artifact as string, "utf8")).toContain("AssertionError: unexpected STOPPED");
      const sidecar = JSON.parse(readFileSync((artifact as string).replace(/\.log$/, ".json"), "utf8")) as Record<string, unknown>;
      expect(sidecar).toMatchObject({ command: test, cwd: dir, head_sha: sha, exit_code: 1, output_file: artifact });
      expect(typeof sidecar.command_id).toBe("string");
      expect(readdirSync(logs).filter((f) => f.endsWith(".log"))).toHaveLength(1);
    } finally {
      process.chdir(cwd);
      delete process.env.MORK_VERIFY_LOG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("two invocations in the same second keep separate outputs; a truncated step is marked in its sidecar", () => {
    expect(verifyLogDir({ HOME: "/home/agent" })).toBe("/home/agent/out/verify");
    const dir = mkdtempSync(join(tmpdir(), "mork-verify-keep-"));
    try {
      const at = new Date("2026-10-16T10:00:00Z");
      const step = { name: "test", command: "false", exit_code: 1 };
      const a = keepVerifyArtifacts({ passed: false, steps: [{ ...step, output: "first run" }], violations: [] }, dir, dir, at);
      const b = keepVerifyArtifacts(
        { passed: false, steps: [{ ...step, output: "second run", output_truncated: true, exit_code: 125 }], violations: [] },
        dir,
        dir,
        at,
      );
      expect(a[0]).not.toBe(b[0]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".log"))).toHaveLength(2);
      const sidecar = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const first = sidecar(a[0] as string);
      const second = sidecar(b[0] as string);
      expect(readFileSync(first.output_file as string, "utf8")).toBe("first run");
      expect(readFileSync(second.output_file as string, "utf8")).toBe("second run");
      expect(first.invocation).not.toBe(second.invocation);
      expect(first).not.toHaveProperty("output_truncated");
      expect(second).toMatchObject({ step: 1, exit_code: 125, output_truncated: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("in publish-required mode the model sees only the root-published artifact and redacted tail, never the raw file", async () => {
    const { dir, sha } = repo();
    const cwd = process.cwd();
    try {
      const logs = join(dir, "logs");
      const specFile = join(dir, "verify.json");
      // The secret comes from a file, so the command line verifyText prints does not carry it.
      writeFileSync(join(dir, "secret.txt"), "token=SECRET123 then FAILED\n");
      const test = "cat secret.txt; exit 1";
      writeFileSync(
        specFile,
        JSON.stringify({
          repo: { base_sha: sha },
          config: { test, checks: [], test_paths: [], protected_paths: [] },
          setupMarker: join(dir, "marker"),
        }),
      );
      process.chdir(dir);
      process.env.MORK_VERIFY = specFile;
      process.env.MORK_VERIFY_LOG_DIR = logs;
      process.env.MORK_VERIFY_PUBLISH_REQUIRED = "1";
      process.env.MORK_VERIFY_PUBLISH_TIMEOUT_MS = "5000";
      const tools: Tool[] = [];
      verify({ registerTool: (t: Tool) => tools.push(t) });
      const tool = tools[0];
      if (!tool) throw new Error("verify not registered");
      // The root loop: answer every raw sidecar with a published one.
      const root = setInterval(() => {
        for (const file of readdirSync(logs)) {
          if (!file.endsWith(".json") || file.endsWith(".published.json")) continue;
          const raw = join(logs, file);
          const published = publishedSidecar(raw);
          if (readdirSync(logs).includes(published.slice(logs.length + 1))) continue;
          writeFileSync(published, JSON.stringify({ artifact: "/work/diagnostics/abc.log", output_tail: "token=[redacted] then FAILED" }));
        }
      }, 20);
      try {
        const result = await tool.execute();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("/work/diagnostics/abc.log");
        expect(text).toContain("token=[redacted] then FAILED");
        expect(text).not.toContain("SECRET123");
        expect(text).not.toContain(logs);
        expect(result.details.artifacts).toEqual(["/work/diagnostics/abc.log"]);
      } finally {
        clearInterval(root);
      }
      // A redacted command replaces the printed one; a truncated publication is never a pass.
      rmSync(logs, { recursive: true, force: true });
      writeFileSync(
        specFile,
        JSON.stringify({
          repo: { base_sha: sha },
          config: { test: "true", checks: [], test_paths: [], protected_paths: [] },
          setupMarker: join(dir, "marker"),
        }),
      );
      const tools2: Tool[] = [];
      verify({ registerTool: (t: Tool) => tools2.push(t) });
      const tool2 = tools2[0];
      if (!tool2) throw new Error("verify not registered");
      const root2 = setInterval(() => {
        for (const file of readdirSync(logs)) {
          if (!file.endsWith(".json") || file.endsWith(".published.json")) continue;
          const published = publishedSidecar(join(logs, file));
          if (readdirSync(logs).includes(published.slice(logs.length + 1))) continue;
          writeFileSync(
            published,
            JSON.stringify({ artifact: "/work/diagnostics/def.log", output_tail: "ok", command: "[command redacted]", output_truncated: true }),
          );
        }
      }, 20);
      try {
        const truncated = await tool2.execute();
        const text = truncated.content[0]?.text ?? "";
        expect(truncated.details.passed).toBe(false);
        expect(text).toContain("verify: FAILED");
        expect(text).toContain("[command redacted]");
        expect(text).not.toContain("`true`");
        expect(text).toContain("exit 125");
      } finally {
        clearInterval(root2);
      }
      // Without a root reply the tool fails closed instead of printing the raw path.
      process.env.MORK_VERIFY_PUBLISH_TIMEOUT_MS = "300";
      rmSync(logs, { recursive: true, force: true });
      await expect(tool.execute()).rejects.toThrow("not published");
      expect(readdirSync(logs).some((f) => f.endsWith(".log"))).toBe(true);
    } finally {
      process.chdir(cwd);
      delete process.env.MORK_VERIFY_LOG_DIR;
      delete process.env.MORK_VERIFY_PUBLISH_REQUIRED;
      delete process.env.MORK_VERIFY_PUBLISH_TIMEOUT_MS;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a publication is accepted only with its required fields and types; unknown fields are dropped", () => {
    expect(Published.safeParse({ artifact: "/work/diagnostics/a.log", output_tail: "ok" }).success).toBe(true);
    expect(Published.safeParse({ artifact: "/work/diagnostics/a.log", output_tail: "ok", command: "redacted", output_truncated: true }).data).toEqual(
      {
        artifact: "/work/diagnostics/a.log",
        output_tail: "ok",
        command: "redacted",
        output_truncated: true,
      },
    );
    expect(Published.safeParse({ artifact: "/work/diagnostics/a.log", output_tail: "ok", extra: 1 }).data).toEqual({
      artifact: "/work/diagnostics/a.log",
      output_tail: "ok",
    });
    for (const broken of [
      {},
      { artifact: 123, output_tail: "ok" },
      { artifact: "", output_tail: "ok" },
      { artifact: "/work/diagnostics/a.log" },
      { artifact: "/work/diagnostics/a.log", output_tail: "ok", output_truncated: "yes" },
      { artifact: "/work/diagnostics/a.log", output_tail: "ok", command: 7 },
    ]) {
      expect(Published.safeParse(broken).success).toBe(false);
    }
  });
  test("a half-written or mistyped publication keeps the wait going until a valid one lands", async () => {
    const { dir, sha } = repo();
    const cwd = process.cwd();
    try {
      const logs = join(dir, "logs");
      const specFile = join(dir, "verify.json");
      writeFileSync(
        specFile,
        JSON.stringify({
          repo: { base_sha: sha },
          config: { test: "exit 1", checks: [], test_paths: [], protected_paths: [] },
          setupMarker: join(dir, "marker"),
        }),
      );
      process.chdir(dir);
      process.env.MORK_VERIFY = specFile;
      process.env.MORK_VERIFY_LOG_DIR = logs;
      process.env.MORK_VERIFY_PUBLISH_REQUIRED = "1";
      process.env.MORK_VERIFY_PUBLISH_TIMEOUT_MS = "5000";
      const tools: Tool[] = [];
      verify({ registerTool: (t: Tool) => tools.push(t) });
      const tool = tools[0];
      if (!tool) throw new Error("verify not registered");
      const attempts: string[] = [];
      const root = setInterval(() => {
        for (const file of readdirSync(logs)) {
          if (!file.endsWith(".json") || file.endsWith(".published.json")) continue;
          const published = publishedSidecar(join(logs, file));
          const stage = attempts.length;
          attempts.push(file);
          if (stage === 0) writeFileSync(published, '{"artifact": "/work/diag');
          else if (stage === 1) writeFileSync(published, JSON.stringify({ artifact: 1, output_tail: "no" }));
          else writeFileSync(published, JSON.stringify({ artifact: "/work/diagnostics/ok.log", output_tail: "exit 1" }));
        }
      }, 20);
      try {
        const result = await tool.execute();
        expect(result.details.artifacts).toEqual(["/work/diagnostics/ok.log"]);
        expect(attempts.length).toBeGreaterThanOrEqual(3);
      } finally {
        clearInterval(root);
      }
    } finally {
      process.chdir(cwd);
      delete process.env.MORK_VERIFY_LOG_DIR;
      delete process.env.MORK_VERIFY_PUBLISH_REQUIRED;
      delete process.env.MORK_VERIFY_PUBLISH_TIMEOUT_MS;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
