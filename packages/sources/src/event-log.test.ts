import { afterAll, expect, test } from "bun:test";
import { eventLog, logged } from "./otlp.ts";

const received: { scope: string; body: string; severity: string }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const payload = (await request.json()) as {
      resourceLogs: { scopeLogs: { scope: { name: string }; logRecords: { body: { stringValue: string }; severityText: string }[] }[] }[];
    };
    for (const scope of payload.resourceLogs[0]?.scopeLogs ?? [])
      for (const record of scope.logRecords) received.push({ scope: scope.scope.name, body: record.body.stringValue, severity: record.severityText });
    return new Response("{}");
  },
});
afterAll(() => server.stop(true));

test("a Lambda's events reach the collector before the invocation returns, failures first", async () => {
  const log = eventLog({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}` }, "steps");
  const done = await logged(log, async () => {
    log.log("task.end", { task: "o/r#1/abc" });
    return "done";
  });
  expect(done).toBe("done");
  await expect(logged(log, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(received.map((r) => [r.scope, JSON.parse(r.body).kind, r.severity])).toEqual([
    ["mork.steps", "task.end", "INFO"],
    ["mork.steps", "invocation.failed", "ERROR"],
  ]);
  expect(JSON.parse(received[0]?.body as string)).toMatchObject({ task: "o/r#1/abc" });
});

test("without a collector the event log only writes stdout", async () => {
  const log = eventLog({}, "intake");
  await logged(log, async () => log.log("ignored", {}));
  expect(received).toHaveLength(2);
});
