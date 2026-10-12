// The same production image runs configured steps without a Git repository.
import { readFileSync, writeFileSync } from "node:fs";
import { WorkflowRun, WorkflowStep, workflowPrefix } from "@mork/contracts/workflow";
import { Store } from "@mork/store";
import { reportInterrupted, reportTo, requiredEnv } from "./callback.ts";
import { runShutdown } from "./shutdown.ts";
import { runWorkflowStep } from "./workflow.ts";

const env = process.env;
const token = requiredEnv(env, "MORK_TASK_TOKEN");
process.once("SIGTERM", () => {
  const deadline = new Promise((resolve) => setTimeout(resolve, 90_000));
  void Promise.race([runShutdown(), deadline])
    .then(() => reportInterrupted(token, env.MORK_WORKFLOW_NAME ?? "workflow"))
    .finally(() => process.exit(143));
});
await reportTo(token, async () => {
  const step = WorkflowStep.parse(JSON.parse(requiredEnv(env, "MORK_WORKFLOW_STEP")));
  if (step.kind === "approval") throw new Error("Approval runs in the steps Lambda");
  const store = Store.fromEnv(env);
  const workflow = requiredEnv(env, "MORK_WORKFLOW_NAME");
  const execution = requiredEnv(env, "MORK_WORKFLOW_EXECUTION");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(execution)) throw new Error("Invalid workflow execution name");
  const run = WorkflowRun.parse(await store.json(`${workflowPrefix(workflow, execution)}/run.json`));
  if (run.request.workflow !== workflow || run.execution !== execution) throw new Error("Workflow does not match this task definition");
  const isRoot = process.getuid?.() === 0;
  const workDir = env.MORK_WORK ?? "/work";
  const caFile = env.MORK_EGRESS_CA ?? "/mork-egress/ca.crt";
  writeFileSync(`${workDir}/egress-ca.pem`, `${readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8")}\n${readFileSync(caFile, "utf8")}`);
  const credentials = Object.fromEntries(Object.keys(step.secrets).map((name) => [name, requiredEnv(env, `STEP_SECRET_${name}`)]));
  return runWorkflowStep({
    run,
    step,
    store,
    credentials,
    model: requiredEnv(env, "MORK_MODEL"),
    env: {
      llmBaseUrl: requiredEnv(env, "LLM_BASE_URL"),
      egress: { proxy: env.MORK_EGRESS_PROXY ?? "http://127.0.0.1:3128", caFile },
      piBin: env.PI_BIN ?? "pi",
      extensionsDir: env.MORK_EXTENSIONS ?? "/opt/mork/packages/runner/extensions",
      workDir,
      agentHome: env.MORK_AGENT_HOME ?? "/home/agent",
      agentUid: isRoot ? 10001 : undefined,
      agentGid: isRoot ? 10001 : undefined,
    },
  });
});
