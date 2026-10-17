import { describe, expect, test } from "bun:test";
import { RULES_MARKER, ruleDirs, rulesFor } from "./dir-rules.ts";

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
  test("appended rules announce themselves as a platform notice, name the file and never pose as its content", () => {
    const files: Record<string, string> = { "service/AGENTS.md": "Automation must ship stopped." };
    const first = rulesFor("/repo", "abc", "service/tests/test_policy.py", new Set(), (p) => files[p]);
    expect(first.startsWith("\n\n")).toBe(true);
    const notice = first.trim();
    expect(notice.startsWith(RULES_MARKER)).toBe(true);
    expect(notice).toContain("service/tests/test_policy.py");
    expect(notice).toContain("not part of");
    expect(notice).toContain("Automation must ship stopped.");
    expect(notice.indexOf(RULES_MARKER)).toBeLessThan(notice.indexOf("## Rules for service/"));
    expect(notice).toContain("source: service/AGENTS.md at base commit abc");
  });
});
