// Entry point of the station image: runs the phase its task definition names
// (plan, build or check) for the brief Step Functions passed in, then reports
// back with the task token.
import { panelFromEnv } from "@mork/decision";
import { type Reporter, slackThreadReporterFromEnv } from "@mork/sources";
import { Store } from "@mork/store";
import { briefFromEnv, reportInterrupted, reportTo, requiredEnv } from "./callback.ts";
import { type Logger, noLogger, OtlpLogger } from "./otlp.ts";
import { build, check, type PhaseContext, plan } from "./phases.ts";
import { onShutdown, runShutdown } from "./shutdown.ts";

const env = process.env;
const isRoot = process.getuid?.() === 0;
const { phase, brief, token } = briefFromEnv(env);

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
  [env.GITHUB_READ_TOKEN, env.JEV_API, env.OPENAI_API_KEY, env.SLACK_BOT_TOKEN].filter((v): v is string => typeof v === "string" && v.length > 0);

const deployment = env.MORK_ENV ?? "dev";

function resourceAttributes(raw: string | undefined): Record<string, string> {
  const pairs = (raw ?? "").split(",").map((pair) => pair.split("=", 2).map((part) => part.trim()));
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== ""));
}

const logger: Logger = env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? new OtlpLogger({
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      resource: {
        "service.name": "mork",
        "deployment.environment.name": deployment,
        // Anything else the log backend wants (team, namespace…): OTEL_RESOURCE_ATTRIBUTES=key=value,key=value
        ...resourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
        "service.instance.id": await ecsTaskId(),
      },
      secrets,
      base: {
        "mork.execution": brief.execution,
        "mork.task": brief.task,
        "mork.phase": phase,
        "mork.attempt": brief.attempt,
      },
    })
  : noLogger;
onShutdown(() => logger.flush());

const ctx: PhaseContext = {
  brief,
  store: Store.fromEnv(env),
  readToken: requiredEnv(env, "GITHUB_READ_TOKEN"),
  model: requiredEnv(env, "MORK_MODEL"),
  panel: panelFromEnv(env),
  superviseEveryMs: Number(env.MORK_SUPERVISE_SECONDS ?? 45) * 1000,
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

const SHUTDOWN_BUDGET_MS = 90_000;

// ECS stops a task with SIGTERM (Fargate Spot reclaim, handover) and SIGKILLs
// it after stopTimeout: save the session and the implementer's work, then let
// Step Functions retry the phase. After a handover nobody waits for the token.
process.once("SIGTERM", () => {
  console.error(JSON.stringify({ kind: "shutdown", phase }));
  // ECS kills the container 120 s after SIGTERM; keep 30 s for reporting the interruption.
  const deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS));
  void Promise.race([runShutdown(), deadline])
    .then(() => reportInterrupted(token, phase))
    .finally(() => process.exit(143));
});

const phases = { plan, build, check };
logger.log(`${phase} · container started (attempt ${brief.attempt})`, { "mork.event": "phase" });
const result = await reportTo(token, () => phases[phase](ctx));
logger.log(
  `${phase} · container finished: ${result.question ? `asked "${result.question.slice(0, 200)}"` : result.ok ? (result.passed === false ? "checks failed" : "ok") : `failed: ${result.error ?? "?"}`}`,
  { "mork.event": "phase" },
  result.ok ? "INFO" : "ERROR",
);
await logger.flush();
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
