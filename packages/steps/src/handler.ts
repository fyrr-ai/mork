// Lambda entry for the steps between containers. Step Functions invokes it
// with { action, state } and keeps whatever it returns. A step that hands the
// task to a person throws HandoverError, which the state's Catch routes.
import { DevelopmentPolicy } from "@mork/contracts/development";
import { panelFromEnv } from "@mork/decision";
import { eventLog, githubAuthFromEnv, grafanaLiveUrl, loadSecrets, logged, type SlackSource, slackSourceFromEnv } from "@mork/sources";
import { Store } from "@mork/store";
import { DynamoStore } from "@mork/timeline/dynamo";
import { ask, type Deps, decide, type FlowState, handover, start } from "./flow.ts";
import { GitHub } from "./github.ts";
import { llmFromEnv } from "./llm.ts";
import { githubReporter, type StartInput } from "./origin.ts";
import { executionRunning, stopStations } from "./stations.ts";
import { type WorkflowEvent, workflowAction, workflowSlack } from "./workflow.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Start gets the execution input as is ({ repo, issue } or SlackStart) and the execution name beside it. */
export type StepEvent =
  | {
      action: "start";
      input: DistributiveOmit<StartInput, "execution" | "execution_arn">;
      execution: string;
      execution_arn: string;
      policy?: unknown;
    }
  | { action: "decide" | "handover"; state: FlowState }
  | { action: "ask"; state: FlowState; task_token: string };

let deps: Deps | undefined;

async function getDeps(): Promise<Deps> {
  if (deps) return deps;
  await loadSecrets(process.env, ["LLM_API_KEY", "JEV_API", "OPENAI_API_KEY"]);
  const auth = await githubAuthFromEnv(process.env);
  const github = new GitHub(auth.token);
  const llm = llmFromEnv(process.env);
  let slackSource: Promise<SlackSource> | undefined;
  // Slack and Jira credentials are only loaded for tasks that come from Slack.
  const slack = () => {
    slackSource ??= slackSourceFromEnv(process.env, llm);
    return slackSource;
  };
  deps = {
    github,
    panel: panelFromEnv(process.env),
    timeline: DynamoStore.fromEnv(process.env),
    llm,
    liveLog: (execution) => grafanaLiveUrl(execution, process.env.MORK_GRAFANA_URL, process.env.MORK_GRAFANA_LOKI_UID),
    reporter: async (task) => {
      if (task.origin.kind === "github") return githubReporter(github, task.repo, task.origin.issue, task.id);
      const { work } = task.origin;
      return (await slack()).reporter(task.origin.start, work ? { ...work, body: "" } : undefined);
    },
    resolveSlack: async (input) => (await slack()).resolve(input),
    tellSlack: async (input, event) => (await slack()).reporter(input).report(event),
    askRequester: async (task, q) => {
      if (task.origin.kind !== "slack") throw new Error("only Slack tasks can ask");
      const work = task.origin.work ? { ...task.origin.work, body: "" } : undefined;
      await (await slack()).askInThread(task.origin.start, work, {
        question: q.question,
        resume: q.resume,
        prefix: q.prefix,
        taskToken: q.taskToken,
        executionArn: task.execution_arn ?? "",
      });
    },
    store: Store.fromEnv(process.env),
    log: (task, kind, detail) => events.log(kind, { task, ...(detail ? { detail } : {}) }),
    stopStations,
    executionRunning,
  };
  return deps;
}

const events = eventLog(process.env, "steps");

export const handler = (event: StepEvent | WorkflowEvent): Promise<unknown> => logged(events, () => handle(event));

async function handle(event: StepEvent | WorkflowEvent): Promise<unknown> {
  if (event.action.startsWith("workflow."))
    return workflowAction({ store: Store.fromEnv(process.env), slack: await workflowSlack() }, event as WorkflowEvent);
  const d = await getDeps();
  switch (event.action) {
    case "start":
      return start({ ...d, development: event.policy === undefined ? undefined : DevelopmentPolicy.parse(event.policy) }, {
        ...event.input,
        execution: event.execution,
        execution_arn: event.execution_arn,
      } as StartInput);
    case "decide":
      return decide(d, event.state);
    case "handover":
      return handover(d, event.state);
    case "ask":
      // Nothing to return: the state machine waits until the answer arrives with this token.
      await ask(d, event.state, event.task_token);
      return {};
  }
}
