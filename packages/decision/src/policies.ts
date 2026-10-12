// The three places the decision model is asked something besides the final
// recommendation. Each policy is a fixed question set plus a pure function
// from answers to an action; the code, not the model, owns the thresholds and
// every `undecided` answer lands on the safe side.
import type { Answer, DecisionPanel, DecisionTrace, Question } from "./core.ts";

const probability = (answer: Answer | undefined): number | undefined => (answer?.type === "noul" ? answer.p : undefined);

// ---------------------------------------------------------------- triage

export const TRIAGE_QUESTIONS = {
  actionable: {
    type: "noul",
    instructions:
      "Is this issue specific enough that an engineer could implement it and check it is done without asking the author anything? Missing expected behaviour, conflicting requirements or an unclear scope mean no.",
  },
  kind: {
    type: "choice",
    instructions: "What kind of change does this issue ask for?",
    options: {
      feature: "New behaviour",
      bug: "Fix of wrong behaviour",
      docs: "Documentation or wording only",
      refactor: "Restructure without changing behaviour",
      security: "Authentication, authorization, secrets, cryptography or input validation",
      other: "Anything else",
    },
  },
} satisfies Record<string, Question>;

/** Asked first about a raw chat message, before any Jira issue exists for it. */
export const REQUEST_QUESTIONS = {
  is_request: {
    type: "noul",
    instructions:
      "Is this chat message asking for a change to software: a new feature, a fix, a refactor, tests or documentation? Greetings, thanks, small talk, questions about status or about something else, and requests that are not about software mean no.",
  },
} satisfies Record<string, Question>;

/** Ask for clarification only when the model is confident the issue is unclear; doubt proceeds, because the end of the pipeline is a human anyway. */
export const CLARIFY_BELOW = 0.2;
/** Ignore a message only when the model is confident it asks for nothing; doubt goes on to triage. */
export const NOT_A_REQUEST_BELOW = 0.2;
export const SECURITY_CONFIDENCE = 0.8;

export type Triage = { route: "proceed" | "clarify" | "ignore"; security: boolean; reasons: string[] };

export function triageFrom(answers: Record<string, Answer>): Triage {
  const reasons: string[] = [];
  const request = probability(answers.is_request);
  if (request !== undefined && request <= NOT_A_REQUEST_BELOW) {
    return { route: "ignore", security: false, reasons: [`Not a request for a change (p=${request.toFixed(2)})`] };
  }
  const p = probability(answers.actionable);
  const route = p !== undefined && p <= CLARIFY_BELOW ? "clarify" : "proceed";
  if (route === "clarify") reasons.push(`The issue is unclear (p=${p?.toFixed(2)})`);
  const kind = answers.kind;
  const security = kind?.type === "choice" && kind.choice === "security" && kind.confidence >= SECURITY_CONFIDENCE;
  if (security) reasons.push(`Triage: security change (confidence ${kind.confidence.toFixed(2)})`);
  return { route, security, reasons };
}

export async function triage(panel: DecisionPanel, issue: { title: string; body: string }): Promise<{ triage: Triage; trace: DecisionTrace }> {
  const { answers, trace } = await panel.decide({ issue: { title: issue.title, body: issue.body.slice(0, 12_000) } }, TRIAGE_QUESTIONS);
  return { triage: triageFrom(answers), trace };
}

/**
 * Triage of a chat message as written, before anything is drafted from it:
 * is it a request at all, is it clear, is it security. Deciding on the raw
 * text keeps a drafting model from turning a greeting into a plausible task.
 */
export async function triageMessage(panel: DecisionPanel, message: string): Promise<{ triage: Triage; trace: DecisionTrace }> {
  const { answers, trace } = await panel.decide({ message: message.slice(0, 12_000) }, { ...REQUEST_QUESTIONS, ...TRIAGE_QUESTIONS });
  return { triage: triageFrom(answers), trace };
}

// ------------------------------------------- criteria a test cannot decide
// jev-proof pattern: one yes/no question per criterion, judged only from the
// evidence the reviewer quoted. No evidence never passes; doubt is REVIEW.

export const PASS_AT = 0.8;
export const FAIL_AT = 0.2;

export type CriterionEvidence = { id: string; text: string; evidence: { where: string; quote: string }[] };
export type CriterionVerdict = { id: string; verdict: "pass" | "fail" | "review"; p?: number; reason: string };

export function criterionVerdict(c: CriterionEvidence, answer: Answer | undefined): CriterionVerdict {
  if (!c.evidence.length) return { id: c.id, verdict: "review", reason: "no evidence" };
  const p = probability(answer);
  if (p === undefined) return { id: c.id, verdict: "review", reason: answer?.type === "undecided" ? answer.reason : "no answer" };
  if (p >= PASS_AT) return { id: c.id, verdict: "pass", p, reason: `p=${p.toFixed(2)}` };
  if (p <= FAIL_AT) return { id: c.id, verdict: "fail", p, reason: `p=${p.toFixed(2)}` };
  return { id: c.id, verdict: "review", p, reason: `unsure, p=${p.toFixed(2)}` };
}

export async function judgeCriteria(
  panel: DecisionPanel,
  criteria: CriterionEvidence[],
): Promise<{ verdicts: CriterionVerdict[]; trace?: DecisionTrace }> {
  const asked = criteria.filter((c) => c.evidence.length);
  if (!asked.length) return { verdicts: criteria.map((c) => criterionVerdict(c, undefined)) };
  const questions: Record<string, Question> = Object.fromEntries(
    asked.map((c) => [
      c.id,
      {
        type: "noul",
        instructions: `Does the change satisfy acceptance criterion ${c.id}: "${c.text}"? Judge only from the evidence listed under ${c.id}; if it does not show the criterion is met, answer no.`,
      },
    ]),
  );
  const state = { evidence: Object.fromEntries(asked.map((c) => [c.id, { criterion: c.text, quotes: c.evidence.slice(0, 8) }])) };
  const { answers, trace } = await panel.decide(state, questions);
  return { verdicts: criteria.map((c) => criterionVerdict(c, answers[c.id])), trace };
}

// ------------------------------------------------ implementer supervision
// thruwire/foreman pattern: score the run, steer once with a message the code
// writes, then stop if the problem is still there after a grace period.

export const SUPERVISION_QUESTIONS = {
  worker_stuck: {
    type: "noul",
    instructions: "Is the coding agent stuck: repeating the same commands or failing the same way without changing its approach?",
  },
  work_off_track: {
    type: "noul",
    instructions: "Is the coding agent working on something the task does not ask for?",
  },
  meaningful_progress: {
    type: "noul",
    instructions: "Has the coding agent made meaningful progress toward the task since the previous check?",
  },
} satisfies Record<string, Question>;

export const PROBLEM_AT = 0.8;
export const NO_PROGRESS_BELOW = 0.2;
export const STEER_GRACE_MS = 30_000;

export type Supervision = { steeredAt?: number };
export type SupervisionAction = { action: "continue" } | { action: "steer"; message: string; signals: string[] } | { action: "stop"; reason: string };

const STEER_TEXT: Record<string, string> = {
  worker_stuck: "You are repeating the same steps without progress. Stop, re-read the failing output, and try a different approach.",
  work_off_track: "You are working on something the task does not ask for. Re-read the task and acceptance criteria and work only on them.",
  meaningful_progress: "There has been no progress since the last check. Pick the next acceptance criterion and make a concrete change toward it.",
};

export function problemSignals(answers: Record<string, Answer>): string[] {
  const signals: string[] = [];
  const stuck = probability(answers.worker_stuck);
  const off = probability(answers.work_off_track);
  const progress = probability(answers.meaningful_progress);
  if (stuck !== undefined && stuck >= PROBLEM_AT) signals.push("worker_stuck");
  if (off !== undefined && off >= PROBLEM_AT) signals.push("work_off_track");
  if (progress !== undefined && progress <= NO_PROGRESS_BELOW) signals.push("meaningful_progress");
  return signals;
}

export function supervise(answers: Record<string, Answer>, state: Supervision, now: number): SupervisionAction {
  const signals = problemSignals(answers);
  if (!signals.length) return { action: "continue" };
  if (state.steeredAt === undefined) {
    return { action: "steer", signals, message: signals.map((s) => STEER_TEXT[s]).join("\n") };
  }
  if (now - state.steeredAt < STEER_GRACE_MS) return { action: "continue" };
  return { action: "stop", reason: `Supervisor: the problem persists after steering (${signals.join(", ")})` };
}
