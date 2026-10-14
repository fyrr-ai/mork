import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnalystOutput, type GateReport, keys, MAX_BUILD_ATTEMPTS, type Review } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT_POLICY } from "@mork/contracts/development";
import { type Answer, type Decider, DecisionPanel, findingPriority, type Priority } from "@mork/decision";
import type { ReportEvent } from "@mork/sources";
import { LocalStore } from "@mork/store/local";
import { linkPr, MemoryStore as TimelineMemory } from "@mork/timeline";
import { type FixTrigger, fixTrigger, MARKER, releasePr, savePr } from "./fix.ts";
import { ask, checksTable, type Deps, decide, type FlowState, handover, handoverReason, start, startedBy } from "./flow.ts";
import { prOutcome, signatureValid } from "./intake.ts";
import { githubReporter } from "./origin.ts";
import { recommend } from "./recommend.ts";

const plan: AnalystOutput = {
  problem: "p",
  plan: ["s"],
  risks: [],
  security_sensitive: false,
  acceptance_criteria: [
    { id: "AC1", text: "adds", testable: true },
    { id: "AC2", text: "documented", testable: false },
  ],
  hidden_tests: [{ file: "add.test.mjs", criteria: ["AC1"], content: "assert.equal(add(2, 3), 5) // HIDDEN_SOURCE" }],
};
const gate = {
  mode: "after",
  head_sha: "b".repeat(40),
  repo_tests: { command: "npm test", exit_code: 0, output: "" },
  hidden: [{ file: "add.test.mjs", criteria: ["AC1"], passed: true, output: "" }],
  diff_policy: { violations: [], changed_files: ["math.mjs"], protected_hits: [], flags: [], added_lines: 3, removed_lines: 1 },
} satisfies GateReport;
const review: Review = {
  summary: "ok",
  files_reviewed: ["math.mjs"],
  unreviewed_files: [],
  incomplete: [],
  criteria: [{ id: "AC2", pass: true, evidence: [{ where: "README.md:3", quote: "add(a, b) returns the sum" }] }],
  findings: [],
  read_first: [],
};
const finding: Review["findings"][number] = {
  severity: "P1",
  category: "bug",
  where: "math.mjs:2",
  quote: "return a - b;",
  what: "add subtracts",
  located: { line: 2, excerpt: "2:   return a - b;" },
  verification: {
    status: "confirmed",
    reason: "Addition regressed",
    expected: "Return the sum",
    scenario: "add(2,3) returns -1",
    evidence: [
      { revision: "base", path: "math.mjs", line: 2, quote: "return a + b;" },
      { revision: "head", path: "math.mjs", line: 2, quote: "return a - b;" },
    ],
  },
};
/** Answers the level question with `choice` and every yes/no question with `p`. */
const fixedDecider = (choice: string, confidence: number, p = 0.95): Decider => ({
  name: "fixed",
  decide: async (_state, questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([k, q]): [string, Answer] => [
        k,
        q.type === "choice" ? { type: "choice", choice, confidence, probabilities: {} } : { type: "noul", p },
      ]),
    ),
});
const live = (d: Decider) => new DecisionPanel([d]);
const none = new DecisionPanel([]);
const passed = [{ id: "AC2", verdict: "pass" as const, p: 0.95, reason: "p=0.95" }];
const rec = async (input: {
  plan?: AnalystOutput;
  gate?: GateReport;
  review?: Review;
  panel: DecisionPanel;
  criteria?: typeof passed;
  security?: boolean;
  priorities?: Priority[];
}) =>
  (
    await recommend({
      plan: input.plan ?? plan,
      gate: input.gate ?? gate,
      review: input.review ?? review,
      criteria: input.criteria ?? passed,
      securityTriage: input.security ?? false,
      priorities: input.priorities ?? (input.review ?? review).findings.map((f) => findingPriority(f, undefined)),
      panel: input.panel,
    })
  ).rec.level;

describe("recommendation", () => {
  test("without a decision model the safe default is careful", async () => {
    expect(await rec({ panel: none })).toBe("careful");
  });
  test("a confident model may lower to quick", async () => {
    expect(await rec({ panel: live(fixedDecider("quick", 0.9)) })).toBe("quick");
  });
  test("an unsure model keeps careful", async () => {
    expect(await rec({ panel: live(fixedDecider("quick", 0.6)) })).toBe("careful");
  });
  test("an unproven untestable criterion keeps careful", async () => {
    const unproven = [{ id: "AC2", verdict: "review" as const, reason: "no evidence" }];
    expect(await rec({ panel: live(fixedDecider("quick", 0.99)), criteria: unproven })).toBe("careful");
  });
  test("hard rules beat a confident model", async () => {
    const q = live(fixedDecider("quick", 0.99));
    expect(await rec({ panel: q, plan: { ...plan, security_sensitive: true } })).toBe("takeover");
    expect(await rec({ panel: q, security: true })).toBe("takeover");
    expect(await rec({ panel: q, review: { ...review, findings: [{ ...finding, where: "a:1", what: "x" }] } })).toBe("careful");
    const flagged = { ...gate, diff_policy: { ...gate.diff_policy, flags: ["test script changed"] } };
    expect(await rec({ panel: q, gate: flagged })).toBe("careful");
  });
  test("a finding's priority decides, not the reviewer's severity, and a P0 never takes the task over by itself", async () => {
    const q = live(fixedDecider("quick", 0.99));
    const p0 = { ...review, findings: [{ ...finding, severity: "P0" as const }] };
    const minor = { fix: false, unresolved: false, decidedBy: "decision model" as const, reason: "can wait" };
    const urgent = { fix: true, unresolved: false, decidedBy: "decision model" as const, reason: "must be fixed" };
    expect(await rec({ panel: q, review: p0, priorities: [minor] })).toBe("quick");
    expect(await rec({ panel: q, review: p0, priorities: [urgent] })).toBe("careful");
    expect(await rec({ panel: q, review: { ...review, findings: [{ ...finding, severity: "P2" as const }] }, priorities: [urgent] })).toBe("careful");
  });
  test("a changed file the reviewer did not read keeps careful", async () => {
    const partial = { ...review, unreviewed_files: ["infra/main.tf"] };
    expect(await rec({ panel: live(fixedDecider("quick", 0.99)), review: partial })).toBe("careful");
  });
  test("only a diff over 1000 lines forces careful", async () => {
    const q = live(fixedDecider("quick", 0.99));
    const sized = (added_lines: number) => ({ ...gate, diff_policy: { ...gate.diff_policy, added_lines, removed_lines: 0 } });
    expect(await rec({ panel: q, gate: sized(1000) })).toBe("quick");
    expect(await rec({ panel: q, gate: sized(1001) })).toBe("careful");
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const memory = () => {
  const directory = mkdtempSync(join(tmpdir(), "mork-steps-"));
  directories.push(directory);
  return new LocalStore(directory);
};
const calls: string[] = [];
const github = {
  createDraftPr: async () => {
    calls.push("pr");
    return { number: 7, html_url: "https://github.com/o/r/pull/7" };
  },
  addLabels: async (_repo: string, _n: number, labels: string[]) => void calls.push(`label:${labels.join(",")}`),
  removeLabel: async (_repo: string, _n: number, label: string) => void calls.push(`unlabel:${label}`),
  comment: async () => void calls.push("comment"),
  ensureLabel: async () => undefined,
  repo: async () => ({ default_branch: "main" }),
  file: async () => "[commands]",
  branchSha: async (_repo: string, branch: string) => (branch === "main" ? "a".repeat(40) : (headOf.get(branch) ?? "b".repeat(40))),
  issue: async () => ({ number: 1, title: "Make it better", body: "pls" }),
  pull: async (_repo: string, n: number) => ({
    number: n,
    state: "open",
    html_url: `https://github.com/o/r/pull/${n}`,
    head: { sha: "c".repeat(40), ref: "mork/issue-1-abc" },
  }),
  failedChecks: async () => [{ name: "lint", summary: "2 errors", log: "src/strings.mjs: missing JSDoc" }],
  openPr: async () => undefined,
  review: async () => ({ by: "alice", body: "Rename it", comments: [{ where: "math.mjs:1", body: "call it sum" }] }),
} as unknown as Deps["github"];
const timeline = new TimelineMemory();
const headOf = new Map<string, string>();
const events: ReportEvent[] = [];
const asked: { question: string; resume: string; prefix: string; taskToken: string }[] = [];
const told: ReportEvent[] = [];
const makeDeps = (store: LocalStore, panel: DecisionPanel = none): Deps => ({
  github,
  store,
  panel,
  timeline,
  llm: async () => "- What exactly should get better?",
  liveLog: () => undefined,
  reporter: async (task) =>
    task.origin.kind === "github"
      ? githubReporter(github, task.repo, task.origin.issue, task.id)
      : { report: async (e: ReportEvent) => void events.push(e) },
  resolveSlack: async () => ({ key: "PROJ-7", title: "Add add()", body: "sum two numbers", url: "https://jira/PROJ-7", created: true }),
  askRequester: async (_task, q) => void asked.push(q),
  tellSlack: async (_start, e) => void told.push(e),
  log: () => undefined,
  stopStations: async () => 0,
  executionRunning: async (arn) => arn === "arn:running",
});
const prefix = "tasks/o/r/1/abc";
const baseState: FlowState = {
  task: { id: "o/r#1/abc", repo: "o/r", started_by: "mork-abc", origin: { kind: "github", issue: 1 } },
  brief: {
    attempt: 1,
    prefix,
    repo: { full_name: "o/r", default_branch: "main", base_sha: "a".repeat(40) },
    branch: "mork/issue-1-abc",
  },
};
const publicPlan = { ...plan, hidden_tests: plan.hidden_tests.map(({ file, criteria }) => ({ file, criteria })) };

test("configured development limits stop a failed first build instead of using the default three attempts", async () => {
  const store = memory();
  const policy = { ...DEFAULT_DEVELOPMENT_POLICY, build_attempts: 1 };
  const state = await start({ ...makeDeps(store), development: policy }, { repo: "o/r", issue: 1, execution: "configured" });
  if (!("brief" in state)) throw new Error("Expected a development task");
  expect(state.brief.last_attempt).toBe(1);
  expect(state.policy).toEqual(policy);
  await store.put(keys.feedback(state.brief.prefix, 2), "Acceptance test failed");
  await expect(decide(makeDeps(store), { ...state, last: { ok: true, passed: false } })).rejects.toThrow("by attempt 1");
});
const impl = { summary: "adds add()", changes: [{ path: "math.mjs", change: "add" }], verification: [], deviations: [] };

async function checkedStore(passed: boolean): Promise<LocalStore> {
  const store = memory();
  await store.putJson(keys.issue(prefix), { ref: "#1", title: "Add add()", body: null });
  await store.putJson(keys.plan(prefix), publicPlan);
  await store.putJson(keys.impl(prefix, 1), impl);
  await store.putJson(keys.gate(prefix, 1), passed ? gate : { ...gate, hidden: [{ ...gate.hidden[0], passed: false }] });
  if (passed) await store.putJson(keys.review(prefix, 1), review);
  else await store.put(keys.feedback(prefix, 2), "- Acceptance criterion not met: AC1");
  return store;
}

describe("flow", () => {
  test("a build without a pushed commit goes back to Build without a gate report", async () => {
    const store = memory();
    await store.putJson(keys.plan(prefix), publicPlan);
    await store.put(keys.feedback(prefix, 2), "The previous attempt ended without a pushed commit: boom");
    const retried = await decide(makeDeps(store), { ...baseState, last: { ok: true, passed: false } });
    expect(retried.next).toBe("build");
    expect(retried.brief.attempt).toBe(2);
  });
  test("a branch that moved after the gate is handed over, not opened as a PR", async () => {
    calls.length = 0;
    headOf.set("mork/issue-1-abc", "c".repeat(40));
    const moved = decide(makeDeps(await checkedStore(true), live(fixedDecider("quick", 0.9))), { ...baseState, last: { ok: true, passed: true } });
    await expect(moved).rejects.toThrow("changed after the check");
    expect(calls).not.toContain("pr");
    headOf.clear();
  });
  test("a red check goes back to Build with the stored feedback", async () => {
    const next = await decide(makeDeps(await checkedStore(false)), { ...baseState, last: { ok: true, passed: false } });
    expect(next.next).toBe("build");
    expect(next.brief).toMatchObject({ attempt: 2 });
  });
  test("a red check on the last attempt hands over with the feedback", async () => {
    const store = await checkedStore(false);
    await store.putJson(keys.gate(prefix, MAX_BUILD_ATTEMPTS), (await store.json(keys.gate(prefix, 1))) as GateReport);
    await store.put(keys.feedback(prefix, MAX_BUILD_ATTEMPTS + 1), "- Acceptance criterion not met: AC1");
    const state = { ...baseState, brief: { ...baseState.brief, attempt: MAX_BUILD_ATTEMPTS }, last: { ok: true, passed: false } };
    await expect(decide(makeDeps(store), state)).rejects.toThrow("AC1");
  });
  test("a green check opens a draft PR with the recommendation", async () => {
    calls.length = 0;
    const next = await decide(makeDeps(await checkedStore(true), live(fixedDecider("quick", 0.9))), {
      ...baseState,
      last: { ok: true, passed: true },
    });
    expect(next).toMatchObject({ next: "done", outcome: { level: "quick", url: "https://github.com/o/r/pull/7" } });
    expect(calls).toEqual(["pr", "label:review:quick", "label:mork:done", "unlabel:mork:working", "comment"]);
    const items = [...timeline.items.values()].filter((item) => item.pk === "task#o/r#1/abc").sort((a, b) => a.sk.localeCompare(b.sk));
    expect(items.map((i) => i.sk)).toEqual(["decision#criteria#check-1", "decision#recommendation#check-1", "pr"]);
    expect(await timeline.get("pr#o/r#7", "task")).toMatchObject({ task: "o/r#1/abc" });
  });
  test("a green check the rules send to a person is handed over without a PR", async () => {
    calls.length = 0;
    const store = await checkedStore(true);
    await store.putJson(keys.plan(prefix), { ...publicPlan, security_sensitive: true });
    await expect(decide(makeDeps(store), { ...baseState, last: { ok: true, passed: true } })).rejects.toMatchObject({ name: "Handover" });
    expect(calls).toEqual([]);
  });
});

describe("repair before the PR", () => {
  const passed = { ...baseState, last: { ok: true, passed: true } };
  /** Answers every priority question with the same probability that the finding must be fixed. */
  const urgent = (p: number) =>
    live({
      name: "fixed",
      decide: async (_state, questions) =>
        Object.fromEntries(
          Object.keys(questions).map((k): [string, Answer] => [
            k,
            { type: "choice", choice: p > 0.5 ? "P1" : "P2", confidence: 0.9, probabilities: { P0: p / 2, P1: p / 2, P2: 1 - p } },
          ]),
        ),
    });
  const reviewed = async (findings: Review["findings"]) => {
    const store = await checkedStore(true);
    await store.putJson(keys.review(prefix, 1), { ...review, findings });
    return store;
  };
  test("a proven defect goes back to Build, without a PR, and only located bugs and security issues are candidates", async () => {
    calls.length = 0;
    const store = await reviewed([finding, { ...finding, category: "style" }, { ...finding, located: null }]);
    const next = await decide(makeDeps(store, urgent(0.95)), passed);
    expect(next).toMatchObject({ next: "build", brief: { attempt: 2, last_attempt: MAX_BUILD_ATTEMPTS + 1 }, repair: { rounds: 1, findings: 1 } });
    expect(calls).not.toContain("pr");
    const feedback = await store.text(keys.feedback(prefix, 2));
    expect(feedback).toContain("The reviewer found defects in your change");
    expect(feedback).toContain("2:   return a - b;");
    expect(feedback.match(/^## /gm)).toHaveLength(1);
    expect(await timeline.get("task#o/r#1/abc", "decision#findings#check-1-findings-1")).toMatchObject({
      action: {
        priorities: expect.arrayContaining([expect.objectContaining({ fix: true, unresolved: false, decidedBy: "decision model" })]),
        repair: [expect.stringContaining("math.mjs:2")],
      },
    });
  });
  test("the decision model's priority overrides the reviewer's severity both ways", async () => {
    const minor = await decide(makeDeps(await reviewed([finding]), urgent(0.1)), passed);
    expect(minor.next).toBe("done");
    const major = await decide(makeDeps(await reviewed([{ ...finding, severity: "P2" }]), urgent(0.9)), passed);
    expect(major).toMatchObject({ next: "build", repair: { rounds: 1 } });
  });
  test("without a confident decision model the reviewer's P0 and P1 are repaired", async () => {
    expect((await decide(makeDeps(await reviewed([finding])), passed)).next).toBe("build");
    expect((await decide(makeDeps(await reviewed([{ ...finding, severity: "P2" }])), passed)).next).toBe("done");
    expect((await decide(makeDeps(await reviewed([finding]), urgent(0.5)), passed)).next).toBe("build");
  });
  test("used-up repair rounds send the review to the PR", async () => {
    calls.length = 0;
    const next = await decide(makeDeps(await reviewed([finding])), { ...passed, repair: { rounds: 3, findings: 3 } });
    expect(next).toMatchObject({ next: "done", outcome: { level: "careful" } });
    expect(calls).toContain("pr");
    const twice = { ...passed, repair: { rounds: 1, findings: 1 }, policy: { ...DEFAULT_DEVELOPMENT_POLICY, repairs: { rounds: 2 } } };
    expect(await decide(makeDeps(await reviewed([finding])), twice)).toMatchObject({ next: "build", repair: { rounds: 2, findings: 2 } });
    const off = { ...passed, policy: { ...DEFAULT_DEVELOPMENT_POLICY, repairs: { rounds: 0 } } };
    expect((await decide(makeDeps(await reviewed([finding])), off)).next).toBe("done");
  });
  test("a repair brings its own attempt, also after the last one; changes the rules hand to a person are not repaired", async () => {
    const last = await decide(makeDeps(await reviewed([finding])), { ...passed, brief: { ...baseState.brief, last_attempt: 1 } });
    expect(last).toMatchObject({ next: "build", brief: { attempt: 2, last_attempt: 2 } });
    const store = await reviewed([{ ...finding, severity: "P0" }]);
    await store.putJson(keys.plan(prefix), { ...publicPlan, security_sensitive: true });
    await expect(decide(makeDeps(store), passed)).rejects.toMatchObject({ name: "Handover" });
  });
  test("a P0 defect gets its repair before the rules take the task over", async () => {
    const next = await decide(makeDeps(await reviewed([{ ...finding, severity: "P0" }])), passed);
    expect(next).toMatchObject({ next: "build", repair: { findings: 1 } });
  });
});

describe("triage", () => {
  test("a confidently unclear issue gets questions and ends without a container", async () => {
    calls.length = 0;
    const unclear = live({ name: "fixed", decide: async () => ({ actionable: { type: "noul", p: 0.05 } }) });
    const next = await start(makeDeps(memory(), unclear), { repo: "o/r", issue: 1, execution: "exec-12345678" });
    expect(next.next).toBe("done");
    expect(calls).toEqual(["label:mork:working", "comment", "label:needs-info", "unlabel:mork:working", "unlabel:mork"]);
  });
  test("a clear issue is recorded and the task starts", async () => {
    const clear = live({ name: "fixed", decide: async () => ({ actionable: { type: "noul", p: 0.9 } }) });
    const next = await start(makeDeps(memory(), clear), { repo: "o/r", issue: 1, execution: "exec-87654321" });
    expect(next).toMatchObject({ next: "plan", security: false });
    expect(await timeline.get("task#o/r#1/87654321", "decision#triage#start")).toMatchObject({ point: "triage" });
  });
});

describe("slack origin", () => {
  const slackStart = {
    repo: "o/r",
    source: "slack" as const,
    ref: { kind: "slack" as const, channel: "C123", thread_ts: "1.2", user: "U1" },
    ask: "add add()",
    jira_project: "PROJ",
  };
  test("a Slack task is named after its Jira issue and reports into the thread", async () => {
    events.length = 0;
    const clear = live({ name: "fixed", decide: async () => ({ actionable: { type: "noul", p: 0.9 } }) });
    const next = await start(makeDeps(memory(), clear), { ...slackStart, execution: "slack-Ev0ABCDEF12" });
    expect(next.task.id).toBe("o/r#PROJ-7/abcdef12");
    expect(next.brief).toMatchObject({ prefix: "tasks/o/r/PROJ-7/abcdef12", branch: "mork/proj-7-abcdef12", report: slackStart.ref });
    expect(events.map((e) => e.kind)).toEqual(["started"]);
  });
  test("Jev triages the raw message first: a greeting ends the run before any Jira issue is drafted", async () => {
    told.length = 0;
    let resolved = false;
    const greeting = live({ name: "fixed", decide: async () => ({ is_request: { type: "noul", p: 0.03 }, actionable: { type: "noul", p: 0.9 } }) });
    const deps = {
      ...makeDeps(memory(), greeting),
      resolveSlack: async () => {
        resolved = true;
        return { key: "PROJ-7", title: "invented", body: "", url: "u", created: true };
      },
    };
    const next = await start(deps, { ...slackStart, ask: "ahoj", execution: "slack-Ev0GREETING2" });
    expect(next).toMatchObject({ next: "done" });
    expect(resolved).toBe(false);
    expect(told.map((e) => e.kind)).toEqual(["not_a_request"]);
    expect(await timeline.get("task#o/r#slack/reeting2", "decision#triage#message")).toMatchObject({ action: { route: "ignore" } });
  });
  test("a request is triaged as written and that triage is the one recorded", async () => {
    const clear = live({ name: "fixed", decide: async () => ({ is_request: { type: "noul", p: 0.97 }, actionable: { type: "noul", p: 0.9 } }) });
    const next = await start(makeDeps(memory(), clear), { ...slackStart, execution: "slack-Ev0REQUEST01" });
    expect(next).toMatchObject({ next: "plan" });
    expect(await timeline.get("task#o/r#PROJ-7/equest01", "decision#triage#message")).toMatchObject({ point: "triage" });
  });
  test("a message that asks for nothing ends the run without a Jira issue or a task", async () => {
    calls.length = 0;
    const deps = {
      ...makeDeps(memory()),
      resolveSlack: async () => {
        throw Object.assign(new Error("not a request: ahoj"), { name: "NotARequest" });
      },
    };
    expect(await start(deps, { ...slackStart, ask: "ahoj", execution: "slack-Ev0GREETING1" })).toEqual({
      next: "done",
      dismissed: "not a request: ahoj",
    });
    expect(calls).toEqual([]);
  });
  test("its PR carries the Jira key; Decide only reports the PR", async () => {
    events.length = 0;
    calls.length = 0;
    const state: FlowState = {
      ...baseState,
      task: {
        ...baseState.task,
        origin: { kind: "slack", start: slackStart, work: { key: "PROJ-7", url: "https://jira/PROJ-7", title: "Add add()", created: true } },
      },
      last: { ok: true, passed: true },
    };
    let created: { title: string; body: string } | undefined;
    const deps = makeDeps(await checkedStore(true), live(fixedDecider("quick", 0.9)));
    deps.github = {
      ...github,
      createDraftPr: async (_r: string, pr: { title: string; body: string }) => {
        created = pr;
        return { number: 8, html_url: "u" };
      },
    } as unknown as Deps["github"];
    await decide(deps, state);
    expect(created?.title).toBe("PROJ-7: Add add()");
    expect(created?.body).toContain("Jira: https://jira/PROJ-7");
    expect(events.map((e) => e.kind)).toEqual(["pr"]);
  });
});

describe("questions", () => {
  const slackTask = {
    ...baseState.task,
    origin: {
      kind: "slack" as const,
      start: {
        repo: "o/r",
        source: "slack" as const,
        ref: { kind: "slack" as const, channel: "C1", thread_ts: "1.2", user: "U1" },
        ask: "x",
        jira_project: "PROJ",
      },
      work: { key: "PROJ-7", url: "u", title: "t", created: false },
    },
  };
  test("a station question from a Slack task is posted and waits for the token", async () => {
    asked.length = 0;
    await ask(
      makeDeps(memory()),
      { ...baseState, task: slackTask, last: { ok: true, question: "Pad with spaces or zeros?", resume: "build" } },
      "tok",
    );
    expect(asked).toEqual([{ question: "Pad with spaces or zeros?", resume: "build", prefix, taskToken: "tok" }]);
  });
  test("after a triage answer a later station question wins", async () => {
    asked.length = 0;
    const state: FlowState = {
      ...baseState,
      task: slackTask,
      next: "ask",
      ask: { question: "old", resume: "plan" },
      last: { ok: true, question: "new", resume: "check" },
    };
    await ask(makeDeps(memory()), state, "tok");
    expect(asked[0]).toMatchObject({ question: "new", resume: "check" });
  });
  test("an unavailable answer history cannot reset the question limit", async () => {
    asked.length = 0;
    const deps = makeDeps(memory());
    deps.store.json = async () => {
      throw new Error("S3 unavailable");
    };
    await expect(ask(deps, { ...baseState, task: slackTask, last: { question: "Which?", resume: "plan" } }, "tok")).rejects.toThrow("S3 unavailable");
    expect(asked).toEqual([]);
  });
  test("GitHub tasks and the fourth question go to a person", async () => {
    const q = { ok: true, question: "Which?", resume: "plan" };
    await expect(ask(makeDeps(memory()), { ...baseState, last: q }, "tok")).rejects.toMatchObject({ name: "Handover" });
    const store = memory();
    await store.putJson(
      keys.answers(prefix),
      [1, 2, 3].map((n) => ({ question: `q${n}`, answer: `a${n}` })),
    );
    await expect(ask(makeDeps(store), { ...baseState, task: slackTask, last: q }, "tok")).rejects.toThrow("already asked 3 questions");
  });
  test("an unclear Slack request asks instead of ending", async () => {
    const unclear = live({ name: "fixed", decide: async () => ({ actionable: { type: "noul", p: 0.05 } }) });
    const store = memory();
    const next = await start(makeDeps(store, unclear), { ...slackTask.origin.start, execution: "slack-Ev0QUESTION1" });
    expect(next).toMatchObject({ next: "ask", ask: { resume: "plan" } });
    expect(await store.json(keys.issue(next.brief.prefix))).toMatchObject({ title: "Add add()" });
  });
});

describe("intake", () => {
  test("PR webhooks map to outcomes", () => {
    expect(prOutcome("pull_request", { action: "closed", pull_request: { number: 1, merged: true } })).toBe("merged");
    expect(prOutcome("pull_request", { action: "closed", pull_request: { number: 1, merged: false } })).toBe("closed");
    expect(prOutcome("pull_request_review", { action: "submitted", review: { state: "CHANGES_REQUESTED" } })).toBe("changes_requested");
    expect(prOutcome("pull_request", { action: "opened" })).toBeUndefined();
  });
  test("webhook signatures are checked in constant time", () => {
    const body = Buffer.from('{"a":1}');
    const { createHmac } = require("node:crypto");
    const good = `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
    expect(signatureValid("s", body, good)).toBe(true);
    expect(signatureValid("s", body, "sha256=00")).toBe(false);
    expect(signatureValid("s", body, undefined)).toBe(false);
    for (const secret of ["", " ", "unset"]) {
      const placeholderSignature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      expect(signatureValid(secret, body, placeholderSignature)).toBe(false);
    }
  });
});

describe("handover", () => {
  test("a thrown Handover carries its message as the reason", () => {
    const cause = JSON.stringify({ errorType: "Handover", errorMessage: "The analyst produced no plan", trace: [] });
    expect(handoverReason({ ...baseState, error: { Error: "Handover", Cause: cause } })).toBe("The analyst produced no plan");
  });
  test("a handover opens a draft PR labelled for a person when the branch has work", async () => {
    calls.length = 0;
    const store = await checkedStore(true);
    const cause = JSON.stringify({ errorType: "Handover", errorMessage: "The change touches a protected path", trace: [] });
    const done = await handover(makeDeps(store), { ...baseState, error: { Error: "Handover", Cause: cause } });
    expect(done).toMatchObject({ next: "done", outcome: { level: "takeover" } });
    expect(calls).toEqual(["pr", "label:needs-human", "label:needs-human", "unlabel:mork:working", "comment"]);
    expect(await store.json(keys.pr(prefix))).toMatchObject({ number: 7, fix_rounds: 0 });
  });
  test("a handover without pushed work opens no PR", async () => {
    calls.length = 0;
    headOf.set("mork/issue-1-abc", "a".repeat(40));
    await handover(makeDeps(await checkedStore(true)), { ...baseState, error: { Error: "States.Timeout", Cause: "" } });
    expect(calls).not.toContain("pr");
    headOf.clear();
  });
  test("any other error is reported as unexpected", () => {
    expect(handoverReason({ ...baseState, error: { Error: "States.Timeout", Cause: "" } })).toContain("Unexpected error (States.Timeout)");
  });
  test("startedBy fits ECS limits", () => {
    const value = startedBy("26132711");
    expect(value).toBe("mork-26132711");
    expect(value.length).toBeLessThanOrEqual(36);
  });
});

describe("checks table", () => {
  test("lists every check that ran, and marks what did not pass", () => {
    const table = checksTable({
      gateBefore: { mode: "before", hidden: [{ file: "add.test.mjs", criteria: ["AC1"], passed: false, output: "" }] },
      gate: { ...gate, checks: [{ command: "npm run lint", exit_code: 1, output: "" }] },
      review: { ...review, findings: [{ ...finding, what: "a | b" }] },
      verdicts: [{ id: "AC2", verdict: "pass", p: 0.95, reason: "p=0.95" }],
      attempt: 2,
      lastAttempt: 3,
      head: "b".repeat(40),
    });
    expect(table).toContain("| Hidden tests fail on the base commit | gate | ✅ 1/1 failed before the change |");
    expect(table).toContain("| Repository tests | gate | ✅ `npm test` |");
    expect(table).toContain("| Repository check | gate | ❌ `npm run lint` (exit 1) |");
    expect(table).toContain("| Code review | Open Code Review | ⚠️ 0× P0, 1× P1, 0× P2 |");
    expect(table).toContain("| Build attempts | workflow | 2 of 3 |");
    expect(table).toContain("`bbbbbbb`");
    expect(table.split("\n").every((row) => row.startsWith("| ") && row.endsWith(" |"))).toBe(true);
  });
});

describe("fix runs after the PR", () => {
  test("webhooks that ask for a fix, and ones that do not", () => {
    const suite = (conclusion: string, head_branch = "mork/issue-1-abc") => ({
      action: "completed",
      check_suite: { conclusion, head_branch, head_sha: "c".repeat(40), pull_requests: [{ number: 7 }] },
    });
    expect(fixTrigger("check_suite", suite("failure"))).toMatchObject({ pr: 7, trigger: { kind: "ci" }, key: `ci-${"c".repeat(12)}` });
    expect(fixTrigger("check_suite", suite("success"))).toBeUndefined();
    expect(fixTrigger("check_suite", suite("failure", "feature/x"))).toBeUndefined();
    const review = { action: "submitted", review: { id: 5, state: "CHANGES_REQUESTED", user: { login: "alice" } }, pull_request: { number: 7 } };
    expect(fixTrigger("pull_request_review", review)).toMatchObject({ pr: 7, trigger: { kind: "review", review_id: 5 }, sender: "alice" });
    expect(fixTrigger("pull_request_review", { ...review, review: { ...review.review, state: "APPROVED" } })).toBeUndefined();
    const comment = (body: string, pr = true) => ({
      action: "created",
      issue: { number: 7, ...(pr ? { pull_request: {} } : {}) },
      comment: { id: 9, body, user: { login: "bob" } },
    });
    expect(fixTrigger("issue_comment", comment("@mork please rename it"))).toMatchObject({
      trigger: { kind: "comment", by: "bob" },
      key: "comment-9",
    });
    expect(fixTrigger("issue_comment", comment("looks good"))).toBeUndefined();
    expect(fixTrigger("issue_comment", comment("@morkbot hi"))).toBeUndefined();
    expect(fixTrigger("issue_comment", comment("@mork fix", false))).toBeUndefined();
  });

  const prRecord = (extra: Record<string, unknown> = {}) => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: { task: baseState.task, brief: { ...baseState.brief, attempt: 1 } },
    fix_rounds: 0,
    ...extra,
  });
  const fixInput = (trigger: FixTrigger) => ({ fix: { repo: "o/r", pr: 7, trigger }, execution: "fix-o-r-7-x", execution_arn: "arn:fix" });

  test("CI failure on the PR head continues the task in Build with the failure as feedback", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(keys.pr(prefix), prRecord());
    const next = (await start(makeDeps(store), fixInput({ kind: "ci", sha: "c".repeat(40) }))) as FlowState;
    expect(next).toMatchObject({ next: "build", brief: { attempt: 2, last_attempt: 3, execution: "fix-o-r-7-x" }, fix: { pr: 7, round: 1 } });
    expect(await store.text(keys.feedback(prefix, 2))).toContain("missing JSDoc");
    expect(await store.json(keys.pr(prefix))).toMatchObject({ fix_rounds: 1, running: "arn:fix" });
  });

  test("stale, concurrent and used-up triggers start nothing", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(keys.pr(prefix), prRecord());
    expect(await start(makeDeps(store), fixInput({ kind: "ci", sha: "d".repeat(40) }))).toMatchObject({
      next: "done",
      dismissed: "CI result for an older commit",
    });
    await store.putJson(keys.pr(prefix), prRecord({ running: "arn:running" }));
    expect(await start(makeDeps(store), fixInput({ kind: "review", review_id: 5, by: "alice" }))).toMatchObject({ next: "done" });
    calls.length = 0;
    await store.putJson(keys.pr(prefix), prRecord({ fix_rounds: DEFAULT_DEVELOPMENT_POLICY.fixes.rounds }));
    expect(await start(makeDeps(store), fixInput({ kind: "review", review_id: 5, by: "alice" }))).toMatchObject({ dismissed: "fix rounds used up" });
    expect(calls).toContain("comment");
    expect(
      await start(makeDeps(memory()), {
        ...fixInput({ kind: "ci", sha: "c".repeat(40) }),
        fix: { repo: "o/r", pr: 99, trigger: { kind: "ci", sha: "c".repeat(40) } },
      }),
    ).toMatchObject({ dismissed: "not a Mork PR" });
  });

  test("a green fix comments on the PR instead of opening another, and releases its claim", async () => {
    calls.length = 0;
    const store = await checkedStore(true);
    await store.putJson(keys.pr(prefix), prRecord({ fix_rounds: 1, running: "arn:fix" }));
    const next = await decide(makeDeps(store, live(fixedDecider("quick", 0.9))), {
      ...baseState,
      task: { ...baseState.task, execution_arn: "arn:fix" },
      fix: { pr: 7, url: "https://github.com/o/r/pull/7", round: 1, trigger: "CI failed" },
      last: { ok: true, passed: true },
    });
    expect(next).toMatchObject({ next: "done", outcome: { level: "quick" } });
    expect(calls).not.toContain("pr");
    expect(calls).toContain("comment");
    const saved = await store.json(keys.pr(prefix));
    expect(saved).toMatchObject({ fix_rounds: 1 });
    expect(saved.running).toBeUndefined();
  });
});

describe("fix run claims", () => {
  test("two triggers racing for the same round start one fix run", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(keys.pr(prefix), {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: { task: baseState.task, brief: { ...baseState.brief, attempt: 1 } },
      fix_rounds: 0,
    });
    const input = (n: number) => ({
      fix: { repo: "o/r", pr: 7, trigger: { kind: "comment" as const, body: "@mork x", by: "bob" } },
      execution: `fix-${n}`,
      execution_arn: `arn:fix-${n}`,
    });
    const [a, b] = await Promise.all([start(makeDeps(store), input(1)), start(makeDeps(store), input(2))]);
    const outcomes = [a, b].map((r) => ("dismissed" in r ? r.dismissed : r.next));
    expect(outcomes.sort()).toEqual(["a fix run is already working on this PR", "build"]);
  });
});

describe("fix run replays and bookkeeping", () => {
  const record = (extra: Record<string, unknown> = {}) => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: { task: baseState.task, brief: { ...baseState.brief, attempt: 1 } },
    fix_rounds: 0,
    ...extra,
  });
  const input = {
    fix: { repo: "o/r", pr: 7, trigger: { kind: "comment" as const, body: "@mork x", by: "bob" } },
    execution: "fix-a",
    execution_arn: "arn:fix-a",
  };

  test("a retried Start continues the round it already claimed instead of taking another", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(keys.pr(prefix), record());
    const first = (await start(makeDeps(store), input)) as FlowState;
    const again = (await start(makeDeps(store), input)) as FlowState;
    expect(first).toMatchObject({ next: "build", brief: { attempt: 2 }, fix: { round: 1 } });
    expect(again).toMatchObject({ next: "build", brief: { attempt: 2 }, fix: { round: 1 } });
    expect(await store.json(keys.pr(prefix))).toMatchObject({ fix_rounds: 1, running: "arn:fix-a" });
  });

  test("after a failed fix round the next round starts above every attempt used so far", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(
      keys.pr(prefix),
      record({ fix_rounds: 1, running: "arn:fix-a", state: { task: baseState.task, brief: { ...baseState.brief, attempt: 2 } } }),
    );
    await handover(makeDeps(store), {
      ...baseState,
      task: { ...baseState.task, execution_arn: "arn:fix-a" },
      brief: { ...baseState.brief, attempt: 3 },
      fix: { pr: 7, url: "https://github.com/o/r/pull/7", round: 1, trigger: "CI failed" },
      error: { Error: "Handover", Cause: "gate failed twice" },
    });
    const next = (await start(makeDeps(store), { ...input, execution: "fix-b", execution_arn: "arn:fix-b" })) as FlowState;
    expect(next).toMatchObject({ next: "build", brief: { attempt: 4 }, fix: { round: 2 } });
  });

  test("a failed feedback write resumes the same reservation, and a terminated owner cannot block later triggers", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(keys.pr(prefix), record());
    const put = store.put.bind(store);
    let fail = true;
    store.put = async (key, body) => {
      if (fail && key === keys.feedback(prefix, 2)) throw new Error("interrupted feedback write");
      return put(key, body);
    };
    await expect(start(makeDeps(store), input)).rejects.toThrow("interrupted feedback write");
    expect(await store.json(keys.pr(prefix))).toMatchObject({ running: input.execution_arn, fix_rounds: 1, state: { brief: { attempt: 2 } } });
    fail = false;
    expect(await start(makeDeps(store), input)).toMatchObject({ next: "build", fix: { round: 1 }, brief: { attempt: 2 } });
    const deps = makeDeps(store);
    const inspected: string[] = [];
    deps.executionRunning = async (arn) => {
      inspected.push(arn);
      return false;
    };
    const next = await start(deps, { ...input, execution: "fix-b", execution_arn: "arn:fix-b" });
    // Round 1 reserved attempts 2-3 plus three repair attempts.
    expect(next).toMatchObject({ next: "build", fix: { round: 2 }, brief: { attempt: 7 } });
    expect(inspected).toEqual([input.execution_arn]);
    // Delayed completion of the first owner must preserve its successor.
    await handover(deps, {
      ...baseState,
      task: { ...baseState.task, execution_arn: input.execution_arn },
      fix: { pr: 7, url: "https://github.com/o/r/pull/7", round: 1, trigger: "comment" },
      error: { Error: "Handover", Cause: "late" },
    });
    expect(await store.json(keys.pr(prefix))).toMatchObject({ running: "arn:fix-b", fix_rounds: 2, state: { brief: { attempt: 7 } } });
  });

  test("late completion cannot replace a finished successor or reuse its attempts", async () => {
    const store = memory();
    const deps = makeDeps(store);
    deps.development = { ...DEFAULT_DEVELOPMENT_POLICY, fixes: { rounds: 4, attempts: 2 } };
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    const completed = {
      ...baseState,
      task: { ...baseState.task, execution_arn: "arn:fix-b" },
      brief: { ...baseState.brief, attempt: 5 },
      fix: { pr: 7, url: "https://github.com/o/r/pull/7", round: 2, trigger: "comment" },
    };
    await store.putJson(keys.pr(prefix), record({ fix_rounds: 2, state: { task: completed.task, brief: completed.brief } }));
    const saved = await store.json(keys.pr(prefix));
    for (const late of [
      {
        ...completed,
        task: { ...completed.task, execution_arn: "arn:fix-a" },
        brief: { ...completed.brief, attempt: 2 },
        fix: { ...completed.fix, round: 1 },
      },
      { ...completed, task: { ...completed.task, execution_arn: "arn:fix-a" } },
      { ...completed, brief: { ...completed.brief, attempt: 4 } },
      { ...baseState, task: { ...baseState.task, execution_arn: "arn:original" } },
    ]) {
      await savePr(deps, late, { number: 7, url: completed.fix.url });
      await releasePr(deps, late);
      expect(await store.json(keys.pr(prefix))).toEqual(saved);
    }
    await savePr(deps, completed, { number: 7, url: completed.fix.url });
    expect(await store.json(keys.pr(prefix))).toMatchObject({
      fix_rounds: 2,
      state: { task: { execution_arn: "arn:fix-b" }, brief: { attempt: 5 } },
    });
    expect(await start(deps, { ...input, execution: "fix-c", execution_arn: "arn:fix-c" })).toMatchObject({
      fix: { round: 3 },
      brief: { attempt: 6 },
    });
    await expect(savePr(makeDeps(memory()), completed, { number: 7, url: completed.fix.url })).rejects.toThrow("without its reservation");
  });

  test("storage and execution lookup failures remain retryable", async () => {
    const store = memory();
    await linkPr(timeline, baseState.task.id, "o/r", 7, prefix);
    await store.putJson(keys.pr(prefix), record({ running: "arn:other" }));
    const deps = makeDeps(store);
    deps.executionRunning = async () => {
      throw new Error("SFN unavailable");
    };
    await expect(start(deps, input)).rejects.toThrow("SFN unavailable");
    store.json = async () => {
      throw new Error("S3 unavailable");
    };
    await expect(start(deps, input)).rejects.toThrow("S3 unavailable");
  });

  test("Mork's own comments never trigger a fix, even when they quote @mork", () => {
    const own = {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { id: 1, body: `${MARKER}Fixed what @mork was asked`, user: { login: "bot" } },
    };
    expect(fixTrigger("issue_comment", own)).toBeUndefined();
  });

  test("an expired PR record dismisses the trigger instead of failing", async () => {
    await linkPr(timeline, "o/r#9/old", "o/r", 9, "tasks/o/r/9/old");
    const r = await start(makeDeps(memory()), { ...input, fix: { ...input.fix, pr: 9 } });
    expect(r).toMatchObject({ next: "done", dismissed: "the task's data has expired" });
  });
});

test("unresolved and incomplete reviews cannot become quick even with a confident model", async () => {
  const q = live(fixedDecider("quick", 1));
  expect(
    await rec({
      panel: q,
      review: { ...review, findings: [{ ...finding, verification: { status: "unknown", reason: "Prerequisite not established" } }] },
      priorities: [],
    }),
  ).toBe("careful");
  expect(await rec({ panel: q, review: { ...review, incomplete: ["OCR partial"] } })).toBe("careful");
});
