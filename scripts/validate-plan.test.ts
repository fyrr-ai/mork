import { expect, test } from "bun:test";
import { validatePlan } from "./validate-plan.ts";

const plan = (step: unknown, variable = "MORK_WORKFLOW_STEP") => ({
  planned_values: {
    root_module: {
      child_modules: [
        {
          resources: [
            {
              type: "aws_ecs_task_definition",
              name: "workflow_step",
              address: "module.mork.aws_ecs_task_definition.workflow_step[analysis.calculate]",
              values: { container_definitions: JSON.stringify([{ environment: [{ name: variable, value: JSON.stringify(step) }] }]) },
            },
          ],
        },
      ],
    },
  },
});
const agent = {
  kind: "agent",
  name: "analyze",
  instructions: "Analyze",
  output_schema: { type: "object", properties: { total: { type: "number" } }, required: ["total"] },
};
test("deployment preflight validates rendered generic and development configurations", () => {
  expect(validatePlan(plan(agent))).toBe(1);
  expect(validatePlan(plan({ kind: "plan", name: "design", instructions: "Plan" }, "MORK_DEVELOPMENT_STEP"))).toBe(1);
  for (const patch of [
    { tools: ["INVALID"] },
    { extensions: ["relative.ts"] },
    { model: "" },
    { output_schema: { type: "object", requird: ["total"] } },
    { output_schema: { $async: true, type: "object" } },
  ]) {
    expect(() => validatePlan(plan({ ...agent, ...patch }))).toThrow();
  }
  expect(() => validatePlan({ planned_values: { root_module: {} } })).toThrow("no configured Mork");
});

test("preflight rejects malformed Slack channels and invalid approval configuration", () => {
  const config = {
    channels: { CDEMO: { repo: "org/repo", jira_project: "PROJ" } },
    workflows: { development: { kind: "development", description: "Develop", arn: "arn:aws:states:us-east-1:123456789012:stateMachine:mork" } },
  };
  const make = (content: unknown) => {
    const result = plan(agent);
    result.planned_values.root_module.child_modules[0]?.resources.push({
      type: "aws_s3_object",
      name: "slack_config",
      address: "module.mork.aws_s3_object.slack_config",
      values: { content: JSON.stringify(content) },
    } as any);
    return result;
  };
  expect(validatePlan(make(config))).toBe(1);
  for (const channels of [
    { c0lower: { repo: "org/repo", jira_project: "PROJ" } },
    { CDEMO: { repo: "org/repo", jira_project: "proj" } },
    { CDEMO: { repo: "broken", jira_project: "PROJ" } },
  ])
    expect(() => validatePlan(make({ ...config, channels }))).toThrow();
  const definition = {
    steps: [{ kind: "approval", name: "approve", instructions: "Review", timeout_seconds: 7200 }],
    delivery: { kind: "report", step: "approve" },
  };
  expect(validatePlan(make({ ...config, definitions: { review: definition } }))).toBe(1);
  expect(() =>
    validatePlan(make({ ...config, definitions: { review: { ...definition, steps: [{ ...definition.steps[0], timeout_seconds: 0 }] } } })),
  ).toThrow();
  expect(() => validatePlan(plan({ ...agent, instructions: "é".repeat(13000) }))).toThrow("24 KiB");
  expect(() => validatePlan(plan({ ...agent, environment: { DATA: "x".repeat(50000) } }))).toThrow("48 KiB");
});
