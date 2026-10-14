// Repository evidence is verified against immutable Git objects. A valid quote
// proves its location, not the defect; the verifier must establish the regression.
import type { FindingVerification, Review, ReviewEvidence, VerificationOutput } from "@mork/contracts";
import { exec, mustExec, SAFE_GIT } from "./git.ts";

export type ChangedFile = { path: string; added: number; removed: number };

export function changedFiles(repoDir: string, baseSha: string, head: string): ChangedFile[] {
  return mustExec("git", [...SAFE_GIT, "-C", repoDir, "diff", "--numstat", "--no-renames", "-z", `${baseSha}...${head}`])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split("\t");
      return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
}

export function locate(content: string, quote: string, near: number): { line: number; excerpt: string } | null {
  const wanted = quote
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (!wanted[0]) return null;
  const lines = content.split("\n");
  const matches = lines.flatMap((_, index) => (wanted.every((line, offset) => lines[index + offset]?.trim() === line) ? [index] : []));
  if (!matches.length) return null;
  const index = matches.reduce((best, candidate) => (Math.abs(candidate + 1 - near) < Math.abs(best + 1 - near) ? candidate : best));
  const from = Math.max(0, index - 8);
  return {
    line: index + 1,
    excerpt: lines
      .slice(from, index + wanted.length + 8)
      .map((line, offset) => `${from + offset + 1}: ${line}`)
      .join("\n")
      .slice(0, 4000),
  };
}

function safePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}

export function readAt(repoDir: string, head: string): (path: string) => string | undefined {
  return (path) => {
    if (!safePath(path)) return undefined;
    const shown = exec("git", [...SAFE_GIT, "-C", repoDir, "show", "--end-of-options", `${head}:${path}`]);
    return shown.code === 0 ? shown.output : undefined;
  };
}

export function locateFindings(review: Review, read: (path: string) => string | undefined): Review {
  return {
    ...review,
    findings: review.findings.map((finding) => {
      const where = /^(.+?):(\d+)(?:\D.*)?$/.exec(finding.where);
      const content = read(where?.[1] ?? finding.where);
      return { ...finding, located: content === undefined ? null : locate(content, finding.quote, Number(where?.[2] ?? 1)) };
    }),
  };
}

function citationValid(e: ReviewEvidence, read: { base: (path: string) => string | undefined; head: (path: string) => string | undefined }): boolean {
  if (!safePath(e.path)) return false;
  const content = read[e.revision](e.path);
  if ("absent" in e) return content === undefined;
  return content !== undefined && locate(content, e.quote, e.line)?.line === e.line;
}

export function verifyReview(
  review: Review,
  output: VerificationOutput,
  read: { base: (path: string) => string | undefined; head: (path: string) => string | undefined },
): Review {
  const ids = review.findings.map((_, index) => `F${index + 1}`);
  const seen = new Map<string, FindingVerification>();
  for (const f of output.findings) {
    if (!ids.includes(f.id)) throw new Error(`Verifier returned an unknown finding ${f.id}`);
    if (seen.has(f.id)) throw new Error(`Verifier returned ${f.id} twice`);
    seen.set(f.id, f.verification);
  }
  const unknown = (reason: string): FindingVerification => ({ status: "unknown", reason });
  const findings = review.findings.map((finding, index) => {
    let verification = seen.get(`F${index + 1}`) ?? unknown("Verifier omitted this finding");
    if (verification.status === "confirmed" || verification.status === "refuted") {
      if (!verification.evidence.every((e) => citationValid(e, read)))
        verification = unknown("Verifier evidence was not found at the cited revision and line");
      else if (verification.status === "confirmed") {
        const revisions = new Set(verification.evidence.map((e) => e.revision));
        if (!finding.located || !revisions.has("base") || !revisions.has("head"))
          verification = unknown("A confirmed defect needs located code and evidence of both previous and changed behaviour");
      }
    }
    if (verification.status === "duplicate") {
      const target = Number(verification.of.slice(1)) - 1;
      if (target < 0 || target >= index || seen.get(verification.of)?.status === "duplicate") verification = unknown("Invalid duplicate reference");
    }
    return { ...finding, verification };
  });
  return { ...review, findings };
}
