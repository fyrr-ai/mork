import { describe, expect, test } from "bun:test";
import type { AnalystOutput, GateReport } from "@mork/contracts";
import { bindAuthorCriteria, checkPlan, gateFailures, gateFeedback, gatePassed } from "./rules.ts";

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
const policy = { violations: [], changed_files: ["math.mjs"], protected_hits: [], flags: [], added_lines: 3, removed_lines: 1 };
const gate: GateReport = {
  mode: "after",
  repo_tests: { command: "npm test", exit_code: 0, output: "" },
  hidden: [{ file: "add.test.mjs", criteria: ["AC1"], passed: true, output: "" }],
  diff_policy: policy,
};

describe("plan checks", () => {
  test("an authored runtime criterion cannot be downgraded to evidence", () => {
    const author = [{ id: "AC1", text: "Replay preserves all rows" }];
    const downgraded = { ...plan, acceptance_criteria: [{ ...author[0], testable: false }], hidden_tests: [] };
    expect(checkPlan(downgraded, config, author)).toContain("runtime");
  });
  test("the runner binds author text while preserving missing mappings for validation", () => {
    const author = [{ id: "AC1", text: "Replay preserves all rows" }];
    expect(
      bindAuthorCriteria({ ...plan, acceptance_criteria: [{ id: "AC1", text: "reworded", testable: true }] }, author).acceptance_criteria,
    ).toEqual([{ ...author[0], testable: true }]);
    expect(checkPlan(bindAuthorCriteria({ ...plan, acceptance_criteria: [], hidden_tests: [] }, author), config, author)).toContain("exactly");
  });
  test("accepts a covered plan", () => expect(checkPlan(plan, config)).toBeUndefined());
  test("keeps the author's criteria and honors explicit evidence-only author intent", () => {
    const documented = {
      ...plan,
      acceptance_criteria: [plan.acceptance_criteria[0], { id: "AC2", text: "[evidence] documented", testable: false }],
    } as AnalystOutput;
    const author = [
      { id: "AC2", text: "[evidence] documented" },
      { id: "AC1", text: "adds" },
    ];
    expect(checkPlan(documented, config, author)).toBeUndefined();
    const reworded = { ...plan, acceptance_criteria: [{ id: "AC1", text: "adds two numbers", testable: true }, plan.acceptance_criteria[1]] };
    expect(checkPlan(reworded as AnalystOutput, config, author)).toContain("- AC1: adds");
    const extra = { ...plan, acceptance_criteria: [...plan.acceptance_criteria, { id: "AC3", text: "fast", testable: false }] };
    expect(checkPlan(extra as AnalystOutput, config, author)).toContain("proposed_criteria");
    expect(checkPlan(plan, config, [{ id: "AC1", text: "adds" }])).toContain("exactly");
  });
  test("document evidence criteria need no hidden tests", () => {
    expect(
      checkPlan({ ...plan, acceptance_criteria: [{ id: "AC1", text: "README describes the channel", testable: false }], hidden_tests: [] }, config),
    ).toBeUndefined();
  });
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
    expect(gatePassed({ ...gate, diff_policy: { ...policy, violations: ["modifies existing test"] } })).toBe(false);
  });
  test("without hidden tests repository checks still decide the gate", () => {
    const documentation = { ...gate, hidden: [] };
    expect(gatePassed(documentation)).toBe(true);
    expect(gateFailures(documentation)).toEqual([]);
    expect(gatePassed({ ...documentation, repo_tests: { command: "npm test", exit_code: 1, output: "failed" } })).toBe(false);
  });
});

describe("gate feedback", () => {
  test("invalid execution never claims an acceptance criterion was disproven", () => {
    const invalid = {
      ...gate,
      hidden: [
        {
          file: "add.test.mjs",
          criteria: ["AC1"],
          passed: false,
          status: "execution_failure" as const,
          reason: "missing interpreter",
          output: "ImportError",
          artifact: "diagnostics/one.json",
        },
      ],
    };
    expect(gateFailures(invalid)).toEqual(["verification execution_failure: AC1 remain unverified"]);
    expect(gateFeedback(invalid, plan)).not.toContain("Acceptance criterion not met");
    expect(gateFeedback(invalid, plan)).not.toContain("diagnostics/one.json");
    expect(gateFeedback(invalid, plan)).not.toContain("missing interpreter");
    expect(gateFeedback(invalid, plan, { oracle: true })).toContain("diagnostics/one.json");
    expect(gateFeedback(invalid, plan, { oracle: true })).toContain("missing interpreter");
  });
  test("names the failed criterion, never the hidden test source", () => {
    const red = { ...gate, hidden: [{ file: "add.test.mjs", criteria: ["AC1"], passed: false, output: "expected 5" }] };
    const feedback = gateFeedback(red, plan);
    expect(feedback).toContain("AC1: adds");
    expect(feedback).not.toContain("expected 5");
    expect(gateFeedback(red, plan, { oracle: true })).toContain("expected 5");
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
    expect(gateFailures(red)).toEqual(["repository tests failed: `npm test`", "AC1, AC2 not met", "policy: modifies existing test test/a.mjs (M)"]);
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
