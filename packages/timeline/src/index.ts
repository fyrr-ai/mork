// Append-only decision timeline (DynamoDB). Every decision point records what
// the providers saw and answered and what the code did; the PR outcome
// arrives later from GitHub webhooks. Calibration joins the two.
//
// Keys:   pk = task#<task id>         sk = decision#<point>#<attempt>
//                                     sk = pr                  (link to the PR)
//                                     sk = outcome#<delivery>  (one per webhook)
//         pk = pr#<repo>#<number>     sk = task                (reverse link)
// Writes use deterministic keys, so a retried step or a redelivered webhook
// overwrites its own item instead of adding a duplicate.

/** Structural copy of @mork/decision's DecisionTrace; kept local so this package has no dependencies. */
export type Trace = {
  used: string;
  state: unknown;
  questions: Record<string, unknown>;
  providers: Record<string, { answers: Record<string, unknown>; ms: number }>;
};

export type DecisionPoint = "triage" | "criteria" | "findings" | "recommendation" | "supervision";

export type DecisionItem = {
  pk: string;
  sk: string;
  kind: "decision";
  task: string;
  point: DecisionPoint;
  at: string;
  trace: Trace;
  /** What the code did with it, e.g. { level: "careful", reasons: [...] }. */
  action: Record<string, unknown>;
};

export type Outcome = "merged" | "closed" | "approved" | "changes_requested" | "taken_over";

export type OutcomeItem = { pk: string; sk: string; kind: "outcome"; task: string; at: string; outcome: Outcome; by?: string };
export type LinkItem = { pk: string; sk: string; kind: "link"; task: string; repo: string; pr: number; prefix?: string };
export type TimelineItem = DecisionItem | OutcomeItem | LinkItem;

export interface TimelineStore {
  put(item: TimelineItem): Promise<void>;
  get(pk: string, sk: string): Promise<TimelineItem | undefined>;
  scan(): AsyncIterable<TimelineItem>;
}

const taskKey = (task: string) => `task#${task}`;
const prKey = (repo: string, pr: number) => `pr#${repo}#${pr}`;

export function recordDecision(
  store: TimelineStore,
  input: { task: string; point: DecisionPoint; attempt: string; trace: Trace; action: Record<string, unknown>; at?: Date },
): Promise<void> {
  return store.put({
    pk: taskKey(input.task),
    sk: `decision#${input.point}#${input.attempt}`,
    kind: "decision",
    task: input.task,
    point: input.point,
    at: (input.at ?? new Date()).toISOString(),
    trace: input.trace,
    action: input.action,
  });
}

export async function linkPr(store: TimelineStore, task: string, repo: string, pr: number, prefix?: string): Promise<void> {
  const extra = prefix ? { prefix } : {};
  await store.put({ pk: taskKey(task), sk: "pr", kind: "link", task, repo, pr, ...extra });
  await store.put({ pk: prKey(repo, pr), sk: "task", kind: "link", task, repo, pr, ...extra });
}

/** The Mork task behind a PR, or undefined for PRs Mork did not open. */
export async function prTask(store: TimelineStore, repo: string, pr: number): Promise<{ task: string; prefix?: string } | undefined> {
  const link = await store.get(prKey(repo, pr), "task");
  if (link?.kind !== "link") return undefined;
  return { task: link.task, ...(link.prefix ? { prefix: link.prefix } : {}) };
}

/** Records a PR outcome; returns false for PRs Mork did not open. */
export async function recordOutcome(
  store: TimelineStore,
  input: { repo: string; pr: number; delivery: string; outcome: Outcome; by?: string; at?: Date },
): Promise<boolean> {
  const link = await store.get(prKey(input.repo, input.pr), "task");
  if (!link) return false;
  await store.put({
    pk: taskKey(link.task),
    sk: `outcome#${input.delivery}`,
    kind: "outcome",
    task: link.task,
    at: (input.at ?? new Date()).toISOString(),
    outcome: input.outcome,
    ...(input.by ? { by: input.by } : {}),
  });
  return true;
}

/** Records a handover (no PR) as `taken_over`, keyed so repeats converge. */
export function recordTakeover(store: TimelineStore, task: string, at?: Date): Promise<void> {
  return store.put({ pk: taskKey(task), sk: "outcome#takeover", kind: "outcome", task, at: (at ?? new Date()).toISOString(), outcome: "taken_over" });
}

/**
 * What the human's behaviour says the review level should have been:
 * merged without requested changes → quick; merged after changes → careful;
 * closed unmerged or taken over → takeover. Undefined while the PR is open.
 */
export function levelLabel(outcomes: Outcome[]): "quick" | "careful" | "takeover" | undefined {
  if (outcomes.includes("taken_over")) return "takeover";
  if (outcomes.includes("merged")) return outcomes.includes("changes_requested") ? "careful" : "quick";
  if (outcomes.includes("closed")) return "takeover";
  return undefined;
}

export type JevcalRow = { id: string; state: string; labels: Record<string, unknown> };

/**
 * jevcal input (`{"id","state","labels"}` per line) for one decision point.
 * Only the recommendation gets a label from outcomes; other points come out
 * unlabelled for `jevcal label` or a human to fill in.
 */
export async function exportJevcal(store: TimelineStore, point: DecisionPoint): Promise<JevcalRow[]> {
  const decisions: DecisionItem[] = [];
  const outcomes = new Map<string, Outcome[]>();
  for await (const item of store.scan()) {
    if (item.kind === "decision" && item.point === point) decisions.push(item);
    if (item.kind === "outcome") outcomes.set(item.task, [...(outcomes.get(item.task) ?? []), item.outcome]);
  }
  return decisions
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((d) => {
      const level = point === "recommendation" ? levelLabel(outcomes.get(d.task) ?? []) : undefined;
      return { id: `${d.task}/${d.sk}`, state: JSON.stringify(d.trace.state), labels: level ? { level } : {} };
    });
}

/** In-memory store for tests and local runs. */
export class MemoryStore implements TimelineStore {
  readonly items = new Map<string, TimelineItem>();
  async put(item: TimelineItem): Promise<void> {
    this.items.set(`${item.pk}\u0000${item.sk}`, structuredClone(item));
  }
  async get(pk: string, sk: string): Promise<TimelineItem | undefined> {
    return this.items.get(`${pk}\u0000${sk}`);
  }
  async *scan(): AsyncIterable<TimelineItem> {
    yield* this.items.values();
  }
}
