// "@mork status" in a task's thread: where the run is right now, read from
// Step Functions. Intake records which execution a thread belongs to when it
// starts one, so a thread can always find its run.
import { z } from "zod";
import { executionUrl } from "./slack.ts";
import type { ThreadStore } from "./threads.ts";
import { pendingQuestion } from "./threads.ts";
import type { SlackRef } from "./types.ts";

export const ThreadTask = z.object({ execution_arn: z.string(), started_at: z.string() });
export type ThreadTask = z.infer<typeof ThreadTask>;

export const taskKey = (ref: SlackRef) => `threads/${ref.channel}/${ref.thread_ts}.task.json`;

/** "status", "status?", "progress" … asks for the state rather than answering a question. */
export function asksForStatus(text: string): boolean {
  return /^\s*(status|state|progress)\b\??/i.test(text);
}

export type Run = {
  status: string;
  startDate?: Date;
  stopDate?: Date;
  /** Execution output when finished: { outcome: { level, url? } }. */
  output?: string;
  /** Latest state entered, newest first is fine. */
  current?: { name: string; entered: Date; attempt?: number };
};

export type StatusDeps = { store: ThreadStore; describe: (executionArn: string) => Promise<Run> };

const PHASE_TEXT: Record<string, string> = {
  Start: "starting",
  Plan: "planning",
  Build: "implementing",
  Check: "running checks",
  Decide: "deciding",
  Ask: "waiting for an answer",
  Handover: "handing over",
};

function ago(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** One short status message for the thread. */
export async function statusText(deps: StatusDeps, ref: SlackRef, now = new Date()): Promise<string> {
  let task: ThreadTask;
  try {
    task = ThreadTask.parse(await deps.store.json(taskKey(ref)));
  } catch {
    return "I have no task in this thread. To start one, post a new message in the channel.";
  }
  const run = await deps.describe(task.execution_arn);
  const link = `<${executionUrl(task.execution_arn)}|View the workflow run>`;
  const since = run.startDate ? `, started ${ago(run.startDate, now)} ago` : "";

  if (run.status === "RUNNING") {
    const pending = await pendingQuestion(deps.store, ref).catch(() => undefined);
    if (pending && !pending.answered_at) return `*Status:* waiting for your answer to the question above\n${link}`;
    const phase = run.current ? (PHASE_TEXT[run.current.name] ?? run.current.name) : "running";
    const attempt = run.current?.attempt && (run.current.name === "Build" || run.current.name === "Check") ? ` (attempt ${run.current.attempt})` : "";
    const forHow = run.current ? ` for ${ago(run.current.entered, now)}` : "";
    return `*Status:* ${phase}${attempt}${forHow}${since}\n${link}`;
  }
  if (run.status === "SUCCEEDED") {
    const outcome = (() => {
      try {
        return (JSON.parse(run.output ?? "{}") as { outcome?: { level?: string; url?: string } }).outcome;
      } catch {
        return undefined;
      }
    })();
    if (outcome?.url) return `*Status:* done, draft PR ${outcome.url}\n${link}`;
    if (outcome?.level === "takeover") return `*Status:* handed over to a person\n${link}`;
    return `*Status:* finished\n${link}`;
  }
  return `*Status:* the run ${run.status.toLowerCase().replace("_", " ")}\n${link}`;
}
