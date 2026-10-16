// Pi extension, loaded only for tasks whose requester can answer (Slack).
// Asking ends the station: the runner reports the question, the workflow
// waits for the answer and reruns the phase with it in the prompt.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";

/** The requester reads the question in a chat message; nothing of it is ever cut silently. */
export const MAX_QUESTION_CHARS = 2_000;

export function questionTooLong(question: string): string | undefined {
  if (question.length <= MAX_QUESTION_CHARS) return undefined;
  return `The question is ${question.length} characters; the requester reads at most ${MAX_QUESTION_CHARS}. Nothing was sent. Ask one short, self-contained question: state the decision you need and the options, and leave the evidence you gathered in your own notes.`;
}

export default function ask(pi: any) {
  const out = process.env.MORK_QUESTION;
  if (!out) throw new Error("MORK_QUESTION is not set");
  pi.registerTool({
    name: "ask_human",
    label: "Ask the requester",
    description:
      "Ask the person who requested this task one short, concrete question when the task cannot be done correctly without their decision. The run stops after asking and restarts with the answer.",
    promptSnippet: "Ask the requester one question and stop",
    promptGuidelines: [
      "Use ask_human only for decisions only the requester can make (expected behaviour, scope, trade-offs). Never ask about things you can find out from the repository.",
      "After ask_human returns, stop immediately; do not call submit_result.",
    ],
    parameters: Type.Object({ question: Type.String({ description: "One short, self-contained question in English" }) }),
    async execute(_toolCallId: string, params: { question: string }) {
      const question = params.question.trim();
      if (!question) throw new Error("The question is empty.");
      const problem = questionTooLong(question);
      if (problem) throw new Error(problem);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, question);
      return { content: [{ type: "text", text: "Question sent to the requester. Stop now; you will be restarted with the answer." }], details: {} };
    },
  });
}
