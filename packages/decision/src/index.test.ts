import { afterAll, describe, expect, test } from "bun:test";
import {
  type Answer,
  boundEvidence,
  checkBudget,
  criterionVerdict,
  type Decider,
  DecisionPanel,
  JevDecider,
  judgeCriteria,
  OpenAiDecider,
  panelFromEnv,
  STEER_GRACE_MS,
  supervise,
  triageFrom,
} from "./index.ts";

const q = { level: { type: "choice" as const, instructions: "pick", options: { quick: "a", careful: "b" } } };

const requests: { path: string; body: Record<string, unknown> }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (await req.json()) as Record<string, unknown>;
    requests.push({ path, body });
    if (path === "/v1/systemone") return Response.json({ answers: { level: { choice: "quick", confidence: 0.9, probabilities: { quick: 0.9 } } } });
    if (path === "/v1/decisions") {
      return Response.json({
        answers: [
          { type: "choice", name: "level", choice: "careful", confidence: 0.7, probabilities: [{ value: "careful", probability: 0.7 }] },
          { type: "predicate", name: "ok", probability: 0.95 },
          { type: "refusal", name: "nope" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop());
const base = `http://127.0.0.1:${server.port}`;

const fixed = (name: string, answers: Record<string, Answer>): Decider => ({ name, decide: async () => answers });

describe("providers", () => {
  test("budget rejects oversized state", () => {
    expect(checkBudget({ big: "x".repeat(40_000) }, q)).toContain("state + longest question");
    expect(checkBudget({ small: "x" }, q)).toBeUndefined();
  });
  test("over-budget requests never reach the network", async () => {
    const answers = await new JevDecider("k", "http://127.0.0.1:9").decide({ big: "x".repeat(70_000) }, q);
    expect(answers.level).toEqual({ type: "undecided", reason: expect.stringContaining("budget") });
  });
  test("network failure is undecided, not an exception", async () => {
    const answers = await new OpenAiDecider("k", "http://127.0.0.1:9").decide({}, q);
    expect(answers.level?.type).toBe("undecided");
  });
  test("evidence is bounded", () => {
    const bounded = boundEvidence({ out: "y".repeat(5_000) }) as { out: string };
    expect(bounded.out.length).toBe(2_001);
  });
  test("jev wire format: keyed questions, options as criteria", async () => {
    const answers = await new JevDecider("k", base).decide({ s: 1 }, q);
    expect(answers.level).toEqual({ type: "choice", choice: "quick", confidence: 0.9, probabilities: { quick: 0.9 } });
    const sent = requests.find((r) => r.path === "/v1/systemone")?.body as { questions: Record<string, { criteria: unknown }> };
    expect(sent.questions.level?.criteria).toEqual({ quick: "a", careful: "b" });
  });
  test("openai wire format: named predicate/choice array, refusal is undecided", async () => {
    const answers = await new OpenAiDecider("k", `${base}/v1`).decide(
      { s: 1 },
      { ...q, ok: { type: "noul", instructions: "ok?" }, nope: { type: "noul", instructions: "?" } },
    );
    expect(answers.level).toEqual({ type: "choice", choice: "careful", confidence: 0.7, probabilities: { careful: 0.7 } });
    expect(answers.ok).toEqual({ type: "noul", p: 0.95 });
    expect(answers.nope?.type).toBe("undecided");
    const sent = requests.find((r) => r.path === "/v1/decisions")?.body as { input: string; questions: { type: string; name: string }[] };
    expect(sent.input).toBe('{"s":1}');
    expect(sent.questions.map((x) => `${x.type}:${x.name}`)).toEqual(["choice:level", "predicate:ok", "predicate:nope"]);
  });
});

describe("panel", () => {
  const jev = fixed("jev", { level: { type: "choice", choice: "quick", confidence: 0.99, probabilities: {} } });
  const openai = fixed("openai", { level: { type: "choice", choice: "careful", confidence: 0.6, probabilities: {} } });

  test("no provider means undecided", async () => {
    const { answers, trace } = await new DecisionPanel([]).decide({ s: 1 }, q);
    expect(answers.level?.type).toBe("undecided");
    expect(trace.used).toBe("none");
  });
  test("the primary decides and the others are still recorded", async () => {
    const { answers, trace } = await new DecisionPanel([jev, openai], "openai").decide({}, q);
    expect(answers.level).toMatchObject({ choice: "careful" });
    expect(trace.providers.jev?.answers.level).toMatchObject({ choice: "quick" });
  });
  test("the first configured provider is primary; an unconfigured primary is an error", async () => {
    expect((await panelFromEnv({ JEV_API: "k" }).decide({ big: "x".repeat(70_000) }, q)).trace.used).toBe("jev");
    expect(() => panelFromEnv({ JEV_API: "k", MORK_DECISION_PRIMARY: "openai" })).toThrow();
  });
});

describe("policies", () => {
  test("triage asks for clarification only when confidently unclear", () => {
    expect(triageFrom({ actionable: { type: "noul", p: 0.1 } }).route).toBe("clarify");
    expect(triageFrom({ actionable: { type: "noul", p: 0.4 } }).route).toBe("proceed");
    expect(triageFrom({ actionable: { type: "undecided", reason: "jev 500" } }).route).toBe("proceed");
    const sec = triageFrom({ kind: { type: "choice", choice: "security", confidence: 0.9, probabilities: {} } });
    expect(sec.security).toBe(true);
  });
  test("criteria: no evidence and doubt are review, bands decide the rest", () => {
    const c = { id: "AC1", text: "README mentions it", evidence: [{ where: "README.md", quote: "truncate()" }] };
    expect(criterionVerdict({ ...c, evidence: [] }, { type: "noul", p: 1 }).verdict).toBe("review");
    expect(criterionVerdict(c, { type: "noul", p: 0.85 }).verdict).toBe("pass");
    expect(criterionVerdict(c, { type: "noul", p: 0.5 }).verdict).toBe("review");
    expect(criterionVerdict(c, { type: "noul", p: 0.1 }).verdict).toBe("fail");
    expect(criterionVerdict(c, { type: "undecided", reason: "jev 500" }).verdict).toBe("review");
  });
  test("criteria without evidence are not sent to the model", async () => {
    const panel = new DecisionPanel([fixed("jev", {})]);
    const result = await judgeCriteria(panel, [{ id: "AC2", text: "x", evidence: [] }]);
    expect(result.trace).toBeUndefined();
    expect(result.verdicts[0]?.verdict).toBe("review");
  });
  test("supervision steers once, waits out the grace, then stops", () => {
    const stuck = { worker_stuck: { type: "noul" as const, p: 0.9 } };
    const first = supervise(stuck, {}, 0);
    expect(first.action).toBe("steer");
    expect(supervise(stuck, { steeredAt: 0 }, STEER_GRACE_MS - 1).action).toBe("continue");
    expect(supervise(stuck, { steeredAt: 0 }, STEER_GRACE_MS).action).toBe("stop");
    expect(supervise({ worker_stuck: { type: "undecided", reason: "x" } }, {}, 0).action).toBe("continue");
  });
});

describe("message triage", () => {
  test("a confident not-a-request is ignored; doubt goes on", () => {
    expect(triageFrom({ is_request: { type: "noul", p: 0.05 }, actionable: { type: "noul", p: 0.9 } }).route).toBe("ignore");
    expect(triageFrom({ is_request: { type: "noul", p: 0.5 }, actionable: { type: "noul", p: 0.9 } }).route).toBe("proceed");
    expect(triageFrom({ is_request: { type: "undecided", reason: "down" }, actionable: { type: "noul", p: 0.1 } }).route).toBe("clarify");
  });
});
