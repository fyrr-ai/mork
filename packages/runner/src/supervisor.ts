// Supervises the implementer while Pi runs (thruwire/foreman pattern): at a
// fixed interval the decision model scores the run from bounded evidence;
// the code steers once and then stops a run that stays stuck.
import { boundEvidence, type DecisionPanel, type DecisionTrace, SUPERVISION_QUESTIONS, type Supervision, supervise } from "@mork/decision";

type Json = Record<string, unknown>;

export type SupervisionRecord = { at: string; trace: DecisionTrace; action: Json };

export type SupervisorHooks = {
  /** Current `git diff --stat` against the base, run as the agent user. */
  diffStat: () => string;
  steer: (message: string) => Promise<void>;
  stop: (reason: string) => void;
};

export class Supervisor {
  readonly records: SupervisionRecord[] = [];
  readonly #panel: DecisionPanel;
  readonly #task: Json;
  readonly #hooks: SupervisorHooks;
  readonly #started = Date.now();
  readonly #state: Supervision = {};
  #calls: string[] = [];
  #toolErrors = 0;
  #lastMessage = "";
  #turns = 0;
  #busy = false;

  constructor(panel: DecisionPanel, task: Json, hooks: SupervisorHooks) {
    this.#panel = panel;
    this.#task = task;
    this.#hooks = hooks;
  }

  /** Feed every Pi RPC event here. */
  observe(event: Json): void {
    if (event.type === "turn_end") this.#turns += 1;
    if (event.type === "tool_execution_start") {
      this.#calls = [...this.#calls, `${String(event.toolName)} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`].slice(-20);
    }
    if (event.type === "tool_execution_end" && event.isError === true) this.#toolErrors += 1;
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

  /** One supervision check; overlapping calls are skipped. */
  async check(now = Date.now()): Promise<void> {
    if (!this.#panel.enabled || this.#busy) return;
    this.#busy = true;
    try {
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
      this.records.push({ at: new Date(now).toISOString(), trace, action });
    } finally {
      this.#busy = false;
    }
  }
}
