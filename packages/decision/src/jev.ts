// TypeSafe Jev over `POST /v1/systemone`. Questions travel as an object keyed
// by name; `choice` options are called `criteria` on the wire. Verified
// against the live API on 2026-10-10.
import { type Answer, type Decider, postDecision, type Question } from "./core.ts";

export class JevDecider implements Decider {
  readonly name = "jev";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;

  constructor(apiKey: string, baseUrl = "https://api.typesafe.ai", model = "jev-latest") {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#model = model;
  }

  decide(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const wire = Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        q.type === "noul" ? { type: "noul", instructions: q.instructions } : { type: "choice", instructions: q.instructions, criteria: q.options },
      ]),
    );
    return postDecision(
      this.name,
      `${this.#baseUrl}/v1/systemone`,
      this.#apiKey,
      { model: this.#model, state, questions: wire },
      state,
      questions,
      (json) => {
        const answers = (json as { answers?: Record<string, Record<string, unknown>> }).answers;
        return Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, parseJevAnswer(q, answers?.[key])]));
      },
    );
  }
}

function parseJevAnswer(question: Question, raw: Record<string, unknown> | undefined): Answer {
  if (!raw) return { type: "undecided", reason: "missing answer" };
  if (question.type === "noul" && typeof raw.noul === "number") return { type: "noul", p: raw.noul };
  if (question.type === "choice" && typeof raw.choice === "string") {
    return {
      type: "choice",
      choice: raw.choice,
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
      probabilities: (raw.probabilities as Record<string, number>) ?? {},
    };
  }
  return { type: "undecided", reason: "unexpected answer shape" };
}
