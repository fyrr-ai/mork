// OpenAI Decisions over `POST /v1/decisions`. Questions travel as an ordered
// array with a `name`; our `noul` is their `predicate`. Answers come back in
// question order and echo the name; a declined question is `refusal`.
// Wire format per the OpenAI-compatible reference (Vercel AI Gateway docs);
// not yet exercised against the live API (no OpenAI key in this project).
import { type Answer, type Decider, isRecord, postDecision, type Question } from "./core.ts";

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
        const answers: unknown[] = isRecord(json) && Array.isArray(json.answers) ? json.answers : [];
        return Object.fromEntries(
          Object.entries(questions).map(([name, q]) => {
            const matching = answers.filter((a) => isRecord(a) && a.name === name);
            return [name, matching.length === 1 ? parseOpenAiAnswer(q, matching[0]) : { type: "undecided", reason: "missing or duplicate answer" }];
          }),
        );
      },
    );
  }
}

function parseOpenAiAnswer(question: Question, raw: unknown): Answer {
  if (!isRecord(raw)) return { type: "undecided", reason: "missing answer" };
  if (raw.type === "refusal") return { type: "undecided", reason: "openai refused to answer" };
  if (question.type === "noul" && raw.type === "predicate" && typeof raw.probability === "number") return { type: "noul", p: raw.probability };
  if (
    question.type === "choice" &&
    raw.type === "choice" &&
    (typeof raw.choice === "string" || typeof raw.choice === "boolean") &&
    typeof raw.confidence === "number" &&
    Array.isArray(raw.probabilities) &&
    raw.probabilities.every(
      (p) => isRecord(p) && (typeof p.value === "string" || typeof p.value === "boolean") && typeof p.probability === "number",
    ) &&
    new Set(raw.probabilities.map((p) => String(p.value))).size === raw.probabilities.length
  ) {
    return {
      type: "choice",
      choice: String(raw.choice),
      confidence: raw.confidence,
      probabilities: Object.fromEntries(raw.probabilities.map((p) => [String(p.value), p.probability])),
    };
  }
  return { type: "undecided", reason: "unexpected answer shape" };
}
