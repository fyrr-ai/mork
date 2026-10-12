// Reads a run for the status reply: the execution and the state it is in.
import { DescribeExecutionCommand, GetExecutionHistoryCommand, SendTaskSuccessCommand, type SFNClient } from "@aws-sdk/client-sfn";
import type { AnswerOutput } from "./answers.ts";
import type { Run } from "./status.ts";

/** A lost SendTaskSuccess response can mean the callback already succeeded. */
export async function resumeAnswer(sfn: Pick<SFNClient, "send">, executionArn: string, taskToken: string, output: AnswerOutput): Promise<void> {
  try {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
    return;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== "TaskTimedOut" && name !== "InvalidToken" && name !== "TaskDoesNotExist") throw error;
    let nextToken: string | undefined;
    do {
      const history = await sfn.send(
        new GetExecutionHistoryCommand({ executionArn, reverseOrder: true, maxResults: 1000, includeExecutionData: true, nextToken }),
      );
      for (const event of history.events ?? []) {
        const result = event.taskSucceededEventDetails?.output;
        if (!result) continue;
        try {
          if ((JSON.parse(result) as { answer_event?: unknown }).answer_event === output.answer_event) return;
        } catch {
          // Other task outputs are unrelated to this callback.
        }
      }
      nextToken = history.nextToken;
    } while (nextToken);
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (execution.status !== "RUNNING") throw error;
    // History may lag behind a successful callback. Preserve the claim and let
    // the next Slack delivery reconcile it rather than erase an accepted answer.
    throw new Error("answer callback outcome is not yet visible in execution history");
  }
}

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
