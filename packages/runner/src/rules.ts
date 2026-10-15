// Rules the containers apply to their own results: is the plan usable, did
// the gate pass, what does the implementer need to hear when it did not.
import type { AnalystOutput, AuthorCriterion, GateReport, PublicPlan, RepoConfig } from "@mork/contracts";

/** Two lines naming the same id cannot both be the contract; only the author can fix that. */
export function duplicateCriteria(author: AuthorCriterion[]): string[] {
  const ids = author.map((c) => c.id);
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

export function checkPlan(plan: PublicPlan, config: RepoConfig, author: AuthorCriterion[] = []): string | undefined {
  if (author.length) {
    const changed =
      plan.acceptance_criteria.length !== author.length ||
      author.some((a) => !plan.acceptance_criteria.some((c) => c.id === a.id && sameText(c.text, a.text)));
    if (changed)
      return `Return exactly the author's acceptance criteria, same ids and text, and decide only which are testable:\n${author.map((c) => `- ${c.id}: ${c.text}`).join("\n")}\nPut any other check you think is needed in proposed_criteria.`;
  }
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
  for (const hidden of gate.hidden.filter((h) => !h.passed)) lines.push(`${hidden.criteria.join(", ")} not met (${hidden.file})`);
  for (const violation of gate.diff_policy?.violations ?? []) lines.push(`policy: ${violation}`);
  return lines;
}

export function gatePassed(gate: GateReport): boolean {
  return (
    (gate.setup?.exit_code ?? 0) === 0 &&
    gate.repo_tests?.exit_code === 0 &&
    failedChecks(gate).length === 0 &&
    gate.hidden.every((h) => h.passed) &&
    (gate.diff_policy?.violations.length ?? 0) === 0
  );
}

/** Feedback for a failed gate. Shows what failed, never the hidden test source. */
export function gateFeedback(gate: GateReport, plan: Pick<AnalystOutput, "acceptance_criteria">): string {
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
    lines.push(`- Acceptance criterion not met: ${text}. Test output tail:\n\n\`\`\`\n${hidden.output.slice(-1200)}\n\`\`\``);
  }
  for (const violation of gate.diff_policy?.violations ?? []) lines.push(`- Policy violation: ${violation}. Revert that part.`);
  return `# The attempt did not pass the gate\n\n${lines.join("\n")}`;
}
