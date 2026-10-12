// Check the actual JSON embedded in planned task definitions with runner parsers.
import { readFileSync } from "node:fs";
import { DevelopmentStep, DevelopmentWorkflow } from "../packages/contracts/src/development.ts";
import { Workflow, WorkflowStep } from "../packages/contracts/src/workflow.ts";
import { outputParser } from "../packages/runner/src/workflow.ts";
import { SlackConfig } from "../packages/sources/src/routing.ts";

type Module = {
  resources?: { type: string; name: string; address: string; values: { container_definitions?: string; content?: string } }[];
  child_modules?: Module[];
};
export function validatePlan(plan: { planned_values?: { root_module: Module } }): number {
  let checked = 0;
  const visit = (module: Module) => {
    for (const resource of module.resources ?? []) {
      if (resource.type === "aws_s3_object" && resource.name === "slack_config") {
        if (!resource.values.content) throw new Error(`${resource.address}: routing configuration is unknown`);
        const config = JSON.parse(resource.values.content);
        SlackConfig.parse(config);
        for (const [name, definition] of Object.entries(config.definitions ?? {})) {
          if (name === "development") DevelopmentWorkflow.parse(definition);
          else {
            const workflow = Workflow.parse(definition);
            for (const step of workflow.steps) if (step.kind !== "approval") outputParser(step.output_schema);
          }
        }
      }
      if (resource.type !== "aws_ecs_task_definition" || !["phase", "workflow_step"].includes(resource.name)) continue;
      if (!resource.values.container_definitions) throw new Error(`${resource.address}: container definitions are unknown; bootstrap ECR first`);
      // Project budget for the complete serialized configuration, including escaping.
      if (Buffer.byteLength(resource.values.container_definitions) > 48 * 1024)
        throw new Error(`${resource.address}: container definitions exceed the 48 KiB configuration budget`);
      const containers = JSON.parse(resource.values.container_definitions) as { environment?: { name: string; value: string }[] }[];
      for (const container of containers) {
        for (const variable of container.environment ?? []) {
          if (variable.name === "MORK_DEVELOPMENT_STEP") {
            DevelopmentStep.parse(JSON.parse(variable.value));
            checked++;
          }
          if (variable.name === "MORK_WORKFLOW_STEP") {
            const step = WorkflowStep.parse(JSON.parse(variable.value));
            if (step.kind !== "approval") outputParser(step.output_schema);
            checked++;
          }
        }
      }
    }
    for (const child of module.child_modules ?? []) visit(child);
  };
  if (!plan.planned_values) throw new Error("Expected tofu show -json plan output");
  visit(plan.planned_values.root_module);
  if (!checked) throw new Error("The plan has no configured Mork runner steps");
  return checked;
}
if (import.meta.main) {
  const count = validatePlan(JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8")));
  console.log(`Validated ${count} planned runner configurations and output schemas`);
}
