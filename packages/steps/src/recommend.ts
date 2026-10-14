// The recommendation a human gets with the finished work. Hard rules decide
// first and can only raise the level; a confident decision model sets the
// level, never below what the rules require, and an unsure one leaves careful.
import { type GateReport, type PublicPlan, type Review, type ReviewLevel, raiseLevel } from "@mork/contracts";
import { boundEvidence, type CriterionVerdict, type DecisionPanel, type DecisionTrace, type Priority } from "@mork/decision";

export const QUICK_THRESHOLD = 0.8;
export const LARGE_DIFF_LINES = 1000;

export type Recommendation = { level: ReviewLevel; reasons: string[]; decidedBy: string };

export const LEVEL_QUESTION = {
  level: {
    type: "choice",
    instructions: "How much attention should a human reviewer give this change before merging? It already passed its tests and an automated review.",
    options: {
      quick: "A quick look is enough: small, low-risk change, clean review",
      careful: "Read it carefully: non-trivial logic, moderate risk or reviewer concerns",
      takeover: "A human should take the task over: risky or likely wrong",
    },
  },
} as const;

export async function recommend(input: {
  plan: PublicPlan;
  gate: GateReport;
  review: Review;
  /** Decision-model verdicts for the criteria tests cannot decide. */
  criteria: CriterionVerdict[];
  /** Triage classified the issue as a security change. */
  securityTriage: boolean;
  /** Each review finding's priority, in the order of `review.findings`. */
  priorities: Priority[];
  panel: DecisionPanel;
}): Promise<{ rec: Recommendation; trace?: DecisionTrace }> {
  const { plan, gate, review, criteria } = input;
  const reasons: string[] = [];
  const state = { floor: "quick" as ReviewLevel };
  const hit = (level: ReviewLevel, reason: string) => {
    state.floor = raiseLevel(state.floor, level);
    reasons.push(reason);
  };

  const protectedHits = gate.diff_policy?.protected_hits ?? [];
  if (protectedHits.length) hit("takeover", `Changes protected paths: ${protectedHits.join(", ")}`);
  if (plan.security_sensitive) hit("takeover", "The analyst marked the change as security-sensitive");
  if (input.securityTriage) hit("takeover", "Triage classified the issue as a security change");
  const failedJudgments = review.criteria.filter((c) => !c.pass);
  if (failedJudgments.length) hit("careful", `The reviewer did not confirm ${failedJudgments.map((c) => c.id).join(", ")}`);
  for (const v of criteria) {
    if (v.verdict === "fail") hit("careful", `Decision model: ${v.id} not met (${v.reason})`);
    if (v.verdict === "review") hit("careful", `${v.id} unconfirmed (${v.reason})`);
  }
  if (review.unreviewed_files.length) hit("careful", `The reviewer did not read ${review.unreviewed_files.length} changed file(s)`);
  // A finding's priority, not the reviewer's severity, decides: reviewers often call a P1 or a non-issue P0.
  const mustFix = review.findings.filter((_, index) => input.priorities[index]?.fix);
  if (mustFix.length) hit("careful", `${mustFix.length} finding(s) should be fixed before merge: ${mustFix.map((f) => f.where).join(", ")}`);
  for (const flag of gate.diff_policy?.flags ?? []) hit("careful", `Gate: ${flag}`);
  const size = (gate.diff_policy?.added_lines ?? 0) + (gate.diff_policy?.removed_lines ?? 0);
  if (size > LARGE_DIFF_LINES) hit("careful", `Large diff (${size} lines)`);

  const floor = state.floor;
  if (floor === "takeover") return { rec: { level: floor, reasons, decidedBy: "rules" } };

  const { answers, trace } = await input.panel.decide(
    boundEvidence({
      acceptance_criteria: plan.acceptance_criteria,
      hidden_tests: gate.hidden.map((h) => ({ criteria: h.criteria, passed: h.passed })),
      untestable_criteria: criteria.map(({ id, verdict }) => ({ id, verdict })),
      repo_tests_passed: gate.repo_tests?.exit_code === 0,
      changed_files: gate.diff_policy?.changed_files,
      diff_size: size,
      review_summary: review.summary,
      findings: review.findings,
    }),
    LEVEL_QUESTION,
  );
  const answer = answers.level;
  if (answer?.type === "choice" && answer.confidence >= QUICK_THRESHOLD) {
    const level = raiseLevel(floor, answer.choice as ReviewLevel);
    reasons.push(`Decision model (${trace.used}): ${answer.choice} with confidence ${answer.confidence.toFixed(2)}`);
    return { rec: { level, reasons, decidedBy: trace.used }, trace };
  }
  reasons.push(
    answer?.type === "undecided"
      ? `The decision model did not decide (${answer.reason}); the safe default applies`
      : `The decision model was unsure (${answer?.type === "choice" ? `${answer.choice} ${answer.confidence.toFixed(2)}` : "?"}); the safe default applies`,
  );
  return { rec: { level: raiseLevel(floor, "careful"), reasons, decidedBy: "default" }, trace };
}
