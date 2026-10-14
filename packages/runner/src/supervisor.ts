// Supervises an LLM station while Pi runs (thruwire/foreman pattern). Cheap signals
// from the event stream decide when to ask: a repeated tool call, tool errors in a
// row, a diff that stopped changing, or the periodic check. The decision model then
// scores the run from bounded evidence; the code steers once and stops a run that
// stays stuck.
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
const REPEATS = 3;
const ERRORS_IN_ROW = 3;

export type SupervisorOptions = {
  /** Ask at least this often even without a signal. */
  everyMs: number;
  /** The station edits code, so a diff that stops changing is a signal. */
  trackDiff: boolean;
  started?: number;
};

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
  #toolErrors = 0;
  #errorsInRow = 0;
  #lastMessage = "";
  #turns = 0;
  #busy = false;
  #askedAt: number;
  #callsWhenAsked = 0;
  #diff: string | undefined;
  #diffChangedAt: number;

  constructor(panel: DecisionPanel, task: Json, hooks: SupervisorHooks, options: SupervisorOptions) {
    this.#panel = panel;
    this.#task = task;
    this.#hooks = hooks;
    this.#options = options;
    this.#started = options.started ?? Date.now();
    this.#askedAt = this.#started;
    this.#diffChangedAt = this.#started;
  }

  /** Feed every Pi RPC event here. */
  observe(event: Json): void {
    if (event.type === "turn_end") this.#turns += 1;
    if (event.type === "tool_execution_start") {
      this.#calls = [...this.#calls, `${String(event.toolName)} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`].slice(-20);
      this.#callCount += 1;
    }
    if (event.type === "tool_execution_end") {
      this.#errorsInRow = event.isError === true ? this.#errorsInRow + 1 : 0;
      if (event.isError === true) this.#toolErrors += 1;
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

  /** Why the decision model should be asked now, if at all. */
  #trigger(now: number): string | undefined {
    const { steeredAt } = this.#state;
    // After a steer, the next question waits out the grace and decides whether to stop.
    if (steeredAt !== undefined && this.#askedAt <= steeredAt) return now - steeredAt >= STEER_GRACE_MS ? "after steering" : undefined;
    const fresh = this.#callCount > this.#callsWhenAsked;
    const last = this.#calls.slice(-REPEATS);
    if (fresh && last.length === REPEATS && new Set(last).size === 1) return "repeated tool call";
    if (fresh && this.#errorsInRow >= ERRORS_IN_ROW) return "tool errors in a row";
    if (this.#options.trackDiff && now - Math.max(this.#diffChangedAt, this.#askedAt) >= STALL_MS) return "diff unchanged";
    if (now - this.#askedAt >= this.#options.everyMs) return "periodic";
    return undefined;
  }

  /** Looks at the cheap signals and asks the decision model when one fires; overlapping calls are skipped. */
  async check(now = Date.now()): Promise<void> {
    if (!this.#panel.enabled || this.#busy) return;
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
      const evidence = boundEvidence(
        {
          task: this.#task,
          minutes_elapsed: Math.round((now - this.#started) / 6_000) / 10,
          turns: this.#turns,
          recent_tool_calls: this.#calls,
          tool_errors: this.#toolErrors,
          diff_stat: this.#hooks.diffStat(),
          last_message: this.#lastMessage,
        },
        1_500,
      );
      const { answers, trace } = await this.#panel.decide(evidence, SUPERVISION_QUESTIONS);
      const action = supervise(answers, this.#state, now);
      if (action.action === "steer") {
        this.#state.steeredAt = now;
        await this.#hooks.steer(action.message);
      }
      if (action.action === "stop") this.#hooks.stop(action.reason);
      this.records.push({ at: new Date(now).toISOString(), trace, action: { ...action, trigger } });
    } finally {
      this.#busy = false;
    }
  }
}
