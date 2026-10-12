import { describe, expect, test } from "bun:test";
import { type Decider, DecisionPanel, STEER_GRACE_MS } from "@mork/decision";
import { Supervisor } from "./supervisor.ts";

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
  test("steers once, waits out the grace, then stops", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h);
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    await s.check(1_000);
    await s.check(1_000 + STEER_GRACE_MS - 1);
    await s.check(1_000 + STEER_GRACE_MS);
    expect(done).toEqual(["steer:You are repe", "stop:Supervi"]);
    expect(s.records.map((r) => r.action.action)).toEqual(["steer", "continue", "stop"]);
    const state = s.records[0]?.trace.state as { recent_tool_calls: string[]; diff_stat: string };
    expect(state.recent_tool_calls[0]).toContain("npm test");
    expect(state.diff_stat).toContain("a.mjs");
  });
  test("an undecided model never touches the run", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([]), { title: "t" }, h);
    await s.check(0);
    expect(done).toEqual([]);
    expect(s.records[0]?.action).toEqual({ action: "continue" });
  });
});
