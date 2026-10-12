import { describe, expect, test } from "bun:test";
import type { AnalystOutput, GateReport } from "@mork/contracts";
import { checkPlan, gateFailures, gateFeedback, gatePassed } from "./rules.ts";

const config = {
  test: "npm test",
  hidden_tests: { dir: "test/hidden", command: "node --test {file}", file_suffix: ".test.mjs" },
  protected_paths: [],
  test_paths: ["test/"],
};
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
const gate: GateReport = {
  mode: "after",
  repo_tests: { command: "npm test", exit_code: 0, output: "" },
  hidden: [{ file: "add.test.mjs", criteria: ["AC1"], passed: true, output: "" }],
  diff_policy: { violations: [], changed_files: ["math.mjs"], protected_hits: [], flags: [], added_lines: 3, removed_lines: 1 },
};

describe("plan checks", () => {
  test("accepts a covered plan", () => expect(checkPlan(plan, config)).toBeUndefined());
  test("rejects uncovered testable criteria", () => {
    expect(checkPlan({ ...plan, hidden_tests: [] }, config)).toContain("AC1");
  });
  test("rejects wrong hidden test suffix", () => {
    expect(checkPlan({ ...plan, hidden_tests: [{ file: "add.js", criteria: ["AC1"], content: "x" }] }, config)).toContain(".test.mjs");
  });
});

describe("gate verdict", () => {
  test("green gate passes", () => expect(gatePassed(gate)).toBe(true));
  test("a violation fails the gate", () => {
    expect(gatePassed({ ...gate, diff_policy: { ...gate.diff_policy!, violations: ["modifies existing test"] } })).toBe(false);
  });
  test("no hidden tests is not a pass", () => expect(gatePassed({ ...gate, hidden: [] })).toBe(false));
});

describe("gate feedback", () => {
  test("names the failed criterion, never the hidden test source", () => {
    const red = { ...gate, hidden: [{ file: "add.test.mjs", criteria: ["AC1"], passed: false, output: "expected 5" }] };
    const feedback = gateFeedback(red, plan);
    expect(feedback).toContain("AC1: adds");
    expect(feedback).toContain("expected 5");
    expect(feedback).not.toContain("HIDDEN_SOURCE");
  });
});

describe("gate failures for chat", () => {
  test("a green gate has none", () => expect(gateFailures(gate)).toEqual([]));
  test("each reason is one short line", () => {
    const red: GateReport = {
      ...gate,
      repo_tests: { command: "npm test", exit_code: 1, output: "long output" },
      hidden: [{ file: "add.test.mjs", criteria: ["AC1", "AC2"], passed: false, output: "x" }],
      diff_policy: {
        ...gate.diff_policy,
        violations: ["modifies existing test test/a.mjs (M)"],
        flags: [],
        changed_files: [],
        protected_hits: [],
        added_lines: 0,
        removed_lines: 0,
      },
    };
    expect(gateFailures(red)).toEqual([
      "repository tests failed: `npm test`",
      "AC1, AC2 not met (add.test.mjs)",
      "policy: modifies existing test test/a.mjs (M)",
    ]);
  });
});

describe("repository checks in the gate", () => {
  const withCheck = (exit: number) => ({ ...gate, checks: [{ command: "npm run lint", exit_code: exit, output: "x.ts:1 unused" }] });
  test("a failing check fails the gate and is named in the feedback", () => {
    expect(gatePassed(withCheck(0))).toBe(true);
    expect(gatePassed(withCheck(1))).toBe(false);
    expect(gateFailures(withCheck(1))).toContain("check failed: `npm run lint`");
    expect(gateFeedback(withCheck(1), plan)).toContain("x.ts:1 unused");
  });
});
