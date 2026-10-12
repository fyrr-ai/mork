import { z } from "zod";

export const WorkflowName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const StepName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
/** Host names only; wildcard matches subdomains. Never URLs, ports or YAML. */
export const AllowedDomain = z
  .string()
  .max(253)
  .regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/);
export const Capacity = z.enum(["spot", "on_demand"]);
export const StepSettings = {
  allowed_domains: z.array(AllowedDomain).default([]),
  capacity: Capacity.default("on_demand"),
  spot_retries: z.number().int().min(0).max(8).default(4),
};
const variableName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .refine(
    (name) => !/^(AWS_|MORK_|PI_|NODE_|BUN_)/.test(name) && !["HOME", "PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].includes(name),
    "Platform environment variables cannot be overridden",
  );
export const Instructions = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).length <= 24 * 1024, "Instructions must fit within 24 KiB of UTF-8");

/** Shared settings for generic agents and development operations. */
export const AgentSettings = {
  instructions: Instructions,
  model: z.string().min(1).nullable().optional(),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default(["read", "bash", "edit", "write", "grep", "find", "ls"]),
  /** Trusted extensions baked into the configured runner image. */
  extensions: z.array(z.string().startsWith("/")).default([]),
};
const common = {
  ...StepSettings,
  name: StepName,
  inputs: z.array(StepName).default([]),
  timeout_seconds: z.number().int().min(301).max(86400).default(7200),
  retries: z.number().int().min(0).max(3).default(0),
};
const executable = {
  ...common,
  output_schema: z
    .preprocess(
      (value) => {
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          return undefined;
        }
      },
      z.record(z.string(), z.unknown()),
    )
    .default({ type: "object" }),
  environment: z.record(variableName, z.string()).default({}),
  /** Environment variable -> Secrets Manager ARN. Only this step receives it. */
  secrets: z.record(variableName, z.string().regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/)).default({}),
};
export const WorkflowStep = z.discriminatedUnion("kind", [
  z.object({
    ...executable,
    kind: z.literal("agent"),
    ...AgentSettings,
  }),
  z.object({ ...executable, kind: z.literal("command"), command: z.array(z.string()).min(1) }),
  z.object({
    ...common,
    kind: z.literal("approval"),
    instructions: Instructions,
    timeout_seconds: z.number().int().min(1).max(31536000).default(7200),
  }),
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const Workflow = z
  .object({
    steps: z.array(WorkflowStep).min(1).max(30),
    /** Step whose JSON result is delivered at the end. */
    delivery: z.object({ kind: z.literal("report"), step: StepName }),
  })
  .superRefine((workflow, ctx) => {
    const seen = new Set<string>();
    for (const [index, step] of workflow.steps.entries()) {
      if (seen.has(step.name)) ctx.addIssue({ code: "custom", path: ["steps", index, "name"], message: "Duplicate step name" });
      for (const input of step.inputs) {
        if (!seen.has(input)) ctx.addIssue({ code: "custom", path: ["steps", index, "inputs"], message: `Input ${input} must precede this step` });
      }
      seen.add(step.name);
    }
    if (!seen.has(workflow.delivery.step)) ctx.addIssue({ code: "custom", path: ["delivery", "step"], message: "Delivery step does not exist" });
  });
export type Workflow = z.infer<typeof Workflow>;

export const SlackRef = z.object({
  kind: z.literal("slack"),
  channel: z.string().regex(/^[CG][A-Z0-9]+$/),
  thread_ts: z.string().regex(/^\d+\.\d+$/),
  user: z.string().min(1),
});
export type SlackRef = z.infer<typeof SlackRef>;

export const WorkflowRequest = z.object({
  source: z.literal("slack"),
  workflow: WorkflowName,
  ask: z.string().trim().min(1).max(24000),
  ref: SlackRef,
});
export type WorkflowRequest = z.infer<typeof WorkflowRequest>;
export const WorkflowRun = z.object({
  request: WorkflowRequest,
  execution: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  execution_arn: z.string().regex(/^arn:aws:states:[a-z0-9-]+:\d{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;
export const workflowPrefix = (workflow: string, execution: string) => `tasks/workflows/${workflow}/${execution}`;
export const stepOutputKey = (prefix: string, step: string) => `${prefix}/steps/${step}/output.json`;
