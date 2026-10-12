// Lambda behind a Function URL: Slack Events API intake. Slack wants an
// answer within 3 s, so this only verifies, maps the channel and starts the
// execution; Start resolves the Jira issue. The execution is named after the
// Slack event, so Slack's retries start nothing twice. A mention inside a
// thread answers the question a run is waiting on there, or asks for status.
import { ExecutionAlreadyExists, SendTaskSuccessCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { Store } from "@mork/store";
import { deliverAnswer } from "./answers.ts";
import { channelsFromEnv } from "./channels.ts";
import { allOf } from "./index.ts";
import { Jira, jiraReporter } from "./jira.ts";
import { loadSecrets } from "./secrets.ts";
import { describeRun } from "./sfn-run.ts";
import { parseSlackRequest, Slack, slackReporter, slackSignatureValid, slackText } from "./slack.ts";
import { asksForStatus, statusText, type ThreadTask, taskKey } from "./status.ts";
import { pendingQuestion } from "./threads.ts";
import type { SlackRef, SlackStart } from "./types.ts";

type UrlEvent = {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string; path?: string } };
};
type UrlResult = { statusCode: number; headers?: Record<string, string>; body?: string };

const sfn = new SFNClient({});
let bucketStore: Store | undefined;
function store(): Store {
  bucketStore ??= Store.fromEnv(process.env);
  return bucketStore;
}

/** A thread waits for an answer when a question is parked there and still open. */
async function waitsForAnswer(threads: Store, ref: SlackRef): Promise<boolean> {
  const pending = await pendingQuestion(threads, ref);
  return pending !== undefined && !pending.answered_at;
}
const log = (kind: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), kind, detail }));

export async function handler(event: UrlEvent): Promise<UrlResult> {
  if (event.requestContext?.http?.path === "/health") return { statusCode: 200, body: "ok" };
  if (event.requestContext?.http?.method !== "POST") return { statusCode: 404 };
  await loadSecrets(process.env, ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"]);
  const body = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8").toString("utf8");
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const secret = process.env.SLACK_SIGNING_SECRET ?? "";
  if (!secret || !slackSignatureValid(secret, body, headers["x-slack-request-timestamp"], headers["x-slack-signature"])) return { statusCode: 401 };

  // Slack retries when the first delivery took over 3 s; that delivery is still being handled.
  if (headers["x-slack-retry-reason"] === "http_timeout") return { statusCode: 200 };

  const request = parseSlackRequest(body);
  if (request.kind === "challenge") return { statusCode: 200, headers: { "content-type": "text/plain" }, body: request.challenge };
  if (request.kind === "ignored") return { statusCode: 200 };

  const slack = new Slack(process.env.SLACK_BOT_TOKEN ?? "");
  if (request.in_thread && (asksForStatus(request.ask) || !(await waitsForAnswer(store(), request.ref)))) {
    await slack.reply(request.ref, await statusText({ store: store(), describe: (arn) => describeRun(sfn, arn) }, request.ref));
    log("slack.status", { thread: request.ref.thread_ts });
    return { statusCode: 200 };
  }
  if (request.in_thread) {
    await loadSecrets(process.env, ["JIRA_API_TOKEN"]);
    const jira = process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN ? Jira.fromEnv(process.env) : undefined;
    const outcome = await deliverAnswer(
      {
        store: store(),
        slack,
        reporter: (jiraKey) =>
          allOf(jira && jiraKey ? [slackReporter(slack, request.ref), jiraReporter(jira, jiraKey)] : [slackReporter(slack, request.ref)]),
        resume: async (taskToken, output) => {
          await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
        },
      },
      { event_id: request.event_id, ref: request.ref, text: request.ask },
    );
    log("slack.answer", { thread: request.ref.thread_ts, outcome });
    return { statusCode: 200 };
  }
  const channel = channelsFromEnv(process.env)[request.ref.channel];
  if (!channel) {
    log("slack.unmapped", { channel: request.ref.channel });
    await slack.reply(request.ref, "This channel is not linked to a repository, so I will not start anything here.");
    return { statusCode: 200 };
  }
  if (!request.ask) {
    await slack.reply(request.ref, slackText({ kind: "not_a_request" }));
    return { statusCode: 200 };
  }

  const input: SlackStart = {
    repo: channel.repo,
    source: "slack",
    ref: request.ref,
    ask: request.ask,
    jira_project: channel.jira_project,
    jira_components: channel.jira_components,
  };
  try {
    const started = await sfn.send(
      new StartExecutionCommand({ stateMachineArn: process.env.STATE_MACHINE_ARN, name: `slack-${request.event_id}`, input: JSON.stringify(input) }),
    );
    log("slack.started", { repo: channel.repo, event: request.event_id, execution: started.executionArn });
    const task: ThreadTask = { execution_arn: started.executionArn ?? "", started_at: new Date().toISOString() };
    await store().putJson(taskKey(request.ref), task);
    await slack.setStatus(request.ref, "received");
  } catch (error) {
    if (!(error instanceof ExecutionAlreadyExists)) throw error;
    log("slack.duplicate", { event: request.event_id });
  }
  return { statusCode: 200 };
}
