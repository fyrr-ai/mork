// Which repository and Jira project a Slack channel works on. Configured as
// config/slack.json:
//   {"C0123ABC": {"repo": "org/repo", "jira_project": "PROJ", "jira_components": ["Backend"]}}
// Components are set on issues the channel creates (some projects require one).

import { WorkflowName } from "@mork/contracts/workflow";
import { z } from "zod";

const Channel = z
  .object({
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .nullish()
      .transform((value) => value ?? undefined),
    jira_project: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .nullish()
      .transform((value) => value ?? undefined),
    jira_components: z.array(z.string().min(1)).default([]),
    default_workflow: WorkflowName.default("development"),
    allowed_workflows: z.array(WorkflowName).min(1).default(["development"]),
  })
  .refine((channel) => channel.allowed_workflows.includes(channel.default_workflow), {
    message: "Default workflow must be allowed in this channel",
  });
export type Channel = z.infer<typeof Channel>;
export const Channels = z.record(z.string().regex(/^[CG][A-Z0-9]+$/), Channel);
