import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workflow, WorkflowStep } from "@mork/contracts/workflow";
import { execAsync } from "./git.ts";
import { outputParser } from "./workflow.ts";

const schema = { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false };
const first = { name: "calculate", kind: "command", command: ["node", "-e", ""], output_schema: schema };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("workflow contracts reject forward inputs, duplicate names and platform environment overrides", () => {
  for (const steps of [[{ ...first, inputs: ["later"] }], [first, first]]) {
    expect(() => Workflow.parse({ steps, delivery: { kind: "report", step: "calculate" } })).toThrow();
  }
  for (const patch of [{ tools: ["INVALID"] }, { extensions: ["relative.ts"] }, { model: "" }, { output_schema: "{" }]) {
    expect(WorkflowStep.safeParse({ ...first, kind: "agent", instructions: "Analyze", ...patch }).success).toBe(false);
  }
  for (const name of ["AWS_ACCESS_KEY_ID", "PATH", "MORK_OUTPUT", "NODE_OPTIONS"]) {
    expect(() => WorkflowStep.parse({ ...first, environment: { [name]: "override" } })).toThrow();
  }
});

test("result validation rejects extra fields and incorrect types without coercion", () => {
  const parse = outputParser(schema);
  expect(parse({ total: 42 })).toEqual({ total: 42 });
  expect(() => parse({ total: "42" })).toThrow();
  expect(() => parse({ total: 42, passed: true })).toThrow();
  expect(() => outputParser({ type: "imaginary" })).toThrow();
  expect(() => outputParser({ $async: true, type: "object" })).toThrow("synchronous");
});

test.skipIf(process.getuid?.() === 0)("configured CLI executes and resumes real commands with pinned inputs and no AWS credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "mork-configured-cli-"));
  directories.push(root);
  const definition = join(root, "workflow.json");
  const directory = join(root, "task");
  const marker = join(root, "executed.txt");
  const code = `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'run\\n'); fs.writeFileSync(process.env.MORK_OUTPUT, JSON.stringify({total:42}));`;
  const check = `const fs=require('node:fs'); const input=JSON.parse(fs.readFileSync(process.env.MORK_INPUT_FILE,'utf8')); if(process.env.AWS_ACCESS_KEY_ID) throw Error('Leaked AWS credentials'); if(input.inputs.calculate.total!==42) throw Error('Missing input'); fs.writeFileSync(process.env.MORK_OUTPUT, JSON.stringify({total:input.inputs.calculate.total}));`;
  writeFileSync(
    definition,
    JSON.stringify({
      steps: [
        { ...first, command: ["node", "-e", code] },
        { ...first, name: "validate", inputs: ["calculate"], command: ["node", "-e", check], output_schema: JSON.stringify(schema) },
      ],
      delivery: { kind: "report", step: "validate" },
    }),
  );
  const cli = join(import.meta.dir, "workflow-local-cli.ts");
  const env = { ...process.env, AWS_ACCESS_KEY_ID: "must-stay-in-parent" };
  const started = await execAsync(
    process.execPath,
    [cli, "--trusted", "--definition", definition, "--workflow", "analysis", "--task", "20 + 22", "--output", directory],
    { env, timeoutMs: 15000 },
  );
  expect(started.code, started.output).toBe(0);
  expect(JSON.parse(started.output)).toMatchObject({ output: { total: 42 } });
  writeFileSync(definition, "{}");
  const resumed = await execAsync(process.execPath, [cli, "--trusted", "--resume", directory], { env, timeoutMs: 15000 });
  expect(resumed.code, resumed.output).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("run\n");
});

test("human approval waits may exceed a container timeout", () => {
  expect(WorkflowStep.parse({ kind: "approval", name: "publish", instructions: "Publish?", timeout_seconds: 259200 }).timeout_seconds).toBe(259200);
  expect(WorkflowStep.safeParse({ ...first, timeout_seconds: 259200 }).success).toBe(false);
});

test("malformed command JSON cannot leak granted secrets through the actual failure callback", async () => {
  const { SFNClient } = await import("@aws-sdk/client-sfn");
  const { LocalStore } = await import("@mork/store/local");
  const { WorkflowRun } = await import("@mork/contracts/workflow");
  const { reportTo } = await import("./callback.ts");
  const { runWorkflowStep } = await import("./workflow.ts");
  const root = mkdtempSync(join(tmpdir(), "mork-secret-callback-"));
  directories.push(root);
  const callbacks: { target: string; body: { cause?: string } }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      callbacks.push({ target: request.headers.get("x-amz-target") ?? "", body: (await request.json()) as { cause?: string } });
      return Response.json({});
    },
  });
  const client = new SFNClient({
    region: "us-east-1",
    endpoint: server.url.origin,
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 1,
  });
  const run = WorkflowRun.parse({
    request: { source: "slack", workflow: "analysis", ask: "calculate", ref: { kind: "slack", channel: "CLOCAL", thread_ts: "1.0", user: "U1" } },
    execution: "fixture",
    execution_arn: "arn:aws:states:us-east-1:000000000000:execution:analysis:fixture",
  });
  try {
    for (const [index, secret] of ['private-"fixture-token', "very-long-sensitive-prefix-never-appears-in-errors-0123456789", "xyz"].entries()) {
      const step = WorkflowStep.parse({
        ...first,
        name: `broken${index}`,
        command: ["node", "-e", "require('node:fs').writeFileSync(process.env.MORK_OUTPUT, process.env.API_TOKEN)"],
        secrets: { API_TOKEN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:fixture" },
      });
      if (step.kind === "approval") throw new Error("Unexpected approval");
      const result = await reportTo(
        "fixture",
        () =>
          runWorkflowStep({
            run,
            step,
            credentials: { API_TOKEN: secret },
            model: "unused",
            store: new LocalStore(join(root, "outputs")),
            env: {
              trustedLocal: { apiKey: "fixture-local-key" },
              llmBaseUrl: "http://127.0.0.1",
              piBin: "unused",
              extensionsDir: "unused",
              agentHome: join(root, step.name, "agent"),
              workDir: join(root, step.name, "work"),
            },
          }),
        client,
      );
      expect(result).toMatchObject({ ok: false });
      const failure = callbacks.at(-1);
      expect(failure?.target).toEndWith("SendTaskFailure");
      expect(failure?.body.cause).not.toContain(secret);
      expect(failure?.body.cause).toContain("Invalid JSON in workflow data");
    }
  } finally {
    client.destroy();
    server.stop(true);
  }
});

test.skipIf(process.getuid?.() === 0)(
  "SIGTERM stops command descendants, releases the local lock and allows resume",
  async () => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "mork-resume-signal-"));
    directories.push(root);
    const directory = join(root, "run");
    const definition = join(root, "workflow.json");
    const marker = join(root, "started");
    const pidFile = join(root, "pid");
    const code = `const fs=require('node:fs'); if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'started'); const child=require('node:child_process').spawn('sleep',['30']); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setTimeout(()=>fs.writeFileSync(process.env.MORK_OUTPUT,'{}'),30000);}else fs.writeFileSync(process.env.MORK_OUTPUT,'{}');`;
    writeFileSync(
      definition,
      JSON.stringify({ steps: [{ kind: "command", name: "wait", command: ["node", "-e", code] }], delivery: { kind: "report", step: "wait" } }),
    );
    const cli = join(import.meta.dir, "workflow-local-cli.ts");
    const child = spawn("node", [cli, "--trusted", "--definition", definition, "--workflow", "test", "--task", "wait", "--output", directory], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    try {
      for (let tries = 0; tries < 100 && !existsSync(pidFile); tries++) await Bun.sleep(20);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGTERM");
      expect(await closed).toBe(143);
      expect(existsSync(join(directory, ".run.lock"))).toBe(false);
      // A dead process can briefly remain a zombie until init reaps it.
      const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] : undefined;
      expect(stat === undefined || stat === "Z").toBe(true);
      const resumed = await execAsync("node", [cli, "--trusted", "--resume", directory], { timeoutMs: 3000 });
      expect(resumed.code, resumed.output).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  },
  10000,
);

test("redaction that conflicts with a result schema fails explicitly without saving invalid output", async () => {
  const { LocalStore } = await import("@mork/store/local");
  const { WorkflowRun, workflowPrefix, stepOutputKey } = await import("@mork/contracts/workflow");
  const { runWorkflowStep } = await import("./workflow.ts");
  const root = mkdtempSync(join(tmpdir(), "mork-redacted-result-"));
  directories.push(root);
  const store = new LocalStore(join(root, "outputs"));
  const secret = "private-fixture-token";
  const step = WorkflowStep.parse({
    kind: "command",
    name: "run",
    command: ["node", "-e", "require('node:fs').writeFileSync(process.env.MORK_OUTPUT,JSON.stringify({id:process.env.API_TOKEN}))"],
    output_schema: { type: "object", properties: { id: { const: secret } }, required: ["id"] },
    secrets: { API_TOKEN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:fixture" },
  });
  if (step.kind === "approval") throw new Error("Unexpected approval");
  const run = WorkflowRun.parse({
    request: { source: "slack", workflow: "analysis", ask: "test", ref: { kind: "slack", channel: "CLOCAL", thread_ts: "1.0", user: "U1" } },
    execution: "fixture",
    execution_arn: "arn:aws:states:us-east-1:000000000000:execution:analysis:fixture",
  });
  await expect(
    runWorkflowStep({
      run,
      step,
      store,
      credentials: { API_TOKEN: secret },
      model: "unused",
      env: {
        trustedLocal: { apiKey: "local-no-auth" },
        llmBaseUrl: "http://127.0.0.1",
        piBin: "unused",
        extensionsDir: "unused",
        workDir: join(root, "work"),
        agentHome: join(root, "agent"),
      },
    }),
  ).rejects.toThrow("cannot satisfy its schema after redaction");
  await expect(store.json(stepOutputKey(workflowPrefix("analysis", "fixture"), "run"))).rejects.toMatchObject({ name: "NoSuchKey" });
});
