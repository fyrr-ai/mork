import { describe, expect, test } from "bun:test";
import { authorCriteria, BRANCH_PATTERN, parseRepoConfig, raiseLevel } from "./index.ts";

describe("contracts", () => {
  test("repo config parses with defaults", () => {
    const c = parseRepoConfig(`test = "npm test"\n[hidden_tests]\ndir = "test/hidden"\ncommand = "node --test {file}"\nfile_suffix = ".test.mjs"\n`);
    expect(c.test_paths).toEqual(["test/", "tests/"]);
    expect(c.protected_paths).toEqual([]);
  });
  test("hidden test command must reference {file}", () => {
    expect(() => parseRepoConfig(`test = "x"\n[hidden_tests]\ndir = "d"\ncommand = "node --test"\nfile_suffix = ".t"\n`)).toThrow();
  });
  test("levels only rise", () => {
    expect(raiseLevel("quick", "careful")).toBe("careful");
    expect(raiseLevel("takeover", "quick")).toBe("takeover");
  });
  test("branch pattern refuses main, refs and metacharacters", () => {
    for (const b of ["main", "mork/../main", "refs/heads/mork/x", "mork/a;rm", "mork/A"]) expect(BRANCH_PATTERN.test(b)).toBe(false);
    expect(BRANCH_PATTERN.test("mork/issue-12-fix-reset")).toBe(true);
  });
  test("author criteria are numbered lines, however Jira renders the list", () => {
    const body = [
      "Goal: link the config.",
      "",
      "Acceptance criteria",
      "- AC1: README links  `.mork/config.toml`",
      "**AC2**: other README text is unchanged",
      "AC3 - CI passes",
      "We discussed AC4 later.",
    ].join("\n");
    expect(authorCriteria(body)).toEqual([
      { id: "AC1", text: "README links `.mork/config.toml`" },
      { id: "AC2", text: "other README text is unchanged" },
      { id: "AC3", text: "CI passes" },
    ]);
    expect(authorCriteria(null)).toEqual([]);
    expect(authorCriteria("- adds a link\n- keeps the rest")).toEqual([]);
  });
});
