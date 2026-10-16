// Rules the containers apply to their own results: is the plan usable, did
// the gate pass, what does the implementer need to hear when it did not.
import type { AnalystOutput, AuthorCriterion, GateReport, PublicPlan, RepoConfig } from "@mork/contracts";

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** The author owns text and IDs. The model supplies only the verification mapping. */
export function bindAuthorCriteria<T extends PublicPlan>(plan: T, author: AuthorCriterion[]): T {
  if (!author.length) return plan;
  return {
    ...plan,
    acceptance_criteria: plan.acceptance_criteria.map((criterion) => {
      const original = author.find((item) => item.id === criterion.id);
      return original ? { ...criterion, text: original.text } : criterion;
    }),
  };
}

export function checkPlan(plan: PublicPlan, config: RepoConfig, author: AuthorCriterion[] = []): string | undefined {
  if (author.length) {
    const changed =
      plan.acceptance_criteria.length !== author.length ||
      author.some((a) => !plan.acceptance_criteria.some((c) => c.id === a.id && sameText(c.text, a.text)));
    if (changed)
      return `Return exactly the author's acceptance criteria, same ids and text, and decide only which are testable:\n${author.map((c) => `- ${c.id}: ${c.text}`).join("\n")}\nPut any other check you think is needed in proposed_criteria.`;
    const downgraded = plan.acceptance_criteria.filter((c) => !c.testable && !/^\[evidence\]\s/i.test(author.find((a) => a.id === c.id)?.text ?? ""));
    if (downgraded.length)
      return `Authored criteria require runtime verification: ${downgraded.map((c) => c.id).join(", ")}. Write executable checks. Only an author's explicit [evidence] annotation permits evidence-only verification; do not add that annotation yourself.`;
  }
  const ids = plan.acceptance_criteria.map((c) => c.id);
  if (new Set(ids).size !== ids.length) return "Acceptance criterion IDs must be unique";
  const unknown = plan.hidden_tests.flatMap((test) => test.criteria).filter((id) => !ids.includes(id));
  if (unknown.length) return `Hidden tests reference unknown criteria: ${[...new Set(unknown)].join(", ")}`;
  const covered = new Set(plan.hidden_tests.flatMap((t) => t.criteria));
  const uncovered = plan.acceptance_criteria.filter((c) => c.testable && !covered.has(c.id)).map((c) => c.id);
  if (uncovered.length) return `Testable criteria without a hidden test: ${uncovered.join(", ")}. Write one for each.`;
  const badNames = plan.hidden_tests
    .filter((t) => !t.file.endsWith(config.hidden_tests.file_suffix) || t.file.includes("/") || t.file.startsWith("."))
    .map((t) => t.file);
  if (badNames.length) return `Hidden test files must be plain file names ending with ${config.hidden_tests.file_suffix}: ${badNames.join(", ")}`;
  const names = plan.hidden_tests.map((t) => t.file);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length) return `Hidden test file names must be unique, each test in its own file: ${[...new Set(duplicates)].join(", ")}`;
  return undefined;
}

const failedChecks = (gate: GateReport) => (gate.checks ?? []).filter((c) => c.exit_code !== 0);

/** One short line per reason the gate failed, for a chat thread. */
export function gateFailures(gate: GateReport): string[] {
  const lines: string[] = [];
  if (gate.setup && gate.setup.exit_code !== 0) lines.push(`setup failed: \`${gate.setup.command}\``);
  if (gate.repo_tests && gate.repo_tests.exit_code !== 0) lines.push(`repository tests failed: \`${gate.repo_tests.command}\``);
  for (const check of failedChecks(gate)) lines.push(`check failed: \`${check.command}\``);
  for (const hidden of gate.hidden.filter((h) => !h.passed))
    lines.push(
      hidden.status && hidden.status !== "behavior_failure"
        ? `verification ${hidden.status}: ${hidden.criteria.join(", ")} remain unverified`
        : `${hidden.criteria.join(", ")} not met`,
    );
  for (const violation of gate.diff_policy?.violations ?? []) lines.push(`policy: ${violation}`);
  return lines;
}

export function gatePassed(gate: GateReport): boolean {
  return (
    (gate.setup?.exit_code ?? 0) === 0 &&
    gate.repo_tests?.exit_code === 0 &&
    failedChecks(gate).length === 0 &&
    gate.hidden.every((h) => h.passed && (!h.status || h.status === "pass")) &&
    (gate.diff_policy?.violations.length ?? 0) === 0
  );
}

/** Feedback for a failed gate. Shows what failed, never the hidden test source. */
export function gateFeedback(gate: GateReport, plan: Pick<AnalystOutput, "acceptance_criteria">, options: { oracle?: boolean } = {}): string {
  const lines: string[] = [];
  if (gate.setup && gate.setup.exit_code !== 0)
    lines.push(`- Setup failed (\`${gate.setup.command}\`):\n\n\`\`\`\n${gate.setup.output.slice(-1500)}\n\`\`\``);
  if (gate.repo_tests && gate.repo_tests.exit_code !== 0) {
    lines.push(`- Repository tests failed (\`${gate.repo_tests.command}\`):\n\n\`\`\`\n${gate.repo_tests.output.slice(-2000)}\n\`\`\``);
  }
  for (const check of failedChecks(gate)) {
    lines.push(`- Check failed (\`${check.command}\`):\n\n\`\`\`\n${check.output.slice(-1500)}\n\`\`\``);
  }
  for (const hidden of gate.hidden.filter((h) => !h.passed)) {
    const text = hidden.criteria.map((id) => `${id}: ${plan.acceptance_criteria.find((c) => c.id === id)?.text ?? ""}`).join("; ");
    const verdict =
      hidden.status && hidden.status !== "behavior_failure"
        ? `Verification runtime ${hidden.status}: ${options.oracle ? (hidden.reason ?? "no valid behavior evidence") : "Plan-owned verification repair required"}. Criteria remain unverified: ${text}`
        : `Acceptance criterion not met: ${text}`;
    if (!options.oracle) {
      lines.push(`- ${verdict}`);
      continue;
    }
    lines.push(`- ${verdict}. Test output tail:\n\n\`\`\`\n${hidden.output.slice(-1200)}\n\`\`\``);
    if (hidden.artifact) lines.push(`Full diagnostic: ${hidden.artifact}`);
  }
  for (const step of [gate.setup, gate.repo_tests, ...(gate.checks ?? [])])
    if (step?.artifact) lines.push(`Full diagnostic for ${step.command_id}: ${step.artifact}`);
  for (const violation of gate.diff_policy?.violations ?? []) lines.push(`- Policy violation: ${violation}. Revert that part.`);
  return `# The attempt did not pass the gate\n\n${lines.join("\n")}`;
}
