// An @mention inside a thread is an answer to the question the agent parked
// there. Only the requester may answer, because the answer becomes part of
// the agent's prompt. The answer is appended to the task's answers.json and
// sent back to Step Functions on the parked task token; the run resumes.
import { createHash } from "node:crypto";
import type { Slack } from "./slack.ts";
import { answersKey, answersSoFar, pendingQuestion, type ThreadStore, threadKey } from "./threads.ts";
import type { Reporter, SlackRef } from "./types.ts";

export type Answer = { event_id: string; ref: SlackRef; text: string };
export type AnswerDeps = {
  store: ThreadStore;
  slack: Pick<Slack, "reply">;
  /** Thread (and Jira, when configured) reporter for the issue the question belongs to. */
  reporter: (jiraKey: string | undefined) => Reporter;
  /** SendTaskSuccess; throws when the token has expired or was already used. */
  resume: (taskToken: string, output: { answered: true; resume: string; answer: string }) => Promise<void>;
};

export type AnswerOutcome = "resumed" | "duplicate" | "already_answered" | "nothing_pending" | "not_requester" | "empty" | "expired";

export async function deliverAnswer(deps: AnswerDeps, answer: Answer): Promise<AnswerOutcome> {
  const { store, slack } = deps;
  const pending = await pendingQuestion(store, answer.ref);
  if (pending?.answered_event === answer.event_id) return "duplicate";
  if (!pending) {
    await slack.reply(answer.ref, "Nothing in this thread is waiting for an answer. To start a new task, post a new message in the channel.");
    return "nothing_pending";
  }
  if (pending.answered_at) {
    await slack.reply(answer.ref, "This question has already been answered.");
    return "already_answered";
  }
  if (answer.ref.user !== pending.asked_by_user) {
    await slack.reply(answer.ref, `Only <@${pending.asked_by_user}>, who asked for this task, can answer.`);
    return "not_requester";
  }
  if (!answer.text) {
    await slack.reply(answer.ref, "Mention me together with your answer, in this thread.");
    return "empty";
  }

  // Two deliveries (a Slack retry, or two quick replies) may both get here: one claim per question decides.
  const claimKey = `${threadKey(answer.ref).replace(/\.json$/, "")}.answer-${createHash("sha256").update(pending.task_token).digest("hex").slice(0, 16)}.json`;
  if (!(await store.claim(claimKey, { event_id: answer.event_id }))) {
    const owner = (await store.json(claimKey).catch(() => undefined)) as { event_id?: string } | undefined;
    return owner?.event_id === answer.event_id ? "duplicate" : "already_answered";
  }
  const at = new Date().toISOString();
  const answers = await answersSoFar(store, pending.prefix);
  // Written before resuming, so the phase that runs next already reads it.
  await store.putJson(answersKey(pending.prefix), [
    ...answers,
    { question: pending.question, answer: answer.text, by: answer.ref.user, resume: pending.resume, at },
  ]);
  try {
    await deps.resume(pending.task_token, { answered: true, resume: pending.resume, answer: answer.text });
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name !== "TaskTimedOut" && name !== "InvalidToken" && name !== "TaskDoesNotExist") throw error;
    await store.putJson(answersKey(pending.prefix), answers);
    await slack.reply(answer.ref, "This question is no longer open (the run has ended or timed out). Post a new message to start again.");
    return "expired";
  }
  await store.putJson(threadKey(answer.ref), { ...pending, answered_at: at, answered_by: answer.ref.user, answered_event: answer.event_id });
  await slack.reply(answer.ref, "*Thanks, continuing.*");
  await deps.reporter(pending.jira_key).report({ kind: "answered", text: answer.text, by: answer.ref.user });
  return "resumed";
}
