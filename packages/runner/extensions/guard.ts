// Pi extension loaded into every LLM station. Blocks actions the station must
// never take, with a reason the model can read. The real limits are the
// container, the narrowed push token and the repository rulesets; this keeps
// an honest agent from tripping over them.
const WORK_BRANCH = process.env.MORK_WORK_BRANCH;

/** Every `git push` in the command must push the work branch to origin, nothing else. */
export function pushDenied(command: string, branch = WORK_BRANCH): string | undefined {
  // Recognize global options too (-C, --git-dir, --work-tree, -c). Only the
  // canonical form below is allowed; this guard is advice, not a shell sandbox.
  const pushes = command.match(/\bgit\s+(?:[^;&|\n]*?\s+)?push\b[^;&|\n]*/g);
  if (!pushes) return undefined;
  if (!branch) return "This station never pushes.";
  const allowed = new RegExp(
    `^git\\s+push(\\s+(-u|--set-upstream))?\\s+origin\\s+(HEAD:)?(refs/heads/)?${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
  );
  for (const push of pushes) {
    if (!allowed.test(push.trim())) return `Only \`git push origin ${branch}\` is allowed: no force, no other branches, tags or deletes.`;
  }
  return undefined;
}

const DENY_BASH: Array<[RegExp, string]> = [
  [
    /\bgh\s+(?!auth\s+status\b)(pr|issue|release|repo|api|workflow|secret|variable|gist|auth|ruleset|label)\b/,
    "gh is not for this task; the platform opens the pull request.",
  ],
  [/\bgit\s+remote\s+(add|set-url)\b/, "Remotes are managed by the platform."],
  [/169\.254\.(169|170)\.(254|2)\b/, "Metadata endpoints are off limits."],
  [/\/proc\/1\//, "Process 1 belongs to the platform."],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/, "Refusing to delete the filesystem root."],
];

const PROTECTED_PATH = /(^|\/)(\.git|\.mork|\.github|\.pi)(\/|$)/;

export default function guard(pi: any) {
  pi.on("tool_call", async (event: any) => {
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
        return { block: true, reason: `${path} is managed by the platform and must not be changed.` };
      }
    }
    return undefined;
  });
}
