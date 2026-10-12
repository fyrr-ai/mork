// Do the hidden tests catch a wrong implementation? (Meta ACH / TestGen
// pattern, kept cheap.) A few deterministic mutants on the lines the change
// added, each run against the hidden tests only, inside a time budget. A
// mutant the tests still pass "survived": the tests do not pin that line.
// The result is a metric for the PR and the analyst, never a gate.
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export type Mutant = { file: string; line: number; change: string; mutated: string };
export type MutationReport = {
  mutants: { where: string; change: string; killed: boolean }[];
  killed: number;
  total: number;
  /** Mutants not run because the time budget ran out (invalid ones are left out entirely). */
  skipped: number;
  seconds: number;
};

const CODE = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".py", ".go", ".rb", ".java", ".kt", ".rs", ".sql"]);
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;
const TYPED = new Set([".ts", ".tsx", ".mts", ".java", ".kt", ".rs", ".go"]);

/** First applicable rule wins; each rewrites the first match on the line. */
const RULES: Array<[RegExp, (m: string) => string, string]> = [
  [/===/, () => "!==", "=== → !=="],
  [/!==/, () => "===", "!== → ==="],
  [/(?<![=!<>])==(?!=)/, () => "!=", "== → !="],
  [/!=(?!=)/, () => "==", "!= → =="],
  [/<=/, () => ">", "<= → >"],
  [/>=/, () => "<", ">= → <"],
  [/(?<![<=>-])<(?![=<])/, () => ">=", "< → >="],
  [/(?<![=>-])>(?![=>])/, () => "<=", "> → <="],
  [/&&/, () => "||", "&& → ||"],
  [/\|\|/, () => "&&", "|| → &&"],
  [/\band\b/, () => "or", "and → or"],
  [/\bor\b/, () => "and", "or → and"],
  [/\btrue\b/, () => "false", "true → false"],
  [/\bfalse\b/, () => "true", "false → true"],
  [/\bTrue\b/, () => "False", "True → False"],
  [/(?<![\w.])\d+(?![\w.])/, (m) => String(Number(m) + 1), "n → n+1"],
];

/** Strips string literals so operators inside them are not mutated. */
function codeOnly(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (s) => " ".repeat(s.length));
}

export function mutateLine(line: string, ext = ".js"): { mutated: string; change: string } | undefined {
  if (COMMENT.test(line)) return undefined;
  const code = codeOnly(line);
  for (const [pattern, replace, change] of RULES) {
    // In TypeScript `<` and `>` are as often generics as comparisons; mutating them mostly breaks the syntax.
    if (TYPED.has(ext) && /^[<>] →/.test(change)) continue;
    const match = pattern.exec(code);
    if (!match) continue;
    return { mutated: line.slice(0, match.index) + replace(match[0]) + line.slice(match.index + match[0].length), change };
  }
  return undefined;
}

/** Mutants on lines added by `patch` (git diff --unified=0), spread across files and lines. */
export function mutantsFrom(patch: string, skip: (path: string) => boolean, max = 5): Mutant[] {
  const all: Mutant[] = [];
  let file = "";
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const current = line++;
    if (!file || skip(file) || !CODE.has(extname(file))) continue;
    const m = mutateLine(raw.slice(1), extname(file));
    if (m) all.push({ file, line: current, ...m });
  }
  if (all.length <= max) return all;
  const step = all.length / max;
  return Array.from({ length: max }, (_, i) => all[Math.floor(i * step)] as Mutant);
}

/** What the hidden tests said about one mutant: still passing, failing, or the mutant did not even run (syntax). */
export type MutantVerdict = "pass" | "fail" | "invalid";

/**
 * Applies each mutant in turn, asks `hiddenTests` how the hidden tests fare,
 * and restores the file. Mutants that break the syntax are left out of the
 * score. Stops starting new mutants once `budgetMs` is spent.
 */
export function runMutants(repoDir: string, mutants: Mutant[], hiddenTests: () => MutantVerdict, budgetMs = 60_000): MutationReport {
  const started = Date.now();
  const results: MutationReport["mutants"] = [];
  let invalid = 0;
  for (const m of mutants) {
    if (Date.now() - started > budgetMs) break;
    const path = join(repoDir, m.file);
    const original = readFileSync(path, "utf8");
    const lines = original.split("\n");
    if (lines[m.line - 1] === undefined) continue;
    lines[m.line - 1] = m.mutated;
    writeFileSync(path, lines.join("\n"));
    try {
      const verdict = hiddenTests();
      if (verdict !== "invalid") results.push({ where: `${m.file}:${m.line}`, change: m.change, killed: verdict === "fail" });
      else invalid++;
    } finally {
      writeFileSync(path, original);
    }
  }
  return {
    mutants: results,
    killed: results.filter((r) => r.killed).length,
    total: results.length,
    skipped: mutants.length - results.length - invalid,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
