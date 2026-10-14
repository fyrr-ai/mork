import { expect, test } from "bun:test";
import type { ReviewerOutput } from "@mork/contracts";
import { checkReview, locate, reviewRules } from "./review.ts";

const file = ["export function add(a, b) {", "  return a - b;", "}", "", "export const twice = (n) => add(n, n);"].join("\n");
const output: ReviewerOutput = {
  summary: "reviewed",
  files_reviewed: ["./src/math.mjs"],
  criteria: [],
  findings: [
    { severity: "P1", category: "bug", where: "src/math.mjs:2", quote: "return a - b;", what: "add subtracts" },
    { severity: "P1", category: "bug", where: "src/math.mjs:2-3", quote: "return a * b;", what: "invented line" },
    { severity: "P2", category: "style", where: "src/missing.mjs:1", quote: "return a - b;", what: "file does not exist" },
  ],
  read_first: [],
};
const files = [
  { path: "src/math.mjs", added: 2, removed: 1 },
  { path: "infra/main.tf", added: 4, removed: 0 },
];

test("a finding is located only when its quote is in the named file of the reviewed commit", () => {
  const review = checkReview(output, files, (path) => (path === "src/math.mjs" ? file : undefined));
  expect(review.findings.map((finding) => finding.located?.line ?? null)).toEqual([2, null, null]);
  expect(review.findings[0]?.located?.excerpt).toContain("2:   return a - b;");
});

test("paths with hyphens and line ranges are located", () => {
  const named = {
    ...output,
    findings: [
      { ...output.findings[0], where: "src/github-auth.mjs:2-3" },
      { ...output.findings[0], where: "src/github-auth.mjs" },
    ],
  } as ReviewerOutput;
  const review = checkReview(named, files, (path) => (path === "src/github-auth.mjs" ? file : undefined));
  expect(review.findings.map((finding) => finding.located?.line ?? null)).toEqual([2, 2]);
});

test("changed files the reviewer did not list are reported", () => {
  expect(checkReview(output, files, () => file).unreviewed_files).toEqual(["infra/main.tf"]);
});

test("a repeated line is located at the occurrence nearest to the stated line", () => {
  expect(locate(["x = 1", "y", "x = 1"].join("\n"), "x = 1", 3)?.line).toBe(3);
  expect(locate("x = 1", "   ", 1)).toBeNull();
});

test("the reviewer gets the general rules plus those for the changed file types", () => {
  const rules = reviewRules(files);
  expect(rules).toContain("### All files");
  expect(rules).toContain("### Terraform");
  expect(rules).not.toContain("### Python");
});
