// Stops station containers that are still running when a task is handed over.
// Step Functions starts them with ECS Group = the task's started_by value.
import { DescribeTasksCommand, ECSClient, ListTasksCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";

const ecs = new ECSClient({});
const sfn = new SFNClient({});

/** A fix run claims its PR while it runs; a claim of a finished execution is stale. */
export async function executionRunning(executionArn: string): Promise<boolean> {
  try {
    const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    return status === "RUNNING";
  } catch {
    return false;
  }
}

export async function stopStations(group: string): Promise<number> {
  const cluster = process.env.ECS_CLUSTER;
  if (!cluster) throw new Error("ECS_CLUSTER is required");
  let stopped = 0;
  let nextToken: string | undefined;
  do {
    const listed = await ecs.send(new ListTasksCommand({ cluster, desiredStatus: "RUNNING", nextToken }));
    nextToken = listed.nextToken;
    if (!listed.taskArns?.length) continue;
    const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: listed.taskArns }));
    for (const task of (described.tasks ?? []).filter((t) => t.group === group && t.taskArn)) {
      await ecs.send(new StopTaskCommand({ cluster, task: task.taskArn, reason: "mork handover" }));
      stopped++;
    }
  } while (nextToken);
  return stopped;
}
