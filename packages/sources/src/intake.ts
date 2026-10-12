// Verify and enqueue the Slack event. Jev routing and thread replies run in
// an asynchronous invocation, outside Slack's acknowledgement deadline.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient } from "@aws-sdk/client-sfn";
import { DecisionPanel, JevDecider } from "@mork/decision";
import { Store } from "@mork/store";
import { z } from "zod";
import { deliverAnswer } from "./answers.ts";
import { allOf } from "./index.ts";
import { Jira, jiraReporter } from "./jira.ts";
import { Binding, decideWorkflow, dispatchWorkflow, SlackConfig, selectedWorkflow } from "./routing.ts";
import { loadSecrets } from "./secrets.ts";
import { describeRun, resumeAnswer } from "./sfn-run.ts";
import { parseSlackRequest, Slack, slackReporter, slackSignatureValid } from "./slack.ts";
import { asksForStatus, statusText } from "./status.ts";
import { pendingQuestion } from "./threads.ts";
import { SlackRef } from "./types.ts";

type UrlEvent = {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string; path?: string } };
};
type UrlResult = { statusCode: number; headers?: Record<string, string>; body?: string };
export const Mention = z.object({
  kind: z.literal("mention"),
  event_id: z.string().regex(/^Ev[A-Z0-9]+$/),
  ref: SlackRef,
  ask: z.string().max(12000),
  in_thread: z.boolean(),
});
type Mention = z.infer<typeof Mention>;
const WorkerEvent = z.object({ action: z.literal("slack.mention"), request: Mention });
const RoutingQuestion = z.object({ request: Mention, completed: z.boolean().default(false) });
const routingKey = (ref: SlackRef) => `threads/${ref.channel}/${ref.thread_ts}.routing.json`;
const sfn = new SFNClient({});
const lambda = new LambdaClient({});
let bucketStore: Store | undefined;
function store(): Store {
  bucketStore ??= Store.fromEnv(process.env);
  return bucketStore;
}
const log = (kind: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), kind, detail }));

async function missingJson(store: Pick<Store, "json">, key: string): Promise<unknown | undefined> {
  try {
    return await store.json(key);
  } catch (error) {
    if ((error as { name?: string }).name !== "NoSuchKey") throw error;
    return undefined;
  }
}

export type MentionDeps = {
  store: Store;
  slack: Slack;
  sfn: SFNClient;
  config: SlackConfig;
  panel: DecisionPanel;
  jira?: Jira;
};

/** The actual worker path, also exercised against local HTTP adapters. */
export async function processSlackMention(request: Mention, deps: MentionDeps): Promise<void> {
  const { slack, store, config } = deps;
  if (request.in_thread) {
    const waiting = await missingJson(store, routingKey(request.ref));
    const routing = waiting ? RoutingQuestion.parse(waiting) : undefined;
    if (routing && !routing.completed && !asksForStatus(request.ask)) {
      if (request.ref.user !== routing.request.ref.user) {
        await slack.reply(request.ref, `Only <@${routing.request.ref.user}>, who asked for this task, can choose its workflow.`);
        return;
      }
      await routeMention(routing.request, deps, request.ask, request.event_id);
      return;
    }
    const pending = await pendingQuestion(store, request.ref);
    if (asksForStatus(request.ask) || !pending || pending.answered_at) {
      await slack.reply(request.ref, await statusText({ store, describe: (arn) => describeRun(deps.sfn, arn) }, request.ref));
      return;
    }
    await deliverAnswer(
      {
        store,
        slack,
        reporter: (jiraKey) =>
          allOf(deps.jira && jiraKey ? [slackReporter(slack, request.ref), jiraReporter(deps.jira, jiraKey)] : [slackReporter(slack, request.ref)]),
        resume: (token, output, arn) => resumeAnswer(deps.sfn, arn, token, output),
      },
      { event_id: request.event_id, ref: request.ref, text: request.ask },
    );
    return;
  }
  if (!config.channels[request.ref.channel]) {
    await slack.reply(request.ref, "This channel has no configured workflows.");
    return;
  }
  if (!request.ask.trim()) {
    await slack.reply(request.ref, "Tell me what you want done.");
    return;
  }
  await routeMention(request, deps);
}

async function routeMention(request: Mention, deps: MentionDeps, clarification?: string, answerEvent?: string): Promise<void> {
  const channel = deps.config.channels[request.ref.channel];
  if (!channel) return;
  const bindingKey = `threads/events/${request.event_id}.json`;
  let existing = await missingJson(deps.store, bindingKey);
  let name: string | undefined;
  if (!existing) {
    const decisionKey = `threads/events/${request.event_id}${answerEvent ? `-${answerEvent}` : ""}.decision.json`;
    const saved = await missingJson(deps.store, decisionKey);
    const decision = saved
      ? z.object({ name: z.string().optional(), unavailable: z.boolean().default(false), trace: z.unknown() }).parse(saved)
      : await decideWorkflow(deps.panel, deps.config, channel, request.ask, clarification);
    if (!saved) await deps.store.putJson(decisionKey, decision);
    name = decision.name;
    existing = await missingJson(deps.store, bindingKey);
    if (!existing && !name) {
      if (decision.unavailable) {
        await deps.slack.reply(request.ref, "Jev routing failed. No workflow was started. Please try again.");
        return;
      }
      await deps.store.putJson(routingKey(request.ref), { request, completed: false });
      await deps.slack.reply(
        request.ref,
        `Which workflow should handle this?\n${channel.allowed_workflows.map((workflow) => `• ${workflow}: ${deps.config.workflows[workflow]?.description}`).join("\n")}\nReply in this thread and mention me.`,
      );
      await deps.slack.setStatus(request.ref, "clarify");
      return;
    }
  }
  if (existing) {
    const binding = Binding.parse(existing);
    const original = binding.input;
    const restoredChannel =
      "repo" in original
        ? { ...channel, repo: original.repo, jira_project: original.jira_project, jira_components: original.jira_components }
        : channel;
    await dispatchWorkflow(
      deps,
      {
        name: binding.workflow,
        ask: original.ask,
        route: {
          arn: binding.arn,
          kind: "repo" in original ? "development" : "configured",
          description: "Bound Slack event",
        },
      },
      restoredChannel,
      request,
    );
  } else {
    try {
      if (!name) throw new Error("Routing decision has no workflow");
      const ask = clarification ? `${request.ask}\n\nRequester clarification: ${clarification}` : request.ask;
      await dispatchWorkflow(deps, selectedWorkflow(name, channel, deps.config.workflows, ask), channel, request);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Workflow ")) throw error;
      await deps.slack.reply(request.ref, error.message);
      return;
    }
  }
  await deps.store.putJson(routingKey(request.ref), { request, completed: true });
  log("slack.started", { event: request.event_id, workflow: name ?? Binding.parse(existing).workflow });
}

export async function handler(event: UrlEvent | z.infer<typeof WorkerEvent>): Promise<UrlResult> {
  if ("action" in event) {
    const job = WorkerEvent.parse(event);
    await loadSecrets(process.env, ["SLACK_BOT_TOKEN", "JEV_API"]);
    const config = SlackConfig.parse(await store().json(process.env.SLACK_CONFIG_KEY ?? "config/slack.json"));
    const key = process.env.JEV_API;
    let jira: Jira | undefined;
    if (job.request.in_thread && process.env.JIRA_BASE_URL) {
      await loadSecrets(process.env, ["JIRA_API_TOKEN"]);
      if (process.env.JIRA_API_TOKEN) jira = Jira.fromEnv(process.env);
    }
    await processSlackMention(job.request, {
      store: store(),
      slack: new Slack(process.env.SLACK_BOT_TOKEN ?? ""),
      sfn,
      config,
      jira,
      panel: new DecisionPanel(key ? [new JevDecider(key, process.env.TYPESAFE_BASE_URL, process.env.TYPESAFE_MODEL)] : []),
    });
    return { statusCode: 200 };
  }
  if (event.requestContext?.http?.path === "/health") return { statusCode: 200, body: "ok" };
  if (event.requestContext?.http?.method !== "POST") return { statusCode: 404 };
  await loadSecrets(process.env, ["SLACK_SIGNING_SECRET"]);
  const body = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8").toString("utf8");
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (!slackSignatureValid(process.env.SLACK_SIGNING_SECRET ?? "", body, headers["x-slack-request-timestamp"], headers["x-slack-signature"]))
    return { statusCode: 401 };
  const parsed = parseSlackRequest(body);
  if (parsed.kind === "challenge") return { statusCode: 200, headers: { "content-type": "text/plain" }, body: parsed.challenge };
  if (parsed.kind === "ignored") return { statusCode: 200 };
  const request = Mention.safeParse(parsed);
  if (!request.success) return { statusCode: 200 };
  const invoked = await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.MORK_SLACK_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ action: "slack.mention", request: request.data })),
    }),
  );
  if (invoked.StatusCode !== 202) throw new Error("Slack worker event was not accepted");
  return { statusCode: 200 };
}
