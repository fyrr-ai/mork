import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stepOutputKey, Workflow, WorkflowName, WorkflowRun, workflowPrefix } from "@mork/contracts/workflow";
import { LocalStore } from "@mork/store/local";
import { z } from "zod";
import { withLocalRun } from "./local-run.ts";
import { runWorkflowStep } from "./workflow.ts";

const { values } = parseArgs({
  options: {
    trusted: { type: "boolean" },
    definition: { type: "string" },
    workflow: { type: "string" },
    task: { type: "string" },
    output: { type: "string" },
    resume: { type: "string" },
    model: { type: "string" },
    "llm-url": { type: "string" },
    pi: { type: "string", default: process.env.PI_BIN ?? "pi" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: mise run workflow:configured -- --trusted --definition workflow.json --workflow analysis --task 'request' --output NEW_DIR [--model MODEL --llm-url URL --pi BIN]",
  );
  console.log("Resume: mise run workflow:configured -- --trusted --resume DIR [--model MODEL --llm-url URL --pi BIN]");
  console.log("Trusted Linux mode. Commands and agent tools run as your user. Named step secrets come from your environment; no AWS calls.");
  process.exit(0);
}
if (!values.trusted) throw new Error("--trusted is required because workflow tools run as your user");
if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Local workflows need Linux and a non-root user");
const Manifest = z.object({ workflow: Workflow, run: WorkflowRun });
if (values.resume && (values.output || values.definition || values.workflow || values.task))
  throw new Error("--resume cannot be combined with new task options");
const directory = resolve(values.resume ?? values.output ?? "");
if (!values.resume && (!values.definition || !values.workflow || !values.task || !values.output))
  throw new Error("--definition, --workflow, --task and --output are required");
if (!values.resume) mkdirSync(directory, { mode: 0o700 });
await withLocalRun(directory, async (signal) => {
  const store = new LocalStore(join(directory, "outputs"));
  const manifest = values.resume
    ? Manifest.parse(await store.json("manifest.json"))
    : Manifest.parse({
        workflow: JSON.parse(readFileSync(z.string().parse(values.definition), "utf8")),
        run: {
          request: {
            source: "slack",
            workflow: WorkflowName.parse(values.workflow),
            ask: values.task,
            ref: { kind: "slack", channel: "CLOCAL", thread_ts: "1.0", user: "local" },
          },
          execution: "local",
          execution_arn: "arn:aws:states:us-east-1:000000000000:execution:local:local",
        },
      });
  if (!values.resume) await store.putJson("manifest.json", manifest);
  const { workflow, run } = manifest;
  if (workflow.steps.some((step) => step.kind === "agent") && (!values.model || !values["llm-url"]))
    throw new Error("Agent steps require --model and --llm-url");
  const prefix = workflowPrefix(run.request.workflow, run.execution);
  for (const step of workflow.steps) {
    signal.throwIfAborted();
    const key = stepOutputKey(prefix, step.name);
    if (step.kind === "approval") {
      try {
        await store.json(key);
        continue;
      } catch (error) {
        if ((error as Error).name !== "NoSuchKey") throw error;
      }
      for (const input of step.inputs) console.log(JSON.stringify(await store.json(stepOutputKey(prefix, input)), null, 2));
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      let answer: string;
      try {
        answer = await terminal.question(`${step.instructions}\nType approve to continue: `);
      } finally {
        terminal.close();
      }
      if (answer.trim().toLowerCase() !== "approve") throw new Error("Approval rejected; subsequent steps did not run");
      await store.putJson(key, { output: { approved: true, by: "local" } });
      continue;
    }
    const credentials = Object.fromEntries(
      Object.keys(step.secrets).map((name) => {
        const value = process.env[name];
        if (!value) throw new Error(`Local step ${step.name} needs ${name} in the environment`);
        return [name, value];
      }),
    );
    for (let attempt = 0; ; attempt++) {
      try {
        await runWorkflowStep({
          run,
          step,
          store,
          credentials,
          model: values.model ?? "unused",
          env: {
            llmBaseUrl: values["llm-url"] ?? "http://127.0.0.1",
            trustedLocal: { apiKey: process.env.MORK_LOCAL_API_KEY ?? "local-no-auth" },
            piBin: values.pi ?? "pi",
            extensionsDir: fileURLToPath(new URL("../extensions", import.meta.url)),
            workDir: join(directory, "work", step.name),
            agentHome: join(directory, "agents", step.name),
          },
        });
        break;
      } catch (error) {
        signal.throwIfAborted();
        if (attempt >= step.retries) throw error;
      }
    }
  }
  console.log(JSON.stringify(await store.json(stepOutputKey(prefix, workflow.delivery.step)), null, 2));
});
