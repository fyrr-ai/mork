import { z } from "zod";
import defaults from "./development.json" with { type: "json" };
import { AgentSettings, StepName, StepSettings } from "./workflow.ts";

const step = {
  ...StepSettings,
  name: StepName,
  ...AgentSettings,
  timeout_seconds: z.number().int().min(301).max(86400).default(7200),
  attempts: z.number().int().min(1).max(8).default(1),
};
export const DevelopmentStep = z.discriminatedUnion("kind", [
  z.object({ ...step, kind: z.literal("plan") }),
  z.object({ ...step, kind: z.literal("build") }),
  z.object({ ...step, kind: z.literal("check"), attempts: z.literal(1).default(1) }),
]);
export type DevelopmentStep = z.infer<typeof DevelopmentStep>;
export const DevelopmentLimits = z.object({
  questions: z.object({ timeout_seconds: z.number().int().min(1).max(31536000), max: z.number().int().min(0).max(8) }),
  fixes: z.object({ rounds: z.number().int().min(0).max(8), attempts: z.number().int().min(1).max(8) }),
  /** Times per run that proven reviewer findings go back to Build before the PR; 0 turns repairs off. */
  repairs: z.object({ rounds: z.number().int().min(0).max(8) }).default({ rounds: 1 }),
});
export type DevelopmentLimits = z.infer<typeof DevelopmentLimits>;
export const DevelopmentWorkflow = DevelopmentLimits.extend({
  steps: z.tuple([DevelopmentStep.options[0], DevelopmentStep.options[1], DevelopmentStep.options[2]]),
  delivery: z.object({ kind: z.literal("draft_pr"), step: StepName }),
}).superRefine((workflow, ctx) => {
  const reserved = ["start", "route", "decide", "ask", "resume", "handover", "handoverfailed", "done"];
  if (workflow.steps.some((step) => reserved.includes(step.name)))
    ctx.addIssue({ code: "custom", message: "Development step name collides with a control state" });
  if (new Set(workflow.steps.map((s) => s.name)).size !== 3) ctx.addIssue({ code: "custom", message: "Development step names must be unique" });
  if (workflow.delivery.step !== workflow.steps[2].name) ctx.addIssue({ code: "custom", message: "Draft PR delivery must follow Check" });
});
export type DevelopmentWorkflow = z.infer<typeof DevelopmentWorkflow>;
export const DEFAULT_DEVELOPMENT = DevelopmentWorkflow.parse(defaults);

export const DevelopmentPolicy = DevelopmentLimits.extend({ build_attempts: z.number().int().min(1).max(8) });
export type DevelopmentPolicy = z.infer<typeof DevelopmentPolicy>;
export const DEFAULT_DEVELOPMENT_POLICY = DevelopmentPolicy.parse({ ...DEFAULT_DEVELOPMENT, build_attempts: DEFAULT_DEVELOPMENT.steps[1].attempts });
