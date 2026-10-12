import { expect, test } from "bun:test";
import { DEFAULT_DEVELOPMENT, DevelopmentWorkflow } from "./development.ts";
import { WorkflowStep } from "./workflow.ts";

test("development configuration preserves the gate boundaries and validates its retry budget", () => {
  const definition = structuredClone(DEFAULT_DEVELOPMENT);
  definition.steps[1].attempts = 1;
  definition.steps[1].allowed_domains = ["github.com", "*.example.test"];
  expect(DevelopmentWorkflow.parse(definition).steps[1].attempts).toBe(1);
  expect(
    DevelopmentWorkflow.safeParse({ ...definition, steps: [{ ...definition.steps[0], name: "route" }, ...definition.steps.slice(1)] }).success,
  ).toBe(false);
  expect(DevelopmentWorkflow.safeParse({ ...definition, steps: definition.steps.slice(0, 2) }).success).toBe(false);
  definition.delivery.step = "build";
  expect(DevelopmentWorkflow.safeParse(definition).success).toBe(false);
});

test("step domain lists accept hosts and wildcards, and reject configuration injection", () => {
  for (const host of ["https://example.test", "example.test:443", "example.test/path", "example.test\nother", "*", "a&b", 'a"b']) {
    expect(WorkflowStep.safeParse({ name: "run", kind: "command", command: ["true"], allowed_domains: [host] }).success).toBe(false);
  }
  const step = WorkflowStep.parse({
    name: "run",
    kind: "command",
    command: ["true"],
    allowed_domains: ["github.com", "*.github.com"],
    capacity: "spot",
  });
  expect(step.allowed_domains).toEqual(["github.com", "*.github.com"]);
  expect(step.spot_retries).toBe(4);
});
