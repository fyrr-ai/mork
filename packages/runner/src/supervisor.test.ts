import { describe, expect, test } from "bun:test";
import { type Decider, DecisionPanel, STEER_GRACE_MS } from "@mork/decision";
import { MAX_CORRECTION_RESETS, STALL_MS, Supervisor, toolOutcome } from "./supervisor.ts";

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
    supervisor.observe({ type: "tool_execution_start", toolName: "read", args: { path: "other.py" } });
    supervisor.observe({ type: "tool_execution_end", toolName: "read", isError: false });
    supervisor.observe({ type: "turn_end" });
    await supervisor.check(2000 + STEER_GRACE_MS);
    expect(done).toHaveLength(2);
  });
  test("steers once, waits out the grace, then stops", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, every);
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    await s.check(1_000);
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    s.observe({ type: "tool_execution_end", toolName: "bash", isError: false });
    s.observe({ type: "turn_end" });
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
  test("a long useful command is not stopped just because the grace elapsed after a steer", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, every);
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    await s.check(1_000);
    expect(done).toEqual(["steer:You are repe"]);
    // The agent started the suite after the steer and is still waiting for it.
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "mise run test -- slow" } });
    await s.check(1_000 + STEER_GRACE_MS * 20);
    expect(done).toHaveLength(1);
    // The command finished and the turn completed, the same problem persists: now it stops.
    s.observe({ type: "tool_execution_end", toolName: "bash", isError: false });
    s.observe({ type: "turn_end" });
    await s.check(1_000 + STEER_GRACE_MS * 21);
    expect(done).toEqual(["steer:You are repe", "stop:Supervi"]);
  });
  test("a completed earlier turn does not count as completing the new command after steering", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, { ...every, everyMs: 60_000 });
    await s.check(60_000);
    s.observe({ type: "turn_end" });
    s.observe({ type: "tool_execution_start", toolCallId: "slow", toolName: "bash", args: { command: "mise run test -- slow" } });
    await s.check(60_000 + STEER_GRACE_MS * 20);
    expect(done).toEqual(["steer:You are repe"]);
    s.observe({ type: "tool_execution_end", toolCallId: "slow", toolName: "bash", isError: false });
    s.observe({ type: "turn_end" });
    await s.check(60_000 + STEER_GRACE_MS * 21);
    expect(done).toEqual(["steer:You are repe", "stop:Supervi"]);
  });
  test("three no-match searches are not three environment errors, a blocked command is not one either", async () => {
    const { hooks: h } = hooks();
    const fine: Decider = { name: "fixed", decide: async () => ({ worker_stuck: { type: "noul", p: 0.05 } }) };
    const s = new Supervisor(new DecisionPanel([fine]), { title: "t" }, h, { everyMs: 300_000, trackDiff: false, started: 0 });
    const end = (text: string) => ({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text }] } });
    for (let i = 0; i < 3; i++) {
      s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: `cd /work/x; grep -rn "needle${i}" src/` } });
      s.observe(end("\n\nCommand exited with code 1"));
    }
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "git push origin b 2>&1 | tail" } });
    s.observe(end("Blocked by Mork: only `git push origin b` is allowed"));
    await s.check(1_000);
    expect(s.records).toEqual([]);
    for (let i = 0; i < 3; i++) {
      s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: `mise run test:unit -- -x -q${i}` } });
      s.observe(end("ModuleNotFoundError: No module named 'tests.-q'\n\nCommand exited with code 1"));
    }
    await s.check(2_000);
    expect(s.records.map((r) => r.action.trigger)).toEqual(["tool errors in a row"]);
    const state = s.records[0]?.trace.state as { tool_outcomes: Record<string, number>; recent_tool_results: string[] };
    expect(state.tool_outcomes).toEqual({ ok: 0, no_match: 3, blocked: 1, error: 3 });
    expect(state.recent_tool_results.at(-1)).toContain("ModuleNotFoundError");
  });
  test("tool outcomes: no-match searches, blocked commands and real failures are told apart", () => {
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    expect(
      toolOutcome({ toolName: "bash", args: { command: "grep -rn x src" } }, { isError: true, result: text("Command exited with code 1") }),
    ).toBe("no_match");
    expect(
      toolOutcome(
        { toolName: "bash", args: { command: 'export PATH="$HOME/.local/bin:$PATH" && cd dagster && rg -n "foo" tests' } },
        { isError: true, result: text("\n\nCommand exited with code 1") },
      ),
    ).toBe("no_match");
    expect(toolOutcome({ toolName: "grep", args: { pattern: "x" } }, { isError: true, result: text("No matches found") })).toBe("no_match");
    expect(
      toolOutcome(
        { toolName: "bash", args: { command: "grep -rn x src" } },
        { isError: true, result: text("grep: src: No such file or directory\n\nCommand exited with code 2") },
      ),
    ).toBe("error");
    expect(
      toolOutcome({ toolName: "bash", args: { command: "git push origin b | tail" } }, { isError: true, result: text("Blocked by Mork: only…") }),
    ).toBe("blocked");
    expect(toolOutcome({ toolName: "write", args: { path: "x" } }, { isError: true, result: text("Blocked by Mork (directory rules): …") })).toBe(
      "blocked",
    );
    expect(
      toolOutcome({ toolName: "bash", args: { command: "mise run test" } }, { isError: true, result: text("FAILED\n\nCommand exited with code 1") }),
    ).toBe("error");
    expect(toolOutcome({ toolName: "bash", args: { command: "grep x" } }, { isError: false, result: text("match") })).toBe("ok");
  });
  test("a correction prompt clears stale steering within a bounded budget", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, every);
    const act = () => {
      s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
      s.observe({ type: "tool_execution_end", toolName: "bash", isError: false });
      s.observe({ type: "turn_end" });
    };
    let now = 1_000;
    for (let i = 0; i < MAX_CORRECTION_RESETS; i++) {
      await s.check(now);
      expect(done.at(-1)).toBe("steer:You are repe");
      expect(s.correctionStarted(now)).toBe(true);
      act();
      now += STEER_GRACE_MS + 1;
    }
    expect(s.correctionStarted(now)).toBe(false);
    await s.check(now);
    expect(done.at(-1)).toBe("steer:You are repe");
    act();
    await s.check(now + STEER_GRACE_MS + 1);
    expect(done.at(-1)).toBe("stop:Supervi");
    expect(done.filter((d) => d.startsWith("stop:"))).toHaveLength(1);
    const state = s.records.at(-1)?.trace.state as { corrections: number };
    expect(state.corrections).toBe(MAX_CORRECTION_RESETS);
  });
  test("the evidence names the command still running and how long", async () => {
    const { hooks: h } = hooks();
    const fine: Decider = { name: "fixed", decide: async () => ({ worker_stuck: { type: "noul", p: 0.05 } }) };
    const s = new Supervisor(new DecisionPanel([fine]), { title: "t" }, h, { everyMs: 60_000, trackDiff: false, started: 0 });
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "mise run test -- slow" } });
    await s.check(90_000);
    const state = s.records[0]?.trace.state as { running_tool?: { tool: string; command: string; seconds: number } };
    expect(state.running_tool).toEqual({ tool: "bash", command: "mise run test -- slow", seconds: 90 });
  });
  test("scoring pauses while the runner validates the output, and a verdict from before the boundary is dropped", async () => {
    const { done, hooks: h } = hooks();
    let release: () => void = () => undefined;
    const slow: Decider = {
      name: "fixed",
      decide: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { worker_stuck: { type: "noul", p: 0.95 } };
      },
    };
    const s = new Supervisor(new DecisionPanel([slow]), { title: "t" }, h, every);
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    const inFlight = s.check(1_000);
    s.observe({ type: "validation_started" });
    release();
    await inFlight;
    expect(done).toEqual([]);
    expect(s.records).toEqual([]);
    await s.check(2_000);
    expect(done).toEqual([]);
    s.observe({ type: "validation_finished" });
    const after = s.check(3_000);
    release();
    await after;
    expect(done).toEqual(["steer:You are repe"]);
  });
  test("a semantic_repair event clears stale steering like correctionStarted, within the same budget", async () => {
    const { done, hooks: h } = hooks();
    const s = new Supervisor(new DecisionPanel([stuck]), { title: "t" }, h, every);
    await s.check(1_000);
    s.observe({ type: "semantic_repair" });
    s.observe({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    s.observe({ type: "tool_execution_end", toolName: "bash", isError: false });
    s.observe({ type: "turn_end" });
    await s.check(1_000 + STEER_GRACE_MS + 1);
    expect(done).toEqual(["steer:You are repe", "steer:You are repe"]);
    expect(s.correctionStarted(2_000 + STEER_GRACE_MS)).toBe(true);
    expect(s.correctionStarted(2_000 + STEER_GRACE_MS)).toBe(false);
  });
});
