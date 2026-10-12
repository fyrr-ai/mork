// The implementer's own check, Spotify-Honk style: the repository's setup,
// test and `checks` commands plus a preview of the diff policy, run on the
// working tree while the agent still works. Hidden tests are not part of it;
// they stay in Check. Runs as the agent user, like any of its bash calls.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import type { RepoConfig, RepoRef } from "@mork/contracts";
import { checkDiff } from "./gate.ts";

/** Written by the runner from the base commit's config; the agent's branch cannot change it. */
export type VerifySpec = {
  repo: RepoRef;
  config: Pick<RepoConfig, "setup" | "test" | "checks" | "test_paths" | "protected_paths">;
  /** Marker file: setup ran once in this container. */
  setupMarker: string;
};

export type VerifyStep = { name: string; command: string; exit_code: number; output: string };
export type VerifyResult = { passed: boolean; steps: VerifyStep[]; violations: string[] };

const TAIL = 1_500;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

/** Async on purpose: inside Pi a blocking run would freeze the agent (and its supervisor) for the whole test. */
function shell(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4 * TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(error) });
    });
  });
}

export async function runVerify(spec: VerifySpec, repoDir: string, env: NodeJS.ProcessEnv = process.env): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const run = async (name: string, command: string) => {
    const result = await shell(command, repoDir, env);
    const step = { name, command, exit_code: result.code, output: result.output.slice(-TAIL) };
    steps.push(step);
    return step.exit_code === 0;
  };
  if (spec.config.setup && !existsSync(spec.setupMarker)) {
    if (!(await run("setup", spec.config.setup))) return { passed: false, steps, violations: [] };
    writeFileSync(spec.setupMarker, "");
  }
  await run("test", spec.config.test);
  for (const command of spec.config.checks) await run("check", command);
  const policy = checkDiff(repoDir, { repo: spec.repo, config: spec.config, allow_test_change: false }, "worktree");
  return { passed: steps.every((s) => s.exit_code === 0) && policy.violations.length === 0, steps, violations: policy.violations };
}

/** What the agent reads back: one line per command, failing output tails, policy violations. Bounded. */
export function verifyText(result: VerifyResult): string {
  const lines = [`verify: ${result.passed ? "PASSED" : "FAILED"}`];
  for (const step of result.steps) {
    lines.push(`- ${step.name} \`${step.command}\`: ${step.exit_code === 0 ? "ok" : `FAILED (exit ${step.exit_code})`}`);
    if (step.exit_code !== 0) lines.push("```", step.output, "```");
  }
  for (const violation of result.violations) lines.push(`- policy: ${violation}. The platform rejects this; revert that part.`);
  lines.push("Hidden acceptance tests are not run here; they run after you push.");
  return lines.join("\n");
}
