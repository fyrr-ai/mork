// Executed in the production runner image with --network none. All service
// adapters listen on container loopback; Pi and the step entrypoint are real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const objects = new Map<string, string>();
let modelCalls = 0;
let submissions = 0;
let callbacks: any[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const path = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
  if (path.startsWith("/workflow-test/")) {
    if (request.method === "PUT") {
      objects.set(path, text);
      response.writeHead(200, { etag: '"fixture"' }).end();
    } else if (objects.has(path)) response.writeHead(200, { "content-type": "application/json" }).end(objects.get(path));
    else response.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
    return;
  }
  if (path === "/v1/chat/completions") {
    const body = JSON.parse(text);
    modelCalls++;
    const afterTool = body.messages.at(-1)?.role === "tool";
    const value = { report: "Verified agent report", total: submissions === 0 ? "invalid" : 42 };
    if (!afterTool) submissions++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    };
    chunk({ role: "assistant" });
    if (afterTool) chunk({ content: "Done." });
    else
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `submit-${submissions}`,
            type: "function",
            function: { name: "submit_result", arguments: JSON.stringify({ json: JSON.stringify(value) }) },
          },
        ],
      });
    chunk({}, afterTool ? "stop" : "tool_calls");
    response.end("data: [DONE]\n\n");
    return;
  }
  const target = request.headers["x-amz-target"];
  if (typeof target === "string" && target.includes("SendTask")) {
    callbacks.push({ target, ...JSON.parse(text) });
    response.writeHead(200, { "content-type": "application/x-amz-json-1.0" }).end("{}");
    return;
  }
  response.writeHead(500).end(`Unexpected path ${path}`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const run = {
  request: {
    source: "slack",
    workflow: "analysis",
    ask: "Calculate 20 + 22 and report the result",
    ref: { kind: "slack", channel: "CDEMO", thread_ts: "1.0", user: "U1" },
  },
  execution: "slack-Ev1",
  execution_arn: "arn:aws:states:us-east-1:123456789012:execution:mork_analysis:slack-Ev1",
};
objects.set("/workflow-test/tasks/workflows/analysis/slack-Ev1/run.json", JSON.stringify(run));
async function execute(step: Record<string, unknown>, extra: Record<string, string> = {}, failure?: string) {
  callbacks = [];
  const child = spawn(process.execPath, [extra.TEST_ENTRYPOINT ?? "packages/runner/src/workflow-main.ts"], {
    cwd: "/opt/mork",
    env: {
      PATH: process.env.PATH,
      HOME: "/root",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fixture",
      AWS_SECRET_ACCESS_KEY: "fixture",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_ENDPOINT_URL_S3: base,
      AWS_ENDPOINT_URL_SFN: base,
      LLM_BASE_URL: `${base}/v1`,
      MORK_BUCKET: "workflow-test",
      MORK_MODEL: "fixture",
      MORK_WORKFLOW_NAME: "analysis",
      MORK_WORKFLOW_EXECUTION: run.execution,
      MORK_WORKFLOW_STEP: JSON.stringify(step),
      MORK_TASK_TOKEN: "fixture-token",
      MORK_EGRESS_CA: "/etc/ssl/certs/ca-certificates.crt",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(code, 0, log);
    assert.equal(callbacks.length, 1, log);
    if (failure) {
      assert(callbacks[0].target.endsWith("SendTaskFailure"), JSON.stringify(callbacks));
      assert.equal(callbacks[0].taskToken, "fixture-token");
      assert.equal(callbacks[0].error, "StationError");
      assert.match(callbacks[0].cause, new RegExp(failure));
      return;
    }
    assert(callbacks[0].target.endsWith("SendTaskSuccess"), JSON.stringify(callbacks));
    return JSON.parse(callbacks[0].output);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

try {
  const invalidAgent = { name: "bad", kind: "agent", instructions: "Test" };
  await execute({ ...invalidAgent, tools: ["INVALID"] }, {}, "tools");
  await execute({ ...invalidAgent, extensions: ["relative.ts"] }, {}, "extensions");
  await execute({ ...invalidAgent, model: "" }, {}, "model");
  await execute(invalidAgent, { MORK_WORKFLOW_STEP: "{" }, "SyntaxError");
  await execute(invalidAgent, { MORK_WORKFLOW_EXECUTION: "invalid/path" }, "Invalid workflow execution");
  await execute(invalidAgent, { MORK_BUCKET: "" }, "MORK_BUCKET");
  await execute(invalidAgent, { MORK_EGRESS_CA: "/missing-ca" }, "ENOENT");
  await execute(invalidAgent, { TEST_ENTRYPOINT: "packages/runner/src/main.ts", MORK_PHASE: "plan", MORK_BRIEF: "{" }, "SyntaxError");
  await execute(invalidAgent, { TEST_ENTRYPOINT: "packages/runner/src/main.ts", MORK_PHASE: "INVALID", MORK_BRIEF: "{}" }, "Invalid option");
  assert.equal(modelCalls, 0, "Invalid bootstrap configuration must fail before calling Pi");
  const agent = {
    name: "analyze",
    kind: "agent",
    instructions: "Add the supplied numbers and submit the report and total.",
    tools: ["read"],
    output_schema: {
      type: "object",
      required: ["report", "total"],
      properties: { report: { type: "string" }, total: { type: "number" } },
      additionalProperties: false,
    },
  };
  await execute({ ...agent, output_schema: { type: "object", requird: ["total"] } }, {}, "unknown keyword");
  await execute({ ...agent, name: "missing-pi" }, { PI_BIN: "/missing-pi" }, "ENOENT");
  const first = await execute(agent);
  const path = `/workflow-test/${first.output_key}`;
  const saved = JSON.parse(objects.get(path) ?? "null");
  assert.deepEqual(saved.output, { report: "Verified agent report", total: 42 });
  assert.equal(submissions, 2, "Invalid model output must be corrected through real Pi RPC");
  assert(objects.has(path.replace("output.json", "session.jsonl")), "Real agent session must be saved");
  const previousCalls = modelCalls;
  await execute(agent);
  assert.equal(modelCalls, previousCalls, "A successful step must not rerun after a lost callback");

  const code = `const fs=require('node:fs'); const {inputs}=JSON.parse(fs.readFileSync(process.env.MORK_INPUT_FILE,'utf8')); fs.writeFileSync(process.env.MORK_OUTPUT, JSON.stringify({total:inputs.analyze.total,uid:process.getuid(),aws:!!process.env.AWS_ACCESS_KEY_ID,token:process.env.API_TOKEN}));`;
  const command = {
    name: "validate",
    kind: "command",
    inputs: ["analyze"],
    command: ["node", "-e", code],
    secrets: { API_TOKEN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture" },
    output_schema: {
      type: "object",
      required: ["total", "uid", "aws", "token"],
      properties: {
        total: { const: 42 },
        uid: { const: 10001 },
        aws: { const: false },
        token: { type: "string" },
      },
      additionalProperties: false,
    },
  };
  const second = await execute(command, { STEP_SECRET_API_TOKEN: 'private-fixture-"token' });
  assert.deepEqual(JSON.parse(objects.get(`/workflow-test/${second.output_key}`) ?? "null").output, {
    total: 42,
    uid: 10001,
    aws: false,
    token: "[redacted]",
  });
  const secret = "sensitive-prefix-that-must-never-appear-in-a-parser-error-0123456789";
  await execute(
    { ...command, name: "broken-json", command: ["node", "-e", "require('node:fs').writeFileSync(process.env.MORK_OUTPUT, process.env.API_TOKEN)"] },
    { STEP_SECRET_API_TOKEN: secret },
    "Invalid JSON in workflow data",
  );
  assert(!JSON.stringify(callbacks).includes("sensitive-prefix"), "Parser previews must not leak even a truncated credential");
  assert(!objects.has("/workflow-test/tasks/workflows/analysis/slack-Ev1/steps/broken-json/output.json"));
  console.log("Configured workflow passed: real Pi/schema correction, S3 artifacts, callback, isolated command, redaction and retry");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
