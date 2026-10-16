import { expect, test } from "bun:test";
import { keys } from "@mork/contracts";
import type { RunContext } from "@mork/contracts/observability";
import type { FlowState } from "./flow.ts";

const prefix = "tasks/o/r/1/abc";
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
const state: FlowState = {
  task: { id: "o/r#1/abc", repo: "o/r", started_by: "", origin: { kind: "github", issue: 1 } },
  brief: {
    run: context,
    execution: "run-1",
    task: "PROJ-1",
    attempt: 1,
    prefix,
    branch: "mork/issue-1-abc",
    repo: { full_name: "o/r", default_branch: "main", base_sha: "a".repeat(40) },
  },
  last: { ok: true, passed: true },
};

// Invoke the real Lambda entrypoint and SDK clients against local HTTP adapters.
// No workflow-status event or execution-history API is available to these runs.
test.each(["completed", "handover", "retry"] as const)("%s is reported directly by the normal step handler", async (scenario) => {
  const records: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const objects = new Map<string, unknown>([
    [keys.issue(prefix), { ref: "#1", title: "Fix the test", body: null }],
    [
      keys.plan(prefix),
      {
        problem: "p",
        plan: ["s"],
        risks: [],
        security_sensitive: false,
        acceptance_criteria: [{ id: "AC1", text: "The fix works", testable: true }],
        hidden_tests: [],
      },
    ],
    [keys.impl(prefix, 1), { summary: "Fixed", changes: [{ path: "test.ts", change: "fix" }], verification: [], deviations: [] }],
    [keys.gate(prefix, 1), { mode: "after", head_sha: "b".repeat(40), hidden: [] }],
    [
      keys.review(prefix, 1),
      { summary: "ok", files_reviewed: ["test.ts"], unreviewed_files: [], incomplete: [], criteria: [], findings: [], read_first: [] },
    ],
  ]);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/logs") {
        const body = await req.json();
        for (const scope of body.resourceLogs[0].scopeLogs)
          for (const record of scope.logRecords) {
            const value = JSON.parse(record.body.stringValue);
            if (value.event === "run.snapshot") records.push(value);
          }
        return Response.json({});
      }
      const target = req.headers.get("x-amz-target");
      if (target?.startsWith("DynamoDB_")) return Response.json({});
      if (url.pathname.startsWith("/repos/o/r/")) {
        if (url.pathname.includes("/git/ref/")) return Response.json({ object: { sha: (scenario === "handover" ? "a" : "b").repeat(40) } });
        if (url.pathname.includes("/commits/")) return Response.json({ commit: { message: "fix: test" } });
        if (url.pathname.endsWith("/pulls"))
          return Response.json(req.method === "GET" ? [] : { number: 7, html_url: "https://github.com/o/r/pull/7" });
        return Response.json({});
      }
      if (url.pathname.startsWith("/local-bucket/")) {
        const key = decodeURIComponent(url.pathname.slice("/local-bucket/".length));
        const etag = `"${Bun.hash(JSON.stringify(objects.get(key)) ?? "")}"`;
        if (req.method === "PUT") {
          if (
            (req.headers.get("if-none-match") === "*" && objects.has(key)) ||
            (req.headers.has("if-match") && req.headers.get("if-match") !== etag)
          ) {
            return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
          }
          objects.set(key, await req.json());
          return new Response("");
        }
        if (key === keys.feedback(prefix, 2)) return new Response("Fix the failing check");
        if (objects.has(key)) return Response.json(objects.get(key), { headers: { ETag: etag } });
        return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      }
      unexpected.push(`${req.method} ${url.pathname} ${target ?? ""}`);
      return new Response("Unexpected request", { status: 400 });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const event = {
      action: scenario === "handover" ? "handover" : "decide",
      state: { ...state, ...(scenario === "retry" ? { last: { ok: true, passed: false } } : {}) },
    };
    const child = Bun.spawn(
      [
        "bun",
        "--eval",
        `const originalFetch = globalThis.fetch;
        globalThis.fetch = (url, init) => originalFetch(String(url).replace("https://api.github.com", ${JSON.stringify(endpoint)}), init);
        const {handler} = await import(${JSON.stringify(new URL("./handler.ts", import.meta.url).pathname)});
        const event = ${JSON.stringify(event)};
        const result = await handler(event);
        if (event.action === "handover") {
          const replay = await handler(event);
          if (!replay.replayed) throw new Error("Completed handover was not idempotent");
        }
        console.log(JSON.stringify(result));`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          AWS_REGION: "eu-west-1",
          AWS_ACCESS_KEY_ID: "local",
          AWS_SECRET_ACCESS_KEY: "local",
          AWS_ENDPOINT_URL: endpoint,
          GITHUB_TOKEN: "local",
          MORK_BUCKET: "local-bucket",
          MORK_TIMELINE_TABLE: "local-timeline",
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          MORK_ENV: "test",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [error, stdout, code] = await Promise.all([new Response(child.stderr).text(), new Response(child.stdout).text(), child.exited]);
    expect(code, error).toBe(0);
    expect(unexpected).toEqual([]);
    if (scenario === "retry") {
      expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({ next: "build" });
      expect(records).toEqual([]);
    } else {
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: "run.snapshot",
        run_id: "run-1",
        status: scenario,
        review: scenario === "handover" ? "takeover" : "careful",
        pr_url: scenario === "handover" ? null : "https://github.com/o/r/pull/7",
        tokens: null,
        cost_usd: null,
      });
    }
  } finally {
    server.stop(true);
  }
});
