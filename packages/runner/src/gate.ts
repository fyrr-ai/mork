// LLM-free gate. Runs the repository's own commands and the hidden tests as an
// unprivileged user, then applies the diff policy. Nothing here can be talked
// into a different result: it only reports exit codes and diffs.
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GateReport, type HiddenTest, PLATFORM_PROTECTED_PATHS, type RepoConfig, type RepoRef } from "@mork/contracts";
import { z } from "zod";
import { killUser, writeFresh } from "./agentfs.ts";
import { exec, execAsync, fetchRepo, mustExec, SAFE_GIT } from "./git.ts";
import { type Mutant, type MutationReport, mutantsFrom } from "./mutants.ts";

const OUTPUT_TAIL = 4_000;
const SKIP_MARKERS = /\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|pytest\.skip\(|\bt\.skip\(|\{\s*skip\s*:\s*true/;

export type Sandbox = { uid?: number; gid?: number; env: Record<string, string> };

/** One gate run, assembled by `main` from the brief and the stored outputs. */
export type GateJob = {
  mode: "before" | "after";
  repo: RepoRef;
  /** After mode: the pushed branch under test. */
  branch?: string;
  config: RepoConfig;
  hidden_tests: HiddenTest[];
  allow_test_change: boolean;
};

export async function runGate(spec: GateJob, readToken: string, workDir: string, sandbox: Sandbox): Promise<GateReport> {
  const repoDir = join(workDir, "repo");
  rmSync(repoDir, { recursive: true, force: true });
  fetchRepo({
    dir: repoDir,
    fullName: spec.repo.full_name,
    token: readToken,
    baseSha: spec.repo.base_sha,
    branch: spec.mode === "after" ? spec.branch : undefined,
  });

  // Everything root learns from git happens now, while root still owns the checkout: once
  // repository code has run as `sandbox`, `.git` may hold hooks or textconv drivers.
  const after = spec.mode === "after";
  const diffPolicy = after ? checkDiff(repoDir, spec) : undefined;
  const headSha = after ? mustExec("git", [...SAFE_GIT, "-C", repoDir, "rev-parse", "HEAD"]).trim() : undefined;
  const addedPatch = after ? mustExec("git", [...SAFE_GIT, "-C", repoDir, "diff", ...NO_DRIVERS, "--unified=0", `${spec.repo.base_sha}..HEAD`]) : "";
  for (const test of spec.hidden_tests) {
    if (!test.file.endsWith(spec.config.hidden_tests.file_suffix) || test.file.includes("/") || test.file.startsWith(".")) {
      throw new Error(`hidden test ${test.file} must be a plain file name ending with ${spec.config.hidden_tests.file_suffix}`);
    }
  }
  if (sandbox.uid !== undefined) mustExec("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, repoDir]);

  const run = async (command: string, timeoutMs = 900_000) => {
    const result = await execAsync("bash", ["-c", command], { cwd: repoDir, env: sandbox.env, uid: sandbox.uid, gid: sandbox.gid, timeoutMs });
    return { command, exit_code: result.code, output: result.output.slice(-OUTPUT_TAIL) };
  };
  const hiddenCommand = (test: HiddenTest) =>
    spec.config.hidden_tests.command.replaceAll("{file}", shellQuote(join(spec.config.hidden_tests.dir, test.file)));

  const report: GateReport = { mode: spec.mode, ...(headSha ? { head_sha: headSha } : {}), hidden: [], diff_policy: diffPolicy };
  if (spec.config.setup) {
    report.setup = await run(spec.config.setup);
    if (report.setup.exit_code !== 0) return report;
  }
  if (after) {
    report.repo_tests = await run(spec.config.test);
    report.checks = [];
    for (const check of spec.config.checks) report.checks.push(await run(check));
  }
  // Hidden tests land only now, root-owned and read-only, rewritten before each run with no
  // sandbox process left alive: repository code cannot have replaced them.
  for (const test of spec.hidden_tests) {
    killUser(sandbox.uid);
    placeHiddenTests(repoDir, spec.config.hidden_tests.dir, spec.hidden_tests);
    const result = await run(hiddenCommand(test));
    report.hidden.push({ file: test.file, criteria: test.criteria, passed: result.exit_code === 0, output: result.output });
  }
  if (after && report.hidden.length && report.hidden.every((h) => h.passed)) {
    const isTest = (path: string) => [...spec.config.test_paths, spec.config.hidden_tests.dir].some((prefix) => path.startsWith(prefix));
    const mutants = mutantsFrom(addedPatch, isTest);
    if (mutants.length) {
      killUser(sandbox.uid);
      placeHiddenTests(repoDir, spec.config.hidden_tests.dir, spec.hidden_tests);
      report.mutation = await runMutantsAsSandbox(workDir, repoDir, mutants, spec.hidden_tests.map(hiddenCommand), sandbox);
    }
  }
  killUser(sandbox.uid);
  return report;
}

/** Diff options that never run a command configured by the repository. */
const NO_DRIVERS = ["--no-ext-diff", "--no-textconv"];

/**
 * Writes the hidden tests into `dir` (relative to the checkout) as root-owned,
 * read-only files. Every path component is checked: a component the sandbox
 * turned into a symlink or file is replaced by a fresh directory.
 */
function placeHiddenTests(repoDir: string, dir: string, tests: HiddenTest[]): void {
  let current = repoDir;
  const parts = dir.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`hidden_tests.dir must stay inside the repository: ${dir}`);
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatOrUndefined(current);
    // The hidden-test directory itself is always recreated; parents only when they are not real directories.
    if (i === parts.length - 1 || !stat?.isDirectory()) {
      rmSync(current, { recursive: true, force: true });
      mkdirSync(current, { mode: 0o755 });
    }
  }
  for (const test of tests) writeFresh(join(current, test.file), test.content, 0o644);
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Runs the mutants in a separate process as the sandbox user: root never writes into the sandbox's checkout. */
async function runMutantsAsSandbox(
  workDir: string,
  repoDir: string,
  mutants: Mutant[],
  commands: string[],
  sandbox: Sandbox,
): Promise<MutationReport | undefined> {
  const specFile = join(workDir, "mutants.json");
  writeFresh(specFile, JSON.stringify({ mutants, commands }), 0o644);
  const cli = join(dirname(fileURLToPath(import.meta.url)), "mutate-cli.ts");
  const result = await execAsync(process.execPath, [cli, specFile], {
    cwd: repoDir,
    env: sandbox.env,
    uid: sandbox.uid,
    gid: sandbox.gid,
    timeoutMs: 120_000,
  });
  const last = result.output.trim().split("\n").at(-1) ?? "";
  try {
    return MutationResult.parse(JSON.parse(last));
  } catch {
    console.error(JSON.stringify({ kind: "gate.mutation_failed", code: result.code, output: result.output.slice(-500) }));
    return undefined;
  }
}

const MutationResult = z.object({
  mutants: z.array(z.object({ where: z.string(), change: z.string(), killed: z.boolean() })),
  killed: z.number().int(),
  total: z.number().int(),
  skipped: z.number().int(),
  seconds: z.number(),
});

/**
 * The diff policy against the base commit. The gate judges the pushed commit
 * (`HEAD`); the implementer's `verify` previews it on its working tree, where
 * uncommitted edits and new untracked files count too.
 */
export function checkDiff(
  repoDir: string,
  spec: Pick<GateJob, "repo" | "allow_test_change"> & { config: Pick<RepoConfig, "test_paths" | "protected_paths"> },
  against: "HEAD" | "worktree" = "HEAD",
): NonNullable<GateReport["diff_policy"]> {
  const git = (...args: string[]) => mustExec("git", [...SAFE_GIT, "-C", repoDir, ...args]);
  // `git diff <base>` compares the base with the working tree.
  const range = against === "HEAD" ? `${spec.repo.base_sha}..HEAD` : spec.repo.base_sha;
  // NUL-separated output: Git quotes unusual file names otherwise, and a quoted path would slip past every prefix check.
  const fields = git("diff", ...NO_DRIVERS, "--name-status", "-z", "--no-renames", range)
    .split("\0")
    .filter(Boolean);
  const changes: [string, string][] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push([fields[i] as string, fields[i + 1] as string]);
  if (against === "worktree") {
    for (const path of git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean)) changes.push(["A", path]);
  }
  const violations: string[] = [];
  const protectedHits: string[] = [];
  const isTest = (path: string) => spec.config.test_paths.some((prefix) => path.startsWith(prefix));

  for (const [kind, path] of changes) {
    if (PLATFORM_PROTECTED_PATHS.some((prefix) => path.startsWith(prefix))) violations.push(`changes platform-managed path ${path}`);
    if (spec.config.protected_paths.some((prefix) => path.startsWith(prefix))) protectedHits.push(path);
    if (isTest(path) && kind !== "A" && !spec.allow_test_change) violations.push(`modifies existing test ${path} (${kind})`);
  }

  const patch = git("diff", ...NO_DRIVERS, "--unified=0", range);
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++") && SKIP_MARKERS.test(line) && !spec.allow_test_change) {
      violations.push(`adds a test skip marker: ${line.slice(1, 160).trim()}`);
    }
  }

  const flags: string[] = [];
  if (changes.some(([, path]) => path === "package.json")) {
    const script = (ref: string) => {
      const shown = exec("git", [...SAFE_GIT, "-C", repoDir, "show", `${ref}:package.json`]);
      try {
        return shown.code === 0 ? (JSON.parse(shown.output) as { scripts?: Record<string, string> }).scripts?.test : undefined;
      } catch {
        return "(unparseable package.json)";
      }
    };
    const before = script(spec.repo.base_sha);
    const after = against === "HEAD" ? script("HEAD") : workingScript(repoDir);
    if (before !== after) flags.push(`test script changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }

  let added = 0;
  let removed = 0;
  for (const record of git("diff", ...NO_DRIVERS, "--numstat", "-z", range).split("\0")) {
    const [a, r] = record.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return {
    violations,
    changed_files: changes.map(([, path]) => path),
    protected_hits: protectedHits,
    flags,
    added_lines: added,
    removed_lines: removed,
  };
}

function workingScript(repoDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.test;
  } catch {
    return "(unparseable package.json)";
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
