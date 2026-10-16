import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pi ships typebox inside the runner image; the unit test only needs the schema calls to exist.
mock.module("typebox", () => ({ Type: { Object: (v: unknown) => v, String: (v: unknown) => v } }));
const { default: ask, MAX_QUESTION_CHARS } = await import("./ask.ts");

type Tool = { name: string; execute: (id: string, params: { question: string }) => Promise<unknown> };

function load(out: string): Tool {
  process.env.MORK_QUESTION = out;
  const tools: Tool[] = [];
  ask({ registerTool: (t: Tool) => tools.push(t) });
  const tool = tools[0];
  if (!tool) throw new Error("ask_human not registered");
  return tool;
}

describe("ask_human", () => {
  test("a question within the limit reaches the requester whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mork-ask-"));
    try {
      const out = join(dir, "out", "question.txt");
      const question = `Should the loader ${"x".repeat(MAX_QUESTION_CHARS - 40)} replace or append?`;
      await load(out).execute("c1", { question: `  ${question}  ` });
      expect(readFileSync(out, "utf8")).toBe(question);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a question over the limit is refused with its size, nothing is cut or sent, and the model can rephrase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mork-ask-"));
    try {
      const out = join(dir, "out", "question.txt");
      const tool = load(out);
      const long = `Tool outputs are corrupted ${"evidence ".repeat(400)}what now?`;
      await expect(tool.execute("c1", { question: long })).rejects.toThrow(`${long.length} characters`);
      expect(existsSync(out)).toBe(false);
      await tool.execute("c2", { question: "Replace a file's rows whole, or append and dedupe later?" });
      expect(readFileSync(out, "utf8")).toBe("Replace a file's rows whole, or append and dedupe later?");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
