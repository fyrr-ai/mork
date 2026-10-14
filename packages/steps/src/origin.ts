// Where a task came from: a labelled GitHub issue or a Slack mention backed by
// a Jira issue. Everything that differs between the two lives here: how the
// task is named, which branch it gets, how the PR links back, and where its
// progress is reported. The flow itself does not branch on the source.
import { REVIEW_LEVEL_TEXT, type Reporter, type SlackStart } from "@mork/sources";
import type { FixRequest } from "./fix.ts";
import type { GitHub } from "./github.ts";

export type StartInput = ({ repo: string; issue: number } | SlackStart | { fix: FixRequest }) & { execution: string; execution_arn?: string };

export type Origin =
  | { kind: "github"; issue: number }
  | {
      kind: "slack";
      start: SlackStart;
      /** The Jira issue; missing only when Start failed before resolving it. */
      work?: { key: string; url: string; title: string; created: boolean };
    };

export type Naming = { id: string; prefix: string; branch: string; ref: string };

/** Task id, bucket prefix and branch, from the tracker reference and the run's short id. */
export function naming(repo: string, origin: Origin, short: string): Naming {
  if (origin.kind === "github") {
    const n = origin.issue;
    return { id: `${repo}#${n}/${short}`, prefix: `tasks/${repo}/${n}/${short}`, branch: `mork/issue-${n}-${short}`, ref: `#${n}` };
  }
  const key = origin.work?.key ?? "unresolved";
  return { id: `${repo}#${key}/${short}`, prefix: `tasks/${repo}/${key}/${short}`, branch: `mork/${key.toLowerCase()}-${short}`, ref: key };
}

/** PR title and the line that links the PR back to its tracker. */
export function prLink(origin: Origin, title: string): { title: string; footer: string } {
  const reference = origin.kind === "github" ? `#${origin.issue}` : origin.work?.key;
  const suffix = reference ? ` (${reference})` : "";
  const subject = suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
  const conventional = /^(feat|fix|docs|test|refactor|perf|build|ci|chore|style|revert)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(subject);
  const scope = conventional?.[2] && /^[a-z0-9][a-z0-9_-]*$/.test(conventional[2]) ? conventional[2] : "mork";
  const normalized = conventional ? `${conventional[1]}(${scope})${conventional[3] ?? ""}: ${conventional[4]}` : `chore(mork): ${subject}`;
  return {
    title: `${normalized.slice(0, 100 - suffix.length).trimEnd()}${suffix}`,
    footer: origin.kind === "github" ? `Closes #${origin.issue}` : `Jira: ${origin.work?.url ?? reference ?? ""}`,
  };
}

export const LABELS = {
  trigger: { name: "mork", color: "5319e7", description: "Hand this issue to Mork" },
  working: { name: "mork:working", color: "fbca04", description: "Mork is working on this" },
  done: { name: "mork:done", color: "0e8a16", description: "Mork opened a draft PR" },
  takeover: { name: "needs-human", color: "b60205", description: "Mork hands this to a person" },
  clarify: { name: "needs-info", color: "d876e3", description: "Mork needs a clearer issue" },
  quick: { name: "review:quick", color: "c2e0c6", description: "A quick look is enough" },
  careful: { name: "review:careful", color: "fef2c0", description: "Review carefully" },
} as const;

/** GitHub issues hear about the task through labels and a few comments. */
export function githubReporter(github: GitHub, repo: string, issue: number, taskId: string): Reporter {
  return {
    async report(event) {
      switch (event.kind) {
        case "started":
          for (const label of Object.values(LABELS)) await github.ensureLabel(repo, label.name, label.color, label.description);
          await github.addLabels(repo, issue, [LABELS.working.name]);
          return;
        case "clarify":
          await github.comment(
            repo,
            issue,
            `**Mork needs a clearer issue before it starts.**\n\n${event.questions}\n\nOnce the issue is clearer, add the \`${LABELS.trigger.name}\` label again.\n\n<sub>task ${taskId}</sub>`,
          );
          await github.addLabels(repo, issue, [LABELS.clarify.name]);
          await github.removeLabel(repo, issue, LABELS.working.name);
          await github.removeLabel(repo, issue, LABELS.trigger.name);
          return;
        case "pr":
          await github.addLabels(repo, issue, [LABELS.done.name]);
          await github.removeLabel(repo, issue, LABELS.working.name);
          await github.comment(repo, issue, `Mork opened draft PR ${event.url}. Recommendation: **${REVIEW_LEVEL_TEXT[event.level]}**.`);
          return;
        case "handover":
          await github.addLabels(repo, issue, [LABELS.takeover.name]);
          await github.removeLabel(repo, issue, LABELS.working.name);
          await github.comment(
            repo,
            issue,
            `**Mork hands this task to a person.**${event.pr_url ? ` Its work is in draft PR ${event.pr_url}.` : ""}\n\n${event.reason}\n\n<sub>task ${taskId}</sub>`,
          );
          return;
        default:
          // plan, build and check progress only goes to chat sources.
          return;
      }
    },
  };
}
