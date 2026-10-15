// Slack: verify the Events API request, read an @mention as a task, and
// post short updates into the thread under it.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { REVIEW_LEVEL_TEXT, type ReportEvent, type Reporter, type SlackRef } from "./types.ts";

const MAX_SKEW_SECONDS = 300;

/** Slack signing secret check (v0), with replay protection on the timestamp. */
export function slackSignatureValid(
  secret: string,
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret.trim() || secret.trim().toLowerCase() === "unset") return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`);
  const presented = Buffer.from(signature ?? "");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const Envelope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_verification"), challenge: z.string() }),
  z.object({
    type: z.literal("event_callback"),
    event_id: z.string().regex(/^Ev[A-Z0-9]+$/),
    event: z.object({
      type: z.string(),
      subtype: z.string().optional(),
      bot_id: z.string().optional(),
      user: z.string().optional(),
      text: z.string().default(""),
      channel: z.string(),
      ts: z.string(),
      thread_ts: z.string().optional(),
    }),
  }),
]);

export type SlackRequest =
  | { kind: "challenge"; challenge: string }
  /** `in_thread`: the mention is a reply inside an existing thread, e.g. an answer. */
  | { kind: "mention"; event_id: string; ref: SlackRef; ask: string; in_thread: boolean }
  | { kind: "ignored"; why: string };

/** Reads a verified Events API body. Only human @mentions become tasks. */
export function parseSlackRequest(body: string): SlackRequest {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: "ignored", why: "invalid JSON" };
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success) return { kind: "ignored", why: "unknown payload" };
  const envelope = parsed.data;
  if (envelope.type === "url_verification") return { kind: "challenge", challenge: envelope.challenge };
  const { event } = envelope;
  if (event.type !== "app_mention") return { kind: "ignored", why: `event ${event.type}` };
  if (event.bot_id || event.subtype || !event.user) return { kind: "ignored", why: "not a person" };
  const ask = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  return {
    kind: "mention",
    event_id: envelope.event_id,
    ref: { kind: "slack", channel: event.channel, thread_ts: event.thread_ts ?? event.ts, user: event.user },
    ask,
    in_thread: event.thread_ts !== undefined && event.thread_ts !== event.ts,
  };
}

/** Minimal Web API client: the bot only posts into threads and reacts. */
export class Slack {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    // Status reactions are set idempotently: adding one twice or removing an absent one is fine.
    if (!result.ok && result.error !== "already_reacted" && result.error !== "no_reaction")
      throw new Error(`Slack ${method}: ${result.error ?? response.status}`);
    return result;
  }

  async reply(ref: SlackRef, text: string): Promise<void> {
    await this.call("chat.postMessage", { channel: ref.channel, thread_ts: ref.thread_ts, text, unfurl_links: false, unfurl_media: false });
  }

  /** Resolve a stable filter ID separately from the person's display name. */
  async requester(ref: SlackRef): Promise<{ id: string; name: string; url: string }> {
    const user = z
      .object({
        user: z.object({ name: z.string(), real_name: z.string().optional(), profile: z.object({ display_name: z.string().optional() }).optional() }),
      })
      .parse(await this.call("users.info", { user: ref.user })).user;
    const link = z
      .object({ permalink: z.string().url() })
      .parse(await this.call("chat.getPermalink", { conversation_id: ref.channel, message_ts: ref.thread_ts }));
    return { id: ref.user, name: user.profile?.display_name || user.real_name || user.name, url: link.permalink };
  }

  /**
   * Shows the task's state as the one status reaction on the thread's first
   * message: the new one goes on before the others come off, so it is never blank.
   */
  async setStatus(ref: SlackRef, status: Status): Promise<void> {
    const target = { channel: ref.channel, timestamp: ref.thread_ts };
    await this.call("reactions.add", { ...target, name: STATUS[status] });
    for (const [other, name] of Object.entries(STATUS)) {
      if (other !== status) await this.call("reactions.remove", { ...target, name });
    }
  }
}

/**
 * Status reaction per state: seen, working, checking, draft PR waiting for a
 * person's review, handed over (no PR, a person takes the task), question.
 */
export const STATUS = {
  received: "black_circle",
  working: "hourglass_flowing_sand",
  checking: "mag",
  ready: "eyes",
  handover: "hand",
  clarify: "question",
} as const;
export type Status = keyof typeof STATUS;

export function statusOf(event: ReportEvent): Status {
  switch (event.kind) {
    case "started":
    case "plan":
    case "build":
      return "working";
    case "built":
      return "checking";
    case "check":
      return event.passed ? "checking" : "working";
    case "repair":
      return "working";
    case "pr":
    case "fixed":
      return "ready";
    case "fix":
      return "working";
    case "handover":
      return "handover";
    case "clarify":
    case "question":
    case "not_a_request":
      return "clarify";
    case "answered":
      return "working";
  }
}

/** Literal task/model text must not become Slack mentions or labeled links. */
export function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const link = (url: string | undefined, text: string) => (url ? `<${url}|${escapeSlack(text)}>` : escapeSlack(text));
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const bullets = (items: string[]) => items.map((item) => `• ${escapeSlack(item)}`).join("\n");

/** `https://github.com/owner/repo/pull/27` → `owner/repo#27`. */
function prLabel(url: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
}

/**
 * One short message per event, a bold label first; details live in Jira, the
 * PR and the run. Empty when the thread already shows it (an answer).
 */
export function slackText(event: ReportEvent): string {
  switch (event.kind) {
    case "started": {
      const head = `*${event.work.created ? "Created" : "Taking"} ${link(event.work.url, event.work.key)}:* ${escapeSlack(event.work.title)}`;
      const links = [
        event.live_url ? link(event.live_url, "Live log in Grafana") : undefined,
        event.execution_url ? link(event.execution_url, "View the workflow run") : undefined,
      ].filter(Boolean);
      return links.length ? `${head}\n${links.join(" · ")}` : head;
    }
    case "clarify":
      return `*Before I start, I need a few answers:*\n${escapeSlack(event.questions)}`;
    case "not_a_request":
      return "*Nothing to do:* this does not look like a request for a change. Tell me what to build or fix, for example `add a padLeft helper to src/strings.mjs` or `implement PROJ-123`.";
    case "question":
      // A list of questions starts on its own line; a single question stays inline.
      return `*Question:*${/^\s*[-*•]/.test(event.text) ? "\n" : " "}${escapeSlack(event.text.trim())}\nReply in this thread and mention me with your answer.`;
    case "answered":
      return "";
    case "plan":
      return `*Plan ready:* ${event.criteria} acceptance ${event.criteria === 1 ? "criterion" : "criteria"}${event.hidden_tests ? `, ${count(event.hidden_tests, "hidden test")}` : ""}`;
    case "build":
      return `*Implementing:* attempt ${event.attempt} of ${event.max}`;
    case "built":
      return `*Pushed:* ${link(event.branch_url, event.branch)}${event.files ? ` (${count(event.files, "file")} changed)` : ""}, running checks`;
    case "check":
      if (event.passed) return "*Checks passed:* repository tests, hidden tests and review";
      return `*Checks failed* (attempt ${event.attempt})${event.failures?.length ? `\n${bullets(event.failures)}` : ""}`;
    case "repair":
      return `*Review found ${count(event.findings.length, "defect")}, fixing before the PR:*\n${bullets(event.findings)}`;
    case "pr":
      return `*Draft PR ready:* ${link(event.url, prLabel(event.url))}\n*Recommendation:* ${REVIEW_LEVEL_TEXT[event.level]}${event.reasons.length ? `\n${bullets(event.reasons)}` : ""}${event.transcripts_url ? `\n${link(event.transcripts_url, "Agent transcripts")}` : ""}`;
    case "handover":
      return `*Handed over to a person:* ${escapeSlack(event.reason.split("\n")[0]?.slice(0, 300) ?? "")}${event.pr_url ? `\n*Draft PR:* ${link(event.pr_url, prLabel(event.pr_url))}` : ""}`;
    case "fix":
      return `*Fixing ${link(event.pr_url, prLabel(event.pr_url))}:* ${escapeSlack(event.trigger)} (round ${event.round} of ${event.max})`;
    case "fixed":
      return `*Fix pushed to ${link(event.pr_url, prLabel(event.pr_url))}:* ${escapeSlack(event.summary.split("\n")[0]?.slice(0, 300) ?? "")}`;
  }
}

export function slackReporter(slack: Slack, ref: SlackRef): Reporter {
  return {
    report: async (event) => {
      const text = slackText(event);
      if (text) await slack.reply(ref, text);
      await slack.setStatus(ref, statusOf(event));
    },
  };
}

/**
 * Grafana Explore on the agent's live log for one run: Loki, filtered by the
 * `mork_execution` attribute the runner puts on every line. Undefined when no
 * Grafana is configured (`MORK_GRAFANA_URL`).
 */
export function grafanaLiveUrl(executionName: string, grafana: string | undefined, lokiUid = "loki"): string | undefined {
  if (!grafana) return undefined;
  const expr = `{service_name="mork"} | mork_execution=${JSON.stringify(executionName)}`;
  const panes = {
    live: {
      datasource: lokiUid,
      queries: [{ refId: "A", expr, datasource: { type: "loki", uid: lokiUid } }],
      range: { from: "now-6h", to: "now" },
    },
  };
  return `${grafana}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

/** AWS console link to a Step Functions execution, from its ARN ($$.Execution.Id). */
export function executionUrl(executionArn: string): string {
  const region = executionArn.split(":")[3];
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/v2/executions/details/${executionArn}`;
}
