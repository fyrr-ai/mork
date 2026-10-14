// What every source hands Mork, and what Mork tells it back.
// A source turns its webhook into a StartInput; Start resolves it into a tracker issue
// and reports progress through the source's Reporter.
import { SlackRef } from "@mork/contracts/workflow";
import { z } from "zod";

export { SlackRef } from "@mork/contracts/workflow";

/** Execution input for a task that came from Slack. */
export const SlackStart = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  source: z.literal("slack"),
  ref: SlackRef,
  /** The request as written, mention stripped. */
  ask: z.string().min(1),
  /** Jira project new issues go to. */
  jira_project: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  /** Components set on a new issue; some projects require one. */
  jira_components: z.array(z.string().min(1)).default([]),
});
export type SlackStart = z.input<typeof SlackStart>;

/** The request in its tracker: an existing Jira issue, or one created for it. */
export type TrackerIssue = { key: string; title: string; body: string; url: string; created: boolean };

/**
 * Short state changes a source shows to the people who asked, sent as they
 * happen: Start reports started/clarify, each container reports its own
 * phase, Decide and Handover report the outcome.
 */
export type ReportEvent =
  | { kind: "started"; work: TrackerIssue; execution_url?: string; live_url?: string }
  | { kind: "clarify"; questions: string }
  | { kind: "not_a_request" }
  | { kind: "question"; text: string }
  | { kind: "answered"; text: string; by: string }
  | { kind: "plan"; criteria: number; hidden_tests?: number }
  | { kind: "build"; attempt: number; max: number }
  | { kind: "built"; attempt: number; branch: string; branch_url?: string; files?: number }
  | { kind: "check"; attempt: number; passed: boolean; failures?: string[] }
  /** The gate passed, but the reviewer found defects Mork fixes before it opens the PR. */
  | { kind: "repair"; attempt: number; findings: string[] }
  | { kind: "pr"; url: string; level: "quick" | "careful"; reasons: string[]; transcripts_url?: string }
  /** Mork stops; `pr_url` is the draft PR it opened for the person who takes over, when the branch had work. */
  | { kind: "handover"; reason: string; pr_url?: string }
  /** After the PR: CI failed or a reviewer asked for changes, and Mork is on it. */
  | { kind: "fix"; pr_url: string; trigger: string; round: number; max: number }
  | { kind: "fixed"; pr_url: string; summary: string };

export interface Reporter {
  report(event: ReportEvent): Promise<void>;
}

export const REVIEW_LEVEL_TEXT = { quick: "a quick look is enough", careful: "review carefully", takeover: "take over" } as const;

/** One-shot completion, e.g. steps' llmFromEnv. */
export type Complete = (system: string, user: string) => Promise<string>;
