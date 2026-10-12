import { describe, expect, test } from "bun:test";
import { pushDenied } from "./guard.ts";

const branch = "factory/issue-7-abc12345";

describe("guard: push", () => {
  test("the work branch may be pushed, also after a commit", () => {
    expect(pushDenied(`git push origin ${branch}`, branch)).toBeUndefined();
    expect(pushDenied(`git add -A && git commit -m x && git push -u origin HEAD:${branch}`, branch)).toBeUndefined();
  });
  test("anything else is denied", () => {
    for (const cmd of [
      `git push --force origin ${branch}`,
      `git push -f origin ${branch}`,
      `git push origin +${branch}`,
      "git push origin main",
      `git push origin ${branch} main`,
      `git push origin :${branch}`,
      "git push --tags",
      "git push",
      `git -c foo=bar push origin main`,
    ]) {
      expect(pushDenied(cmd, branch)).toBeDefined();
    }
  });
  test("stations without a work branch never push", () => {
    expect(pushDenied(`git push origin ${branch}`, undefined)).toBe("This station never pushes.");
    expect(pushDenied("git status", undefined)).toBeUndefined();
  });
});
