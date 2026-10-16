// Supervises an LLM station while Pi runs (thruwire/foreman pattern). Cheap signals
// from the event stream decide when to ask: a repeated tool call, real tool errors in a
// row, a diff that stopped changing, or the periodic check. The decision model then
// scores the run from bounded evidence; the code steers once and stops a run that
// stays stuck after it acted on the steer.
import {
  boundEvidence,
  type DecisionPanel,
  type DecisionTrace,
  STEER_GRACE_MS,
  SUPERVISION_QUESTIONS,
  type Supervision,
  supervise,
} from "@mork/decision";

type Json = Record<string, unknown>;

export type SupervisionRecord = { at: string; trace: DecisionTrace; action: Json };

export type SupervisorHooks = {
  /** Current `git diff --stat` against the base, run as the agent user. */
  diffStat: () => string;
  steer: (message: string) => Promise<void>;
  stop: (reason: string) => void;
};

/** How often the runner looks at the cheap signals; asking the decision model is rarer. */
export const SUPERVISION_TICK_MS = 15_000;
/** A station that edits code and has not changed its diff for this long gets a check. */
export const STALL_MS = 10 * 60_000;
/**
 * How many same-session corrections (schema, push, verify, semantic repair) may clear
 * stale steering evidence. Past that, a steer that was already delivered stands and the
 * next persisting problem stops the run: the total budget is never reset.
 */
export const MAX_CORRECTION_RESETS = 2;
const REPEATS = 3;
const ERRORS_IN_ROW = 3;
const RECENT_RESULTS = 8;
const RESULT_TAIL = 160;

export type SupervisorOptions = {
  /** Ask at least this often even without a signal. */
  everyMs: number;
  /** The station edits code, so a diff that stops changing is a signal. */
  trackDiff: boolean;
  started?: number;
};

/** What a finished tool call was: a search that found nothing and a guard block are not environment failures. */
export type ToolOutcome = "ok" | "no_match" | "blocked" | "error";

const BLOCKED = /^\s*Blocked by Mork\b/;
const NO_MATCH_TEXT = /\bno (matches|files|results)( found)?\b/i;
/** Commands whose exit 1 means "nothing found", after any `cd …;`/`export …&&` prefix. */
const SEARCH_COMMAND = /^(?:\s*(?:cd\s+\S+|export\s+[^;&|]+)\s*(?:;|&&)\s*)*\s*(?:git\s+grep|grep|rg|find|ls|diff|cmp|test|\[)\b/;
const EXIT_CODE = /Command exited with code (\d+)\s*$/;

function resultText(end: Json): string {
  const result = end.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export function toolOutcome(call: { toolName?: unknown; args?: unknown }, end: Json): ToolOutcome {
  if (end.isError !== true) return "ok";
  const text = resultText(end);
  if (BLOCKED.test(text)) return "blocked";
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const code = EXIT_CODE.exec(text)?.[1];
    if (code === "1" && SEARCH_COMMAND.test(command)) return "no_match";
    return "error";
  }
  if (NO_MATCH_TEXT.test(text)) return "no_match";
  return "error";
}

type PendingCall = { id: string; sequence: number; name: string; what: string; since: number };

export class Supervisor {
  readonly records: SupervisionRecord[] = [];
  readonly #panel: DecisionPanel;
  readonly #task: Json;
  readonly #hooks: SupervisorHooks;
  readonly #options: SupervisorOptions;
  readonly #started: number;
  readonly #state: Supervision = {};
  #calls: string[] = [];
  #callCount = 0;
  #lastCompletedCall = 0;
  #toolErrors = 0;
  #errorsInRow = 0;
  #outcomes: Record<ToolOutcome, number> = { ok: 0, no_match: 0, blocked: 0, error: 0 };
  #recentResults: string[] = [];
  #pending: PendingCall[] = [];
  #lastMessage = "";
  #turns = 0;
  #busy = false;
  #askedAt: number;
  #callsWhenAsked = 0;
  #diff: string | undefined;
  #diffChangedAt: number;
  #previousCheck: Json | undefined;
  /** What the agent had done when the steer message was delivered. */
  #steerDelivered: { calls: number; turns: number } | undefined;
  #corrections = 0;
  /** Bumped by a correction or validation boundary; a decision from an older epoch is dropped. */
  #epoch = 0;
  #validating = 0;
  #now: () => number;

  constructor(panel: DecisionPanel, task: Json, hooks: SupervisorHooks, options: SupervisorOptions) {
    this.#panel = panel;
    this.#task = task;
    this.#hooks = hooks;
    this.#options = options;
    this.#started = options.started ?? Date.now();
    this.#now = options.started === undefined ? Date.now : () => this.#askedAt;
    this.#askedAt = this.#started;
    this.#diffChangedAt = this.#started;
  }

  /** Feed every Pi RPC event here, plus the runner's own `semantic_repair` and `validation_*` events. */
  observe(event: Json): void {
    if (event.type === "semantic_repair") {
      this.correctionStarted(this.#now());
      return;
    }
    if (event.type === "validation_started") {
      this.#validating += 1;
      this.#epoch += 1;
      return;
    }
    if (event.type === "validation_finished") {
      this.#validating = Math.max(0, this.#validating - 1);
      this.#epoch += 1;
      return;
    }
    if (event.type === "turn_end") this.#turns += 1;
    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const what = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : JSON.stringify(args);
      this.#calls = [...this.#calls, `${String(event.toolName)} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`].slice(-20);
      this.#callCount += 1;
      this.#pending = [
        ...this.#pending,
        {
          id: String(event.toolCallId ?? this.#callCount),
          sequence: this.#callCount,
          name: String(event.toolName ?? ""),
          what: what.slice(0, 200),
          since: this.#now(),
        },
      ].slice(-10);
    }
    if (event.type === "tool_execution_end") {
      const id = event.toolCallId === undefined ? undefined : String(event.toolCallId);
      const index = id === undefined ? this.#pending.length - 1 : this.#pending.findIndex((p) => p.id === id);
      const call = index >= 0 ? this.#pending[index] : undefined;
      if (index >= 0) this.#pending.splice(index, 1);
      if (call) this.#lastCompletedCall = Math.max(this.#lastCompletedCall, call.sequence);
      const outcome = toolOutcome({ toolName: call?.name ?? event.toolName, args: { command: call?.what } }, event);
      this.#outcomes[outcome] += 1;
      this.#errorsInRow = outcome === "error" ? this.#errorsInRow + 1 : 0;
      if (outcome === "error") this.#toolErrors += 1;
      const tail = resultText(event).trim().slice(-RESULT_TAIL).replace(/\s+/g, " ");
      this.#recentResults = [
        ...this.#recentResults,
        `${call?.name ?? String(event.toolName ?? "")} ${outcome}: ${call?.what ?? ""}${tail ? ` → ${tail}` : ""}`,
      ].slice(-RECENT_RESULTS);
    }
    if (event.type === "message_end") {
      const message = event.message as { role?: string; content?: { type: string; text?: string }[] } | undefined;
      if (message?.role !== "assistant") return;
      const text = (message.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (text) this.#lastMessage = text;
    }
  }

  /**
   * The runner is about to send a same-session correction (schema, push, verify or
   * semantic repair). Stale steering, error streaks and repeat buffers from before it
   * must not carry a stop reason into the repair; the elapsed time and the records stay.
   * Returns false once the reset budget is used up: then earlier steering stands.
   */
  correctionStarted(now = this.#now()): boolean {
    this.#epoch += 1;
    if (this.#corrections >= MAX_CORRECTION_RESETS) return false;
    this.#corrections += 1;
    this.#state.steeredAt = undefined;
    this.#state.actedAfterSteer = undefined;
    this.#steerDelivered = undefined;
    this.#errorsInRow = 0;
    this.#calls = [];
    this.#previousCheck = undefined;
    this.#askedAt = now;
    this.#callsWhenAsked = this.#callCount;
    return true;
  }

  /** The agent completed a tool call and a turn after the steer was delivered, or has been idle a whole period. */
  #actedAfterSteer(now: number): boolean {
    const delivered = this.#steerDelivered;
    if (!delivered || this.#state.steeredAt === undefined) return false;
    if (this.#lastCompletedCall > delivered.calls && this.#turns > delivered.turns) return true;
    return this.#pending.length === 0 && now - this.#state.steeredAt >= this.#options.everyMs;
  }

  /** Why the decision model should be asked now, if at all. */
  #trigger(now: number): string | undefined {
    const { steeredAt } = this.#state;
    // After a steer, the next question waits for the grace and a completed action, then decides whether to stop.
    if (steeredAt !== undefined && this.#askedAt <= steeredAt) {
      return now - steeredAt >= STEER_GRACE_MS && this.#actedAfterSteer(now) ? "after steering" : undefined;
    }
    const fresh = this.#callCount > this.#callsWhenAsked;
    const last = this.#calls.slice(-REPEATS);
    if (fresh && last.length === REPEATS && new Set(last).size === 1) return "repeated tool call";
    if (fresh && this.#errorsInRow >= ERRORS_IN_ROW) return "tool errors in a row";
    if (this.#options.trackDiff && now - Math.max(this.#diffChangedAt, this.#askedAt) >= STALL_MS) return "diff unchanged";
    if (now - this.#askedAt >= this.#options.everyMs) return "periodic";
    return undefined;
  }

  /** Looks at the cheap signals and asks the decision model when one fires; overlapping calls and validation windows are skipped. */
  async check(now = Date.now()): Promise<void> {
    if (!this.#panel.enabled || this.#busy || this.#validating > 0) return;
    this.#busy = true;
    try {
      if (this.#options.trackDiff) {
        const diff = this.#hooks.diffStat();
        if (diff !== this.#diff) {
          this.#diff = diff;
          this.#diffChangedAt = now;
        }
      }
      const trigger = this.#trigger(now);
      if (!trigger) return;
      this.#askedAt = now;
      this.#callsWhenAsked = this.#callCount;
      const running = this.#pending.at(-1);
      const snapshot = {
        turns: this.#turns,
        recent_tool_calls: this.#calls,
        tool_errors: this.#toolErrors,
        tool_outcomes: { ...this.#outcomes },
        recent_tool_results: this.#recentResults,
        running_tool: running ? { tool: running.name, command: running.what, seconds: Math.round((now - running.since) / 1000) } : undefined,
        corrections: this.#corrections,
        diff_stat: this.#options.trackDiff ? this.#diff : undefined,
        last_message: this.#lastMessage,
      };
      const evidence = boundEvidence(
        {
          task: this.#task,
          minutes_elapsed: Math.round((now - this.#started) / 6_000) / 10,
          ...snapshot,
          previous_check: this.#previousCheck ?? null,
        },
        1_500,
      );
      const questions = this.#previousCheck
        ? SUPERVISION_QUESTIONS
        : { worker_stuck: SUPERVISION_QUESTIONS.worker_stuck, work_off_track: SUPERVISION_QUESTIONS.work_off_track };
      const epoch = this.#epoch;
      const { answers, trace } = await this.#panel.decide(evidence, questions);
      // A correction or validation boundary passed while the model was deciding: that verdict is about a run that no longer exists.
      if (epoch !== this.#epoch) return;
      this.#previousCheck = snapshot;
      this.#state.actedAfterSteer = this.#actedAfterSteer(now);
      const action = supervise(answers, this.#state, now);
      if (action.action === "steer") {
        await this.#hooks.steer(action.message);
        // Delivered: only what the agent does from here on counts as acting on it.
        this.#state.steeredAt = now;
        this.#steerDelivered = { calls: this.#callCount, turns: this.#turns };
      }
      if (action.action === "stop") this.#hooks.stop(action.reason);
      this.records.push({ at: new Date(now).toISOString(), trace, action: { ...action, trigger } });
    } finally {
      this.#busy = false;
    }
  }
}
