import { afterAll, describe, expect, test } from "bun:test";
import { type Logger, OtlpLogger } from "@mork/sources";
import { logPiEvent } from "./llm.ts";

const bodies: unknown[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    bodies.push(await req.json());
    return new Response("{}");
  },
});
afterAll(() => server.stop());

describe("otlp logger", () => {
  test("batches redacted records with resource and per-station attributes", async () => {
    const root = new OtlpLogger({
      endpoint: `http://127.0.0.1:${server.port}`,
      resource: { "service.name": "mork", "team.name": "engineering" },
      secrets: () => ["sk-secret-value-123"],
      base: { "mork.execution": "slack-Ev1" },
    });
    const station = root.with({ "mork.station": "implementer", "mork.attempt": 2 });
    station.log("bash: echo sk-secret-value-123", { "mork.event": "tool_call", "mork.tool": "bash" });
    station.log("bash failed", { "mork.event": "tool_result" }, "ERROR");
    await root.flush();
    const sent = bodies[0] as {
      resourceLogs: {
        resource: { attributes: { key: string }[] };
        scopeLogs: {
          logRecords: { body: { stringValue: string }; severityText: string; attributes: { key: string; value: Record<string, unknown> }[] }[];
        }[];
      }[];
    };
    expect(sent.resourceLogs[0]?.resource.attributes.map((a) => a.key)).toEqual(["service.name", "team.name"]);
    const records = sent.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
    expect(records.map((r) => r.body.stringValue)).toEqual(["bash: echo [redacted]", "bash failed"]);
    expect(records[1]?.severityText).toBe("ERROR");
    expect(Object.fromEntries((records[0]?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]))).toEqual({
      "mork.execution": "slack-Ev1",
      "mork.station": "implementer",
      "mork.attempt": "2",
      "mork.event": "tool_call",
      "mork.tool": "bash",
    });
  });
  test("an unreachable collector never throws", async () => {
    const logger = new OtlpLogger({ endpoint: "http://127.0.0.1:9", resource: {}, secrets: () => [] });
    logger.log("x");
    await logger.flush();
  });
});

describe("pi events as log lines", () => {
  test("tool calls, results and text read as one line each", () => {
    const lines: [string, string | undefined, string | undefined][] = [];
    const log: Logger = {
      log: (body, attrs, sev) => void lines.push([body, attrs?.["mork.event"] as string, sev]),
      with: () => log,
      flush: async () => undefined,
    };
    logPiEvent(log, "implementer", { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }, 3);
    logPiEvent(
      log,
      "implementer",
      { type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "1 failing" }] } },
      3,
    );
    logPiEvent(
      log,
      "implementer",
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "<think>hm</think>Fixing the test." }] } },
      3,
    );
    logPiEvent(log, "implementer", { type: "message_end", message: { role: "user", content: [{ type: "text", text: "x" }] } }, 3);
    expect(lines).toEqual([
      ["implementer · bash: npm test", "tool_call", undefined],
      ["implementer · bash failed: …1 failing", "tool_result", "ERROR"],
      ["implementer · Fixing the test.", "text", undefined],
    ]);
  });
});
