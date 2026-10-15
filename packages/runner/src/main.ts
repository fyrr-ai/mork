// Entry point of the station image: runs the phase its task definition names
// (plan, build or check) for the brief Step Functions passed in, then reports
// back with the task token.

import { randomUUID } from "node:crypto";
import { DEFAULT_DEVELOPMENT, DevelopmentStep } from "@mork/contracts/development";
import { panelFromEnv } from "@mork/decision";
import {
  emitPhase,
  emitRun,
  githubAuthFromEnv,
  type Logger,
  noLogger,
  OtlpLogger,
  type PhaseRecord,
  type Reporter,
  resourceAttributes,
  slackThreadReporterFromEnv,
} from "@mork/sources";
import { Store } from "@mork/store";
import { briefFromEnv, reportInterrupted, reportTo, requiredEnv } from "./callback.ts";
import { withGitHubTokenFile } from "./github-auth.ts";
import { caBundle, egressEnv } from "./llm.ts";
import { build, check, type PhaseContext, plan } from "./phases.ts";
import { onShutdown, runShutdown } from "./shutdown.ts";

const env = process.env;
const isRoot = process.getuid?.() === 0;
const token = requiredEnv(env, "MORK_TASK_TOKEN");
let logger: Logger = noLogger;
process.once("SIGTERM", () => {
  const deadline = new Promise((resolve) => setTimeout(resolve, 90_000));
  void Promise.race([runShutdown(), deadline])
    .then(() => reportInterrupted(token, env.MORK_PHASE ?? "station"))
    .finally(() => process.exit(143));
});

await reportTo(token, async () => {
  const { phase, brief } = briefFromEnv(env);
  const auth = await githubAuthFromEnv(env);

  // Progress goes to the Slack thread of Slack tasks. Reporting must never fail a
  // phase, so a missing or broken Slack token only costs the messages.
  async function threadReporter(): Promise<Reporter> {
    if (!brief.report) return { report: async () => undefined };
    try {
      return await slackThreadReporterFromEnv(env, brief.report);
    } catch (error) {
      console.error(JSON.stringify({ kind: "report.unavailable", error: (error as Error).message }));
      return { report: async () => undefined };
    }
  }

  /** ECS task id for service.instance.id; the agent cannot reach the metadata endpoint, this root process can. */
  async function ecsTaskId(): Promise<string | undefined> {
    const uri = env.ECS_CONTAINER_METADATA_URI_V4;
    if (!uri) return undefined;
    try {
      const task = (await (await fetch(`${uri}/task`, { signal: AbortSignal.timeout(2_000) })).json()) as { TaskARN?: string };
      return task.TaskARN?.split("/").at(-1);
    } catch {
      return undefined;
    }
  }

  const secrets = () =>
    [...auth.secrets(), env.JEV_API, env.OPENAI_API_KEY, env.SLACK_BOT_TOKEN].filter((v): v is string => typeof v === "string" && v.length > 0);

  const deployment = env.MORK_ENV ?? "dev";
  const stepId = (await ecsTaskId()) ?? randomUUID();

  logger = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OtlpLogger({
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        resource: {
          "service.name": "mork",
          "deployment.environment.name": deployment,
          // Anything else the log backend wants (team, namespace…): OTEL_RESOURCE_ATTRIBUTES=key=value,key=value
          ...resourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
          "service.instance.id": stepId,
        },
        secrets,
        base: {
          "mork.execution": brief.execution,
          "mork.task": brief.task,
          "mork.phase": phase,
          "mork.attempt": brief.attempt,
          "mork.step": stepId,
        },
      })
    : noLogger;
  onShutdown(() => logger.flush());

  const ctx: PhaseContext = {
    brief,
    step: env.MORK_DEVELOPMENT_STEP
      ? DevelopmentStep.parse(JSON.parse(env.MORK_DEVELOPMENT_STEP))
      : { plan: DEFAULT_DEVELOPMENT.steps[0], build: DEFAULT_DEVELOPMENT.steps[1], check: DEFAULT_DEVELOPMENT.steps[2] }[phase],
    store: Store.fromEnv(env),
    githubToken: () => auth.token(brief.repo.full_name),
    model: requiredEnv(env, "MORK_MODEL"),
    panel: panelFromEnv(env),
    superviseEveryMs: Number(env.MORK_SUPERVISE_SECONDS ?? 300) * 1000,
    reporter: await threadReporter(),
    secrets,
    logger,
    env: {
      llmBaseUrl: requiredEnv(env, "LLM_BASE_URL"),
      egress: { proxy: env.MORK_EGRESS_PROXY ?? "http://127.0.0.1:3128", caFile: env.MORK_EGRESS_CA ?? "/mork-egress/ca.crt" },
      piBin: env.PI_BIN ?? "pi",
      extensionsDir: env.MORK_EXTENSIONS ?? "/opt/mork/packages/runner/extensions",
      workDir: env.MORK_WORK ?? "/work",
      agentHome: env.MORK_AGENT_HOME ?? "/home/agent",
      agentUid: isRoot ? Number(env.MORK_AGENT_UID ?? 10001) : undefined,
      agentGid: isRoot ? Number(env.MORK_AGENT_GID ?? 10001) : undefined,
    },
    sandbox: {
      uid: isRoot ? Number(env.MORK_SANDBOX_UID ?? 10002) : undefined,
      gid: isRoot ? Number(env.MORK_SANDBOX_GID ?? 10002) : undefined,
      env: { HOME: env.MORK_SANDBOX_HOME ?? "/home/sandbox", PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CI: "1" },
    },
  };

  if (ctx.step.kind !== phase) throw new Error("Configured development step does not match the task phase");
  if (ctx.env.egress) Object.assign(ctx.sandbox.env, egressEnv(ctx.env.egress.proxy, caBundle(ctx.env)));

  const phases = { plan, build, check };
  const startedAt = env.MORK_PHASE_STARTED_AT ? Date.parse(env.MORK_PHASE_STARTED_AT) : Date.now();
  const step: PhaseRecord = {
    run_id: brief.execution ?? "unknown",
    step_id: stepId,
    phase: phase.charAt(0).toUpperCase() + phase.slice(1),
    attempt: brief.attempt,
    started_at: startedAt,
    model: ctx.step.model ?? ctx.model,
  };
  let finished = false;
  const removeShutdown = onShutdown(async () => {
    if (!finished) emitPhase(logger, step, "interrupted", `${phase} · container stopped before it finished`);
    await logger.flush();
  });
  if (brief.run) emitRun(logger, brief.run, "running", startedAt);
  emitPhase(logger, step, "running", `${phase} · container started (attempt ${brief.attempt})`, startedAt);
  try {
    const result = env.GITHUB_TOKEN_FILE
      ? await withGitHubTokenFile(auth, brief.repo.full_name, env.GITHUB_TOKEN_FILE, () => phases[phase](ctx))
      : await phases[phase](ctx);
    emitPhase(
      logger,
      step,
      result.question ? "waiting" : !result.ok || result.passed === false ? "failed" : "passed",
      `${phase} · container finished: ${result.question ? `asked "${result.question.slice(0, 200)}"` : result.ok ? (result.passed === false ? "checks failed" : "ok") : `failed: ${result.error ?? "?"}`}`,
      Date.now(),
      result.stats,
    );
    console.log(
      JSON.stringify({
        phase,
        attempt: brief.attempt,
        prefix: brief.prefix,
        ok: result.ok,
        passed: result.passed,
        error: result.error,
        stats: result.stats,
      }),
    );
    return result;
  } catch (error) {
    emitPhase(logger, step, "failed", `${phase} · container failed: ${String(error).slice(0, 500)}`);
    throw error;
  } finally {
    finished = true;
    removeShutdown();
    await logger.flush();
  }
});
await logger.flush();
