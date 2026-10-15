import { afterAll, expect, test } from "bun:test";
import type { HistoryEvent } from "@aws-sdk/client-sfn";
import type { Brief } from "@mork/contracts";
import type { RunContext } from "@mork/contracts/observability";
import type { Logger } from "@mork/sources";
import { terminalSnapshot } from "./observability.ts";

const context: RunContext = {
  run_id: "run-1",
  repository: "o/r",
  issue: "PROJ-1",
  title: "Fix a test",
  issue_url: "https://jira.example/PROJ-1",
  requested_by: "Alex",
  requested_by_id: "U1",
  slack_url: "https://slack.example/thread",
  started_at: 1000,
  running_since: 1000,
  pr_url: null,
};
const brief: Brief = {
  run: context,
  execution: "run-1",
  task: "PROJ-1",
  attempt: 1,
  prefix: "tasks/o/r/1/abc",
  branch: "mork/issue-1-abc",
  repo: { full_name: "o/r", default_branch: "main", base_sha: "a".repeat(40) },
};
const scheduled = (id: number): HistoryEvent => ({
  id,
  type: "TaskScheduled",
  timestamp: new Date(id * 1000),
  taskScheduledEventDetails: {
    resourceType: "ecs",
    resource: "runTask.sync",
    region: "eu-west-1",
    timeoutInSeconds: 600,
    parameters: JSON.stringify({
      Overrides: {
        ContainerOverrides: [
          {
            Name: "station",
            Environment: [
              { Name: "MORK_BRIEF", Value: JSON.stringify(brief) },
              { Name: "MORK_PHASE", Value: "build" },
              { Name: "MORK_PHASE_STARTED_AT", Value: new Date(id * 1000).toISOString() },
            ],
          },
        ],
      },
    }),
  },
});
const submitted = (id: number): HistoryEvent => ({
  id,
  type: "TaskSubmitted",
  timestamp: new Date(id * 1000),
  taskSubmittedEventDetails: {
    resourceType: "ecs",
    resource: "runTask.waitForTaskToken",
    output: JSON.stringify({ Tasks: [{ TaskArn: "arn:aws:ecs:eu-west-1:123456789012:task/cluster/ecs-id" }] }),
  },
});
const success = (id: number): HistoryEvent => ({
  id,
  type: "TaskSucceeded",
  timestamp: new Date(id * 1000),
  taskSucceededEventDetails: {
    resourceType: "ecs",
    resource: "runTask.waitForTaskToken",
    output: JSON.stringify({ ok: true, stats: [{ station: "implementer", turns: 2, tokens: 100, cost: 0.1 }] }),
  },
});
function capture() {
  const records: Record<string, unknown>[] = [];
  const log: Logger = {
    log: (body) => {
      records.push(JSON.parse(body));
    },
    with: () => log,
    flush: async () => {},
  };
  return { log, records };
}

test("completed runs aggregate every successful container callback once", () => {
  const { log, records } = capture();
  terminalSnapshot(
    log,
    context,
    [scheduled(2), submitted(3), success(4), scheduled(5), submitted(6), success(7)],
    "SUCCEEDED",
    8000,
    JSON.stringify({ outcome: { level: "careful", url: "https://github.example/pr/1" } }),
  );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    status: "completed",
    tokens: 200,
    cost_usd: 0.2,
    review: "careful",
    pr_url: "https://github.example/pr/1",
    updated_at: 8000,
  });
});

test("a failed Spot container closes its own step and makes total usage unknown", () => {
  const { log, records } = capture();
  const failed: HistoryEvent = {
    id: 4,
    type: "TaskFailed",
    timestamp: new Date(4000),
    taskFailedEventDetails: { resourceType: "ecs", resource: "runTask.waitForTaskToken", error: "Mork.Interrupted" },
  };
  terminalSnapshot(
    log,
    context,
    [scheduled(2), submitted(3), failed, scheduled(5), submitted(6), success(7)],
    "SUCCEEDED",
    8000,
    JSON.stringify({ outcome: { level: "quick", url: "https://github.example/pr/1" } }),
  );
  expect(records[0]).toMatchObject({ event: "phase", step_id: "ecs-id", result: "interrupted", ended_at: 4000 });
  expect(records.at(-1)).toMatchObject({ status: "completed", tokens: null, cost_usd: null });
});

test.each(["ABORTED", "TIMED_OUT", "FAILED"])("%s closes an unfinished step even without a callback", (status) => {
  const { log, records } = capture();
  terminalSnapshot(log, context, [scheduled(2), submitted(3)], status, 8000);
  expect(records[0]).toMatchObject({ step_id: "ecs-id", result: status === "ABORTED" ? "cancelled" : "failed", ended_at: 8000, authoritative: true });
  expect(records[1]).toMatchObject({ status: status === "ABORTED" ? "cancelled" : "failed", tokens: null });
});

test("success without a PR is never labelled Draft PR ready", () => {
  const { log, records } = capture();
  terminalSnapshot(log, context, [], "SUCCEEDED", 8000);
  expect(records[0]?.status).toBe("handover");
});

// Exercise the deployed Lambda entry, actual AWS SDK HTTP serialization and OTLP delivery.
// Only the external services are replaced with local HTTP adapters.
const delivered: Record<string, unknown>[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.json();
    if (new URL(req.url).pathname === "/v1/logs") {
      for (const scope of body.resourceLogs[0].scopeLogs) for (const record of scope.logRecords) delivered.push(JSON.parse(record.body.stringValue));
      return Response.json({});
    }
    const target = req.headers.get("x-amz-target") ?? "";
    if (target.endsWith("DescribeExecution"))
      return Response.json({
        executionArn: "arn:aws:states:eu-west-1:123456789012:execution:mork:run-1",
        stateMachineArn: "arn:aws:states:eu-west-1:123456789012:stateMachine:mork",
        name: "run-1",
        status: "SUCCEEDED",
        startDate: 1,
        stopDate: 8,
        output: JSON.stringify({ outcome: { level: "quick", url: "https://github.example/pr/1" } }),
      });
    if (target.endsWith("GetExecutionHistory"))
      return Response.json({
        events: body.nextToken
          ? [scheduled(2), submitted(3), success(4)].map((e) => ({ ...e, timestamp: (e.timestamp?.getTime() ?? 0) / 1000 }))
          : [
              {
                id: 1,
                type: "TaskSucceeded",
                timestamp: 1,
                taskSucceededEventDetails: { resourceType: "lambda", resource: "invoke", output: JSON.stringify({ Payload: { brief } }) },
              },
            ],
        ...(body.nextToken ? {} : { nextToken: "page-2" }),
      });
    return new Response(target, { status: 400 });
  },
});
afterAll(() => server.stop(true));

test("terminal handler reads every history page and flushes the snapshot before returning", async () => {
  const event = {
    source: "aws.states",
    "detail-type": "Step Functions Execution Status Change",
    detail: {
      executionArn: "arn:aws:states:eu-west-1:123456789012:execution:mork:run-1",
      stateMachineArn: "arn:aws:states:eu-west-1:123456789012:stateMachine:mork",
      status: "SUCCEEDED",
    },
  };
  const child = Bun.spawn(
    [
      "bun",
      "--eval",
      `import {handler} from ${JSON.stringify(new URL("./handler.ts", import.meta.url).pathname)}; await handler(${JSON.stringify(event)});`,
    ],
    {
      env: {
        ...process.env,
        AWS_PROFILE: "",
        AWS_REGION: "eu-west-1",
        AWS_ACCESS_KEY_ID: "local",
        AWS_SECRET_ACCESS_KEY: "local",
        AWS_ENDPOINT_URL_SFN: `http://127.0.0.1:${server.port}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`,
        MORK_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
  expect(delivered.at(-1)).toMatchObject({ event: "run.snapshot", run_id: "run-1", status: "completed", tokens: 100, review: "quick" });
});
