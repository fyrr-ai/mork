import { IssueDoc, keys } from "@mork/contracts";
import { RunContext } from "@mork/contracts/observability";
import { emitRun, type Logger, type Slack } from "@mork/sources";
import type { Store } from "@mork/store";
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
