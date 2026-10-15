// Sources: where tasks come from and where their progress goes. Start calls
// `slackSource` for executions whose input has source "slack".

import { Store } from "@mork/store";
import { draftIssue, findIssueKey, Jira, jiraReporter } from "./jira.ts";
import { loadSecrets } from "./secrets.ts";
import { Slack, slackReporter } from "./slack.ts";
import { type Pending, type ThreadStore, threadKey } from "./threads.ts";
import type { Complete, ReportEvent, Reporter, SlackRef, SlackStart, TrackerIssue } from "./types.ts";

export { deliverAnswer } from "./answers.ts";
export { GitHubAuth, type GitHubTokenSource, githubAuthFromEnv } from "./github-auth.ts";
export { adfToText, draftByRules, findIssueKey, Jira } from "./jira.ts";
export { emitPhase, emitRun, type PhaseRecord, runSnapshot, usage } from "./observability.ts";
export { type EventLog, eventLog, type Logger, logged, noLogger, OtlpLogger, redact, resourceAttributes, type Severity } from "./otlp.ts";
export { loadSecrets } from "./secrets.ts";
export { escapeSlack, executionUrl, grafanaLiveUrl, Slack, STATUS, slackText, statusOf } from "./slack.ts";
export { asksForStatus, statusText, taskKey } from "./status.ts";
export { type AnswerRecord, answersKey, answersSoFar, type Pending, pendingQuestion, threadKey } from "./threads.ts";
export * from "./types.ts";

/** The message asked for no change; the requester has been told, nothing else happens. */
export class NotARequestError extends Error {
  constructor(ask: string) {
    super(`not a request: ${ask.slice(0, 200)}`);
    this.name = "NotARequest";
  }
}

/** Reports to every target; one failing target never fails the task. */
export function allOf(reporters: Reporter[], log: (error: unknown) => void = console.error): Reporter {
  return {
    report: async (event: ReportEvent) => {
      const results = await Promise.allSettled(reporters.map((r) => r.report(event)));
      for (const result of results) if (result.status === "rejected") log(result.reason);
    },
  };
}

export type SlackSource = {
  /** The Jira issue the request names, or a new Story or Bug for it. */
  resolve(input: SlackStart): Promise<TrackerIssue>;
  /**
   * Short updates into the Slack thread; PR, handover and clarify also go on
   * the Jira issue once there is one (a Start that fails before resolving has none).
   */
  reporter(input: SlackStart, work?: TrackerIssue): Reporter;
  /**
   * Asks the requester in the thread and parks the run's task token under the
   * thread; the Slack intake sends the answer back with SendTaskSuccess.
   */
  askInThread(input: SlackStart, work: TrackerIssue | undefined, question: AskedQuestion): Promise<void>;
};

export type AskedQuestion = {
  question: string;
  /** Phase to (re)run after the answer. */
  resume: Pending["resume"];
  prefix: string;
  taskToken: string;
  executionArn: string;
};

export function slackSource(slack: Slack, jira: Jira, complete?: Complete, store?: ThreadStore): SlackSource {
  const reporter = (input: SlackStart, work?: TrackerIssue) =>
    allOf(work ? [slackReporter(slack, input.ref), jiraReporter(jira, work.key)] : [slackReporter(slack, input.ref)]);
  return {
    async resolve(input) {
      const key = findIssueKey(input.ask);
      if (key) return jira.issue(key);
      const draft = await draftIssue(input.ask, complete);
      if (draft.type === "none") {
        await slackReporter(slack, input.ref).report({ kind: "not_a_request" });
        throw new NotARequestError(input.ask);
      }
      return jira.create(
        input.jira_project,
        {
          ...draft,
          description: `${draft.description}\n\nRequested in Slack, thread ${input.ref.channel}/${input.ref.thread_ts}.`,
        },
        input.jira_components ?? [],
      );
    },
    reporter,
    async askInThread(input, work, asked) {
      if (!store) throw new Error("asking needs the Mork bucket (MORK_BUCKET)");
      const pending: Pending = {
        task_token: asked.taskToken,
        execution_arn: asked.executionArn,
        prefix: asked.prefix,
        resume: asked.resume,
        question: asked.question,
        asked_by_user: input.ref.user,
        jira_key: work?.key,
        asked_at: new Date().toISOString(),
      };
      // Parked before it is posted, so a quick answer always finds the token.
      await store.putJson(threadKey(input.ref), pending);
      await reporter(input, work).report({ kind: "question", text: asked.question });
    },
  };
}

/**
 * For a phase container: reports its own progress into the Slack thread.
 * Needs SLACK_BOT_TOKEN (or SLACK_BOT_TOKEN_SECRET_ID) in the environment.
 */
export async function slackThreadReporterFromEnv(env: NodeJS.ProcessEnv, ref: SlackRef): Promise<Reporter> {
  await loadSecrets(env, ["SLACK_BOT_TOKEN"]);
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required");
  return allOf([slackReporter(new Slack(env.SLACK_BOT_TOKEN), ref)]);
}

/** Needs SLACK_BOT_TOKEN and JIRA_* (or their `_SECRET_ID`s) in the environment. */
export async function slackSourceFromEnv(env: NodeJS.ProcessEnv, complete?: Complete): Promise<SlackSource> {
  await loadSecrets(env, ["SLACK_BOT_TOKEN", "JIRA_API_TOKEN"]);
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required");
  return slackSource(new Slack(env.SLACK_BOT_TOKEN), Jira.fromEnv(env), complete, env.MORK_BUCKET ? Store.fromEnv(env) : undefined);
}
