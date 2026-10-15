import type { RunResult } from "@mork/contracts";
import type { RunContext, RunStatus, StepResult } from "@mork/contracts/observability";
import type { Logger } from "./otlp.ts";

type Usage = { tokens: number | null; cost_usd: number | null; turns: number | null };

/** Missing provider usage is unknown, including when only some stations reported it. */
export function usage(stats: RunResult["stats"]): Usage {
  const sum = (field: "tokens" | "cost" | "turns") =>
    stats?.length && stats.every((s) => s[field] !== undefined) ? stats.reduce((n, s) => n + (s[field] ?? 0), 0) : null;
  return { tokens: sum("tokens"), cost_usd: sum("cost"), turns: sum("turns") };
}

export function runSnapshot(
  context: RunContext,
  status: RunStatus,
  at: number,
  extra: { review?: string | null; pr_url?: string | null } & Partial<Usage> = {},
) {
  const { running_since, resume, ...fields } = context;
  const active = status === "running" || status === "waiting";
  return {
    event: "run.snapshot",
    ...fields,
    requested_by: context.requested_by ?? "Unknown",
    status,
    updated_at: status === "running" ? (resume ? Date.parse(resume.at) : running_since) : at,
    observed_at: at,
    duration_s: Math.max(0, (at - context.started_at) / 1000),
    range_start: context.started_at - 300_000,
    range_end: active ? "now" : at + 300_000,
    review: null as string | null,
    tokens: null as number | null,
    cost_usd: null as number | null,
    ...extra,
  };
}

export function emitRun(log: Logger, context: RunContext, status: RunStatus, at = Date.now(), extra?: Parameters<typeof runSnapshot>[3]): void {
  log.log(JSON.stringify(runSnapshot(context, status, at, extra)), { "mork.event": "run.snapshot", "mork.execution": context.run_id });
}

export type PhaseRecord = {
  run_id: string;
  step_id: string;
  phase: string;
  attempt: number;
  started_at: number;
  model: string | null;
};

/** Enrich the existing phase event; readable text remains available to the logs panel. */
export function emitPhase(
  log: Logger,
  step: PhaseRecord,
  result: StepResult,
  message: string,
  at = Date.now(),
  stats?: RunResult["stats"],
  authoritative = false,
): void {
  log.log(
    JSON.stringify({
      event: "phase",
      authoritative,
      ...step,
      label: `${step.phase} ${step.attempt}`,
      result,
      ended_at: at,
      observed_at: at,
      duration_s: Math.max(0, (at - step.started_at) / 1000),
      ...usage(stats),
      message,
    }),
    { "mork.event": "phase", "mork.execution": step.run_id, "mork.step": step.step_id, "mork.message": message },
    result === "failed" ? "ERROR" : result === "interrupted" || result === "cancelled" ? "WARN" : "INFO",
  );
}
