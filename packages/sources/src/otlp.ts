// Logs for Grafana, shipped as OTLP/HTTP JSON to a collector (e.g. Alloy, which
// fans out to Loki). The runner's live log has one readable line per thing the
// agent or the gate does; Lambdas log one JSON line per event. Batched; a
// failing collector costs log lines, never the work.

/** Replaces every secret value (and its JSON-escaped form) in `text`. */
export function redact(text: string, secrets: string[], minimumLength = 8): string {
  let out = text;
  for (const secret of secrets)
    if (secret && secret.length >= minimumLength) {
      out = out.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
      out = out.split(secret).join("[redacted]");
    }
  return out;
}

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
  readonly #scope: string;
  readonly #resource: unknown[];
  readonly #secrets: () => string[];
  readonly #base: LogAttrs;
  readonly #queue: Record_[];
  readonly #state: { timer?: ReturnType<typeof setTimeout>; sending: Promise<void>; warned: boolean };

  constructor(opts: { endpoint: string; resource: LogAttrs; secrets: () => string[]; base?: LogAttrs; scope?: string }, shared?: OtlpLogger) {
    this.#url = shared ? shared.#url : `${opts.endpoint.replace(/\/$/, "")}/v1/logs`;
    this.#scope = shared ? shared.#scope : (opts.scope ?? "mork.runner");
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
    const secrets = this.#secrets();
    const text = redact(body, secrets);
    const safeAttrs = Object.fromEntries(
      Object.entries({ ...this.#base, ...attrs }).map(([key, value]) => [key, typeof value === "string" ? redact(value, secrets) : value]),
    );
    // Truncating a dashboard record would make it invalid JSON and hide its state change.
    const structured = attrs["mork.event"] === "run.snapshot" || (attrs["mork.event"] === "phase" && text.startsWith("{"));
    this.#queue.push({
      timeUnixNano: `${Date.now()}000000`,
      severityNumber: SEVERITY_NUMBER[severity],
      severityText: severity,
      body: { stringValue: !structured && text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text },
      attributes: attributes(safeAttrs),
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
            resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope: { name: this.#scope }, logRecords: batch }] }],
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

/** OTEL_RESOURCE_ATTRIBUTES (`key=value,key=value`) as resource attributes. */
export function resourceAttributes(raw: string | undefined): LogAttrs {
  const pairs = (raw ?? "").split(",").map((pair) => pair.split("=", 2).map((part) => part.trim()));
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== ""));
}

export type EventLog = {
  records: Logger;
  with(attrs: LogAttrs): EventLog;
  log(kind: string, detail?: Record<string, unknown>): void;
  flush(): Promise<void>;
};

/**
 * A Lambda's log: one JSON line per event on stdout and, with
 * OTEL_EXPORTER_OTLP_ENDPOINT set, the same line to the collector. Call
 * `flush` before the handler returns; a frozen Lambda sends nothing.
 */
export function eventLog(env: NodeJS.ProcessEnv, service: string): EventLog {
  const otlp = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OtlpLogger({
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        resource: {
          "service.name": "mork",
          "deployment.environment.name": env.MORK_ENV,
          "mork.function": service,
          ...resourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
        },
        secrets: () =>
          [env.SLACK_BOT_TOKEN, env.GITHUB_TOKEN, env.LLM_API_KEY, env.JEV_API, env.OPENAI_API_KEY].filter((s): s is string => Boolean(s)),
        scope: `mork.${service}`,
      })
    : noLogger;
  const scoped = (records: Logger): EventLog => ({
    records,
    with: (attrs) => scoped(records.with(attrs)),
    log(kind, detail) {
      const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...detail });
      console.log(line);
      records.log(
        line,
        { "mork.event": kind, "mork.task": typeof detail?.task === "string" ? detail.task : undefined },
        kind.endsWith("failed") || kind === "error" ? "ERROR" : "INFO",
      );
    },
    flush: () => records.flush(),
  });
  return scoped(otlp);
}

/** Runs one Lambda invocation and sends its log before the Lambda freezes; a failure is logged first. */
export async function logged<T>(log: EventLog, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    log.log("invocation.failed", { error: (error as Error).message?.slice(0, 2_000) });
    throw error;
  } finally {
    await log.flush();
  }
}
