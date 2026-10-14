import { describe, expect, test } from "bun:test";
import { type Decider, DecisionPanel, STEER_GRACE_MS } from "@mork/decision";
import { STALL_MS, Supervisor } from "./supervisor.ts";

const every = { everyMs: 0, trackDiff: false, started: 0 };

const stuck: Decider = { name: "fixed", decide: async () => ({ worker_stuck: { type: "noul", p: 0.95 } }) };

function hooks() {
  const done: string[] = [];
  return {
    done,
    hooks: {
      diffStat: () => " a.mjs | 2 +-",
      steer: async (m: string) => void done.push(`steer:${m.slice(0, 12)}`),
      stop: (r: string) => void done.push(`stop:${r.slice(0, 7)}`),
    },
  };
}

describe("supervisor", () => {
  test("read-only progress is judged against a previous check without inspecting a code diff", async () => {
    const { done, hooks: h } = hooks();
    h.diffStat = () => {
      throw new Error("An analyst must not be measured by a code diff");
    };
    const evaluated: Array<{ state: unknown; questions: string[] }> = [];
    const model: Decider = {
      name: "fixed",
      decide: async (state, questions) => {
        evaluated.push({ state, questions: Object.keys(questions) });
        return { meaningful_progress: { type: "noul", p: 0 } };
      },
    };
    const supervisor = new Supervisor(new DecisionPanel([model]), { station: "analyst" }, h, every);
    supervisor.observe({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
    await supervisor.check(1000);
    expect(evaluated[0]?.questions).not.toContain("meaningful_progress");
    expect(done).toEqual([]);
    supervisor.observe({ type: "tool_execution_start", toolName: "read", args: { path: "component.py" } });
    await supervisor.check(2000);
    expect(evaluated[1]?.questions).toContain("meaningful_progress");
    const state = evaluated[1]?.state as { previous_check: { recent_tool_calls: string[] }; recent_tool_calls: string[] };
    expect(state.previous_check.recent_tool_calls).toHaveLength(1);
    expect(state.recent_tool_calls).toHaveLength(2);
    expect(done).toHaveLength(1);
    expect(supervisor.records[1]?.action.message).toContain("without editing project files");
    await supervisor.check(2000 + STEER_GRACE_MS);
    expect(done).toHaveLength(2);
  });
  test("steers once, waits out the grace, then stops", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, every);
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    await s.check(1_000);
    await s.check(1_000 + STEER_GRACE_MS - 1);
    await s.check(1_000 + STEER_GRACE_MS);
    expect(done).toEqual(["steer:You are repe", "stop:Supervi"]);
    expect(s.records.map((r) => r.action.action)).toEqual(["steer", "stop"]);
    expect(s.records.map((r) => r.action.trigger)).toEqual(["periodic", "after steering"]);
    const state = s.records[0]?.trace.state as { recent_tool_calls: string[]; diff_stat?: string };
    expect(state.recent_tool_calls[0]).toContain("npm test");
    expect(state.diff_stat).toBeUndefined();
  });
  test("without a model supervision does not collect evidence or write records", async () => {
    const { done, hooks: h } = hooks();
    h.diffStat = () => {
      throw new Error("No model must not spawn git");
    };
    const s = new Supervisor(new DecisionPanel([]), { title: "t" }, h, every);
    await s.check(0);
    expect(done).toEqual([]);
    expect(s.records).toEqual([]);
  });
  test("a configured model that cannot decide still records its safe default", async () => {
    const { done, hooks: h } = hooks();
    const unavailable: Decider = { name: "fixed", decide: async () => ({ worker_stuck: { type: "undecided", reason: "offline" } }) };
    const s = new Supervisor(new DecisionPanel([unavailable]), { title: "t" }, h, every);
    await s.check(0);
    expect(done).toEqual([]);
    expect(s.records[0]?.action).toEqual({ action: "continue", trigger: "periodic" });
  });
  test("asks on a repeated tool call or tool errors in a row, otherwise once per period", async () => {
    const { hooks: h } = hooks();
    const fine: Decider = { name: "fixed", decide: async () => ({ worker_stuck: { type: "noul", p: 0.05 } }) };
    const s = new Supervisor(new DecisionPanel([fine]), { title: "t" }, h, { everyMs: 300_000, trackDiff: false, started: 0 });
    await s.check(60_000);
    for (let i = 0; i < 3; i++) s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    await s.check(61_000);
    await s.check(62_000);
    for (let i = 0; i < 3; i++) {
      s.observe({ type: "tool_execution_start", toolName: "read", args: { path: `f${i}` } });
      s.observe({ type: "tool_execution_end", isError: true });
    }
    await s.check(63_000);
    await s.check(63_000 + 300_000);
    expect(s.records.map((r) => r.action.trigger)).toEqual(["repeated tool call", "tool errors in a row", "periodic"]);
  });
  test("an implementer whose diff stops changing gets a check", async () => {
    const { hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, { everyMs: 3_600_000, trackDiff: true, started: 0 });
    await s.check(1_000);
    await s.check(STALL_MS);
    await s.check(STALL_MS + 1_000);
    expect(s.records.map((r) => r.action.trigger)).toEqual(["diff unchanged"]);
  });
});
