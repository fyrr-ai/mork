// A question the agent asked in a Slack thread, waiting for the requester's
// answer. Step Functions holds the run on a task token; the token is kept in
// the Mork bucket under the thread, so the answer can find its way back.
import { createHash } from "node:crypto";
import { Answer } from "@mork/contracts";
import { StepName } from "@mork/contracts/workflow";
import { z } from "zod";
import type { SlackRef } from "./types.ts";

export const Pending = z.object({
  task_token: z.string(),
  execution_arn: z.string(),
  /** Task prefix in the Mork bucket; answers go to `${prefix}/answers.json`. */
  prefix: z.string(),
  /** Phase that runs (again) once the answer is in. */
  resume: StepName,
  /** Approval accepts only an explicit approve/reject from the requester. */
  approval: z.boolean().optional(),
  question: z.string(),
  /** Only the requester answers: the answer becomes part of the agent's prompt. */
  asked_by_user: z.string(),
  /** Jira issue the answer is recorded on, when there is one. */
  jira_key: z.string().optional(),
  asked_at: z.string(),
  answered_at: z.string().optional(),
  answered_by: z.string().optional(),
  /** Slack event that delivered the answer, so Slack's retries are no-ops. */
  answered_event: z.string().optional(),
});
export type Pending = z.infer<typeof Pending>;

/** The part of @mork/store this needs. */
export type ThreadStore = {
  json(key: string): Promise<unknown>;
  putJson(key: string, value: unknown): Promise<string>;
  /** Atomic JSON update; retries its synchronous updater after a conflicting write. */
  updateJson(key: string, update: (current: unknown | undefined) => unknown): Promise<string>;
  /** Conditional create: false when the key already exists. */
  claim(key: string, value: unknown): Promise<boolean>;
};

export const threadKey = (ref: SlackRef) => `threads/${ref.channel}/${ref.thread_ts}.json`;
export const answersKey = (prefix: string) => `${prefix}/answers.json`;
export const answerClaimKey = (ref: SlackRef, taskToken: string) =>
  `${threadKey(ref).replace(/\.json$/, "")}.answer-${createHash("sha256").update(taskToken).digest("hex").slice(0, 16)}.json`;
export const answerCompletionKey = (ref: SlackRef, taskToken: string) => answerClaimKey(ref, taskToken).replace(/\.json$/, ".completed.json");
export const AnswerCompletion = z.object({ event_id: z.string(), at: z.string(), by: z.string() });

/** One entry of `${prefix}/answers.json`, which every later prompt includes. */
export const AnswerRecord = Answer.extend({
  by: z.string(),
  resume: StepName,
  at: z.string(),
  event_id: z.string().optional(),
});
export type AnswerRecord = z.infer<typeof AnswerRecord>;

export async function pendingQuestion(store: ThreadStore, ref: SlackRef): Promise<Pending | undefined> {
  let pending: Pending;
  try {
    pending = Pending.parse(await store.json(threadKey(ref)));
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return undefined;
    throw error;
  }
  if (pending.answered_at) return pending;
  try {
    const completion = AnswerCompletion.parse(await store.json(answerCompletionKey(ref, pending.task_token)));
    return { ...pending, answered_at: completion.at, answered_by: completion.by, answered_event: completion.event_id };
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return pending;
    throw error;
  }
}

/** Reads the task's answers so far; none yet is an empty list. */
export async function answersSoFar(store: ThreadStore, prefix: string): Promise<AnswerRecord[]> {
  try {
    return z.array(AnswerRecord).parse(await store.json(answersKey(prefix)));
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return [];
    throw error;
  }
}
