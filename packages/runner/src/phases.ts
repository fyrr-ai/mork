// The three containers of a task. Each reads the outputs it needs from the
// Mork bucket and writes its own at the conventional keys.
//
// Plan and Check run an LLM station and the LLM-free gate in one container.
// The gate always works in its own fresh clone as the `sandbox` user, and
// every process of the previous user is killed before the next step starts,
// so what ran before cannot reach into what runs next.
import { join } from "node:path";
import {
  AnalystOutput,
  Answers,
  type Brief,
  type BuildResult,
  BuildResult as BuildResultSchema,
  type GateReport,
  HandoverError,
  HiddenTest,
  ImplementerOutput,
  IssueDoc,
  keys,
  type LlmStation,
  lastAttempt,
  type Phase,
  PublicPlan,
  parseRepoConfig,
  type RepoConfig,
  type RunResult,
  StationOutput,
} from "@mork/contracts";
import type { DevelopmentStep } from "@mork/contracts/development";
import type { DecisionPanel } from "@mork/decision";
import type { Reporter } from "@mork/sources";
import type { Store } from "@mork/store";
import { z } from "zod";
import { killUser } from "./agentfs.ts";
import { runGate, type Sandbox } from "./gate.ts";
import { fetchRepo, mustExec, remoteHead, repoUrl, SAFE_GIT } from "./git.ts";
import { type LlmJob, type LlmOutcome, type RunnerEnv, runLlmStation } from "./llm.ts";
import type { Logger } from "./otlp.ts";
import * as prompts from "./prompts.ts";
import { checkPlan, gateFailures, gateFeedback, gatePassed } from "./rules.ts";
import { SessionLog } from "./session.ts";
import { onShutdown } from "./shutdown.ts";
import type { SupervisionRecord } from "./supervisor.ts";

export type PhaseContext = {
  brief: Brief;
  /** Trusted step configuration; local/default callers use the same shipped definition. */
  step: DevelopmentStep;
  store: Store;
  env: RunnerEnv;
  sandbox: Sandbox;
  githubToken: string;
  /** Trusted local workflows fetch and push only this task-owned bare repository. */
  localRepo?: string;
  model: string;
  /** Supervises every LLM station; the keys stay with this process, not with Pi. */
  panel: DecisionPanel;
  superviseEveryMs: number;
  /** Progress for the people who asked (a Slack thread); a no-op for GitHub tasks. Never fails the phase. */
  reporter: Reporter;
  /** Every secret value the container holds, for redacting saved sessions. */
  secrets: () => string[];
  /** Live log (Grafana) with the phase's attributes. */
  logger: Logger;
};

/** The gate's verdict as log lines: every check it ran, failures as errors. */
function logGate(logger: Logger, report: GateReport): void {
  const log = logger.with({ "mork.station": `gate-${report.mode}`, "mork.event": "gate" });
  if (report.setup)
    log.log(
      `gate ${report.mode} · setup ${report.setup.exit_code === 0 ? "ok" : "failed"}: ${report.setup.command}`,
      {},
      report.setup.exit_code === 0 ? "INFO" : "ERROR",
    );
  if (report.repo_tests)
    log.log(
      `gate ${report.mode} · repository tests ${report.repo_tests.exit_code === 0 ? "passed" : "failed"}: ${report.repo_tests.command}`,
      {},
      report.repo_tests.exit_code === 0 ? "INFO" : "ERROR",
    );
  for (const h of report.hidden) {
    // Before the change hidden tests must fail, after it they must pass.
    const good = report.mode === "before" ? !h.passed : h.passed;
    log.log(`gate ${report.mode} · hidden ${h.file} ${h.passed ? "passed" : "failed"} (${h.criteria.join(", ")})`, {}, good ? "INFO" : "ERROR");
  }
  for (const v of report.diff_policy?.violations ?? []) log.log(`gate ${report.mode} · policy: ${v}`, {}, "ERROR");
}

/** Runs a phase and stores what the supervisor asked and did, also when the phase fails. */
async function supervised<T>(ctx: PhaseContext, phase: Phase, run: (records: SupervisionRecord[]) => Promise<T>): Promise<T> {
  const records: SupervisionRecord[] = [];
  try {
    return await run(records);
  } finally {
    if (records.length) await ctx.store.putJson(keys.supervision(ctx.brief.prefix, phase, ctx.brief.attempt), records);
  }
}

type Stats = NonNullable<RunResult["stats"]>;

function checkout(ctx: PhaseContext, name: string, withBranch: boolean): string {
  const dir = join(ctx.env.workDir, name);
  mustExec("rm", ["-rf", dir]);
  fetchRepo({
    dir,
    fullName: ctx.brief.repo.full_name,
    token: ctx.githubToken,
    baseSha: ctx.brief.repo.base_sha,
    branch: withBranch ? ctx.brief.branch : undefined,
    localRepo: ctx.localRepo,
  });
  return dir;
}

/** Repository config always comes from the base commit, never from the agent's branch. */
function baseConfig(dir: string, baseSha: string): RepoConfig {
  return parseRepoConfig(mustExec("git", [...SAFE_GIT, "-C", dir, "show", `${baseSha}:.mork/config.toml`]));
}

async function llm(
  ctx: PhaseContext,
  label: string,
  station: LlmStation,
  repoDir: string,
  message: string,
  stats: Stats,
  records: SupervisionRecord[],
  task: Record<string, unknown>,
  push?: LlmJob["push"],
  verify?: LlmJob["verify"],
): Promise<LlmOutcome> {
  const { prefix } = ctx.brief;
  const answers = Answers.parse(await ctx.store.json(keys.answers(prefix)).catch(() => []));
  const session = new SessionLog({
    file: join(ctx.env.agentHome, "sessions", `${label}.jsonl`),
    key: keys.session(prefix, label),
    store: ctx.store,
    secrets: ctx.secrets(),
    piBin: ctx.env.piBin,
    piEnv: { HOME: ctx.env.workDir, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    staging: join(ctx.env.workDir, "session-export"),
  });
  // A station that stopped to ask continues its own session with the answer;
  // one whose container was interrupted continues where it stopped.
  const pending = (await ctx.store.json(keys.pendingSession(prefix)).catch(() => ({}))) as { label?: string; interrupted?: boolean };
  const answer = answers.at(-1);
  const resumable = pending.label === label && (pending.interrupted === true || answer !== undefined);
  const resumed = resumable && (await session.restore());
  if (resumed) await ctx.store.putJson(keys.pendingSession(prefix), {});
  const offInterrupt = onShutdown(async () => {
    await ctx.store.putJson(keys.pendingSession(prefix), { label, interrupted: true });
  });
  const outcome = await runLlmStation(
    {
      station,
      instructions: ctx.step.instructions,
      tools: ctx.step.tools,
      extensions: ctx.step.extensions,
      message: !resumed
        ? message + prompts.clarifications(answers)
        : pending.interrupted
          ? prompts.INTERRUPTED_PROMPT
          : prompts.answerPrompt(answers.at(-1) as Answers[number]),
      resumed,
      session,
      log: ctx.logger.with({ "mork.station": station }),
      ask: ctx.brief.report !== undefined,
      output_schema: z.toJSONSchema(StationOutput[station]) as Record<string, unknown>,
      model: ctx.step.model ?? ctx.model,
      repo: ctx.brief.repo,
      push,
      verify,
      supervise: { panel: ctx.panel, everyMs: ctx.superviseEveryMs, task },
    },
    ctx.env,
    repoDir,
  );
  offInterrupt();
  killUser(ctx.env.agentUid);
  if (outcome.question) await ctx.store.putJson(keys.pendingSession(prefix), { label });
  if (outcome.stats) stats.push({ station, ...outcome.stats });
  records.push(...(outcome.supervision ?? []));
  return outcome;
}

/** Plan: analyst writes the plan and hidden tests; the gate proves they fail on the base commit. */
export function plan(ctx: PhaseContext): Promise<RunResult> {
  return supervised(ctx, "plan", (records) => planWith(ctx, records));
}

async function planWith(ctx: PhaseContext, records: SupervisionRecord[]): Promise<RunResult> {
  const { brief, store } = ctx;
  const issue = IssueDoc.parse(await store.json(keys.issue(brief.prefix)));
  const stats: Stats = [];
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= ctx.step.attempts; attempt++) {
    const repoDir = checkout(ctx, `analyst-${attempt}`, false);
    const config = baseConfig(repoDir, brief.repo.base_sha);
    const outcome = await llm(ctx, `plan-${attempt}-analyst`, "analyst", repoDir, prompts.analystMessage(issue, config, feedback), stats, records, {
      title: issue.title,
      analyst_attempt: attempt,
    });
    if (outcome.question) return { ok: true, question: outcome.question, resume: "plan", stats };
    const parsed = outcome.ok ? AnalystOutput.safeParse(outcome.output) : undefined;
    if (!parsed?.success) {
      feedback = `The previous attempt failed: ${outcome.error ?? parsed?.error.message ?? "no output"}`;
      continue;
    }
    const full = parsed.data;
    const publicPlan: PublicPlan = { ...full, hidden_tests: full.hidden_tests.map(({ file, criteria }) => ({ file, criteria })) };
    const problem = checkPlan(publicPlan, config);
    if (problem) {
      feedback = problem;
      continue;
    }
    const report = await runGate(
      { mode: "before", repo: brief.repo, config, hidden_tests: full.hidden_tests, allow_test_change: false, localRepo: ctx.localRepo },
      ctx.githubToken,
      join(ctx.env.workDir, `gate-before-${attempt}`),
      ctx.sandbox,
    );
    killUser(ctx.sandbox.uid);
    if (ctx.localRepo) mustExec("chmod", ["-R", "u+rwX", join(ctx.env.workDir, `gate-before-${attempt}`)]);
    mustExec("rm", ["-rf", join(ctx.env.workDir, `gate-before-${attempt}`)]);
    logGate(ctx.logger, report);
    await store.putJson(keys.gateBefore(brief.prefix), report);
    if (report.setup && report.setup.exit_code !== 0)
      throw new HandoverError(`Repository setup failed:\n\n\`\`\`\n${report.setup.output.slice(-1500)}\n\`\`\``);
    const passing = report.hidden.filter((h) => h.passed);
    if (passing.length) {
      feedback = `These hidden tests already PASS on the current code, so they verify nothing: ${passing.map((h) => h.file).join(", ")}. Rewrite them so they fail until the change is implemented.`;
      continue;
    }
    await store.putJson(keys.hidden(brief.prefix), full.hidden_tests);
    await store.putJson(keys.plan(brief.prefix), publicPlan);
    await ctx.reporter.report({ kind: "plan", criteria: publicPlan.acceptance_criteria.length, hidden_tests: full.hidden_tests.length });
    return { ok: true, stats };
  }
  throw new HandoverError(`The analyst did not produce a valid plan with hidden tests. Last problem: ${feedback}`);
}

/** Build: the implementer changes the code and pushes the work branch itself; nothing here sees hidden tests. */
export function build(ctx: PhaseContext): Promise<RunResult> {
  return supervised(ctx, "build", (records) => buildWith(ctx, records));
}

async function buildWith(ctx: PhaseContext, records: SupervisionRecord[]): Promise<RunResult> {
  const { brief, store } = ctx;
  await ctx.reporter.report({ kind: "build", attempt: brief.attempt, max: lastAttempt(brief) });
  const issue = IssueDoc.parse(await store.json(keys.issue(brief.prefix)));
  const thePlan = PublicPlan.parse(await store.json(keys.plan(brief.prefix)));
  const feedback = brief.attempt > 1 ? await store.text(keys.feedback(brief.prefix, brief.attempt)).catch(() => undefined) : undefined;
  const remote = () => remoteHead(brief.repo.full_name, ctx.githubToken, brief.branch, ctx.localRepo);
  // Later attempts continue on what the previous attempt pushed, if it pushed anything.
  const repoDir = checkout(ctx, "implementer", remote() !== undefined);
  const config = baseConfig(repoDir, brief.repo.base_sha);
  const setupMarker = join(ctx.env.agentHome, ".verify-setup-done");
  // Local attempts share a home but get a fresh checkout, so its dependencies
  // must be installed again. Cloud attempts get a fresh container and home.
  if (ctx.localRepo) mustExec("rm", ["-f", setupMarker]);
  mustExec("git", [...SAFE_GIT, "-C", repoDir, "switch", "-q", "-C", brief.branch]);
  mustExec("git", [...SAFE_GIT, "-C", repoDir, "remote", "add", "origin", ctx.localRepo ?? repoUrl(brief.repo.full_name)]);
  const stats: Stats = [];
  const outcome = await llm(
    ctx,
    `build-${brief.attempt}-implementer`,
    "implementer",
    repoDir,
    prompts.implementerMessage(issue, thePlan, config, brief.branch, feedback),
    stats,
    records,
    { title: issue.title, acceptance_criteria: thePlan.acceptance_criteria.map((c) => `${c.id}: ${c.text}`), attempt: brief.attempt },
    { branch: brief.branch, remoteHead: remote },
    {
      repo: brief.repo,
      config: {
        setup: config.setup,
        test: config.test,
        checks: config.checks,
        test_paths: config.test_paths,
        protected_paths: config.protected_paths,
      },
      setupMarker,
    },
  );
  if (outcome.question) return { ok: true, question: outcome.question, resume: "build", stats };
  const result: BuildResult =
    outcome.ok && outcome.headSha ? { ok: true, head_sha: outcome.headSha } : { ok: false, error: outcome.error ?? "no pushed commit" };
  if (outcome.output !== undefined) await store.putJson(keys.impl(brief.prefix, brief.attempt), outcome.output);
  await store.putJson(keys.buildResult(brief.prefix, brief.attempt), result);
  if (result.ok) {
    const output = ImplementerOutput.safeParse(outcome.output);
    await ctx.reporter.report({
      kind: "built",
      attempt: brief.attempt,
      branch: brief.branch,
      branch_url: ctx.localRepo ? `file://${ctx.localRepo}` : `https://github.com/${brief.repo.full_name}/tree/${brief.branch}`,
      files: output.success ? output.data.changes.length : undefined,
    });
  }
  return result.ok ? { ok: true, stats } : { ok: false, error: result.error, stats };
}

/** Check: the gate judges the pushed branch first; only a green gate lets the reviewer run. */
export function check(ctx: PhaseContext): Promise<RunResult> {
  return supervised(ctx, "check", (records) => checkWith(ctx, records));
}

async function checkWith(ctx: PhaseContext, records: SupervisionRecord[]): Promise<RunResult> {
  const { brief, store } = ctx;
  const thePlan = PublicPlan.parse(await store.json(keys.plan(brief.prefix)));
  const built = BuildResultSchema.parse(await store.json(keys.buildResult(brief.prefix, brief.attempt)));
  if (!built.ok) {
    await store.put(
      keys.feedback(brief.prefix, brief.attempt + 1),
      `The previous attempt ended without a pushed commit: ${built.error}`,
      "text/markdown",
    );
    await ctx.reporter.report({ kind: "check", attempt: brief.attempt, passed: false, failures: [`no pushed commit: ${built.error.slice(0, 200)}`] });
    return { ok: true, passed: false };
  }
  const hidden = z.array(HiddenTest).parse(await store.json(keys.hidden(brief.prefix)));
  const configDir = checkout(ctx, "config", false);
  const config = baseConfig(configDir, brief.repo.base_sha);
  const report = await runGate(
    { mode: "after", repo: brief.repo, branch: brief.branch, config, hidden_tests: hidden, allow_test_change: false, localRepo: ctx.localRepo },
    ctx.githubToken,
    join(ctx.env.workDir, "gate-after"),
    ctx.sandbox,
  );
  killUser(ctx.sandbox.uid);
  if (ctx.localRepo) mustExec("chmod", ["-R", "u+rwX", join(ctx.env.workDir, "gate-after")]);
  mustExec("rm", ["-rf", join(ctx.env.workDir, "gate-after")]);
  logGate(ctx.logger, report);
  await store.putJson(keys.gate(brief.prefix, brief.attempt), report);
  if (report.head_sha !== built.head_sha) {
    throw new HandoverError(
      `Branch \`${brief.branch}\` changed after Build: the implementer pushed \`${built.head_sha}\`, the remote has \`${report.head_sha}\`. Someone else pushed to it, so Mork stops here.`,
    );
  }
  if (!gatePassed(report)) {
    await store.put(keys.feedback(brief.prefix, brief.attempt + 1), gateFeedback(report, thePlan), "text/markdown");
    await ctx.reporter.report({ kind: "check", attempt: brief.attempt, passed: false, failures: gateFailures(report) });
    return { ok: true, passed: false };
  }
  await ctx.reporter.report({ kind: "check", attempt: brief.attempt, passed: true });
  const issue = IssueDoc.parse(await store.json(keys.issue(brief.prefix)));
  const impl = ImplementerOutput.parse(await store.json(keys.impl(brief.prefix, brief.attempt)));
  const repoDir = checkout(ctx, "reviewer", true);
  const stats: Stats = [];
  const outcome = await llm(
    ctx,
    `check-${brief.attempt}-reviewer`,
    "reviewer",
    repoDir,
    prompts.reviewerMessage(issue, thePlan, brief.repo.base_sha, report, impl),
    stats,
    records,
    { title: issue.title, reviewing: brief.branch },
  );
  if (outcome.question) return { ok: true, question: outcome.question, resume: "check", stats };
  if (!outcome.ok) throw new HandoverError(`The reviewer failed: ${outcome.error}. Branch \`${brief.branch}\` passed the gate.`);
  await store.putJson(keys.review(brief.prefix, brief.attempt), outcome.output);
  return { ok: true, passed: true, stats };
}
