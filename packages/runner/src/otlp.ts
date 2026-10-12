// Live log of a phase for Grafana: one readable line per thing the agent or
// the gate does, shipped as OTLP/HTTP JSON to the central Alloy, which fans
// out to Loki. Batched; a failing collector costs log lines, never the phase.
import { redact } from "./session.ts";

export type Severity = "INFO" | "WARN" | "ERROR";
export type LogAttrs = Record<string, string | number | boolean | undefined>;

const SEVERITY_NUMBER: Record<Severity, number> = { INFO: 9, WARN: 13, ERROR: 17 };
const BATCH_MS = 2_000;
const BATCH_SIZE = 50;
const MAX_BODY = 4_000;

type Record_ = { timeUnixNano: string; severityNumber: number; severityText: Severity; body: { stringValue: string }; attributes: unknown[] };

const attributes = (attrs: LogAttrs) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([key, v]) => ({
      key,
      value: typeof v === "number" ? { intValue: String(v) } : typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v) },
    }));

export interface Logger {
  log(body: string, attrs?: LogAttrs, severity?: Severity): void;
  /** A logger whose records all carry `attrs` too. */
  with(attrs: LogAttrs): Logger;
  flush(): Promise<void>;
}

export class OtlpLogger implements Logger {
  readonly #url: string;
  readonly #resource: unknown[];
  readonly #secrets: () => string[];
  readonly #base: LogAttrs;
  readonly #queue: Record_[];
  readonly #state: { timer?: ReturnType<typeof setTimeout>; sending: Promise<void>; warned: boolean };

  constructor(opts: { endpoint: string; resource: LogAttrs; secrets: () => string[]; base?: LogAttrs }, shared?: OtlpLogger) {
    this.#url = shared ? shared.#url : `${opts.endpoint.replace(/\/$/, "")}/v1/logs`;
    this.#resource = shared ? shared.#resource : attributes(opts.resource);
    this.#secrets = opts.secrets;
    this.#base = opts.base ?? {};
    // Child loggers share the parent's queue so one flush sends everything.
    this.#queue = shared ? shared.#queue : [];
    this.#state = shared ? shared.#state : { sending: Promise.resolve(), warned: false };
  }

  with(attrs: LogAttrs): Logger {
    return new OtlpLogger({ endpoint: "", resource: {}, secrets: this.#secrets, base: { ...this.#base, ...attrs } }, this);
  }

  log(body: string, attrs: LogAttrs = {}, severity: Severity = "INFO"): void {
    const text = redact(body, this.#secrets());
    this.#queue.push({
      timeUnixNano: `${Date.now()}000000`,
      severityNumber: SEVERITY_NUMBER[severity],
      severityText: severity,
      body: { stringValue: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text },
      attributes: attributes({ ...this.#base, ...attrs }),
    });
    if (this.#queue.length >= BATCH_SIZE) void this.flush();
    else this.#state.timer ??= setTimeout(() => void this.flush(), BATCH_MS);
  }

  async flush(): Promise<void> {
    clearTimeout(this.#state.timer);
    this.#state.timer = undefined;
    const batch = this.#queue.splice(0);
    if (!batch.length) return this.#state.sending;
    const resource = this.#resource;
    this.#state.sending = this.#state.sending.then(async () => {
      try {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope: { name: "mork.runner" }, logRecords: batch }] }],
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`OTLP ${response.status}`);
      } catch (error) {
        if (!this.#state.warned) console.error(JSON.stringify({ kind: "otlp.unavailable", error: (error as Error).message }));
        this.#state.warned = true;
      }
    });
    return this.#state.sending;
  }
}

/** Keeps the call sites unconditional when no collector is configured. */
export const noLogger: Logger = { log: () => undefined, with: () => noLogger, flush: async () => undefined };
