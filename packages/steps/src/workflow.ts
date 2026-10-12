import { StepName, stepOutputKey, WorkflowName, WorkflowRequest, WorkflowRun, WorkflowStep, workflowPrefix } from "@mork/contracts/workflow";
import { escapeSlack, executionUrl, loadSecrets, Slack } from "@mork/sources";
import { threadKey } from "@mork/sources/threads";
import type { Store } from "@mork/store";
import { z } from "zod";
import { stopStations } from "./stations.ts";

const Event = z.discriminatedUnion("action", [
  z.object({ action: z.literal("workflow.start"), workflow: WorkflowName, input: WorkflowRequest, execution: z.string(), execution_arn: z.string() }),
  z.object({ action: z.literal("workflow.approval"), run: WorkflowRun, step: WorkflowStep, task_token: z.string().min(1) }),
  z.object({ action: z.literal("workflow.report"), run: WorkflowRun, step: StepName }),
  z.object({ action: z.literal("workflow.approved"), run: WorkflowRun, step: StepName, approved: z.literal(true) }),
  z.object({ action: z.literal("workflow.failed"), run: WorkflowRun, error: z.unknown() }),
]);
export type WorkflowEvent = z.infer<typeof Event>;
export type WorkflowDeps = { store: Store; slack: Pick<Slack, "reply" | "setStatus">; stop?: (group: string) => Promise<number> };

/** Separate from development adapters: no GitHub token, Jira or LLM credentials. */
export async function workflowAction(deps: WorkflowDeps, input: WorkflowEvent): Promise<unknown> {
  const event = Event.parse(input);
  if (event.action === "workflow.start") {
    if (event.input.workflow !== event.workflow) throw new Error("Request workflow does not match the state machine");
    const run = WorkflowRun.parse({ request: event.input, execution: event.execution, execution_arn: event.execution_arn });
    const prefix = workflowPrefix(run.request.workflow, run.execution);
    if (!(await deps.store.claim(`${prefix}/run.json`, run))) {
      const saved = WorkflowRun.parse(await deps.store.json(`${prefix}/run.json`));
      if (JSON.stringify(saved) !== JSON.stringify(run)) throw new Error("Workflow execution already has a different request");
    }
    const notification = `${prefix}/steps/_start/notification.json`;
    try {
      await deps.store.json(notification);
      return run;
    } catch (error) {
      if ((error as Error).name !== "NoSuchKey") throw error;
    }
    // Retry failed status/reply calls. A confirmed notification is not posted again.
    await deps.slack.setStatus(run.request.ref, "working");
    await deps.slack.reply(run.request.ref, `*Starting ${event.workflow}*\n<${executionUrl(run.execution_arn)}|View the workflow run>`);
    await deps.store.putJson(notification, { sent: true });
    return run;
  }
  const { run } = event;
  const prefix = workflowPrefix(run.request.workflow, run.execution);
  if (event.action === "workflow.approval") {
    if (event.step.kind !== "approval") throw new Error("Expected an approval step");
    const inputs: Record<string, unknown> = {};
    for (const name of event.step.inputs) {
      inputs[name] = ((await deps.store.json(stepOutputKey(prefix, name))) as { output: unknown }).output;
    }
    const key = `${prefix}/steps/${event.step.name}/review.json`;
    await deps.store.putJson(key, inputs);
    await deps.store.putJson(threadKey(run.request.ref), {
      task_token: event.task_token,
      execution_arn: run.execution_arn,
      prefix,
      resume: event.step.name,
      approval: true,
      question: event.step.instructions,
      asked_by_user: run.request.ref.user,
      asked_at: new Date().toISOString(),
    });
    await deps.slack.reply(
      run.request.ref,
      `*Approval required:* ${escapeSlack(event.step.instructions)}\n${escapeSlack(JSON.stringify(inputs, null, 2).slice(0, 2000))}\n<${artifactUrl(deps.store.bucket, key)}|Full inputs>\nReply with \`@mork approve\` or \`@mork reject\`.`,
    );
    await deps.slack.setStatus(run.request.ref, "clarify");
    return {};
  }
  if (event.action === "workflow.failed") {
    // Keep the original failure durable even when cleanup or Slack is unavailable.
    await deps.store.putJson(`${prefix}/status.json`, { status: "failed", error: event.error });
    const results = await Promise.allSettled([
      (deps.stop ?? stopStations)(run.execution_arn),
      (async () => {
        await deps.slack.reply(run.request.ref, `*${run.request.workflow} failed.*\n<${executionUrl(run.execution_arn)}|Inspect the workflow run>`);
        await deps.slack.setStatus(run.request.ref, "handover");
      })(),
    ]);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Workflow failure cleanup or notification failed");
    return {};
  }
  if (event.action === "workflow.approved") {
    await deps.store.putJson(stepOutputKey(prefix, event.step), { output: { approved: true, by: run.request.ref.user } });
    await deps.slack.setStatus(run.request.ref, "working");
    return {};
  }
  const key = stepOutputKey(prefix, event.step);
  const { output } = (await deps.store.json(key)) as { output: unknown };
  const report =
    output && typeof output === "object" && "report" in output && typeof output.report === "string" ? output.report : JSON.stringify(output, null, 2);
  await deps.slack.reply(
    run.request.ref,
    `*${run.request.workflow} complete*\n${escapeSlack(report.slice(0, 3000))}\n<${artifactUrl(deps.store.bucket, key)}|Full result>`,
  );
  await deps.slack.setStatus(run.request.ref, "ready");
  return { workflow: run.request.workflow, output_key: key };
}

function artifactUrl(bucket: string, key: string): string {
  return `https://s3.console.aws.amazon.com/s3/object/${bucket}?prefix=${encodeURIComponent(key)}`;
}

export async function workflowSlack(): Promise<Slack> {
  await loadSecrets(process.env, ["SLACK_BOT_TOKEN"]);
  if (!process.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required");
  return new Slack(process.env.SLACK_BOT_TOKEN);
}
