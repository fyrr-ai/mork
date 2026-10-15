// Repository evidence is verified against immutable Git objects. A valid quote
// proves its location, not the defect; the verifier must establish the regression.
import type { CriteriaOutput, FindingVerification, Review, ReviewEvidence, VerificationOutput } from "@mork/contracts";
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

export type Snapshot = { status: "present"; content: string } | { status: "absent" } | { status: "error"; reason: string };
export type SnapshotReader = (path: string) => Snapshot;

export function readAt(repoDir: string, head: string): SnapshotReader {
  return (path) => {
    if (!safePath(path)) return { status: "error", reason: "Invalid repository path" };
    // Establish absence from the tree. A failed/oversized blob read is not absence.
    const tree = exec("git", [...SAFE_GIT, "--literal-pathspecs", "-C", repoDir, "ls-tree", "-z", head, "--", path]);
    if (tree.code !== 0) return { status: "error", reason: "Cannot read commit tree" };
    if (!tree.output) return { status: "absent" };
    const blob = /^\d+ blob ([0-9a-f]+)\t/.exec(tree.output);
    if (!blob) return { status: "error", reason: "Path is not a blob" };
    const shown = exec("git", [...SAFE_GIT, "-C", repoDir, "cat-file", "-p", blob[1] as string]);
    return shown.code === 0 ? { status: "present", content: shown.output } : { status: "error", reason: "Cannot read blob" };
  };
}

/** Findings not explicitly resolved are reassessed on each new head, even if OCR misses them next time. */
export function carryFindings(review: Review, previous: Review): Review {
  const findings = [...review.findings];
  const claims = new Set(findings.map((f) => `${f.where}\0${f.what}\0${f.quote}`));
  for (const finding of previous.findings) {
    const claim = `${finding.where}\0${finding.what}\0${finding.quote}`;
    if (claims.has(claim)) continue;
    claims.add(claim);
    findings.push({ ...finding, located: null, verification: { status: "unknown", reason: "Previous claim needs reassessment against this head" } });
  }
  return { ...review, findings };
}

export function locateFindings(review: Review, read: SnapshotReader): Review {
  return {
    ...review,
    findings: review.findings.map((finding) => {
      const where = /^(.+?):(\d+)(?:\D.*)?$/.exec(finding.where);
      const snapshot = read(where?.[1] ?? finding.where);
      return { ...finding, located: snapshot.status !== "present" ? null : locate(snapshot.content, finding.quote, Number(where?.[2] ?? 1)) };
    }),
  };
}

function citationValid(e: ReviewEvidence, read: { base: SnapshotReader; head: SnapshotReader }): boolean {
  if (!safePath(e.path)) return false;
  const snapshot = read[e.revision](e.path);
  if ("absent" in e) return snapshot.status === "absent";
  return snapshot.status === "present" && locate(snapshot.content, e.quote, e.line)?.line === e.line;
}

/** Resolve agent checkout paths to immutable Git revisions before checking quotes. */
export function verifyCriteria(
  review: Review,
  output: CriteriaOutput,
  expected: string[],
  read: { base: SnapshotReader; head: SnapshotReader },
  roots: { base: string; head: string },
): Review {
  const seen = new Set<string>();
  const criteria = output.criteria
    .filter((c) => {
      if (!expected.includes(c.id) || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .map((c) => ({
      ...c,
      evidence: c.evidence.flatMap((e) => {
        const where = /^(.+):([1-9]\d*)$/.exec(e.where);
        if (!where) return [];
        let path = where[1] as string;
        let revision = e.revision;
        // The actual checkout identifies the revision even if the agent omits it.
        for (const candidate of ["base", "head"] as const) {
          if (!path.startsWith(`${roots[candidate]}/`)) continue;
          path = path.slice(roots[candidate].length + 1);
          revision = candidate;
          break;
        }
        if (!safePath(path)) return [];
        const line = Number(where[2]);
        const snapshot = read[revision](path);
        if (snapshot.status !== "present" || locate(snapshot.content, e.quote, line)?.line !== line) return [];
        return [{ revision, where: `${path}:${line}`, quote: e.quote }];
      }),
    }));
  return {
    ...review,
    criteria,
    incomplete: [
      ...review.incomplete,
      ...(seen.size !== expected.length ? ["Acceptance criteria checker omitted criteria"] : []),
      ...criteria
        .filter((c) => c.evidence.length !== output.criteria.find((raw) => raw.id === c.id)?.evidence.length)
        .map((c) => `Acceptance criterion ${c.id} has invalid evidence`),
    ],
  };
}

export function verifyReview(review: Review, output: VerificationOutput, read: { base: SnapshotReader; head: SnapshotReader }): Review {
  const ids = review.findings.map((_, index) => `F${index + 1}`);
  const seen = new Map<string, FindingVerification>();
  for (const f of output.findings) {
    if (!ids.includes(f.id)) throw new Error(`Verifier returned an unknown finding ${f.id}`);
    if (seen.has(f.id)) throw new Error(`Verifier returned ${f.id} twice`);
    seen.set(f.id, f.verification);
  }
  const unknown = (reason: string): FindingVerification => ({ status: "unknown", reason });
  const findings = review.findings.map((finding, index) => {
    let anchored = finding;
    let verification = seen.get(`F${index + 1}`) ?? unknown("Verifier omitted this finding");
    if (verification.status === "confirmed" || verification.status === "refuted") {
      if (!verification.evidence.every((e) => citationValid(e, read)))
        verification = unknown("Verifier evidence was not found at the cited revision and line");
      else if (verification.status === "confirmed") {
        const revisions = new Set(verification.evidence.map((e) => e.revision));
        const path = /^(.+?):\d+(?:\D.*)?$/.exec(finding.where)?.[1] ?? finding.where;
        const citation = verification.evidence.find((e) => e.revision === "head" && e.path === path && "quote" in e);
        if (!revisions.has("base") || !revisions.has("head") || !citation || !("quote" in citation))
          verification = unknown("A confirmed defect needs baseline evidence and a current-head quote at the claimed path");
        else {
          const snapshot = read.head(citation.path);
          const located = snapshot.status === "present" ? locate(snapshot.content, citation.quote, citation.line) : null;
          if (!located) verification = unknown("Current-head evidence could not be anchored");
          else anchored = { ...finding, where: `${citation.path}:${citation.line}`, quote: citation.quote, located };
        }
      }
    }
    if (verification.status === "duplicate") {
      const target = Number(verification.of.slice(1)) - 1;
      if (target < 0 || target >= index || seen.get(verification.of)?.status === "duplicate") verification = unknown("Invalid duplicate reference");
    }
    return { ...anchored, verification };
  });
  return { ...review, findings };
}
