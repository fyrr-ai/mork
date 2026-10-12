// Contracts shared by the Lambdas and the phase containers. Everything that
// crosses a process boundary is parsed with these schemas at the boundary.
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export const BRANCH_PREFIX = "mork/";

/** Conservative branch-name subset; nothing outside it reaches a git command line. */
export const BRANCH_PATTERN = /^mork\/[a-z0-9][a-z0-9._-]{0,80}$/;

// ---------------------------------------------------------------------------
// Repository configuration: `.mork/config.toml`, always read from the
// default branch, never from the agent's branch.

export const RepoConfig = z.object({
  setup: z.string().optional(),
  test: z.string().min(1),
  /**
   * Further commands that must pass, e.g. lint or typecheck. The implementer's
   * `verify` tool and the gate both run them, after `test`.
   */
  checks: z.array(z.string().min(1)).default([]),
  hidden_tests: z.object({
    /** Directory (relative to the repo root) the gate copies hidden tests into. */
    dir: z.string().min(1),
    /** Command that runs ONE hidden test file; `{file}` is replaced by its path. */
    command: z.string().includes("{file}"),
    /** Glob-free file-name hint the analyst must follow, e.g. `*.test.mjs`. */
    file_suffix: z.string().min(1),
  }),
  /** Paths whose change sends the task to a human regardless of anything else. */
  protected_paths: z.array(z.string()).default([]),
  /** Files that count as tests for the diff policy (prefix match). */
  test_paths: z.array(z.string()).default(["test/", "tests/"]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export function parseRepoConfig(toml: string): RepoConfig {
  return RepoConfig.parse(parseToml(toml));
}

/** Platform minimum: projects may tighten these, never loosen them. */
export const PLATFORM_PROTECTED_PATHS = [".mork/", ".github/", ".pi/"];

// ---------------------------------------------------------------------------
// Station outputs.

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC\d+$/),
  text: z.string().min(1),
  /** True when a hidden test can decide it; false for docs, wording, readability. */
  testable: z.boolean(),
});

export const HiddenTest = z.object({
  /** File name only; the gate places it under `hidden_tests.dir`. */
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  criteria: z.array(z.string().regex(/^AC\d+$/)).min(1),
  content: z.string().min(1).max(20_000),
});

export type HiddenTest = z.infer<typeof HiddenTest>;

export const AnalystOutput = z.object({
  problem: z.string().min(1),
  plan: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(AcceptanceCriterion).min(1),
  hidden_tests: z.array(HiddenTest),
  risks: z.array(z.string()),
  /** The analyst's own read on whether the change touches security-sensitive code. */
  security_sensitive: z.boolean(),
});
export type AnalystOutput = z.infer<typeof AnalystOutput>;

export const ImplementerOutput = z.object({
  summary: z.string().min(1),
  changes: z.array(z.object({ path: z.string(), change: z.string() })),
  verification: z.array(z.object({ command: z.string(), result: z.string() })),
  deviations: z.array(z.string()),
});
export type ImplementerOutput = z.infer<typeof ImplementerOutput>;

export const ReviewerOutput = z.object({
  summary: z.string().min(1),
  /** Judgments for criteria a test cannot decide. */
  criteria: z.array(
    z.object({
      id: z.string().regex(/^AC\d+$/),
      pass: z.boolean(),
      /** Exact quotes from the diff or files; the decision model judges the criterion only from these. */
      evidence: z.array(z.object({ where: z.string().min(1), quote: z.string().min(1) })),
    }),
  ),
  findings: z.array(
    z.object({
      severity: z.enum(["P0", "P1", "P2"]),
      where: z.string(),
      what: z.string(),
    }),
  ),
  /** Hunks a human should read first, as `path:line` strings. */
  read_first: z.array(z.string()),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

export const StationOutput = {
  analyst: AnalystOutput,
  implementer: ImplementerOutput,
  reviewer: ReviewerOutput,
} as const;
export type LlmStation = keyof typeof StationOutput;

// ---------------------------------------------------------------------------
// Gate report: produced by the LLM-free gate container.

export const CommandResult = z.object({
  command: z.string(),
  exit_code: z.number().int(),
  /** Tail of combined output, bounded. */
  output: z.string(),
});

export const GateReport = z.object({
  mode: z.enum(["before", "after"]),
  /** After mode: the commit of the pushed branch the gate judged. */
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  setup: CommandResult.optional(),
  repo_tests: CommandResult.optional(),
  /** After mode: the repository's `checks` (lint, typecheck…), in config order. */
  checks: z.array(CommandResult).optional(),
  hidden: z.array(z.object({ file: z.string(), criteria: z.array(z.string()), passed: z.boolean(), output: z.string() })),
  diff_policy: z
    .object({
      violations: z.array(z.string()),
      changed_files: z.array(z.string()),
      protected_hits: z.array(z.string()),
      /** Not violations, but a human should know (e.g. the test command changed). */
      flags: z.array(z.string()).default([]),
      added_lines: z.number().int(),
      removed_lines: z.number().int(),
    })
    .optional(),
  /** After mode, when the hidden tests pass: how many deliberate bugs on the added lines they catch. A metric, not a gate. */
  mutation: z
    .object({
      mutants: z.array(z.object({ where: z.string(), change: z.string(), killed: z.boolean() })),
      killed: z.number().int(),
      total: z.number().int(),
      skipped: z.number().int(),
      seconds: z.number(),
    })
    .optional(),
});
export type GateReport = z.infer<typeof GateReport>;

// ---------------------------------------------------------------------------
// What Step Functions hands a phase container for one run.

export const RepoRef = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().min(1),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export type RepoRef = z.infer<typeof RepoRef>;

/** Containers per task: Plan (analyst + gate before), Build (implementer), Check (gate after + reviewer). */
export const Phase = z.enum(["plan", "build", "check"]);
export type Phase = z.infer<typeof Phase>;

export const MAX_ANALYST_ATTEMPTS = 2;
export const MAX_BUILD_ATTEMPTS = 3;
/** After the PR: fix runs per PR (red CI, requested changes, @mork), and build attempts inside one. */
export const MAX_FIX_ROUNDS = 2;
export const MAX_FIX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// The Mork bucket holds outputs only, at keys fixed by convention, so
// Step Functions passes nothing but the brief.

export const keys = {
  issue: (prefix: string) => `${prefix}/issue.json`,
  /** The plan as Build and Check read it: hidden test content stripped. */
  plan: (prefix: string) => `${prefix}/plan.json`,
  /** Only the Plan and Check roles may touch this prefix. */
  hidden: (prefix: string) => `${prefix}/hidden/tests.json`,
  gateBefore: (prefix: string) => `${prefix}/plan/gate-before.json`,
  impl: (prefix: string, attempt: number) => `${prefix}/build/${attempt}/output.json`,
  /** How build attempt `attempt` ended: the pushed commit, or why there is none. */
  buildResult: (prefix: string, attempt: number) => `${prefix}/build/${attempt}/result.json`,
  /** Feedback for build attempt `attempt`, written by whoever sent the work back. */
  feedback: (prefix: string, attempt: number) => `${prefix}/build/${attempt}/feedback.md`,
  gate: (prefix: string, attempt: number) => `${prefix}/check/${attempt}/gate.json`,
  review: (prefix: string, attempt: number) => `${prefix}/check/${attempt}/review.json`,
  /** What the supervisor asked and did while the phase's LLM station ran. */
  supervision: (prefix: string, phase: Phase, attempt: number) => `${prefix}/${phase}/${attempt}/supervision.json`,
  /** A station's saved agent session (`.jsonl`, secrets redacted) and its HTML export (`.html`). */
  session: (prefix: string, label: string) => `${prefix}/sessions/${label}`,
  /** Which station session waits for an answer, so the rerun continues it. */
  pendingSession: (prefix: string) => `${prefix}/sessions/pending.json`,
  /** Questions the requester answered, oldest first; written by the Slack intake. */
  answers: (prefix: string) => `${prefix}/answers.json`,
  /** The draft PR of the task and the flow state behind it, so a fix run after CI or review can continue it. */
  pr: (prefix: string) => `${prefix}/pr.json`,
  /** Created once per fix round with a conditional write: the fix run that creates it owns the round. */
  fixClaim: (prefix: string, round: number) => `${prefix}/fix/${round}.json`,
};

/**
 * The small piece of state Step Functions hands a container in its
 * environment. The phase itself comes from the task definition.
 */
/** Slack thread a task reports into; the same shape as @mork/sources' SlackRef. */
export const SlackThread = z.object({
  kind: z.literal("slack"),
  channel: z.string(),
  thread_ts: z.string(),
  user: z.string(),
});

export const Brief = z.object({
  /** Build attempt this run belongs to (Plan uses 1). */
  attempt: z.number().int().positive(),
  /** Object key prefix of this task in the Mork bucket. */
  prefix: z.string().regex(/^tasks\/[A-Za-z0-9._/-]+$/),
  repo: RepoRef,
  branch: z.string().regex(BRANCH_PATTERN),
  /** Slack tasks: the containers post their progress into this thread. */
  report: SlackThread.optional(),
  /** Step Functions execution name and tracker reference (PROJ-123, owner/repo#12), for the live log. */
  execution: z.string().optional(),
  task: z.string().optional(),
  /** Last build attempt this run may use; fix runs after the PR continue the numbering with their own budget. */
  last_attempt: z.number().int().positive().optional(),
});
export type Brief = z.infer<typeof Brief>;

export function lastAttempt(brief: Pick<Brief, "last_attempt">): number {
  return brief.last_attempt ?? MAX_BUILD_ATTEMPTS;
}

/** The plan as other stations see it: hidden test content stripped. */
export const PublicPlan = AnalystOutput.extend({
  hidden_tests: z.array(HiddenTest.pick({ file: true, criteria: true })),
});
export type PublicPlan = z.infer<typeof PublicPlan>;

/** The task as stations read it; `ref` is the tracker reference (`#12` on GitHub, `PROJ-123` in Jira). */
export const IssueDoc = z.object({ ref: z.string().min(1), title: z.string(), body: z.string().nullable() });
export type IssueDoc = z.infer<typeof IssueDoc>;

const Stats = z.object({ turns: z.number().int(), tokens: z.number().int().optional(), cost: z.number().optional() });

/** What a container reports with SendTaskSuccess. Outputs are at their conventional keys. */
/** A question a station or triage asked and the requester's answer. */
export const Answer = z.object({
  question: z.string(),
  answer: z.string(),
  by: z.string().optional(),
  resume: z.string().optional(),
  at: z.string().optional(),
});
export const Answers = z.array(Answer);
export type Answers = z.infer<typeof Answers>;
/** Questions per task; one more hands the task to a person. */
export const MAX_QUESTIONS = 3;

/** Written by Build, read by Check: the implementer pushes the branch itself. */
export const BuildResult = z.union([
  z.object({ ok: z.literal(true), head_sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type BuildResult = z.infer<typeof BuildResult>;

export const RunResult = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  /** Check only: whether the gate passed and the reviewer ran. */
  passed: z.boolean().optional(),
  /** The station asked the requester something; the workflow waits for the answer, then reruns `resume`. */
  question: z.string().min(1).optional(),
  resume: z.enum(["plan", "build", "check"]).optional(),
  stats: z.array(Stats.extend({ station: z.string() })).optional(),
});
export type RunResult = z.infer<typeof RunResult>;

/** Error a container or step raises when the task goes to a person. */
export const HANDOVER_ERROR = "Handover";
/** A station container stopped before it finished (Fargate Spot reclaim, StopTask); Step Functions retries the phase. */
export const INTERRUPTED_ERROR = "Mork.Interrupted";

// ---------------------------------------------------------------------------
// Recommendation for the human.

export const ReviewLevel = z.enum(["quick", "careful", "takeover"]);
export type ReviewLevel = z.infer<typeof ReviewLevel>;

const LEVEL_ORDER: Record<ReviewLevel, number> = { quick: 0, careful: 1, takeover: 2 };

/** Hard rules only raise the level; this keeps that rule in one place. */
export function raiseLevel(a: ReviewLevel, b: ReviewLevel): ReviewLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Timeline: append-only events, written as JSON lines to stdout (CloudWatch).

export type TimelineEvent = {
  ts: string;
  task: string;
  kind: string;
  detail?: Record<string, unknown>;
};
