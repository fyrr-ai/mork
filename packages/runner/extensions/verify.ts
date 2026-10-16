// Pi extension, implementer only: `verify` runs the repository's own setup,
// test and checks commands and the diff policy on the working tree, so the
// agent can fix failures before it pushes. Hidden tests are not run here.
//
// The model reads a bounded summary (verifyText). The complete output of every
// step is kept as an agent-owned file next to the station's outputs, one per
// invocation and step, with a sidecar naming command, cwd, revision and exit
// code; the root runner collects and redacts these into the task's diagnostics.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { runVerify, type VerifyResult, type VerifySpec, verifyText } from "../src/verify.ts";

/** Where the agent user keeps full verify outputs; the runner reads `MORK_VERIFY_LOG_DIR` or this default under HOME. */
export function verifyLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MORK_VERIFY_LOG_DIR ?? join(env.HOME ?? "/tmp", "out", "verify");
}

/** The root runner answers a raw sidecar `<id>.json` with `<id>.published.json`. */
export function publishedSidecar(rawSidecar: string): string {
  return rawSidecar.replace(/\.json$/, ".published.json");
}

/**
 * What the root runner publishes for one step: its redacted, root-owned artifact and the
 * redacted tail the model may read; optionally a redacted command line to print instead of
 * the raw one, and whether the published output had to be truncated.
 */
export type Published = { artifact: string; output_tail: string; command?: string; output_truncated?: boolean };

/** Exit code a step reports when the platform could not publish its complete output: never a pass. */
export const EXIT_TRUNCATED = 125;

const PUBLISH_POLL_MS = 100;
const PUBLISH_TIMEOUT_MS = 15 * 60_000;

function publishRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MORK_VERIFY_PUBLISH_REQUIRED === "1";
}

/**
 * Publish-required mode (MORK_VERIFY_PUBLISH_REQUIRED=1): the root runner watches the
 * log directory, redacts every raw sidecar and log into a root-owned artifact, and
 * replies with `<id>.published.json`. The model then reads only the published
 * artifact path and tail; the raw path is never printed. Without a reply within the
 * bound the tool fails closed.
 */
export async function awaitPublished(result: VerifyResult, sidecars: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const timeout = Number(env.MORK_VERIFY_PUBLISH_TIMEOUT_MS) || PUBLISH_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  for (const [index, raw] of sidecars.entries()) {
    const file = publishedSidecar(raw);
    let published: Published | undefined;
    while (published === undefined) {
      if (existsSync(file)) {
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Published>;
          if (typeof parsed.artifact === "string" && typeof parsed.output_tail === "string") {
            published = {
              artifact: parsed.artifact,
              output_tail: parsed.output_tail,
              ...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
              ...(parsed.output_truncated === true ? { output_truncated: true } : {}),
            };
            break;
          }
        } catch {
          // Written halfway; poll again.
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `verify ran, but its diagnostics were not published by the platform within ${Math.round(timeout / 1000)} s. Call verify again.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_MS));
    }
    const step = result.steps[index];
    if (!step) continue;
    step.artifact = published.artifact;
    step.output = published.output_tail;
    if (published.command !== undefined) step.command = published.command;
    if (published.output_truncated) {
      step.exit_code = EXIT_TRUNCATED;
      result.passed = false;
    }
  }
}

/** Writes each step's full output and a sidecar record; sets `step.artifact` to the output file. Returns the raw sidecar paths. */
export function keepVerifyArtifacts(result: VerifyResult, dir: string, cwd: string, now = new Date()): string[] {
  mkdirSync(dir, { recursive: true });
  // One id per invocation: two verify calls in the same second must never share or overwrite files.
  const invocation = randomUUID();
  let head = "";
  try {
    head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    head = "";
  }
  const sidecars: string[] = [];
  result.steps.forEach((step, index) => {
    const id = `${invocation}-${index + 1}-${step.name}`;
    const output = join(dir, `${id}.log`);
    const sidecar = join(dir, `${id}.json`);
    writeFileSync(output, step.output);
    writeFileSync(
      sidecar,
      JSON.stringify({
        command_id: id,
        invocation,
        step: index + 1,
        command: step.command,
        cwd,
        head_sha: head,
        exit_code: step.exit_code,
        output_file: output,
        at: now.toISOString(),
        ...(step.output_truncated ? { output_truncated: true } : {}),
      }),
    );
    step.artifact = output;
    sidecars.push(sidecar);
  });
  return sidecars;
}

export default function verify(pi: any) {
  const specFile = process.env.MORK_VERIFY;
  if (!specFile) throw new Error("MORK_VERIFY is not set");
  const spec = JSON.parse(readFileSync(specFile, "utf8")) as VerifySpec;
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Run the repository's tests and checks (lint, typecheck…) and the platform's change policy on your working tree, exactly as the platform will. Returns what failed with the output tail and the path of each step's full output.",
    promptSnippet: "Run the repository's tests, checks and change policy",
    promptGuidelines: [
      "Call verify after each meaningful change and before you push; fix every failure it reports and call it again until it passes.",
      "Read the full output file it names (grep for FAILED, Error, Traceback) before deciding what failed; the inline tail is only the end of it.",
      "Only push and call submit_result once verify passes.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await runVerify(spec, process.cwd());
      const sidecars = keepVerifyArtifacts(result, verifyLogDir(), process.cwd());
      if (publishRequired()) await awaitPublished(result, sidecars);
      return {
        content: [{ type: "text", text: verifyText(result) }],
        details: { passed: result.passed, artifacts: result.steps.map((s) => s.artifact) },
      };
    },
  });
}
