// The implementer's own check, Spotify-Honk style: the repository's setup,
// test and `checks` commands plus a preview of the diff policy, run on the
// working tree while the agent still works. Hidden tests are not part of it;
// they stay in Check. Runs as the agent user, like any of its bash calls.
import { existsSync, writeFileSync } from "node:fs";
import type { RepoConfig, RepoRef } from "@mork/contracts";
import { checkDiff } from "./gate.ts";
import { execAsync } from "./git.ts";

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

export async function runVerify(spec: VerifySpec, repoDir: string, env: NodeJS.ProcessEnv = process.env): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const run = async (name: string, command: string) => {
    const result = await execAsync("bash", ["-c", command], { cwd: repoDir, env, timeoutMs: COMMAND_TIMEOUT_MS });
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
