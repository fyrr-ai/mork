// Mock plans also pass through the parsers used by deployed runners.
import { validatePlan } from "./validate-plan.ts";

const test = Bun.spawn(["tofu", "-chdir=infra/aws", "test", "-json", "-verbose"], { stdout: "pipe", stderr: "inherit" });
const output = await new Response(test.stdout).text();
const code = await test.exited;
let checked = 0;
for (const line of output.trim().split("\n")) {
  const event = JSON.parse(line);
  if (event.type === "test_plan" && !event["@testrun"].startsWith("reject_")) checked += validatePlan(event.test_plan);
  if (["test_run", "test_summary", "diagnostic"].includes(event.type)) console.log(event["@message"]);
}
if (code !== 0) process.exit(code);
if (!checked) throw new Error("Mock tests produced no valid runner configurations");
console.log(`Runtime contracts accepted ${checked} configurations from mock AWS plans`);
