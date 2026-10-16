// The three containers of a task. Each reads the outputs it needs from the
// Mork bucket and writes its own at the conventional keys.
//
// Plan and Check run an LLM station and the LLM-free gate in one container.
// The gate always works in its own fresh clone as the `sandbox` user, and
// every process of the previous user is killed before the next step starts,
// so what ran before cannot reach into what runs next.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AnalystOutput,
  Answers,
  authorCriteria,
  type Brief,
  type BuildResult,
  BuildResult as BuildResultSchema,
  CriteriaOutput,
  type GateReport,
  GateReport as GateReportSchema,
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
  publicFeedback,
  type RepoConfig,
  Review,
  type RunResult,
  readPublicFeedback,
  StationOutput,
  VerificationOutput,
} from "@mork/contracts";
import type { DevelopmentStep } from "@mork/contracts/development";
import type { DecisionPanel } from "@mork/decision";
import { type Logger, type Reporter, redact } from "@mork/sources";
import type { Store } from "@mork/store";
import { z } from "zod";
import { killUser, writeFresh } from "./agentfs.ts";
import { type CommandDiagnostic, runGate, type Sandbox } from "./gate.ts";
import { fetchRepo, mustExec, remoteHead, repoUrl, SAFE_GIT } from "./git.ts";
import { hydrateInputs } from "./inputs.ts";
import { type LlmJob, type LlmOutcome, type RunnerEnv, runLlmStation } from "./llm.ts";
import { ocrReview, parseOcrResult, runOcr } from "./ocr.ts";
import * as prompts from "./prompts.ts";
import { carryFindings, changedFiles, locateFindings, readAt, verifyCriteria, verifyReview } from "./review.ts";
import { bindAuthorCriteria, checkPlan, gateFailures, gateFeedback, gatePassed } from "./rules.ts";
import { preflightRuntime } from "./runtime.ts";
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
  githubToken: () => Promise<string>;
  referenceToken?: (repo: string) => Promise<string>;
  localReferenceRepositories?: Record<string, string>;
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
    const good = report.mode === "before" ? h.status === "behavior_failure" || h.status === "pass" : h.passed;
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

const diagnosticId = z.string().uuid();
const diagnosticRecord = z.object({
  command_id: diagnosticId,
  command: z.string(),
  cwd: z.string(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  exit_code: z.number().int(),
  output: z.string(),
  output_truncated: z.boolean().optional(),
  source: z.literal("agent_verify").optional(),
});

type DiagnosticAudience = "public" | "oracle";
const storedDiagnostic = diagnosticRecord.extend({ audience: z.enum(["public", "oracle"]) });

function localDiagnostic(ctx: PhaseContext, record: CommandDiagnostic, audience: DiagnosticAudience): string {
  diagnosticId.parse(record.command_id);
  const directory = join(ctx.env.workDir, "diagnostics", audience);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const path = join(directory, `${record.command_id}.json`);
  writeFresh(path, redact(JSON.stringify(record), ctx.secrets()), 0o444);
  return path;
}

function saveDiagnostic(ctx: PhaseContext) {
  return async (record: CommandDiagnostic, audience: DiagnosticAudience = "public"): Promise<string> => {
    // Audience comes from the trusted gate invocation, never a record/model label.
    const safe = { ...diagnosticRecord.parse(JSON.parse(redact(JSON.stringify(record), ctx.secrets()))), audience };
    const directory = `${ctx.brief.prefix}/diagnostics/${audience}`;
    await ctx.store.putJson(`${directory}/${safe.command_id}.json`, safe);
    await ctx.store.updateJson(`${directory}/index-${ctx.brief.attempt}.json`, (current) => {
      const ids = z.array(diagnosticId).parse(current ?? []);
      return [...new Set([...ids, safe.command_id])].slice(-32);
    });
    return localDiagnostic(ctx, safe, audience);
  };
}

/** Legacy indexes and gate artifacts are deliberately not hydration inputs. */
async function diagnosticInputs(ctx: PhaseContext, station: string): Promise<{ prompt: string; roots: string[] }> {
  const directory = join(ctx.env.workDir, "diagnostics");
  // Local phases share a work directory: remove prior oracle material before Build.
  if (station === "implementer") rmSync(directory, { recursive: true, force: true });
  const audiences: DiagnosticAudience[] = station === "analyst" ? ["public", "oracle"] : ["public"];
  const files: { command_id: string; command: string; exit_code: number; artifact: string }[] = [];
  for (const audience of audiences) {
    const remote = `${ctx.brief.prefix}/diagnostics/${audience}`;
    const ids = new Set<string>();
    for (const attempt of new Set([ctx.brief.attempt, Math.max(1, ctx.brief.attempt - 1)])) {
      const index = z.array(diagnosticId).safeParse(await ctx.store.json(`${remote}/index-${attempt}.json`).catch(() => []));
      if (index.success) for (const id of index.data) ids.add(id);
    }
    for (const id of ids) {
      const parsed = storedDiagnostic.safeParse(await ctx.store.json(`${remote}/${id}.json`).catch(() => undefined));
      if (!parsed.success || parsed.data.command_id !== id || parsed.data.audience !== audience) continue;
      const record = parsed.data;
      files.push({
        command_id: id,
        command: redact(record.command, ctx.secrets()),
        exit_code: record.exit_code,
        artifact: localDiagnostic(ctx, record, audience),
      });
    }
  }
  if (!files.length) return { prompt: "", roots: [] };
  const manifest = join(directory, `manifest-${station}-${ctx.brief.attempt}.json`);
  writeFresh(manifest, JSON.stringify(files), 0o444);
  return {
    prompt: `\n\n## Verification diagnostics\nRead ${manifest} for the available redacted command outputs, including earlier causes omitted by inline tails. Use these local files; old container paths in feedback may have expired.\n`,
    roots: [manifest, ...audiences.map((audience) => join(directory, audience))],
  };
}

async function checkout(ctx: PhaseContext, name: string, withBranch: boolean): Promise<string> {
  const dir = join(ctx.env.workDir, name);
  mustExec("rm", ["-rf", dir]);
  fetchRepo({
    dir,
    fullName: ctx.brief.repo.full_name,
    token: await ctx.githubToken(),
    baseSha: ctx.brief.repo.base_sha,
    branch: withBranch ? ctx.brief.branch : undefined,
    localRepo: ctx.localRepo,
  });
  preflightRuntime(dir, ctx.brief.repo.base_sha, ctx.brief.runtime);
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
  validation?: Pick<LlmJob, "transformOutput" | "validateOutput" | "maxCorrections">,
): Promise<LlmOutcome> {
  // Old non-analyst sessions may contain oracle diagnostics; never restore them.
  if (station !== "analyst") label += "-public-v1";
  const { prefix } = ctx.brief;
  const answers = Answers.parse(await ctx.store.json(keys.answers(prefix)).catch(() => []));
  const config = baseConfig(repoDir, ctx.brief.repo.base_sha);
  const inputs = await hydrateInputs({
    directory: join(ctx.env.workDir, "inputs"),
    answers,
    references: config.reference_repositories,
    token:
      ctx.referenceToken ??
      (async () => {
        throw new Error("Reference repository access is not configured");
      }),
    secrets: ctx.secrets,
    localRepositories: ctx.localReferenceRepositories,
  });
  const diagnostics = await diagnosticInputs(ctx, station);
  const session = new SessionLog({
    file: join(ctx.env.agentHome, "sessions", `${label}.jsonl`),
    key: keys.session(prefix, label),
    store: ctx.store,
    secrets: ctx.secrets,
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
      instructions:
        ctx.step.instructions +
        (station === "verifier"
          ? "\nYou are the finding verifier. Assess only supplied findings; never edit files or perform a full review."
          : station === "criteria"
            ? "\nYou check only the supplied acceptance criteria. Never edit files or search for bugs."
            : ""),
      tools:
        station === "verifier" || station === "criteria"
          ? (ctx.step.tools?.filter((tool) => ["read", "grep", "find", "ls"].includes(tool)) ?? ["read", "grep", "find", "ls"])
          : ctx.step.tools,
      extensions: ctx.step.extensions,
      environment:
        station === "verifier" || station === "criteria"
          ? {
              MORK_READ_ROOTS: JSON.stringify([
                repoDir,
                ...inputs.roots,
                ...diagnostics.roots,
                ...(typeof task.baselineDir === "string" ? [task.baselineDir] : []),
              ]),
            }
          : undefined,
      message: !resumed
        ? message + inputs.prompt + diagnostics.prompt
        : pending.interrupted
          ? prompts.INTERRUPTED_PROMPT + inputs.prompt + diagnostics.prompt
          : `The requester answered. Continue this session using the latest answer file and the prior inputs listed in the manifest. End with submit_result.${inputs.prompt}${diagnostics.prompt}`,
      resumed,
      session,
      log: ctx.logger.with({ "mork.station": station }),
      ask: ctx.brief.report !== undefined && (station === "analyst" || station === "implementer"),
      output_schema: z.toJSONSchema(StationOutput[station]) as Record<string, unknown>,
      model: ctx.step.model ?? ctx.model,
      repo: ctx.brief.repo,
      push,
      verify,
      ...(config.setup ? { readiness: { command: config.setup, ...(verify ? { marker: verify.setupMarker } : {}) } } : {}),
      ...validation,
      secrets: ctx.secrets,
      saveDiagnostic: (record) => saveDiagnostic(ctx)(record, station === "analyst" ? "oracle" : "public"),
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
  const author = authorCriteria(issue.body);
  const stats: Stats = [];
  const repoDir = await checkout(ctx, "analyst-1", false);
  const config = baseConfig(repoDir, brief.repo.base_sha);
  let submission = 0;
  let accepted: { full: AnalystOutput; publicPlan: PublicPlan } | undefined;
  const previousPlan = PublicPlan.safeParse(await store.json(keys.plan(brief.prefix)).catch(() => undefined));
  const inputs = Answers.parse(await store.json(keys.answers(brief.prefix)).catch(() => []));
  const repairFeedback = previousPlan.success ? await store.text(keys.feedback(brief.prefix, brief.attempt + 1)).catch(() => undefined) : undefined;
  const validateOutput = async (value: unknown): Promise<string | undefined> => {
    const full = AnalystOutput.parse(value);
    const publicPlan: PublicPlan = { ...full, hidden_tests: full.hidden_tests.map(({ file, criteria }) => ({ file, criteria })) };
    const problem = checkPlan(publicPlan, config, author);
    if (problem) return problem;
    let report: GateReport = { mode: "before", hidden: [] };
    if (full.hidden_tests.length) {
      const gateDir = join(ctx.env.workDir, `gate-before-${++submission}`);
      try {
        report = await runGate(
          {
            mode: "before",
            runtime: brief.runtime,
            repo: brief.repo,
            config,
            hidden_tests: full.hidden_tests,
            allow_test_change: false,
            localRepo: ctx.localRepo,
            secrets: ctx.secrets(),
            saveDiagnostic: saveDiagnostic(ctx),
            contract: { criteria: full.acceptance_criteria, inputs },
          },
          await ctx.githubToken(),
          gateDir,
          ctx.sandbox,
        );
      } finally {
        killUser(ctx.sandbox.uid);
        if (ctx.localRepo) mustExec("chmod", ["-R", "u+rwX", gateDir]);
        mustExec("rm", ["-rf", gateDir]);
      }
    }
    logGate(ctx.logger, report);
    await store.putJson(keys.gateBefore(brief.prefix), report);
    if (report.setup && report.setup.exit_code !== 0)
      return `Repository setup failed; repair the verification runtime:\n${report.setup.output}\nDiagnostic: ${report.setup.artifact ?? "unavailable"}`;
    const invalid = report.hidden.filter((h) => h.status !== "behavior_failure" && h.status !== "pass");
    if (invalid.length)
      return `Invalid verification, not a valid red. Repair the test runtime without dropping criteria:\n${gateFeedback(report, full, { oracle: true })}`;
    publicPlan.oracle_version = report.oracle_version;
    if (previousPlan.success && previousPlan.data.oracle_version !== publicPlan.oracle_version)
      throw new HandoverError(
        `Oracle changed after Build. Independent review is required before accepting version ${publicPlan.oracle_version}; previous baseline and candidate evidence are invalid.`,
      );
    accepted = { full, publicPlan };
    return undefined;
  };
  const outcome = await llm(
    ctx,
    "plan-1-analyst",
    "analyst",
    repoDir,
    prompts.analystMessage(issue, config, repairFeedback),
    stats,
    records,
    { title: issue.title, analyst_attempt: 1 },
    undefined,
    undefined,
    { transformOutput: (value) => bindAuthorCriteria(AnalystOutput.parse(value), author), validateOutput, maxCorrections: ctx.step.attempts - 1 },
  );
  if (outcome.question) return { ok: true, question: outcome.question, resume: "plan", stats };
  if (!outcome.ok || !accepted) throw new HandoverError(`The analyst did not produce valid verification: ${outcome.error ?? "no accepted plan"}`);
  await store.putJson(keys.hidden(brief.prefix), accepted.full.hidden_tests);
  await store.putJson(keys.plan(brief.prefix), accepted.publicPlan);
  await ctx.reporter.report({
    kind: "plan",
    criteria: accepted.publicPlan.acceptance_criteria.length,
    hidden_tests: accepted.full.hidden_tests.length,
  });
  return { ok: true, stats };
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
  const feedback = readPublicFeedback(
    brief.attempt > 1 ? await store.text(keys.feedback(brief.prefix, brief.attempt)).catch(() => undefined) : undefined,
  );
  const remote = async () => remoteHead(brief.repo.full_name, await ctx.githubToken(), brief.branch, ctx.localRepo);
  // Later attempts continue on what the previous attempt pushed, if it pushed anything.
  const repoDir = await checkout(ctx, "implementer", (await remote()) !== undefined);
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
        hidden_tests: config.hidden_tests,
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
      publicFeedback("The previous attempt ended without a pushed commit. Inspect the public Build diagnostics before retrying."),
      "text/markdown",
    );
    await ctx.reporter.report({ kind: "check", attempt: brief.attempt, passed: false, failures: [`no pushed commit: ${built.error.slice(0, 200)}`] });
    return { ok: true, passed: false };
  }
  const hidden = z.array(HiddenTest).parse(await store.json(keys.hidden(brief.prefix)));
  const configDir = await checkout(ctx, "config", false);
  const config = baseConfig(configDir, brief.repo.base_sha);
  const report = await runGate(
    {
      mode: "after",
      runtime: brief.runtime,
      repo: brief.repo,
      branch: brief.branch,
      config,
      hidden_tests: hidden,
      allow_test_change: false,
      localRepo: ctx.localRepo,
      secrets: ctx.secrets(),
      saveDiagnostic: saveDiagnostic(ctx),
      contract: { criteria: thePlan.acceptance_criteria, inputs: Answers.parse(await store.json(keys.answers(brief.prefix)).catch(() => [])) },
    },
    await ctx.githubToken(),
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
  let bound = true;
  if (hidden.length) {
    const baseline = GateReportSchema.safeParse(await store.json(keys.gateBefore(brief.prefix)).catch(() => undefined));
    bound = Boolean(
      baseline.success &&
        thePlan.oracle_version &&
        baseline.data.oracle_version === thePlan.oracle_version &&
        report.oracle_version === thePlan.oracle_version,
    );
  }
  const missing = hidden.filter(
    (expected) => !report.hidden.some((actual) => actual.file === expected.file && expected.criteria.every((id) => actual.criteria.includes(id))),
  );
  const invalid =
    (report.setup?.exit_code ?? 0) !== 0 ||
    missing.length > 0 ||
    report.hidden.some((h) => h.status === "execution_failure" || h.status === "inconclusive");
  if (!bound || invalid) {
    const feedback = !bound
      ? "Verification identity changed or baseline evidence is missing. Repair Plan and rerun baseline and candidate verification; prior evidence is invalid."
      : `${gateFeedback(report, thePlan)}${missing.length ? `\nDeclared hidden verification did not complete: ${missing.map((test) => test.file).join(", ")}` : ""}`;
    await store.put(keys.feedback(brief.prefix, brief.attempt + 1), publicFeedback(feedback), "text/markdown");
    await ctx.reporter.report({
      kind: "check",
      attempt: brief.attempt,
      passed: false,
      failures: ["invalid verification", ...gateFailures(report)],
    });
    return { ok: true, passed: false, invalid_verification: true };
  }
  if (!gatePassed(report)) {
    await store.put(keys.feedback(brief.prefix, brief.attempt + 1), publicFeedback(gateFeedback(report, thePlan)), "text/markdown");
    await ctx.reporter.report({ kind: "check", attempt: brief.attempt, passed: false, failures: gateFailures(report) });
    return { ok: true, passed: false };
  }
  await ctx.reporter.report({ kind: "check", attempt: brief.attempt, passed: true });
  const issue = IssueDoc.parse(await store.json(keys.issue(brief.prefix)));
  const repoDir = await checkout(ctx, "ocr", true);
  mustExec("git", [...SAFE_GIT, "-C", repoDir, "checkout", "-q", built.head_sha]);
  const files = changedFiles(repoDir, brief.repo.base_sha, built.head_sha);
  const stats: Stats = [];
  let review: Review;
  try {
    const ocrKey = keys.ocr(brief.prefix, brief.attempt);
    let cached: unknown;
    try {
      cached = await store.json(ocrKey);
    } catch (error) {
      if ((error as Error).name !== "NoSuchKey") throw error;
    }
    if (cached === undefined) {
      const produced = await runOcr(ctx.env, repoDir, brief.repo.base_sha, built.head_sha, ctx.step.model ?? ctx.model);
      // First result wins, so retries and resumed verifier sessions keep identical IDs/order.
      await store.claim(ocrKey, produced);
      cached = await store.json(ocrKey);
    }
    const ocr = parseOcrResult(cached, brief.repo.base_sha, built.head_sha);
    stats.push({ station: "ocr", turns: ocr.tool_calls.total, tokens: ocr.summary.total_tokens });
    review = ocrReview(ocr, files);
    ctx.logger.log(`OCR ${ocr.status}: ${ocr.comments.length} findings`, { "mork.station": "ocr" });
  } catch (error) {
    throw new HandoverError(`OCR failed: ${(error as Error).message}. Branch \`${brief.branch}\` passed the gate.`);
  }
  for (let attempt = brief.attempt - 1; attempt >= 1; attempt--) {
    let previous: unknown;
    try {
      previous = await store.json(keys.review(brief.prefix, attempt));
    } catch (error) {
      if ((error as Error).name !== "NoSuchKey") throw error;
    }
    if (previous !== undefined) {
      const prior = Review.parse(previous);
      if (prior.feedback_visibility === "public-v1") review = carryFindings(review, prior);
      else review.incomplete.push("Legacy reviewer findings withheld: oracle visibility unknown; fresh review required.");
      break;
    }
  }
  // A separate root-owned clone is never passed to an agent. Quotes are checked
  // against this copy after each agent has exited, not its writable checkout.
  const evidenceDir = await checkout(ctx, "review-evidence", true);
  const read = { base: readAt(evidenceDir, brief.repo.base_sha), head: readAt(evidenceDir, built.head_sha) };
  review = locateFindings(review, read.head);
  const untestable = thePlan.acceptance_criteria.filter((criterion) => !criterion.testable);
  const baselineDir = review.findings.length || untestable.length ? await checkout(ctx, "review-base", false) : undefined;
  if (baselineDir && review.findings.length) {
    const verifierDir = await checkout(ctx, "verifier", true);
    mustExec("git", [...SAFE_GIT, "-C", verifierDir, "checkout", "-q", built.head_sha]);
    const outcome = await llm(
      ctx,
      `check-${brief.attempt}-verifier`,
      "verifier",
      verifierDir,
      prompts.verifierMessage(issue, thePlan, brief.repo.base_sha, built.head_sha, review.findings, baselineDir),
      stats,
      records,
      { title: issue.title, verifying: brief.branch, baselineDir },
    );
    if (outcome.ok) review = verifyReview(review, VerificationOutput.parse(outcome.output), read);
    else review.incomplete.push(`Finding verifier failed: ${outcome.error ?? "no result"}`);
  }
  if (baselineDir && untestable.length) {
    const criteriaDir = await checkout(ctx, "criteria", true);
    mustExec("git", [...SAFE_GIT, "-C", criteriaDir, "checkout", "-q", built.head_sha]);
    const outcome = await llm(
      ctx,
      `check-${brief.attempt}-criteria`,
      "criteria",
      criteriaDir,
      prompts.criteriaMessage(issue, thePlan, brief.repo.base_sha, built.head_sha, baselineDir),
      stats,
      records,
      { title: issue.title, criteria: untestable.map((c) => c.id), baselineDir },
    );
    if (outcome.ok) {
      review = verifyCriteria(
        review,
        CriteriaOutput.parse(outcome.output),
        untestable.map((c) => c.id),
        read,
        { base: baselineDir, head: criteriaDir },
      );
    } else review.incomplete.push(`Acceptance criteria checker failed: ${outcome.error ?? "no result"}`);
  }
  await store.putJson(keys.review(brief.prefix, brief.attempt), { ...review, feedback_visibility: "public-v1" });
  return { ok: true, passed: true, stats };
}
