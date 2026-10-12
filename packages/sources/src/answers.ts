// An @mention inside a thread is an answer to the question the agent parked
// there. Only the requester may answer, because the answer becomes part of
// the agent's prompt. The answer is appended to the task's answers.json and
// sent back to Step Functions on the parked task token; the run resumes.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Slack } from "./slack.ts";
import {
  AnswerCompletion,
  AnswerRecord,
  answerClaimKey,
  answerCompletionKey,
  answersKey,
  answersSoFar,
  Pending,
  pendingQuestion,
  type ThreadStore,
  threadKey,
} from "./threads.ts";
import type { Reporter, SlackRef } from "./types.ts";

export type Answer = { event_id: string; ref: SlackRef; text: string };
export type AnswerDeps = {
  store: ThreadStore;
  slack: Pick<Slack, "reply">;
  /** Thread (and Jira, when configured) reporter for the issue the question belongs to. */
  reporter: (jiraKey: string | undefined) => Reporter;
  /** SendTaskSuccess; throws when the token has expired or was already used. */
  resume: (taskToken: string, output: AnswerOutput, executionArn: string) => Promise<void>;
};

export type AnswerOutput = { answered: true; resume: string; answer: string; answer_event: string; approved?: boolean };

const Claim = z.object({
  event_id: z.string(),
  record: AnswerRecord.optional(),
});
const Receipt = z.object({
  pending: Pending.optional(),
  completed: z.boolean().default(false),
  outcome: z.enum(["duplicate", "already_answered", "nothing_pending", "not_requester", "empty", "expired", "invalid_approval"]).optional(),
});

export type AnswerOutcome =
  | "resumed"
  | "duplicate"
  | "already_answered"
  | "nothing_pending"
  | "not_requester"
  | "empty"
  | "expired"
  | "invalid_approval";

export async function deliverAnswer(deps: AnswerDeps, answer: Answer): Promise<AnswerOutcome> {
  const { store, slack } = deps;
  const receiptKey = `${threadKey(answer.ref).replace(/\.json$/, "")}.event-${createHash("sha256").update(answer.event_id).digest("hex")}.json`;
  let receipt: z.infer<typeof Receipt> | undefined;
  try {
    receipt = Receipt.parse(await store.json(receiptKey));
  } catch (error) {
    if ((error as { name?: string }).name !== "NoSuchKey") throw error;
  }
  if (!receipt) {
    const proposedReceipt = { pending: await pendingQuestion(store, answer.ref), completed: false };
    // Bind the event before claiming a question. Another delivery can already
    // have resumed that question while this one was reading the thread.
    receipt = (await store.claim(receiptKey, proposedReceipt)) ? proposedReceipt : Receipt.parse(await store.json(receiptKey));
  }
  if (receipt.completed) return receipt.outcome ?? "duplicate";
  // A retry belongs to the question originally claimed by this event, even if
  // the resumed phase has already asked a subsequent question in the thread.
  const pending = receipt.pending;
  const finish = async (outcome: NonNullable<z.infer<typeof Receipt>["outcome"]>, text?: string): Promise<AnswerOutcome> => {
    if (text) await slack.reply(answer.ref, text);
    await store.putJson(receiptKey, { pending, completed: true, outcome });
    return outcome;
  };
  if (pending?.answered_event === answer.event_id) return finish("duplicate");
  if (!pending) {
    return finish("nothing_pending", "Nothing in this thread is waiting for an answer. To start a new task, post a new message in the channel.");
  }
  if (pending.answered_at) {
    return finish("already_answered", "This question has already been answered.");
  }
  if (answer.ref.user !== pending.asked_by_user) {
    return finish("not_requester", `Only <@${pending.asked_by_user}>, who asked for this task, can answer.`);
  }
  if (!answer.text) {
    return finish("empty", "Mention me together with your answer, in this thread.");
  }
  if (pending.approval && !/^(approve|reject)$/i.test(answer.text.trim()))
    return finish("invalid_approval", "Reply with `@mork approve` or `@mork reject` in this thread.");

  // Two deliveries (a Slack retry, or two quick replies) may both get here: one claim per question decides.
  const claimKey = answerClaimKey(answer.ref, pending.task_token);
  const proposed = {
    event_id: answer.event_id,
    record: {
      question: pending.question,
      answer: answer.text,
      by: answer.ref.user,
      resume: pending.resume,
      at: new Date().toISOString(),
      event_id: answer.event_id,
    },
  };
  const won = await store.claim(claimKey, proposed);
  const claim = won ? proposed : Claim.parse(await store.json(claimKey));
  if (claim.event_id !== answer.event_id) return finish("already_answered");
  const answers = await answersSoFar(store, pending.prefix);
  // Older deployments claimed only the event id and may have written its
  // answer before their callback failed. Upgrade that claim on the same retry.
  const legacy = !claim.record
    ? answers.findLast(
        (existing) =>
          existing.question === pending.question &&
          existing.answer === answer.text &&
          existing.by === answer.ref.user &&
          existing.resume === pending.resume &&
          !existing.event_id,
      )
    : undefined;
  const record = claim.record ?? { ...(legacy ?? proposed.record), event_id: answer.event_id };
  if (!claim.record) await store.putJson(claimKey, { event_id: answer.event_id, record });
  // The write happens before callback delivery so the phase reads its answer.
  // An already stored event is left in place, preserving any later answers.
  await store.updateJson(answersKey(pending.prefix), (current) => {
    const existing = z.array(AnswerRecord).parse(current ?? []);
    if (existing.some((entry) => entry.event_id === answer.event_id)) return current;
    const legacyIndex = legacy
      ? existing.findLastIndex(
          (entry) =>
            !entry.event_id &&
            entry.question === legacy.question &&
            entry.answer === legacy.answer &&
            entry.by === legacy.by &&
            entry.resume === legacy.resume &&
            entry.at === legacy.at,
        )
      : -1;
    return legacyIndex >= 0 ? existing.map((entry, index) => (index === legacyIndex ? record : entry)) : [...existing, record];
  });
  try {
    await deps.resume(
      pending.task_token,
      {
        answered: true,
        resume: pending.resume,
        answer: record.answer,
        answer_event: answer.event_id,
        ...(pending.approval ? { approved: record.answer.trim().toLowerCase() === "approve" } : {}),
      },
      pending.execution_arn,
    );
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name !== "TaskTimedOut" && name !== "InvalidToken" && name !== "TaskDoesNotExist") throw error;
    await store.updateJson(answersKey(pending.prefix), (current) =>
      z
        .array(AnswerRecord)
        .parse(current ?? [])
        .filter((existing) => existing.event_id !== answer.event_id),
    );
    return finish("expired", "This question is no longer open (the run has ended or timed out). Post a new message to start again.");
  }
  // The question producer is the only writer of the thread pointer. Completing
  // this token must never overwrite a newer question parked after the callback.
  const completionKey = answerCompletionKey(answer.ref, pending.task_token);
  if (!(await store.claim(completionKey, { event_id: answer.event_id, at: record.at, by: record.by }))) {
    const completion = AnswerCompletion.parse(await store.json(completionKey));
    if (completion.event_id !== answer.event_id) throw new Error("answer completion belongs to another event");
  }
  await store.putJson(receiptKey, { pending, completed: true });
  await slack.reply(answer.ref, "*Thanks, continuing.*");
  await deps.reporter(pending.jira_key).report({ kind: "answered", text: answer.text, by: answer.ref.user });
  return "resumed";
}
