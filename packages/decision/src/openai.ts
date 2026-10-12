// OpenAI Decisions over `POST /v1/decisions`. Questions travel as an ordered
// array with a `name`; our `noul` is their `predicate`. Answers come back in
// question order and echo the name; a declined question is `refusal`.
// Wire format per the OpenAI-compatible reference (Vercel AI Gateway docs);
// not yet exercised against the live API (no OpenAI key in this project).
import { type Answer, type Decider, postDecision, type Question } from "./core.ts";

type WireAnswer = {
  type?: string;
  name?: string | null;
  probability?: number;
  choice?: string | boolean;
  confidence?: number;
  probabilities?: { value: string | boolean; probability: number }[];
};

export class OpenAiDecider implements Decider {
  readonly name = "openai";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1", model = "gpt-6-luna") {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#model = model;
  }

  decide(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const wire = Object.entries(questions).map(([name, q]) =>
      q.type === "noul"
        ? { type: "predicate", name, instructions: q.instructions }
        : {
            type: "choice",
            name,
            instructions: q.instructions,
            choices: Object.entries(q.options).map(([value, description]) => ({ value, description })),
          },
    );
    return postDecision(
      this.name,
      `${this.#baseUrl}/decisions`,
      this.#apiKey,
      { model: this.#model, input: JSON.stringify(state), questions: wire },
      state,
      questions,
      (json) => {
        const answers = (json as { answers?: WireAnswer[] }).answers ?? [];
        const byName = new Map(answers.map((a) => [a.name, a]));
        return Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, parseOpenAiAnswer(q, byName.get(name))]));
      },
    );
  }
}

function parseOpenAiAnswer(question: Question, raw: WireAnswer | undefined): Answer {
  if (!raw) return { type: "undecided", reason: "missing answer" };
  if (raw.type === "refusal") return { type: "undecided", reason: "openai refused to answer" };
  if (question.type === "noul" && raw.type === "predicate" && typeof raw.probability === "number") return { type: "noul", p: raw.probability };
  if (question.type === "choice" && raw.type === "choice" && raw.choice !== undefined) {
    return {
      type: "choice",
      choice: String(raw.choice),
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
      probabilities: Object.fromEntries((raw.probabilities ?? []).map((p) => [String(p.value), p.probability])),
    };
  }
  return { type: "undecided", reason: "unexpected answer shape" };
}
