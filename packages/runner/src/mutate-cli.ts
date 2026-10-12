// `node mutate-cli.ts <spec.json>`, started by the gate as the sandbox user in
// the checkout: applies each mutant, runs the hidden tests, restores the file,
// and prints the MutationReport as the last line.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Mutant, type MutantVerdict, runMutants } from "./mutants.ts";

/** A failing run whose output is a parse error means the mutant broke the syntax, not the behaviour. */
const SYNTAX = /SyntaxError|Unexpected token|error TS\d+|IndentationError|invalid syntax/;

const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as { mutants: Mutant[]; commands: string[] };
function hiddenTests(): MutantVerdict {
  for (const command of spec.commands) {
    const run = spawnSync("bash", ["-c", command], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    if (run.status === 0) continue;
    return SYNTAX.test(`${run.stdout ?? ""}${run.stderr ?? ""}`) ? "invalid" : "fail";
  }
  return "pass";
}
process.stdout.write(`\n${JSON.stringify(runMutants(process.cwd(), spec.mutants, hiddenTests))}\n`);
