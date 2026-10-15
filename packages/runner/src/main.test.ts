import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const records: { body: string; attributes: { key: string; value: { stringValue?: string } }[] }[] = [];
let callback: { output: string } | undefined;
let phasesAtCallback = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/metadata/task") return Response.json({ TaskARN: "arn:aws:ecs:eu-west-1:123456789012:task/mork/container-1" });
    if (url.pathname === "/v1/logs") {
      const payload = await req.json();
      for (const scope of payload.resourceLogs[0].scopeLogs)
        for (const record of scope.logRecords) records.push({ body: record.body.stringValue, attributes: record.attributes });
      return Response.json({});
    }
    const target = req.headers.get("x-amz-target");
    if (target?.endsWith("SendTaskSuccess")) {
      callback = await req.json();
      phasesAtCallback = records.filter((r) => JSON.parse(r.body).event === "phase").length;
      return Response.json({});
    }
    if (target?.endsWith("SendTaskFailure")) return new Response("Unexpected failure callback", { status: 400 });
    if (req.method === "PUT") return new Response("", { status: 200 });
    if (url.pathname.endsWith("plan.json"))
      return Response.json({
        problem: "Test",
        plan: ["Fix"],
        risks: [],
        security_sensitive: false,
        acceptance_criteria: [{ id: "AC1", text: "Works", testable: true }],
        hidden_tests: [],
      });
    if (url.pathname.endsWith("build/1/result.json")) return Response.json({ ok: false, error: "push failed" });
    return new Response("Unexpected request", { status: 404 });
  },
});
afterAll(() => server.stop(true));

test("the runner executable exports phase records and matching log identity before its callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mork-main-"));
  const ca = join(dir, "ca.pem");
  writeFileSync(ca, "");
  const started = Date.now() - 1000;
  const brief = {
    execution: "test-main",
    task: "PROJ-1",
    attempt: 1,
    prefix: "tasks/o/r/1/test",
    branch: "mork/test",
    repo: { full_name: "o/r", default_branch: "main", base_sha: "a".repeat(40) },
    run: {
      run_id: "test-main",
      repository: "o/r",
      issue: "PROJ-1",
      title: "Test",
      issue_url: "https://example.com/PROJ-1",
      requested_by: "Alex",
      requested_by_id: "U1",
      slack_url: null,
      started_at: started,
      running_since: started,
      pr_url: null,
    },
  };
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const child = Bun.spawn(["bun", new URL("./main.ts", import.meta.url).pathname], {
      env: {
        ...process.env,
        AWS_PROFILE: "",
        AWS_REGION: "eu-west-1",
        AWS_ACCESS_KEY_ID: "local",
        AWS_SECRET_ACCESS_KEY: "local",
        AWS_ENDPOINT_URL_SFN: endpoint,
        AWS_ENDPOINT_URL_S3: endpoint,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        ECS_CONTAINER_METADATA_URI_V4: `${endpoint}/metadata`,
        GITHUB_TOKEN: "github-token-local",
        GITHUB_APP: "",
        GITHUB_APP_SECRET_ID: "",
        GITHUB_TOKEN_SECRET_ID: "",
        MORK_PHASE: "check",
        MORK_PHASE_STARTED_AT: new Date(started).toISOString(),
        MORK_TASK_TOKEN: "local-token",
        MORK_BRIEF: JSON.stringify(brief),
        MORK_BUCKET: "test",
        MORK_MODEL: "test",
        LLM_BASE_URL: "http://localhost/v1",
        MORK_WORK: dir,
        MORK_AGENT_HOME: dir,
        MORK_EGRESS_CA: ca,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(JSON.parse(callback?.output ?? "null")).toMatchObject({ ok: true, passed: false });
    expect(phasesAtCallback).toBe(2);
    const phases = records.filter((r) => JSON.parse(r.body).event === "phase");
    expect(phases.map((r) => JSON.parse(r.body))).toMatchObject([
      { step_id: "container-1", run_id: "test-main", result: "running", started_at: started, authoritative: false },
      { step_id: "container-1", run_id: "test-main", result: "failed", tokens: null },
    ]);
    expect(phases.every((r) => r.attributes.some((a) => a.key === "mork.step" && a.value.stringValue === "container-1"))).toBe(true);
    expect(records.some((r) => r.body.includes("\u001b"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
