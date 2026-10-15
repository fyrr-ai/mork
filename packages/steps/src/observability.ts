import { DescribeExecutionCommand, GetExecutionHistoryCommand, type HistoryEvent, SFNClient } from "@aws-sdk/client-sfn";
import { Brief, IssueDoc, keys, RunResult } from "@mork/contracts";
import { RunContext, type RunStatus } from "@mork/contracts/observability";
import { emitPhase, emitRun, type Logger, type PhaseRecord, type Slack, usage } from "@mork/sources";
import type { Store } from "@mork/store";
import { z } from "zod";
import type { Dismissed, FlowState } from "./flow.ts";
import type { StartInput } from "./origin.ts";

export async function attachRun(
  store: Pick<Store, "json">,
  input: StartInput,
  state: FlowState | Dismissed,
  startedAt: number,
  log: Logger,
  slack?: Slack,
): Promise<void> {
  if (!("brief" in state)) return;
  const issue = await store
    .json(keys.issue(state.brief.prefix))
    .then((value) => IssueDoc.parse(value))
    .catch((error: Error) => {
      log.log(`Cannot read dashboard issue metadata: ${error.message}`, { "mork.event": "metadata" }, "WARN");
      const work = state.task.origin.kind === "slack" ? state.task.origin.work : undefined;
      const ref = work?.key ?? (state.task.origin.kind === "github" ? `#${state.task.origin.issue}` : "");
      return { ref, title: work?.title ?? ref };
    });
  const ref = state.task.origin.kind === "slack" ? state.task.origin.start.ref : undefined;
  const person =
    ref && slack
      ? await slack.requester(ref).catch((error: Error) => {
          log.log(`Cannot resolve Slack requester: ${error.message}`, { "mork.event": "metadata" }, "WARN");
          return undefined;
        })
      : undefined;
  const context = RunContext.parse({
    run_id: input.execution,
    repository: state.task.repo,
    issue: issue.ref,
    issue_url:
      state.task.origin.kind === "slack"
        ? (state.task.origin.work?.url ?? "")
        : `https://github.com/${state.task.repo}/issues/${state.task.origin.issue}`,
    title: issue.title.slice(0, 500),
    requested_by_id: person?.id ?? ref?.user ?? input.requested_by ?? null,
    requested_by: person?.name ?? ref?.user ?? input.requested_by ?? null,
    slack_url: person?.url ?? null,
    started_at: startedAt,
    running_since: startedAt,
    pr_url: state.fix?.url ?? null,
  });
  state.brief.run = context;
  emitRun(log, context, "running", startedAt);
}

export const ExecutionEvent = z.object({
  source: z.literal("aws.states"),
  "detail-type": z.literal("Step Functions Execution Status Change"),
  detail: z.object({ executionArn: z.string(), stateMachineArn: z.string(), status: z.enum(["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]) }),
});
export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

const State = z.object({
  brief: Brief.optional(),
  outcome: z.object({ level: z.string(), url: z.string().optional() }).optional(),
  dismissed: z.string().optional(),
});
function output(raw: string | undefined): unknown {
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  return value !== null && typeof value === "object" && "Payload" in value ? value.Payload : value;
}

/** Replay immutable execution history, never infer success/failure from a log message. */
export function terminalSnapshot(
  log: Logger,
  context: RunContext,
  history: HistoryEvent[],
  status: string,
  stoppedAt: number,
  executionOutput?: string,
): void {
  let outcome = State.parse(output(executionOutput) ?? {}).outcome;
  const stats: NonNullable<RunResult["stats"]> = [];
  let completeUsage = true;
  let current: PhaseRecord | undefined;
  const close = (result: "failed" | "interrupted" | "cancelled", at: number) => {
    if (!current) return;
    completeUsage = false;
    emitPhase(log, current, result, `${current.phase.toLowerCase()} · ${result}`, at, undefined, true);
    current = undefined;
  };
  for (const event of history) {
    const at = event.timestamp?.getTime() ?? stoppedAt;
    const scheduled = event.taskScheduledEventDetails;
    if (scheduled?.resourceType === "ecs") {
      const params = z
        .object({
          Overrides: z.object({
            ContainerOverrides: z.array(
              z.object({ Name: z.string(), Environment: z.array(z.object({ Name: z.string(), Value: z.string() })).optional() }),
            ),
          }),
        })
        .safeParse(output(scheduled.parameters));
      const env = params.success
        ? Object.fromEntries(
            params.data.Overrides.ContainerOverrides.find((c) => c.Name === "station")?.Environment?.map((v) => [v.Name, v.Value]) ?? [],
          )
        : {};
      const rawBrief = env.MORK_BRIEF;
      const brief = rawBrief ? Brief.parse(JSON.parse(rawBrief)) : undefined;
      // The phase is carried explicitly by the task definition in current runners. Historical
      // executions may lack run context and are not backfilled by this integration.
      if (brief && env.MORK_PHASE)
        current = {
          run_id: context.run_id,
          step_id: `unstarted-${event.id}`,
          phase: env.MORK_PHASE.charAt(0).toUpperCase() + env.MORK_PHASE.slice(1),
          attempt: brief.attempt,
          started_at: env.MORK_PHASE_STARTED_AT ? Date.parse(env.MORK_PHASE_STARTED_AT) : at,
          model: null,
        };
    }
    const submitted = event.taskSubmittedEventDetails;
    if (current && submitted?.resourceType === "ecs") {
      const tasks = z
        .object({ Tasks: z.array(z.object({ TaskArn: z.string(), TaskDefinitionArn: z.string().optional() })) })
        .safeParse(output(submitted.output));
      const task = tasks.success ? tasks.data.Tasks[0] : undefined;
      if (task) current.step_id = task.TaskArn.split("/").at(-1) ?? current.step_id;
    }
    if (event.taskSucceededEventDetails) {
      const value = output(event.taskSucceededEventDetails.output);
      const state = State.safeParse(value);
      if (state.success && state.data.outcome) outcome = state.data.outcome;
      if (current && event.taskSucceededEventDetails.resourceType === "ecs") {
        const result = RunResult.safeParse(value);
        if (result.success && result.data.stats?.length) stats.push(...result.data.stats);
        else completeUsage = false;
        current = undefined;
      }
    }
    if (event.taskFailedEventDetails || event.taskTimedOutEventDetails || event.taskStartFailedEventDetails || event.taskSubmitFailedEventDetails) {
      close(event.taskFailedEventDetails?.error === "Mork.Interrupted" ? "interrupted" : "failed", at);
    }
  }
  close(status === "ABORTED" ? "cancelled" : "failed", stoppedAt);
  const finalStatus: RunStatus =
    status === "ABORTED"
      ? "cancelled"
      : status !== "SUCCEEDED"
        ? "failed"
        : outcome?.level === "takeover" || !outcome?.url
          ? "handover"
          : "completed";
  emitRun(log, context, finalStatus, stoppedAt, {
    ...usage(completeUsage ? stats : undefined),
    review: outcome?.level ?? null,
    pr_url: outcome?.url ?? context.pr_url,
  });
}

/** EventBridge covers execution timeouts and manual stops, including when no container can report. */
export async function observeExecution(event: ExecutionEvent, log: Logger, client = new SFNClient({})): Promise<void> {
  const execution = await client.send(new DescribeExecutionCommand({ executionArn: event.detail.executionArn }));
  if (!execution.stopDate || execution.status === "RUNNING" || execution.status === "PENDING_REDRIVE") return;
  const history: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetExecutionHistoryCommand({ executionArn: event.detail.executionArn, maxResults: 1000, nextToken }));
    history.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  const contexts = history.flatMap((e) => {
    if (!e.taskSucceededEventDetails) return [];
    const state = State.safeParse(output(e.taskSucceededEventDetails.output));
    return state.success && state.data.brief?.run ? [state.data.brief.run] : [];
  });
  let context = contexts[0];
  if (!context && execution.status !== "SUCCEEDED") {
    const input = z
      .object({
        repo: z.string().optional(),
        issue: z.number().optional(),
        requested_by: z.string().optional(),
        ask: z.string().optional(),
        ref: z.object({ user: z.string() }).optional(),
        fix: z.object({ repo: z.string(), pr: z.number() }).optional(),
      })
      .parse(output(execution.input) ?? {});
    const repository = input.repo ?? input.fix?.repo;
    if (repository && execution.startDate)
      context = {
        run_id: execution.name ?? event.detail.executionArn.split(":").at(-1) ?? event.detail.executionArn,
        repository,
        issue: input.issue ? `#${input.issue}` : "",
        issue_url: input.issue ? `https://github.com/${repository}/issues/${input.issue}` : "",
        title: (input.ask ?? (input.issue ? `Issue #${input.issue}` : "Starting task")).slice(0, 500),
        requested_by_id: input.ref?.user ?? input.requested_by ?? null,
        requested_by: input.ref?.user ?? input.requested_by ?? null,
        slack_url: null,
        started_at: execution.startDate.getTime(),
        running_since: execution.startDate.getTime(),
        pr_url: input.fix ? `https://github.com/${repository}/pull/${input.fix.pr}` : null,
      };
  }
  if (context) terminalSnapshot(log, context, history, execution.status ?? event.detail.status, execution.stopDate.getTime(), execution.output);
}
