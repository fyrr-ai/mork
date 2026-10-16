// Directory-scoped rules (Stripe Minions pattern): Pi loads the root AGENTS.md
// itself; this finds the AGENTS.md files in the directories between a touched
// file and the root. They are read from the base commit, so a branch the
// agent edits cannot rewrite its own rules.
import { execFileSync } from "node:child_process";
import { isAbsolute, posix, relative, sep } from "node:path";

const NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const MAX_CHARS = 6_000;

/**
 * Opens every rules notice. A read result that carries rules grows by this notice,
 * so the agent can tell an appended platform notice from the file's own content.
 */
export const RULES_MARKER = "[Mork directory rules:";

/** Repo-relative directories from the file's own up to, but not including, the root. */
export function ruleDirs(repoDir: string, file: string): string[] {
  const rel = (isAbsolute(file) ? relative(repoDir, file) : file).split(sep).join("/");
  if (!rel || rel.startsWith("..")) return [];
  const dirs: string[] = [];
  for (let dir = posix.dirname(posix.normalize(rel)); dir !== "." && dir !== "/"; dir = posix.dirname(dir)) dirs.push(dir);
  return dirs;
}

/** Rules for `file` not shown yet, outermost first; marks them shown. */
export function rulesFor(
  repoDir: string,
  baseSha: string,
  file: string,
  shown: Set<string>,
  read: (path: string) => string | undefined = (path) => gitShow(repoDir, baseSha, path),
): string {
  const parts: string[] = [];
  for (const dir of ruleDirs(repoDir, file).reverse()) {
    if (shown.has(dir)) continue;
    shown.add(dir);
    for (const name of NAMES) {
      const text = read(`${dir}/${name}`);
      if (text === undefined) continue;
      const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[truncated]` : text;
      parts.push(`## Rules for ${dir}/ (source: ${dir}/${name} at base commit ${baseSha.slice(0, 12)})\n\n${body.trim()}`);
      break;
    }
  }
  if (!parts.length) return "";
  const rel = (isAbsolute(file) ? relative(repoDir, file) : file).split(sep).join("/");
  return `\n\n${RULES_MARKER} a platform notice appended once per directory per session. It is not part of ${rel}; that file's content ends before this notice and is unchanged.]\n---\nThis file is under directories with their own rules. Follow them for changes there.\n\n${parts.join("\n\n")}`;
}

function gitShow(repoDir: string, baseSha: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repoDir, "show", `${baseSha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}
