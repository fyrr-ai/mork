import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutantsFrom, mutateLine, runMutants } from "./mutants.ts";

describe("mutants", () => {
  test("one deterministic change per line, never inside strings or comments", () => {
    expect(mutateLine("  if (a === b) return 1;")?.mutated).toBe("  if (a !== b) return 1;");
    expect(mutateLine("  return width <= text.length;")?.mutated).toBe("  return width > text.length;");
    expect(mutateLine("const f = (x) => x > 0;")?.mutated).toBe("const f = (x) => x <= 0;");
    expect(mutateLine('  return "a === b";')).toBeUndefined();
    expect(mutateLine("  // if (a === b)")).toBeUndefined();
    expect(mutateLine("  return text.slice(0, 3);")?.mutated).toBe("  return text.slice(1, 3);");
  });
  test("only added code lines outside tests, spread over the change", () => {
    const patch = [
      "+++ b/src/a.mjs",
      "@@ -0,0 +10,2 @@",
      "+if (x === 1) y();",
      "+const name = 'a';",
      "+++ b/test/a.test.mjs",
      "@@ -0,0 +1 @@",
      "+assert(x === 1);",
      "+++ b/README.md",
      "@@ -0,0 +1 @@",
      "+a === b",
    ].join("\n");
    const mutants = mutantsFrom(patch, (p) => p.startsWith("test/"));
    expect(mutants).toEqual([{ file: "src/a.mjs", line: 10, change: "=== → !==", mutated: "if (x !== 1) y();" }]);
  });
  test("hidden tests that pin the behaviour kill the mutant; the file is restored", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutants-"));
    mkdirSync(join(dir, "src"));
    const source = "export function isLong(text, max) {\n  return text.length > max;\n}\n";
    writeFileSync(join(dir, "src/a.mjs"), source);
    writeFileSync(
      join(dir, "hidden.test.mjs"),
      'import { test } from "node:test";\nimport assert from "node:assert";\nimport { isLong } from "./src/a.mjs";\ntest("x", () => { assert.equal(isLong("abc", 2), true); assert.equal(isLong("ab", 2), false); });\n',
    );
    const pass = () => (spawnSync("node", ["--test", "hidden.test.mjs"], { cwd: dir }).status === 0 ? "pass" : "fail") as "pass" | "fail";
    const mutants = mutantsFrom("+++ b/src/a.mjs\n@@ -0,0 +2 @@\n+  return text.length > max;", () => false);
    const report = runMutants(dir, mutants, pass);
    expect(report).toMatchObject({ killed: 1, total: 1, skipped: 0 });
    expect(readFileSync(join(dir, "src/a.mjs"), "utf8")).toBe(source);
  });
  test("a mutant that breaks the syntax is left out of the score", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutants-invalid-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.mjs"), "export const one = 1;\n");
    const mutants = [{ file: "src/a.mjs", line: 1, change: "x", mutated: "export const one = ;" }];
    expect(runMutants(dir, mutants, () => "invalid")).toMatchObject({ killed: 0, total: 0, skipped: 0 });
  });
  test("comparisons in TypeScript are not mutated, they are often generics", () => {
    expect(mutateLine("const xs: Array<number> = [];", ".ts")).toBeUndefined();
    expect(mutateLine("return a === b;", ".ts")?.mutated).toBe("return a !== b;");
  });
});
