// Runs one LLM station (analyst, implementer, reviewer) with Pi and an OpenAI-compatible LLM.
//
// Privilege split inside the container: this process (root in the image)
// holds the task token, AWS credentials, the GitHub token and the decision-API
// keys; Pi runs as the unprivileged `agent` user with a clean environment, so
// the model can read none of them. The agent holds no key at all: its HTTPS
// goes through the task's egress sidecar, which adds the LLM key, and in Build
// the GitHub token, to requests for those hosts only. The implementer pushes its
// own branch; the guard extension only lets it push that branch, without force.

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LlmStation, type RepoRef, StationOutput } from "@mork/contracts";
import type { DecisionPanel } from "@mork/decision";
import { type Logger, redact } from "@mork/sources";
import { z } from "zod";
import { killUser, readAgentFile, writeFresh } from "./agentfs.ts";
import type { CommandDiagnostic } from "./gate.ts";
import { exec, execAsync, mustExec, SAFE_GIT } from "./git.ts";
import { PiRpc } from "./rpc.ts";
import type { SessionLog } from "./session.ts";
import { onShutdown } from "./shutdown.ts";
import { SUPERVISION_TICK_MS, type SupervisionRecord, Supervisor } from "./supervisor.ts";
import { type VerifyResult, type VerifySpec, verifyText } from "./verify.ts";

export type RunnerEnv = {
  llmBaseUrl: string;
  piBin: string;
  extensionsDir: string;
  workDir: string;
  agentHome: string;
  /** Present when the runner can drop privileges (root in the container). */
  agentUid?: number;
  agentGid?: number;
} & ({ egress: { proxy: string; caFile: string }; trustedLocal?: never } | { egress?: never; trustedLocal: { apiKey: string } });

/** One LLM station run, fully assembled by the caller. */
export type LlmJob = {
  instructions: string;
  message: string;
  output_schema: Record<string, unknown>;
  model: string;
  tools?: string[];
  extensions?: string[];
  environment?: Record<string, string>;
  readiness?: { command: string; marker?: string };
  transformOutput?: (value: unknown) => unknown;
  validateOutput?: (value: unknown) => Promise<string | undefined>;
  /** Corrective submissions after the initial one; Plan maps its total attempts to this. */
  maxCorrections?: number;
  secrets?: () => string[];
  saveDiagnostic?: (record: CommandDiagnostic) => Promise<string>;
  /** Implementer only: the agent commits and pushes `branch` itself. */
  push?: { branch: string; remoteHead: () => Promise<string | undefined> };
  /**
   * The only brake on a run: on a cheap signal, and at least every `everyMs`, the
   * decision model scores progress and the supervisor steers or stops. There are no turn or time limits; Step
   * Functions' per-phase timeout is the backstop.
   */
  supervise: { panel: DecisionPanel; everyMs: number; task: Record<string, unknown> };
  /** The requester can answer questions (Slack tasks): the station gets the ask_human tool. */
  ask?: boolean;
  /** Implementer: the `verify` tool, and a verify run after submit_result before the work counts as done. */
  verify?: VerifySpec;
  /** Where the agent's session is kept and saved. */
  session?: SessionLog;
  /** The session continues an earlier run: `message` is the next prompt, not the task. */
  resumed?: boolean;
  /** Live log of what the agent does (Grafana); carries the station's attributes. */
  log?: Logger;
} & (
  | { station: LlmStation; repo: RepoRef; parseOutput?: never }
  | { station: "agent"; repo?: never; push?: never; verify?: never; ask?: never; parseOutput: (value: unknown) => unknown }
);

export type LlmOutcome = {
  ok: boolean;
  error?: string;
  output?: unknown;
  stats?: { turns: number; tokens?: number; cost?: number };
  /** Implementer: the pushed commit. */
  headSha?: string;
  /** The station asked the requester this and stopped. */
  question?: string;
  supervision?: SupervisionRecord[];
};

/** Name of the one custom provider written into Pi's models.json. */
const PROVIDER = "llm";
const READ_ONLY_TOOLS = "read,bash,grep,find,ls,submit_result";
const MAX_CORRECTIONS = 2;

/** Runs Pi on an already prepared checkout in `repoDir`. */
export async function runLlmStation(spec: LlmJob, env: RunnerEnv, repoDir: string): Promise<LlmOutcome> {
  const maxCorrections = spec.maxCorrections ?? MAX_CORRECTIONS;
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 7) throw new Error("maxCorrections must be an integer from 0 to 7");
  const outFile = join(env.agentHome, "out", "result.json");
  const questionFile = join(env.agentHome, "out", "question.txt");
  const piDir = join(env.agentHome, ".pi-mork");
  rmSync(join(env.agentHome, "out"), { recursive: true, force: true });

  writePiConfig(piDir, spec, env);
  // The verify spec stays root-owned: the agent reads the commands, it cannot rewrite them.
  const verifyFile = join(env.workDir, "verify.json");
  if (spec.verify) writeFileSync(verifyFile, JSON.stringify(spec.verify), { mode: 0o644 });
  mkdirSync(join(env.agentHome, "out"), { recursive: true });
  if (env.agentUid !== undefined) {
    mustExec("chown", ["-R", `${env.agentUid}:${env.agentGid}`, repoDir, env.agentHome]);
  }
  const asAgent = { uid: env.agentUid, gid: env.agentGid };
  const verifyLogDir = join(env.agentHome, "out/verify");
  const agentEnv: Record<string, string> = {
    HOME: env.agentHome,
    PATH: `${join(env.agentHome, ".local/bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    PI_CODING_AGENT_DIR: piDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    MORK_OUTPUT: outFile,
    ...(spec.ask ? { MORK_QUESTION: questionFile } : {}),
    ...(spec.verify ? { MORK_VERIFY: verifyFile } : {}),
    ...(spec.verify ? { MORK_VERIFY_LOG_DIR: verifyLogDir, MORK_VERIFY_PUBLISH_REQUIRED: "1" } : {}),
    GIT_AUTHOR_NAME: "mork",
    GIT_AUTHOR_EMAIL: "mork@users.noreply.github.com",
    GIT_COMMITTER_NAME: "mork",
    GIT_COMMITTER_EMAIL: "mork@users.noreply.github.com",
    GIT_TERMINAL_PROMPT: "0",
    ...(spec.repo ? { MORK_BASE_SHA: spec.repo.base_sha } : {}),
    ...spec.environment,
    ...(env.egress ? egressEnv(env.egress.proxy, caBundle(env)) : {}),
    ...(spec.push ? { MORK_WORK_BRANCH: spec.push.branch } : {}),
  };

  const opts = { cwd: repoDir, env: agentEnv, ...asAgent };
  if (spec.readiness) {
    const ready = await execAsync("bash", ["-c", spec.readiness.command], { ...opts, timeoutMs: 900_000, maxOutputBytes: 64 * 1024 * 1024 });
    const artifact = await saveStationDiagnostic(spec, repoDir, spec.readiness.command, ready);
    if (ready.code !== 0 || ready.output_truncated)
      return {
        ok: false,
        error: `Repository readiness failed${ready.output_truncated ? " (diagnostic incomplete)" : ""}: ${redact(ready.output, spec.secrets?.() ?? []).slice(-2000)}${artifact ? `\nDiagnostic: ${artifact}` : ""}`,
      };
    if (spec.readiness.marker) writeFresh(spec.readiness.marker, "");
  }

  const args = [
    ...(spec.session ? ["--session-dir", dirname(spec.session.file), "--session", spec.session.file] : ["--no-session"]),
    "--no-extensions",
    "--no-skills",
    "-e",
    join(env.extensionsDir, "guard.ts"),
    "-e",
    join(env.extensionsDir, "submit.ts"),
    ...(spec.repo ? ["-e", join(env.extensionsDir, "dir-rules.ts")] : []),
    ...(spec.extensions ?? []).flatMap((extension) => ["-e", extension]),
    ...(spec.ask ? ["-e", join(env.extensionsDir, "ask.ts")] : []),
    ...(spec.verify ? ["-e", join(env.extensionsDir, "verify.ts")] : []),
    "--model",
    `${PROVIDER}/${spec.model}`,
  ];
  // Analyst and reviewer get read-only tools; ask_human too when the requester can be asked (the allowlist hides every other tool).
  if (spec.tools)
    args.push(
      "--tools",
      [...new Set([...spec.tools, "submit_result", ...(spec.verify ? ["verify"] : []), ...(spec.ask ? ["ask_human"] : [])])].join(","),
    );
  else if (spec.station !== "implementer") args.push("--tools", spec.ask ? `${READ_ONLY_TOOLS},ask_human` : READ_ONLY_TOOLS);

  const published = new Set<string>();
  let publishing: Promise<void> | undefined;
  const collectDiagnostics = () => {
    publishing ??= publishVerifyDiagnostics(spec, env.workDir, repoDir, verifyLogDir, published)
      .catch((error) =>
        spec.log?.log(
          `Verify diagnostic publication failed: ${redact(String(error), spec.secrets?.() ?? [])}`,
          { "mork.event": "diagnostic" },
          "ERROR",
        ),
      )
      .finally(() => {
        publishing = undefined;
      });
    return publishing;
  };
  // Start before Pi: its first verify can precede the first supervision tick.
  const diagnosticTicker = spec.verify ? setInterval(() => void collectDiagnostics(), 100) : undefined;
  const pi = new PiRpc({ bin: env.piBin, args, cwd: repoDir, env: agentEnv, ...asAgent });
  let turns = 0;
  let aborted: string | undefined;
  pi.onEvent((event) => {
    if (event.type !== "turn_end") return;
    turns += 1;
    spec.session?.tick();
  });
  const log = spec.log;
  if (log) pi.onEvent((event) => logPiEvent(log, spec.station, event, turns));
  log?.log(`${spec.station} · ${spec.resumed ? "resumed with the requester's answer" : "started"}`, { "mork.event": "station" });

  const supervisor = new Supervisor(
    spec.supervise.panel,
    { station: spec.station, ...spec.supervise.task },
    {
      diffStat: () => (spec.repo ? exec("git", ["diff", "--stat", spec.repo.base_sha], opts).output.slice(-3_000) : ""),
      steer: async (message) => {
        log?.log(`supervisor · steer ${spec.station}: ${message}`, { "mork.event": "supervisor" }, "WARN");
        await pi.command({ type: "steer", message });
      },
      stop: (reason) => {
        log?.log(`supervisor · stop ${spec.station}: ${reason}`, { "mork.event": "supervisor" }, "ERROR");
        aborted ??= reason;
        void pi.command({ type: "abort" }).catch(() => undefined);
      },
    },
    { everyMs: spec.supervise.everyMs, trackDiff: spec.station === "implementer" },
  );
  pi.onEvent((event) => supervisor.observe(event));
  const ticker = spec.supervise.panel.enabled ? setInterval(() => void supervisor.check().catch(() => undefined), SUPERVISION_TICK_MS) : undefined;

  const parseOutput =
    spec.parseOutput ??
    ((value: unknown) => {
      return StationOutput[spec.station].parse(value);
    });
  let output: unknown;
  let problem = "";
  // Unfinished work survives the container: the session always, the implementer's commits too
  // (a no-op after a clean, pushed run).
  let finalized = false;
  let verifiedHead: string | undefined;
  let cleanup: Promise<void> | undefined;
  const keepWork = () => {
    cleanup ??= (async () => {
      try {
        // Stop the agent first: never snapshot work while it still edits or commits.
        killUser(env.agentUid);
        await pi.stop();
        clearInterval(diagnosticTicker);
        await collectDiagnostics();
        if (!finalized && spec.push && spec.repo) pushWip(spec.push.branch, spec.repo.base_sha, opts);
        await spec.session?.finish();
      } finally {
        if (env.trustedLocal) rmSync(join(piDir, "models.json"), { force: true });
      }
    })();
    return cleanup;
  };
  const offShutdown = onShutdown(keepWork);
  try {
    const readUsage = async () => {
      const response = await pi.command({ type: "get_session_stats" }).catch(() => undefined);
      const stats = z
        .object({
          data: z
            .object({ tokens: z.object({ total: z.number().nonnegative().optional() }).optional(), cost: z.number().nonnegative().optional() })
            .optional(),
        })
        .safeParse(response);
      return { tokens: stats.success ? stats.data.data?.tokens?.total : undefined, cost: stats.success ? stats.data.data?.cost : undefined };
    };
    // A resumed Pi session reports lifetime usage. Count only this container's increment.
    const initial = spec.resumed ? await readUsage() : { tokens: 0, cost: 0 };
    let prompt = spec.resumed
      ? spec.message
      : `${spec.message}\n\n## Output\n\nWhen you are done, call submit_result with one JSON document matching this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(spec.output_schema)}\n\`\`\``;
    for (let attempt = 0; attempt <= maxCorrections && !aborted; attempt++) {
      const settled = pi.waitSettled();
      await Promise.all([pi.command({ type: "prompt", message: prompt }), settled]);
      if (existsSync(questionFile)) break;
      const submitted = readAgentFile(outFile);
      if (submitted === undefined) {
        problem = "You finished without calling submit_result.";
      } else {
        let parsed: { success: true; data: unknown } | { success: false; error: Error };
        try {
          const value = parseOutput(parseJson(submitted));
          parsed = { success: true, data: spec.transformOutput ? spec.transformOutput(value) : value };
        } catch (error) {
          parsed = { success: false, error: error instanceof Error ? error : new Error(String(error)) };
        }
        if (parsed.success) {
          output = parsed.data;
          if (spec.validateOutput) {
            supervisor.observe({ type: "validation_started" });
            try {
              problem = (await spec.validateOutput(output)) ?? "";
            } finally {
              supervisor.observe({ type: "validation_finished" });
            }
          } else problem = "";
          if (!problem) problem = spec.push && spec.repo ? ((await pushProblem(spec.repo.base_sha, spec.push, opts)) ?? "") : "";
          if (!problem && spec.verify) {
            verifiedHead = exec("git", ["rev-parse", "HEAD"], opts).output.trim();
            // Pushed and submitted, but does it pass the repository's own checks? Still the agent's turn to fix it.
            const verified = await verifyAsAgent(env, verifyFile, opts);
            log?.log(
              `${spec.station} · verify after submit: ${verified.passed ? "passed" : "failed"}`,
              { "mork.event": "verify" },
              verified.passed ? "INFO" : "WARN",
            );
            for (const step of verified.steps) {
              const artifact = await saveStationDiagnostic(spec, repoDir, step.command, {
                code: step.exit_code,
                output: step.output,
                output_truncated: step.output_truncated,
              });
              if (artifact) step.artifact = artifact;
              step.output = redact(step.output, spec.secrets?.() ?? []);
              step.command = redact(step.command, spec.secrets?.() ?? []);
            }
            if (!verified.passed) {
              problem = `Your pushed work does not pass verify yet:\n\n${verifyText(verified)}\n\nFix it, commit and push again.`;
            }
            if (!problem && spec.push && spec.repo) problem = (await pushProblem(spec.repo.base_sha, spec.push, opts)) ?? "";
            if (!problem && exec("git", ["rev-parse", "HEAD"], opts).output.trim() !== verifiedHead)
              problem = "HEAD changed during verify; verify the exact committed revision again";
          }
          if (!problem) break;
        } else {
          problem = `Your submit_result JSON does not match the schema: ${parsed.error.message.slice(0, 2000)}`;
        }
      }
      rmSync(outFile, { force: true });
      supervisor.observe({ type: "semantic_repair" });
      prompt = `${problem} Then call submit_result again.`;
    }
    const stats = await readUsage();
    const delta = (key: "tokens" | "cost") => {
      const before = initial[key],
        after = stats[key];
      return before !== undefined && after !== undefined && after >= before ? after - before : undefined;
    };
    const runStats = { turns, tokens: delta("tokens"), cost: delta("cost") };
    const supervision = supervisor.records;
    const asked = readAgentFile(questionFile, 64_000);
    if (asked !== undefined) {
      const question = asked.trim();
      log?.log(`${spec.station} · asked the requester: ${question}`, { "mork.event": "ask_human" });
      return { ok: false, question, stats: runStats, supervision };
    }

    if (output === undefined || problem || aborted) {
      const error = aborted ?? (problem || "no output");
      log?.log(`${spec.station} · failed after ${turns} turns: ${error}`, { "mork.event": "station" }, "ERROR");
      return { ok: false, error, output, stats: runStats, supervision };
    }
    // Freeze the editing process, then recheck the exact local and remote revision.
    await pi.stop();
    killUser(env.agentUid);
    if (spec.push && spec.repo) {
      const finalProblem = await pushProblem(spec.repo.base_sha, spec.push, opts);
      if (finalProblem) return { ok: false, error: finalProblem, output, stats: runStats, supervision };
      if (verifiedHead && exec("git", ["rev-parse", "HEAD"], opts).output.trim() !== verifiedHead)
        return { ok: false, error: "HEAD changed after verify", output, stats: runStats, supervision };
    }
    finalized = true;
    log?.log(`${spec.station} · submitted its result after ${turns} turns`, { "mork.event": "submit_result" });
    const headSha = spec.push ? exec("git", ["rev-parse", "HEAD"], opts).output.trim() : undefined;
    return { ok: true, output, stats: runStats, headSha, supervision };
  } finally {
    clearInterval(ticker);
    try {
      await keepWork();
    } finally {
      offShutdown();
    }
  }
}

async function saveStationDiagnostic(
  spec: LlmJob,
  repoDir: string,
  command: string,
  result: { code: number; output: string; output_truncated?: boolean },
): Promise<string | undefined> {
  if (!spec.saveDiagnostic) return undefined;
  const secrets = spec.secrets?.() ?? [];
  return spec.saveDiagnostic({
    command_id: randomUUID(),
    command: redact(command, secrets),
    cwd: repoDir,
    head_sha: mustExec("git", [...SAFE_GIT, "rev-parse", "--verify", "HEAD"], { cwd: repoDir }).trim(),
    exit_code: result.code,
    output: redact(result.output, secrets),
    ...(result.output_truncated ? { output_truncated: true } : {}),
  });
}

/** Agent logs are diagnostic claims, never gate evidence. Never follow their supplied output_file path. */
async function publishVerifyDiagnostics(spec: LlmJob, workDir: string, repoDir: string, logDir: string, published: Set<string>): Promise<void> {
  if (!existsSync(logDir) || !lstatSync(logDir).isDirectory() || lstatSync(logDir).isSymbolicLink()) return;
  const diagnosticDir = join(workDir, "diagnostics", spec.station === "analyst" ? "oracle" : "public");
  mkdirSync(diagnosticDir, { recursive: true, mode: 0o755 });
  const sidecarSchema = z.object({
    command_id: z.string().min(1),
    command: z.string(),
    cwd: z.string().optional(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    exit_code: z.number().int(),
    output_truncated: z.boolean().optional(),
  });
  for (const name of readdirSync(logDir)) {
    if (!name.endsWith(".json") || name.endsWith(".published.json") || published.has(name)) continue;
    const raw = readAgentFile(join(logDir, name), 64 * 1024);
    if (!raw) continue;
    let sidecar: z.infer<typeof sidecarSchema>;
    try {
      sidecar = sidecarSchema.parse(JSON.parse(raw));
    } catch {
      continue;
    }
    const outputPath = join(logDir, name.replace(/\.json$/, ".log"));
    const output = readAgentFile(outputPath);
    if (output === undefined) continue;
    const secrets = spec.secrets?.() ?? [];
    const id = randomUUID();
    const truncated = sidecar.output_truncated === true || lstatSync(outputPath).size > 64 * 1024 * 1024;
    const safe = `${truncated ? "[Diagnostic incomplete: output limit exceeded]\n" : ""}${redact(output, secrets)}`;
    const artifact = join(diagnosticDir, `${id}.log`);
    writeFresh(artifact, safe, 0o644);
    await spec.saveDiagnostic?.({
      command_id: id,
      command: redact(sidecar.command, secrets),
      cwd: redact(sidecar.cwd ?? repoDir, secrets),
      head_sha: sidecar.head_sha,
      exit_code: truncated ? 125 : sidecar.exit_code,
      output: safe,
      source: "agent_verify",
      ...(truncated ? { output_truncated: true } : {}),
    });
    writeFresh(
      join(logDir, name.replace(/\.json$/, ".published.json")),
      JSON.stringify({
        artifact,
        output_tail: `${truncated ? "[Diagnostic incomplete]\n" : ""}${safe.slice(-1500)}`,
        command: redact(sidecar.command, secrets),
        output_truncated: truncated,
      }),
      0o644,
    );
    published.add(name);
  }
}

function writePiConfig(piDir: string, spec: LlmJob, env: RunnerEnv): void {
  rmSync(piDir, { recursive: true, force: true });
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const models = {
    providers: {
      [PROVIDER]: {
        baseUrl: env.llmBaseUrl,
        api: "openai-completions",
        // The egress sidecar replaces the Authorization header with the real key.
        apiKey: env.trustedLocal?.apiKey ?? "added-by-egress",
        models: [
          {
            id: spec.model,
            name: spec.model,
            reasoning: true,
            compat: { supportsReasoningEffort: false, supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
            input: ["text"],
            contextWindow: 1_000_000,
            maxTokens: 131_072,
          },
        ],
      },
    },
  };
  writeFileSync(join(piDir, "models.json"), JSON.stringify(models), { mode: 0o600 });
  writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: PROVIDER, defaultModel: spec.model }));
  writeFileSync(join(piDir, "APPEND_SYSTEM.md"), spec.instructions);
}

/** One readable line per Pi event worth seeing live. */
export function logPiEvent(log: Logger, station: string, event: Record<string, unknown>, turns: number): void {
  const tool = String(event.toolName ?? "");
  if (event.type === "tool_execution_start") {
    const args = (event.args ?? {}) as Record<string, unknown>;
    const what = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : JSON.stringify(args);
    log.log(`${station} · ${tool}: ${what.slice(0, 500)}`, { "mork.event": "tool_call", "mork.tool": tool });
  } else if (event.type === "tool_execution_end") {
    const content = ((event.result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const failed = event.isError === true;
    log.log(
      `${station} · ${tool} ${failed ? "failed" : "ok"}${content ? `: …${content.slice(-300)}` : ""}`,
      { "mork.event": "tool_result", "mork.tool": tool },
      failed ? "ERROR" : "INFO",
    );
  } else if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: { type: string; text?: string }[] } | undefined;
    if (message?.role !== "assistant") return;
    const text = (message.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();
    if (text) log.log(`${station} · ${text.slice(0, 800)}`, { "mork.event": "text" });
  } else if (event.type === "turn_end") {
    log.log(`${station} · turn ${turns}`, { "mork.event": "turn" });
  }
}

/** The runner's own verify, as the agent user: repository code never runs as root. */
async function verifyAsAgent(
  env: RunnerEnv,
  verifyFile: string,
  opts: { cwd: string; env: Record<string, string>; uid?: number; gid?: number },
): Promise<VerifyResult> {
  const cli = join(env.extensionsDir, "..", "src", "verify-cli.ts");
  // Async: a long test suite must not block the heartbeats to Step Functions.
  const run = await execAsync(process.execPath, [cli, verifyFile], { ...opts, timeoutMs: 60 * 60_000, maxOutputBytes: 256 * 1024 * 1024 });
  try {
    return JSON.parse(run.output) as VerifyResult;
  } catch {
    return { passed: false, steps: [{ name: "verify", command: "verify", exit_code: run.code, output: run.output.slice(-1_500) }], violations: [] };
  }
}

/** Commits and pushes unfinished work as the agent user; failures are logged. */
function pushWip(branch: string, baseSha: string, opts: { cwd: string; env: Record<string, string>; uid?: number; gid?: number }): void {
  const git = (...args: string[]) => exec("git", args, opts);
  if (git("symbolic-ref", "--short", "HEAD").output.trim() !== branch) return;
  git("add", "-A");
  if (git("diff", "--cached", "--quiet").code !== 0) git("commit", "-q", "--no-verify", "-m", "mork: work in progress");
  if (git("rev-list", "--count", `${baseSha}..HEAD`).output.trim() === "0") return;
  const pushed = git("push", "-q", "origin", branch);
  if (pushed.code !== 0) console.error(JSON.stringify({ kind: "wip.push_failed", branch, output: pushed.output.slice(-300) }));
}

/**
 * What still stands between the implementer's work and a pushed branch, in
 * words the agent can act on. Runs git as the agent user: as root inside an
 * agent-owned repository git would execute whatever hooks the agent set up.
 */
async function pushProblem(
  baseSha: string,
  push: NonNullable<LlmJob["push"]>,
  opts: { cwd: string; env: Record<string, string>; uid?: number; gid?: number },
): Promise<string | undefined> {
  const git = (...args: string[]) => exec("git", args, opts).output.trim();
  const head = git("symbolic-ref", "--short", "HEAD");
  if (head !== push.branch) return `Your work must stay on branch ${push.branch}, but HEAD is ${head || "detached"}. Switch back and push it.`;
  const dirty = git("status", "--porcelain");
  if (dirty) return `You have uncommitted changes:\n${dirty.slice(0, 1000)}\nCommit them and push with \`git push origin ${push.branch}\`.`;
  if (git("rev-list", "--count", `${baseSha}..HEAD`) === "0") return `There are no commits on ${push.branch} yet. Commit your change and push it.`;
  const local = git("rev-parse", "HEAD");
  const remote = await push.remoteHead();
  if (remote !== local) {
    return `${push.branch} on origin is ${remote ?? "missing"}, your HEAD is ${local}. Push with \`git push origin ${push.branch}\` (no force).`;
  }
  return undefined;
}

/** Every HTTPS client the agent starts goes through the egress sidecar and trusts its CA. */
export function egressEnv(proxy: string, bundle: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: bundle,
    GIT_SSL_CAINFO: bundle,
    SSL_CERT_FILE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    PIP_CERT: bundle,
  };
}

/** System CAs plus the sidecar's, for clients that take one bundle file. Written once per container. */
export function caBundle(env: RunnerEnv): string {
  if (!env.egress) throw new Error("An egress connection is required for its CA bundle");
  const bundle = join(env.workDir, "egress-ca.pem");
  if (!existsSync(bundle)) {
    const system = existsSync(SYSTEM_CAS) ? readFileSync(SYSTEM_CAS, "utf8") : "";
    writeFileSync(bundle, `${system}\n${readFileSync(env.egress.caFile, "utf8")}`, { mode: 0o644 });
  }
  return bundle;
}

const SYSTEM_CAS = "/etc/ssl/certs/ca-certificates.crt";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
