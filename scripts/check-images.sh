#!/usr/bin/env bash
# Smoke-test production Node entrypoints and retained notices without AWS/network.
set -euo pipefail
docker run --rm --network none --entrypoint node mork-runner:dev --input-type=module -e '
import { existsSync } from "node:fs";
const {runGate} = await import("./packages/runner/src/gate.ts");
if (typeof runGate !== "function" || !existsSync("/usr/share/licenses/mork/NOTICE")) throw new Error("runner smoke test failed");
console.log("runner entrypoint and notices passed");'
docker run --rm --network none --entrypoint node mork-lambda:dev --input-type=module -e '
import { existsSync } from "node:fs";
for (const path of ["./packages/steps/lambda-steps.mjs", "./packages/steps/lambda-intake.mjs", "./packages/sources/lambda-slack.mjs"]) {
  const module = await import(path);
  if (typeof module.handler !== "function") throw new Error(path);
}
if (!existsSync("/usr/share/licenses/mork/NOTICE")) throw new Error("Lambda notices missing");
console.log("Lambda entrypoints and notices passed");'
docker run --rm --network none --entrypoint sh mork-egress:dev -c '
test -f /usr/share/licenses/mork/NOTICE && test -f /usr/share/licenses/mork/licenses/iron-proxy.LICENSE'
echo "egress notices passed"
