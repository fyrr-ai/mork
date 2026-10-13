// Decision layer. The rest of the system asks typed questions and gets
// typed answers with probabilities; it never depends on a provider's wire
// format. An `undecided` answer always means "take the safe default".
//
// A DecisionPanel asks every configured provider the same question. The
// primary provider's answer is used; the others are asked only so the
// timeline can compare them. The trace records what each provider saw and
// said, which is what calibration needs.

export type Question = { type: "noul"; instructions: string } | { type: "choice"; instructions: string; options: Record<string, string> };

export type Answer =
  | { type: "noul"; p: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "undecided"; reason: string };

export interface Decider {
  readonly name: string;
  decide(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}

/** Conservative byte budgets under Jev's 32k / 64k token limits. Applied to every provider so comparisons see the same input. */
export const BUDGET = { pair: 30_000, request: 60_000 } as const;

export function checkBudget(state: unknown, questions: Record<string, Question>): string | undefined {
  const stateBytes = Buffer.byteLength(JSON.stringify(state));
  const questionBytes = Object.values(questions).map((q) => Buffer.byteLength(JSON.stringify(q)));
  const longest = Math.max(0, ...questionBytes);
  const total = stateBytes + questionBytes.reduce((a, b) => a + b, 0);
  if (stateBytes + longest > BUDGET.pair) return `state + longest question is ${stateBytes + longest} bytes (> ${BUDGET.pair})`;
  if (total > BUDGET.request) return `request is ${total} bytes (> ${BUDGET.request})`;
  return undefined;
}

/** Trims long strings in evidence so it fits the budget; keeps the tail of outputs. */
export function boundEvidence(value: unknown, maxString = 2_000): unknown {
  if (typeof value === "string") return value.length > maxString ? `…${value.slice(-maxString)}` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => boundEvidence(v, maxString));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundEvidence(v, maxString)]));
  }
  return value;
}

export const undecidedAll = (questions: Record<string, Question>, reason: string): Record<string, Answer> =>
  Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "undecided", reason } as Answer]));

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Validate provider output before any probability can affect a workflow. */
export function validateAnswer(question: Question, raw: unknown): Answer {
  if (isRecord(raw)) {
    if (raw.type === "undecided" && typeof raw.reason === "string") return { type: "undecided", reason: raw.reason };
    if (question.type === "noul" && raw.type === "noul" && probability(raw.p)) return { type: "noul", p: raw.p };
    if (
      question.type === "choice" &&
      raw.type === "choice" &&
      typeof raw.choice === "string" &&
      Object.hasOwn(question.options, raw.choice) &&
      probability(raw.confidence) &&
      isRecord(raw.probabilities)
    ) {
      const values = Object.entries(raw.probabilities);
      if (
        values.every(([key, p]) => Object.hasOwn(question.options, key) && probability(p)) &&
        values.reduce((sum, [, p]) => sum + (p as number), 0) <= 1 + 1e-6
      )
        return { type: "choice", choice: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities as Record<string, number> };
    }
  }
  return { type: "undecided", reason: "invalid answer" };
}

/** Shared HTTP call: budget check, timeout, and any failure becomes `undecided`. */
export async function postDecision(
  provider: string,
  url: string,
  apiKey: string,
  body: unknown,
  state: unknown,
  questions: Record<string, Question>,
  parse: (json: unknown) => Record<string, Answer>,
): Promise<Record<string, Answer>> {
  const over = checkBudget(state, questions);
  if (over) return undecidedAll(questions, `budget: ${over}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return undecidedAll(questions, `${provider} ${response.status}`);
    const answers = parse(await response.json());
    return Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, validateAnswer(question, answers[key])]));
  } catch (error) {
    return undecidedAll(questions, `${provider} error: ${(error as Error).message}`);
  }
}

export type DecisionTrace = {
  /** Provider whose answer was used; `none` without providers. */
  used: string;
  state: unknown;
  questions: Record<string, Question>;
  providers: Record<string, { answers: Record<string, Answer>; ms: number }>;
};

export type Verdict = { answers: Record<string, Answer>; trace: DecisionTrace };

export class DecisionPanel {
  readonly #providers: Decider[];
  readonly #primary: string | undefined;

  constructor(providers: Decider[], primary?: string) {
    if (new Set(providers.map((provider) => provider.name)).size !== providers.length) throw new Error("decision provider names must be unique");
    if (primary && !providers.some((p) => p.name === primary)) throw new Error(`primary decision provider ${primary} is not configured`);
    this.#providers = providers;
    this.#primary = primary ?? providers[0]?.name;
  }

  get enabled(): boolean {
    return this.#providers.length > 0;
  }

  async decide(state: unknown, questions: Record<string, Question>): Promise<Verdict> {
    const results = await Promise.all(
      this.#providers.map(async (provider) => {
        const started = Date.now();
        let answers: Record<string, Answer>;
        try {
          const raw = await provider.decide(state, questions);
          answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, validateAnswer(question, raw[key])]));
        } catch (error) {
          answers = undecidedAll(questions, `${provider.name} error: ${(error as Error).message}`);
        }
        return [provider.name, { answers, ms: Date.now() - started }] as const;
      }),
    );
    const providers = Object.fromEntries(results);
    const used = this.#primary ?? "none";
    const answers =
      used === "none"
        ? undecidedAll(questions, "no decision provider configured")
        : (providers[used]?.answers ?? undecidedAll(questions, `${used} did not answer`));
    return { answers, trace: { used, state, questions, providers } };
  }
}
