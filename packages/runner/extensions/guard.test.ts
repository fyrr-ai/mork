import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCKED_PREFIX, pushDenied, readDenied } from "./guard.ts";

const branch = "mork/issue-7-abc12345";

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
      "git -C . push origin main",
      "git --git-dir=.git push origin main",
      "git --work-tree . -C . push origin main",
    ]) {
      expect(pushDenied(cmd, branch)).toBeDefined();
    }
  });
  test("a commit chain ending in the plain push is allowed; only what follows the branch is rejected, and the reason says so", () => {
    expect(pushDenied(`git add -A && git commit -m "x" && git push origin ${branch}`, branch)).toBeUndefined();
    const reason = pushDenied(`git add -A && git commit -q -m x; git push origin ${branch} 2>&1 | tail -3`, branch);
    expect(reason).toBeDefined();
    expect(reason?.startsWith(BLOCKED_PREFIX)).toBe(true);
    expect(reason).toContain(`Rejected: \`git push origin ${branch} 2>`);
    expect(reason).toContain("after the branch name");
    expect(reason).toContain(`Run exactly: \`git push origin ${branch}\``);
    expect(pushDenied("git push --force origin main", branch)).toContain("Rejected: `git push --force origin main`");
  });
  test("stations without a work branch never push", () => {
    expect(pushDenied(`git push origin ${branch}`, undefined)).toBe(`${BLOCKED_PREFIX}: this station never pushes.`);
    expect(pushDenied("git status", undefined)).toBeUndefined();
  });
});

// Evidence workers may inspect the baseline sibling, but not another checkout
// or a symlink that escapes their two explicitly supplied roots.
test("evidence reads stay inside supplied roots after resolving symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "mork-read-scope-"));
  try {
    const head = join(directory, "head");
    const base = join(directory, "base");
    mkdirSync(head);
    mkdirSync(base);
    writeFileSync(join(head, "code.ts"), "head");
    writeFileSync(join(base, "code.ts"), "base");
    writeFileSync(join(directory, "secret"), "outside");
    symlinkSync(join(directory, "secret"), join(head, "escape"));
    expect(readDenied(join(head, "code.ts"), [head, base])).toBe(false);
    expect(readDenied(join(base, "code.ts"), [head, base])).toBe(false);
    expect(readDenied(join(head, "escape"), [head, base])).toBe(true);
    expect(readDenied(directory, [head, base])).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
