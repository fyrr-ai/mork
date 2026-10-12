import { afterEach, beforeEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SFNClient } from "@aws-sdk/client-sfn";
import { DecisionPanel, JevDecider } from "@mork/decision";
import { LocalStore } from "@mork/store/local";
import { workflowAction } from "../../steps/src/workflow.ts";
import { Mention, processSlackMention } from "./intake.ts";
import { decideWorkflow, SlackConfig } from "./routing.ts";
import { Slack } from "./slack.ts";
import { taskKey } from "./status.ts";
import { threadKey } from "./threads.ts";

const machine = (name: string) => `arn:aws:states:us-east-1:123456789012:stateMachine:mork_${name}`;
const config = SlackConfig.parse({
  channels: { CDEMO: { default_workflow: "analysis", allowed_workflows: ["analysis", "dashboard"] } },
  workflows: {
    analysis: { arn: machine("analysis"), kind: "configured", description: "Analyze data and return a report." },
    dashboard: { arn: machine("dashboard"), kind: "configured", description: "Build a Grafana dashboard." },
    development: { arn: machine("development"), kind: "development", description: "Implement software and open a PR." },
  },
});
const request = Mention.parse({
  kind: "mention",
  event_id: "Ev1",
  ref: { kind: "slack", channel: "CDEMO", thread_ts: "1.0", user: "U1" },
  ask: "dashboard latency",
  in_thread: false,
});
let directory: string;
let store: LocalStore;
let server: ReturnType<typeof Bun.serve>;
const nativeFetch = globalThis.fetch;
let calls: { path: string; target: string; body: any }[];
let choice: string;
let confidence: number;
let failStart: boolean;
let failDecision: boolean;
let failSlack: boolean;
let deps: Parameters<typeof processSlackMention>[1];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mork-routing-"));
  store = new LocalStore(directory);
  calls = [];
  choice = "dashboard";
  confidence = 0.99;
  failStart = false;
  failDecision = false;
  failSlack = false;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as any;
      const target = req.headers.get("x-amz-target") ?? "";
      calls.push({ path, target, body });
      if (path === "/v1/systemone") {
        if (failDecision) return new Response("offline", { status: 503 });
        return Response.json({ answers: { workflow: { choice, confidence, probabilities: { [choice]: confidence } } } });
      }
      if (target.endsWith("StartExecution")) {
        if (failStart) return Response.json({ __type: "ServiceUnavailable", message: "offline" }, { status: 503 });
        return Response.json({ executionArn: `${body.stateMachineArn.replace(":stateMachine:", ":execution:")}:${body.name}`, startDate: 0 });
      }
      if (path === "/chat.postMessage" && failSlack) return Response.json({ ok: false, error: "ratelimited" });
      return Response.json({ ok: true });
    },
  });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return nativeFetch(url.startsWith("https://slack.com/api/") ? `${server.url}${url.split("/api/")[1]}` : input, init);
  }) as typeof fetch;
  deps = {
    store,
    slack: new Slack("test-bot"),
    config,
    panel: new DecisionPanel([new JevDecider("test-jev", server.url.origin)]),
    sfn: new SFNClient({
      region: "us-east-1",
      endpoint: server.url.origin,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    }),
  };
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

test("even a named workflow goes through Jev; only channel workflows are offered", async () => {
  await processSlackMention(request, deps);
  const decision = calls.find((call) => call.path === "/v1/systemone");
  assert(decision);
  expect(Object.keys(decision.body.questions.workflow.criteria)).toEqual(["analysis", "dashboard", "_clarify"]);
  expect(decision.body.state.request).toBe("dashboard latency");
  const start = calls.find((call) => call.target.endsWith("StartExecution"));
  assert(start);
  expect(start.body.stateMachineArn).toBe(machine("dashboard"));
  expect(JSON.parse(start.body.input)).toMatchObject({ workflow: "dashboard", ask: "dashboard latency" });
  expect(await store.json(taskKey(request.ref))).toMatchObject({ workflow: "dashboard" });
});

test("an unavailable or low-confidence choice starts nothing and asks the requester", async () => {
  for (const selected of ["development", "_clarify", "dashboard"]) {
    choice = selected;
    confidence = selected === "dashboard" ? 0.5 : 0.99;
    await processSlackMention({ ...request, event_id: `Ev${selected.toUpperCase().replaceAll("_", "")}` }, deps);
  }
  expect(calls.filter((call) => call.target.endsWith("StartExecution"))).toHaveLength(0);
  expect(calls.some((call) => call.path === "/chat.postMessage" && call.body.text.includes("Which workflow"))).toBe(true);
});

test("a Jev outage and no configured provider never use the channel default", async () => {
  failDecision = true;
  await processSlackMention(request, deps);
  await processSlackMention({ ...request, event_id: "Ev2" }, { ...deps, panel: new DecisionPanel([]) });
  expect(calls.filter((call) => call.target.endsWith("StartExecution"))).toHaveLength(0);
  expect(calls.filter((call) => call.path === "/chat.postMessage").every((call) => call.body.text.includes("Jev routing failed"))).toBe(true);
});

test("only the requester can clarify, and Jev chooses again with that clarification", async () => {
  choice = "_clarify";
  await processSlackMention(request, deps);
  choice = "analysis";
  await processSlackMention({ ...request, event_id: "Ev2", in_thread: true, ask: "Analyze it", ref: { ...request.ref, user: "U2" } }, deps);
  expect(calls.filter((call) => call.path === "/v1/systemone")).toHaveLength(1);
  await processSlackMention({ ...request, event_id: "Ev3", in_thread: true, ask: "Analyze it" }, deps);
  expect(calls.findLast((call) => call.path === "/v1/systemone")?.body.state.clarification).toBe("Analyze it");
  expect(calls.find((call) => call.target.endsWith("StartExecution"))?.body.name).toBe("slack-Ev1");
  expect(JSON.parse(calls.find((call) => call.target.endsWith("StartExecution"))?.body.input).ask).toContain("Analyze it");
});

test("a failed start retry keeps its original route across a configuration change", async () => {
  failStart = true;
  await expect(processSlackMention(request, deps)).rejects.toThrow();
  expect(calls.some((call) => call.path === "/chat.postMessage" && call.body.text.includes("could not start"))).toBe(true);
  failStart = false;
  choice = "analysis";
  const changed = structuredClone(config);
  assert(changed.workflows.dashboard);
  changed.workflows.dashboard.arn = machine("new_dashboard");
  await processSlackMention(request, { ...deps, config: changed });
  expect(calls.filter((call) => call.path === "/v1/systemone")).toHaveLength(1);
  expect(calls.filter((call) => call.target.endsWith("StartExecution")).map((call) => call.body.stateMachineArn)).toEqual([
    machine("dashboard"),
    machine("dashboard"),
  ]);
});

test("routing refuses a secondary provider even when it gives a confident answer", async () => {
  const other = new DecisionPanel([
    {
      name: "openai",
      decide: async () => ({ workflow: { type: "choice" as const, choice: "dashboard", confidence: 1, probabilities: { dashboard: 1 } } }),
    },
  ]);
  expect(
    (
      await decideWorkflow(
        other,
        config,
        config.channels.CDEMO ??
          (() => {
            throw new Error("Missing fixture channel");
          })(),
        "dashboard",
      )
    ).name,
  ).toBeUndefined();
});

test("a duplicate event preserves the thread receipt and does not reset a finished status", async () => {
  await processSlackMention(request, deps);
  const receipt = await store.json(taskKey(request.ref));
  await deps.slack.setStatus(request.ref, "ready");
  const updates = calls.filter((call) => call.path.startsWith("/reactions.")).length;
  await processSlackMention(request, deps);
  expect(await store.json(taskKey(request.ref))).toEqual(receipt);
  expect(calls.filter((call) => call.path.startsWith("/reactions."))).toHaveLength(updates);
  expect(calls.filter((call) => call.path === "/v1/systemone")).toHaveLength(1);
});

test("approval requires an explicit requester answer and sends a boolean callback", async () => {
  const run = {
    request: { source: "slack" as const, workflow: "dashboard", ask: request.ask, ref: request.ref },
    execution: "slack-Ev1",
    execution_arn: `${machine("dashboard").replace(":stateMachine:", ":execution:")}:slack-Ev1`,
  };
  await workflowAction(
    { store, slack: deps.slack },
    {
      action: "workflow.approval",
      run,
      step: { name: "publish", kind: "approval", instructions: "Publish?", inputs: [], timeout_seconds: 7200, retries: 0 },
      task_token: "test-token",
    },
  );
  expect(await store.json(threadKey(request.ref))).toMatchObject({ approval: true, resume: "publish", asked_by_user: "U1" });
  await processSlackMention({ ...request, event_id: "Ev2", in_thread: true, ask: "approve", ref: { ...request.ref, user: "U2" } }, deps);
  await processSlackMention({ ...request, event_id: "Ev3", in_thread: true, ask: "looks fine" }, deps);
  expect(calls.filter((call) => call.target.endsWith("SendTaskSuccess"))).toHaveLength(0);
  await processSlackMention({ ...request, event_id: "Ev4", in_thread: true, ask: "reject" }, deps);
  const output = JSON.parse(calls.find((call) => call.target.endsWith("SendTaskSuccess"))?.body.output);
  expect(output).toMatchObject({ approved: false, resume: "publish", answer_event: "Ev4" });
  await workflowAction(
    { store, slack: deps.slack },
    {
      action: "workflow.approval",
      run,
      step: { name: "publish", kind: "approval", instructions: "Publish?", inputs: [], timeout_seconds: 7200, retries: 0 },
      task_token: "test-token-2",
    },
  );
  await processSlackMention({ ...request, event_id: "Ev5", in_thread: true, ask: "approve" }, deps);
  const approved = JSON.parse(calls.findLast((call) => call.target.endsWith("SendTaskSuccess"))?.body.output);
  expect(approved).toMatchObject({ approved: true, answer_event: "Ev5" });
  await workflowAction({ store, slack: deps.slack }, { action: "workflow.approved", run, step: "publish", approved: true });
  expect(await store.json("tasks/workflows/dashboard/slack-Ev1/steps/publish/output.json")).toMatchObject({ output: { approved: true, by: "U1" } });
});

const workflowRun = () => ({
  request: { source: "slack" as const, workflow: "dashboard", ask: request.ask, ref: request.ref },
  execution: "slack-Ev1",
  execution_arn: `${machine("dashboard").replace(":stateMachine:", ":execution:")}:slack-Ev1`,
});

test("workflow start persists the request, refuses mismatched routing and reports the run", async () => {
  const run = workflowRun();
  const event = {
    action: "workflow.start" as const,
    workflow: "dashboard",
    input: run.request,
    execution: run.execution,
    execution_arn: run.execution_arn,
  };
  expect(await workflowAction({ store, slack: deps.slack }, event)).toEqual(run);
  expect(await store.json("tasks/workflows/dashboard/slack-Ev1/run.json")).toEqual(run);
  expect(calls.some((call) => call.path === "/chat.postMessage" && call.body.text.includes("Starting dashboard"))).toBe(true);
  await expect(workflowAction({ store, slack: deps.slack }, { ...event, workflow: "analysis" })).rejects.toThrow("does not match");
});

test("report delivers the selected artifact and does not mark a missing result ready", async () => {
  const run = workflowRun();
  const key = "tasks/workflows/dashboard/slack-Ev1/steps/create/output.json";
  await store.putJson(key, { output: { report: "Dashboard ready", id: 42 } });
  expect(await workflowAction({ store, slack: deps.slack }, { action: "workflow.report", run, step: "create" })).toEqual({
    workflow: "dashboard",
    output_key: key,
  });
  expect(calls.some((call) => call.path === "/chat.postMessage" && call.body.text.includes("Dashboard ready"))).toBe(true);
  calls = [];
  await expect(workflowAction({ store, slack: deps.slack }, { action: "workflow.report", run, step: "missing" })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("approval stores the complete inputs before exposing the question", async () => {
  const run = workflowRun();
  const prefix = "tasks/workflows/dashboard/slack-Ev1";
  await store.putJson(`${prefix}/steps/create/output.json`, { output: { report: "Inspect me", total: 42 } });
  await workflowAction(
    { store, slack: deps.slack },
    {
      action: "workflow.approval",
      run,
      step: { name: "publish", kind: "approval", instructions: "Publish?", inputs: ["create"], timeout_seconds: 7200, retries: 0 },
      task_token: "approval-input-token",
    },
  );
  expect(await store.json(`${prefix}/steps/publish/review.json`)).toEqual({ create: { report: "Inspect me", total: 42 } });
  expect(
    calls.some((call) => call.path === "/chat.postMessage" && call.body.text.includes("Inspect me") && call.body.text.includes("review.json")),
  ).toBe(true);
});

test("failed cleanup still notifies Slack, records the cause and remains retryable", async () => {
  const run = workflowRun();
  const error = { Error: "CommandFailed", Cause: "fixture failed" };
  const groups: string[] = [];
  let fail = true;
  const wf = {
    store,
    slack: deps.slack,
    stop: async (group: string) => {
      groups.push(group);
      if (fail) throw new Error("ECS offline");
      return 1;
    },
  };
  await expect(workflowAction(wf, { action: "workflow.failed", run, error })).rejects.toThrow("cleanup or notification failed");
  expect(calls.some((call) => call.path === "/chat.postMessage" && call.body.text.includes("dashboard failed"))).toBe(true);
  expect(await store.json("tasks/workflows/dashboard/slack-Ev1/status.json")).toEqual({ status: "failed", error });
  fail = false;
  expect(await workflowAction(wf, { action: "workflow.failed", run, error })).toEqual({});
  expect(groups).toEqual([run.execution_arn, run.execution_arn]);
});

test("a Slack outage cannot prevent ECS cleanup and preserves the failure artifact", async () => {
  failSlack = true;
  const run = workflowRun();
  const error = { Error: "StationError", Cause: "bootstrap failed" };
  const stopped: string[] = [];
  await expect(
    workflowAction(
      {
        store,
        slack: deps.slack,
        stop: async (group) => {
          stopped.push(group);
          return 1;
        },
      },
      { action: "workflow.failed", run, error },
    ),
  ).rejects.toThrow("cleanup or notification failed");
  expect(stopped).toEqual([run.execution_arn]);
  expect(await store.json("tasks/workflows/dashboard/slack-Ev1/status.json")).toEqual({ status: "failed", error });
});

test("start retries resume a failed notification and preserve the manifest and completed status", async () => {
  const run = workflowRun();
  const event = {
    action: "workflow.start" as const,
    workflow: "dashboard",
    input: run.request,
    execution: run.execution,
    execution_arn: run.execution_arn,
  };
  failSlack = true;
  await expect(workflowAction({ store, slack: deps.slack }, event)).rejects.toThrow();
  const original = await store.json("tasks/workflows/dashboard/slack-Ev1/run.json");
  failSlack = false;
  await workflowAction({ store, slack: deps.slack }, event);
  calls = [];
  await workflowAction({ store, slack: deps.slack }, event);
  expect(calls).toHaveLength(0);
  expect(await store.json("tasks/workflows/dashboard/slack-Ev1/run.json")).toEqual(original);
});

test("approval and report show agent-controlled mentions and links as literal text", async () => {
  const run = workflowRun();
  const text = "<!channel> <https://evil.example/approve|Official result> & text";
  await store.putJson("tasks/workflows/dashboard/slack-Ev1/steps/create/output.json", { output: { report: text } });
  await workflowAction({ store, slack: deps.slack }, { action: "workflow.report", run, step: "create" });
  await workflowAction(
    { store, slack: deps.slack },
    {
      action: "workflow.approval",
      run,
      step: { kind: "approval", name: "publish", instructions: "Review & approve", inputs: ["create"], timeout_seconds: 7200, retries: 0 },
      task_token: "fixture",
    },
  );
  for (const call of calls.filter((call) => call.path === "/chat.postMessage")) {
    expect(call.body.text).not.toContain("<!channel>");
    expect(call.body.text).not.toContain("<https://evil.example");
    expect(call.body.text).toContain("&lt;!channel&gt;");
    expect(call.body.text).toContain("&amp;");
    expect(call.body.text).toContain("<https://s3.console.aws.amazon.com");
  }
});
