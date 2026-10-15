import { z } from "zod";

/** Context carried by Step Functions. A repair has a new run_id even when it reuses a task. */
export const RunContext = z.object({
  run_id: z.string().min(1),
  repository: z.string().min(1),
  issue: z.string(),
  issue_url: z.string(),
  title: z.string().max(500),
  requested_by_id: z.string().nullable(),
  requested_by: z.string().nullable(),
  slack_url: z.string().nullable(),
  started_at: z.number().int(),
  running_since: z.number().int(),
  resume: z.object({ at: z.iso.datetime() }).optional(),
  pr_url: z.string().nullable(),
});
export type RunContext = z.infer<typeof RunContext>;
export type RunStatus = "running" | "waiting" | "completed" | "handover" | "failed" | "cancelled";
export type StepResult = "running" | "passed" | "failed" | "waiting" | "interrupted" | "cancelled";
