import { describe, expect, test } from "bun:test";
import { ruleDirs, rulesFor } from "./dir-rules.ts";

describe("directory rules", () => {
  test("walks from the file's directory up to, not including, the root", () => {
    expect(ruleDirs("/repo", "models/marts/orders.sql")).toEqual(["models/marts", "models"]);
    expect(ruleDirs("/repo", "/repo/models/x.sql")).toEqual(["models"]);
    expect(ruleDirs("/repo", "README.md")).toEqual([]);
    expect(ruleDirs("/repo", "../etc/passwd")).toEqual([]);
  });
  test("shows each directory's rules once, outermost first, preferring the override", () => {
    const files: Record<string, string> = {
      "models/AGENTS.md": "use ref()",
      "models/marts/AGENTS.override.md": "no SELECT *",
      "models/marts/AGENTS.md": "ignored",
    };
    const shown = new Set<string>();
    const first = rulesFor("/repo", "abc", "models/marts/orders.sql", shown, (p) => files[p]);
    expect(first.indexOf("use ref()")).toBeLessThan(first.indexOf("no SELECT *"));
    expect(first).not.toContain("ignored");
    expect(rulesFor("/repo", "abc", "models/marts/customers.sql", shown, (p) => files[p])).toBe("");
  });
});
