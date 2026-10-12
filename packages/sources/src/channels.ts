// Which repository and Jira project a Slack channel works on. Configured as
// JSON in SLACK_CHANNELS:
//   {"C0123ABC": {"repo": "org/repo", "jira_project": "PROJ", "jira_components": ["Backend"]}}
// Components are set on issues the channel creates (some projects require one).
import { z } from "zod";

const Channel = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  jira_project: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  jira_components: z.array(z.string().min(1)).default([]),
});
export type Channel = z.infer<typeof Channel>;
const Channels = z.record(z.string().regex(/^[CG][A-Z0-9]+$/), Channel);

export function channelsFromEnv(env: NodeJS.ProcessEnv): Record<string, Channel> {
  return Channels.parse(JSON.parse(env.SLACK_CHANNELS ?? "{}"));
}
