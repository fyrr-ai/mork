// Shows how Mork will read a Jira issue before anyone starts it: the text the
// stations see, the author's acceptance criteria, and, with JEV_API set, the
// triage Start would make. Exits 1 when Mork would not take the issue as written.
//
//   acli jira workitem view PROJ-123 --fields summary,description --json | bun scripts/check-ticket.ts
import { authorCriteria } from "../packages/contracts/src/index.ts";
import { panelFromEnv, triage } from "../packages/decision/src/index.ts";
import { duplicateCriteria } from "../packages/runner/src/rules.ts";
import { adfToText } from "../packages/sources/src/jira.ts";

const issue = JSON.parse(await Bun.stdin.text()) as { key?: string; fields: { summary: string; description: Parameters<typeof adfToText>[0] } };
const title = issue.fields.summary;
const body = adfToText(issue.fields.description).trim();
const criteria = authorCriteria(body);
const duplicates = duplicateCriteria(criteria);
const problems: string[] = [];
if (!criteria.length) problems.push("No numbered criteria: write each as its own `AC1: …` line, or Plan derives its own.");
if (duplicates.length) problems.push(`Criteria ids used more than once: ${duplicates.join(", ")}. Mork hands such a task over.`);

const panel = panelFromEnv(process.env);
const triaged = panel.enabled ? (await triage(panel, { title, body })).triage : undefined;
if (triaged && triaged.route !== "proceed") problems.push(`Triage would ${triaged.route}: ${triaged.reasons.join("; ")}`);

console.log(
  JSON.stringify({ key: issue.key, title, criteria, triage: triaged ?? "skipped: set JEV_API to ask the decision model", problems }, null, 2),
);
process.exit(problems.length ? 1 : 0);
