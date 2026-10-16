import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Pi extension loaded into every LLM station. Blocks actions the station must
// never take, with a reason the model can read. The real limits are the
// container, the narrowed push token and the repository rulesets; this keeps
// an honest agent from tripping over them.
const WORK_BRANCH = process.env.MORK_WORK_BRANCH;

/** Every reason this guard blocks with starts so; the supervisor counts blocked calls apart from failures. */
export const BLOCKED_PREFIX = "Blocked by Mork";

/**
 * Every `git push` in the command must push the work branch to origin, nothing else.
 * A `&&`/`;` chain around the push (add, commit) is fine: each push is judged on
 * its own text up to the next operator, so a redirection or pipe after the
 * branch name is what gets rejected, and the reason quotes it.
 */
export function pushDenied(command: string, branch = WORK_BRANCH): string | undefined {
  // Recognize global options too (-C, --git-dir, --work-tree, -c). Only the
  // canonical form below is allowed; this guard is advice, not a shell sandbox.
  const pushes = command.match(/\bgit\s+(?:[^;&|\n]*?\s+)?push\b[^;&|\n]*/g);
  if (!pushes) return undefined;
  if (!branch) return `${BLOCKED_PREFIX}: this station never pushes.`;
  const allowed = new RegExp(
    `^git\\s+push(\\s+(-u|--set-upstream))?\\s+origin\\s+(HEAD:)?(refs/heads/)?${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
  );
  for (const push of pushes) {
    const text = push.trim();
    if (allowed.test(text)) continue;
    return (
      `${BLOCKED_PREFIX}: only \`git push origin ${branch}\` is allowed: no force, no other branches, tags or deletes, ` +
      `and nothing after the branch name (no redirection, pipe or extra arguments). ` +
      `Rejected: \`${text.slice(0, 200)}\`. Run exactly: \`git push origin ${branch}\`.`
    );
  }
  return undefined;
}

const DENY_BASH: Array<[RegExp, string]> = [
  [
    /\bgh\s+(?!auth\s+status\b)(pr|issue|release|repo|api|workflow|secret|variable|gist|auth|ruleset|label)\b/,
    `${BLOCKED_PREFIX}: gh is not for this task; the platform opens the pull request.`,
  ],
  [/\bgit\s+remote\s+(add|set-url)\b/, `${BLOCKED_PREFIX}: remotes are managed by the platform.`],
  [/169\.254\.(169|170)\.(254|2)\b/, `${BLOCKED_PREFIX}: metadata endpoints are off limits.`],
  [/\/proc\/1\//, `${BLOCKED_PREFIX}: process 1 belongs to the platform.`],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/, `${BLOCKED_PREFIX}: refusing to delete the filesystem root.`],
];

const PROTECTED_PATH = /(^|\/)(\.git|\.mork|\.github|\.pi)(\/|$)/;

/** Prevent evidence workers from reading outside their head/base checkouts, including through symlinks. */
export function readDenied(path: string, roots: string[]): boolean {
  try {
    const target = realpathSync(resolve(path));
    return !roots.some((root) => {
      const rel = relative(realpathSync(root), target);
      return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    });
  } catch {
    return true;
  }
}

export default function guard(pi: any) {
  const roots = process.env.MORK_READ_ROOTS ? (JSON.parse(process.env.MORK_READ_ROOTS) as string[]) : undefined;
  pi.on("tool_call", async (event: any) => {
    if (roots) {
      if (["bash", "write", "edit"].includes(event.toolName))
        return { block: true, reason: `${BLOCKED_PREFIX}: evidence checking is read-only and has no shell.` };
      if (["read", "grep", "find", "ls"].includes(event.toolName) && readDenied(String(event.input?.path ?? "."), roots))
        return {
          block: true,
          reason: `${BLOCKED_PREFIX}: read only the supplied repository checkouts. Outside paths and escaping symlinks are not evidence.`,
        };
    }
    if (event.toolName === "bash") {
      const command = String(event.input?.command ?? "");
      const push = pushDenied(command);
      if (push) return { block: true, reason: push };
      for (const [pattern, reason] of DENY_BASH) {
        if (pattern.test(command)) return { block: true, reason };
      }
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(event.input?.path ?? "");
      if (PROTECTED_PATH.test(path)) {
        return { block: true, reason: `${BLOCKED_PREFIX}: ${path} is managed by the platform and must not be changed.` };
      }
    }
    return undefined;
  });
}
