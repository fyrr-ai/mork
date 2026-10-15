import { expect, test } from "bun:test";
import type { RunContext } from "@mork/contracts/observability";
import { emitPhase, runSnapshot, usage } from "./observability.ts";
import type { Logger } from "./otlp.ts";

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

test("status changed stays fixed while work continues and advances after an answer", () => {
  expect(runSnapshot(context, "running", 4000)).toMatchObject({ updated_at: 1000, observed_at: 4000, duration_s: 3, range_end: "now" });
  expect(runSnapshot(context, "waiting", 5000)).toMatchObject({ updated_at: 5000 });
  expect(runSnapshot({ ...context, resume: { at: new Date(6000).toISOString() } }, "running", 7000)).toMatchObject({ updated_at: 6000 });
  expect(runSnapshot(context, "completed", 8000)).toMatchObject({ updated_at: 8000, range_end: 308000 });
});

test("usage is unknown when a provider or station did not report it; known zero remains zero", () => {
  expect(usage(undefined)).toEqual({ tokens: null, cost_usd: null, turns: null });
  expect(usage([{ station: "analyst", turns: 2, tokens: 0, cost: 0 }])).toEqual({ tokens: 0, cost_usd: 0, turns: 2 });
  expect(
    usage([
      { station: "criteria", turns: 2, tokens: 20, cost: 0.1 },
      { station: "ocr", turns: 1, tokens: 30 },
    ]),
  ).toEqual({ tokens: 50, cost_usd: null, turns: 3 });
  expect(usage([{ station: "analyst", turns: 2 }]).tokens).toBeNull();
});

test("phase events retain real step IDs and clean messages, with no presentation codes", () => {
  const records: { body: string; attrs: unknown }[] = [];
  const log: Logger = {
    log: (body, attrs) => {
      records.push({ body, attrs });
    },
    with: () => log,
    flush: async () => {},
  };
  const phase = { run_id: "run-1", step_id: "ecs-id", phase: "Build", attempt: 2, started_at: 1000, model: "model" };
  emitPhase(log, phase, "running", "build started", 1000);
  emitPhase(log, phase, "passed", "build finished", 3000, [{ station: "implementer", tokens: 100, turns: 2, cost: 0.2 }]);
  expect(records.map((r) => JSON.parse(r.body))).toMatchObject([
    { event: "phase", step_id: "ecs-id", result: "running", tokens: null },
    { event: "phase", step_id: "ecs-id", result: "passed", duration_s: 2, tokens: 100 },
  ]);
  expect(records[1]?.attrs).toMatchObject({ "mork.step": "ecs-id", "mork.event": "phase", "mork.message": "build finished" });
  expect(records.some((r) => r.body.includes("\u001b"))).toBe(false);
});
