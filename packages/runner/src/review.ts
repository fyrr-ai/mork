// What the runner adds to a review: the change's files and the rules for their
// types go into the reviewer's task, and afterwards the runner checks itself
// that every finding quotes text that is in the reviewed commit.
import type { Review, ReviewerOutput } from "@mork/contracts";
import general from "../rules/default.md" with { type: "text" };
import go from "../rules/go.md" with { type: "text" };
import java from "../rules/java.md" with { type: "text" };
import python from "../rules/python.md" with { type: "text" };
import terraform from "../rules/terraform.md" with { type: "text" };
import typescript from "../rules/ts_js_tsx_jsx.md" with { type: "text" };
import { exec, mustExec, SAFE_GIT } from "./git.ts";

export type ChangedFile = { path: string; added: number; removed: number };

/** Files changed between the base commit and `head` (binary files count no lines). */
export function changedFiles(repoDir: string, baseSha: string, head: string): ChangedFile[] {
  return mustExec("git", [...SAFE_GIT, "-C", repoDir, "diff", "--numstat", "--no-renames", "-z", `${baseSha}...${head}`])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split("\t");
      return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
}

const RULES: { files: RegExp; title: string; text: string }[] = [
  { files: /\.(ts|js|tsx|jsx|mjs|cjs)$/, title: "TypeScript and JavaScript", text: typescript },
  { files: /\.(py|pyi)$/, title: "Python", text: python },
  { files: /\.go$/, title: "Go", text: go },
  { files: /\.java$/, title: "Java", text: java },
  { files: /\.(tf|hcl|tfvars)$/, title: "Terraform", text: terraform },
];

/** The rule documents for the file types in `files`, the general one first. */
export function reviewRules(files: ChangedFile[]): string {
  const matching = RULES.filter((rule) => files.some((file) => rule.files.test(file.path)));
  return [{ title: "All files", text: general }, ...matching].map((rule) => `### ${rule.title}\n\n${rule.text.trim()}`).join("\n\n");
}

const EXCERPT_LINES = 8;

/** Where `quote` is in `content`: the match nearest to `near`, with the lines around it. */
export function locate(content: string, quote: string, near: number): { line: number; excerpt: string } | null {
  const wanted = quote
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!wanted) return null;
  const lines = content.split("\n");
  const matches = lines.flatMap((line, index) => (line.includes(wanted) ? [index] : []));
  if (!matches.length) return null;
  const index = matches.reduce((best, candidate) => (Math.abs(candidate + 1 - near) < Math.abs(best + 1 - near) ? candidate : best));
  const from = Math.max(0, index - EXCERPT_LINES);
  const excerpt = lines
    .slice(from, index + EXCERPT_LINES + 1)
    .map((line, offset) => `${from + offset + 1}: ${line}`)
    .join("\n");
  return { line: index + 1, excerpt: excerpt.slice(0, 4_000) };
}

/** Adds to the reviewer's output what the runner can verify without a model. */
export function checkReview(output: ReviewerOutput, files: ChangedFile[], read: (path: string) => string | undefined): Review {
  const reviewed = new Set(output.files_reviewed.map((path) => path.replace(/^\.\//, "")));
  return {
    ...output,
    findings: output.findings.map((finding) => {
      // `path`, `path:12` or `path:12-14`; paths may contain hyphens and colons.
      const where = /^(.+?):(\d+)(?:\D.*)?$/.exec(finding.where.trim());
      const content = read((where?.[1] ?? finding.where.trim()).replace(/^\.\//, ""));
      return { ...finding, located: content === undefined ? null : locate(content, finding.quote, Number(where?.[2] ?? 1)) };
    }),
    unreviewed_files: files.map((file) => file.path).filter((path) => !reviewed.has(path)),
  };
}

/** Reads a file from the reviewed commit, not from the working tree the reviewer could have touched. */
export function readAt(repoDir: string, head: string): (path: string) => string | undefined {
  return (path) => {
    const shown = exec("git", [...SAFE_GIT, "-C", repoDir, "show", "--end-of-options", `${head}:${path}`]);
    return shown.code === 0 ? shown.output : undefined;
  };
}
