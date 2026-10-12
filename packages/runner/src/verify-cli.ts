// `node verify-cli.ts <spec.json>`: the runner's own verify after submit_result,
// started as the agent user so no repository code ever runs as root.
import { readFileSync } from "node:fs";
import { runVerify, type VerifySpec } from "./verify.ts";

const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as VerifySpec;
process.stdout.write(JSON.stringify(await runVerify(spec, process.cwd())));
