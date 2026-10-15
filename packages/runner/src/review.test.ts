import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CriteriaOutput, Review, type ReviewEvidence, type VerificationOutput } from "@mork/contracts";
import { mustExec, SAFE_GIT } from "./git.ts";
import { carryFindings, locate, locateFindings, readAt, type SnapshotReader, verifyCriteria, verifyReview } from "./review.ts";

const before = "export function add(a, b) {\n  return a + b;\n}";
const after = "export function add(a, b) {\n  return a - b;\n}";
const read: { base: SnapshotReader; head: SnapshotReader } = {
  base: (path) => (path === "src/math.mjs" ? { status: "present", content: before } : { status: "absent" }),
  head: (path) => (path === "src/math.mjs" ? { status: "present", content: after } : { status: "absent" }),
};
const review = locateFindings(
  Review.parse({
    summary: "OCR",
    files_reviewed: ["src/math.mjs"],
    criteria: [],
    findings: [{ severity: "P1", category: "bug", where: "src/math.mjs:2", quote: "return a - b;", what: "add subtracts", located: null }],
    read_first: [],
    unreviewed_files: [],
  }),
  read.head,
);
const confirmed: VerificationOutput = {
  findings: [
    {
      id: "F1",
      verification: {
        status: "confirmed",
        reason: "The previous addition became subtraction",
        expected: "Sum inputs",
        scenario: "add(2,3) returns -1 instead of 5",
        evidence: [
          { revision: "base", path: "src/math.mjs", line: 2, quote: "  return a + b;" },
          { revision: "head", path: "src/math.mjs", line: 2, quote: "  return a - b;" },
        ],
      },
    },
  ],
};

test("criteria retain absolute checkout citations at their immutable base and head revisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "mork-criteria-evidence-"));
  try {
    const git = (...args: string[]) =>
      mustExec("git", [...SAFE_GIT, "-c", "user.name=test", "-c", "user.email=test@example.test", "-C", dir, ...args]).trim();
    git("init", "-q");
    writeFileSync(join(dir, "README.md"), "## Mork\nMork opens draft PRs.\n\n## Setup\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const channel = "Tasks go to Slack channel #mork-example-app.";
    writeFileSync(join(dir, "README.md"), `## Mork\nMork opens draft PRs.\n${channel}\n\n## Setup\n`);
    git("commit", "-qam", "docs(readme): name the channel");
    const head = git("rev-parse", "HEAD");
    // Verification must read Git objects, even if a worker has edited its checkout.
    writeFileSync(join(dir, "README.md"), "uncommitted content\n");
    const roots = { base: "/work/review-base", head: "/work/criteria" };
    const readers = { base: readAt(dir, base), head: readAt(dir, head) };
    const output = CriteriaOutput.parse({
      criteria: [
        {
          id: "AC1",
          pass: true,
          evidence: [
            { where: "/work/criteria/README.md:3", quote: channel },
            { where: "/work/review-base/README.md:4", quote: "## Setup" },
            { revision: "head", where: "README.md:5", quote: "## Setup" },
            { revision: "base", where: "README.md:2", quote: "Mork opens draft PRs." },
          ],
        },
      ],
    });
    const checked = verifyCriteria(review, output, ["AC1"], readers, roots);
    expect(checked.criteria[0]?.evidence).toEqual([
      { revision: "head", where: "README.md:3", quote: channel },
      { revision: "base", where: "README.md:4", quote: "## Setup" },
      { revision: "head", where: "README.md:5", quote: "## Setup" },
      { revision: "base", where: "README.md:2", quote: "Mork opens draft PRs." },
    ]);
    expect(checked.incomplete).toEqual([]);
    const invalid = CriteriaOutput.parse({
      criteria: [
        {
          id: "AC1",
          pass: true,
          evidence: [
            { where: "/work/criteria-other/README.md:3", quote: channel },
            { where: "/work/criteria/../review-base/README.md:4", quote: "## Setup" },
            { revision: "base", where: "README.md:3", quote: channel },
            { where: "README.md:4", quote: "## Setup" },
            { where: "README.md:3", quote: "invented quote" },
          ],
        },
      ],
    });
    expect(verifyCriteria(review, invalid, ["AC1", "AC2"], readers, roots)).toMatchObject({
      criteria: [{ evidence: [] }],
      incomplete: ["Acceptance criteria checker omitted criteria", "Acceptance criterion AC1 has invalid evidence"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmation requires checked baseline and changed code", () => {
  expect(verifyReview(review, confirmed, read).findings[0]?.verification.status).toBe("confirmed");
  const invented = structuredClone(confirmed);
  if (invented.findings[0]?.verification.status === "confirmed")
    invented.findings[0].verification.evidence[0] = { revision: "base", path: "src/math.mjs", line: 2, quote: "return a * b;" };
  expect(verifyReview(review, invented, read).findings[0]?.verification.status).toBe("unknown");
});

test("a matching first line never proves an invented multiline quote", () => {
  expect(locate(after, "export function add(a, b) {\n  return a * b;", 1)).toBeNull();
  expect(locate("x = 1\ny\nx = 1", "x = 1", 3)?.line).toBe(3);
});

test("wrong revision, wrong line, absent head proof and unlocated findings remain unknown", () => {
  for (const evidence of [
    [{ revision: "head", path: "src/math.mjs", line: 2, quote: "return a - b;" }],
    [{ revision: "base", path: "src/math.mjs", line: 2, quote: "return a - b;" }],
    [{ revision: "head", path: "src/math.mjs", line: 1, quote: "return a - b;" }],
  ]) {
    const output = structuredClone(confirmed);
    if (output.findings[0]?.verification.status === "confirmed") output.findings[0].verification.evidence = evidence as ReviewEvidence[];
    expect(verifyReview(review, output, read).findings[0]?.verification.status).toBe("unknown");
  }
  expect(
    verifyReview({ ...review, findings: review.findings.map((f) => ({ ...f, located: null, where: "src/other.mjs:2" })) }, confirmed, read)
      .findings[0]?.verification.status,
  ).toBe("unknown");
});

test("a new file can prove absence at base, but an existing file cannot", () => {
  const output = structuredClone(confirmed);
  if (output.findings[0]?.verification.status === "confirmed")
    output.findings[0].verification.evidence[0] = { revision: "base", path: "src/math.mjs", absent: true };
  expect(verifyReview(review, output, { ...read, base: () => ({ status: "absent" as const }) }).findings[0]?.verification.status).toBe("confirmed");
  expect(verifyReview(review, output, read).findings[0]?.verification.status).toBe("unknown");
});

test("missing assessments remain visible, and duplicates must refer to earlier canonical findings", () => {
  expect(verifyReview(review, { findings: [] }, read).findings[0]?.verification.status).toBe("unknown");
  const pair = { ...review, findings: [...review.findings, ...review.findings] };
  const output: VerificationOutput = {
    findings: [...confirmed.findings, { id: "F2", verification: { status: "duplicate", of: "F1", reason: "Same subtraction" } }],
  };
  expect(verifyReview(pair, output, read).findings[1]?.verification.status).toBe("duplicate");
  expect(
    verifyReview(review, { findings: [{ id: "F1", verification: { status: "duplicate", of: "F1", reason: "self" } }] }, read).findings[0]
      ?.verification.status,
  ).toBe("unknown");
  expect(() => verifyReview(review, { findings: [...confirmed.findings, ...confirmed.findings] }, read)).toThrow("twice");
});

test("unverifiable refutations and traversal citations cannot clear a finding", () => {
  for (const path of ["../src/math.mjs", "/src/math.mjs", "src/math.mjs"]) {
    const output: VerificationOutput = {
      findings: [
        { id: "F1", verification: { status: "refuted", reason: "handled", evidence: [{ revision: "head", path, line: 2, quote: "return a * b;" }] } },
      ],
    };
    expect(verifyReview(review, output, read).findings[0]?.verification.status).toBe("unknown");
  }
});

test("an oversized existing blob is a read error, never evidence of absence", () => {
  const dir = mkdtempSync(join(tmpdir(), "mork-evidence-read-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "large.txt"), Buffer.alloc(65 * 1024 * 1024, 97));
    writeFileSync(join(dir, "src/math.mjs"), before);
    const git = (...args: string[]) =>
      mustExec("git", [...SAFE_GIT, "-c", "user.name=test", "-c", "user.email=test@example.test", "-C", dir, ...args]).trim();
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
    const snapshot = readAt(dir, git("rev-parse", "HEAD"));
    expect(snapshot("missing.txt").status).toBe("absent");
    expect(snapshot("large.txt").status).toBe("error");
    const output: VerificationOutput = {
      findings: [
        {
          id: "F1",
          verification: {
            status: "refuted",
            reason: "Claim assumes a baseline file",
            evidence: [{ revision: "base", path: "large.txt", absent: true }],
          },
        },
      ],
    };
    expect(verifyReview(review, output, { base: snapshot, head: read.head }).findings[0]?.verification.status).toBe("unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean subsequent OCR pass cannot erase an unknown earlier claim", () => {
  const prior = {
    ...review,
    findings: review.findings.map((f) => ({ ...f, verification: { status: "unknown" as const, reason: "Unproven prerequisite" } })),
  };
  const next = carryFindings({ ...review, findings: [] }, prior);
  expect(next.findings).toHaveLength(1);
  expect(next.findings[0]?.verification.status).toBe("unknown");
  expect(verifyReview(next, { findings: [] }, read).findings[0]?.verification.status).toBe("unknown");
});

test("a carried defect whose line changed is anchored to validated current-head evidence", () => {
  const current = "export function add(a, b, c) {\n  return a - b + c;\n}";
  const readers = { ...read, head: (() => ({ status: "present", content: current })) as SnapshotReader };
  const carried = locateFindings(carryFindings({ ...review, findings: [] }, review), readers.head);
  expect(carried.findings[0]?.located).toBeNull();
  const output = structuredClone(confirmed);
  if (output.findings[0]?.verification.status === "confirmed")
    output.findings[0].verification.evidence[1] = { revision: "head", path: "src/math.mjs", line: 2, quote: "  return a - b + c;" };
  const checked = verifyReview(carried, output, readers);
  expect(checked.findings[0]?.verification.status).toBe("confirmed");
  expect(checked.findings[0]?.quote).toBe("  return a - b + c;");
});
