// Reads a run for the status reply: the execution and the state it is in.
import { DescribeExecutionCommand, GetExecutionHistoryCommand, type SFNClient } from "@aws-sdk/client-sfn";
import type { Run } from "./status.ts";

export async function describeRun(sfn: SFNClient, executionArn: string): Promise<Run> {
  const execution = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn, reverseOrder: true, maxResults: 50, includeExecutionData: true }));
  const entered = history.events?.find((e) => e.type === "TaskStateEntered" && e.stateEnteredEventDetails?.name);
  let attempt: number | undefined;
  try {
    attempt = (JSON.parse(entered?.stateEnteredEventDetails?.input ?? "{}") as { brief?: { attempt?: number } }).brief?.attempt;
  } catch {
    attempt = undefined;
  }
  return {
    status: execution.status ?? "UNKNOWN",
    startDate: execution.startDate,
    stopDate: execution.stopDate,
    output: execution.output,
    current:
      entered?.stateEnteredEventDetails?.name && entered.timestamp
        ? { name: entered.stateEnteredEventDetails.name, entered: entered.timestamp, attempt }
        : undefined,
  };
}
