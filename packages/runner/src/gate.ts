// LLM-free gate. Runs the repository's own commands and the hidden tests as an
// unprivileged user, then applies the diff policy. Nothing here can be talked
// into a different result: it only reports exit codes and diffs.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type GateReport,
  type HiddenTest,
  PLATFORM_PROTECTED_PATHS,
  type RepoConfig,
  type RepoRef,
  VerificationEvidence,
  VerificationResult,
} from "@mork/contracts";
import { redact } from "@mork/sources/redact";
import { hashAgentFile, killUser, writeFresh } from "./agentfs.ts";
import { exec, execAsync, fetchRepo, mustExec, SAFE_GIT } from "./git.ts";

const OUTPUT_TAIL = 4_000;
const SKIP_MARKERS = /\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|pytest\.skip\(|\bt\.skip\(|\{\s*skip\s*:\s*true/;

export type Sandbox = { uid?: number; gid?: number; env: Record<string, string> };
export type CommandDiagnostic = {
  command_id: string;
  command: string;
  cwd: string;
  head_sha: string;
  exit_code: number;
  output: string;
  output_truncated?: boolean;
  source?: "agent_verify";
};

/** One gate run, assembled by `main` from the brief and the stored outputs. */
export type GateJob = {
  mode: "before" | "after";
  repo: RepoRef;
  /** After mode: the pushed branch under test. */
  branch?: string;
  config: RepoConfig;
  hidden_tests: HiddenTest[];
  allow_test_change: boolean;
  /** Local gate CLI only. Fetch from this repository instead of GitHub. */
  localRepo?: string;
  secrets?: string[];
  saveDiagnostic?: (record: CommandDiagnostic) => Promise<string>;
  contract?: { criteria: { id: string; text: string; testable: boolean }[]; inputs: unknown };
};

export async function runGate(spec: GateJob, githubToken: string, workDir: string, sandbox: Sandbox): Promise<GateReport> {
  const repoDir = join(workDir, "repo");
  rmSync(repoDir, { recursive: true, force: true });
  fetchRepo({
    dir: repoDir,
    fullName: spec.repo.full_name,
    token: githubToken,
    baseSha: spec.repo.base_sha,
    branch: spec.mode === "after" ? spec.branch : undefined,
    localRepo: spec.localRepo,
  });

  // Capture the pushed commit and policy before running any repository code.
  // The sandbox never gets write access to tracked files or Git metadata.
  const after = spec.mode === "after";
  const diffPolicy = after ? checkDiff(repoDir, spec) : undefined;
  const testedSha = mustExec("git", [...SAFE_GIT, "-C", repoDir, "rev-parse", "HEAD"]).trim();
  const headSha = after ? testedSha : undefined;
  const runtime = verificationRuntime(repoDir, spec);
  const oracleVersion = verificationVersion(spec, runtime);
  for (const test of spec.hidden_tests) {
    if (!test.file.endsWith(spec.config.hidden_tests.file_suffix) || test.file.includes("/") || test.file.startsWith(".")) {
      throw new Error(`hidden test ${test.file} must be a plain file name ending with ${spec.config.hidden_tests.file_suffix}`);
    }
  }
  const tracked = mustExec("git", [...SAFE_GIT, "-C", repoDir, "ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  const hiddenDir = spec.config.hidden_tests.dir;
  if (!hiddenDir || hiddenDir.startsWith("/") || hiddenDir.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("hidden_tests.dir must be a nonempty relative directory outside .git");
  }
  if (tracked.some((path) => path === hiddenDir || path.startsWith(`${hiddenDir}/`))) {
    throw new Error("hidden_tests.dir must not contain tracked files");
  }
  // Root-owned entries in sticky directories cannot be removed or replaced by
  // the sandbox. Build tools can still create untracked outputs and dependencies.
  // Local runs use the current user and have detection, but no privilege boundary.
  if (sandbox.uid !== undefined) {
    if (sandbox.uid === 0 || sandbox.uid === process.getuid?.()) throw new Error("Gate sandbox must have a distinct non-root uid");
    protectCheckout(repoDir);
    assertProtectedAncestors(repoDir);
  }
  const sealed = snapshot(repoDir, [...tracked, ...gitFiles(repoDir)]);

  const run = async (command: string, timeoutMs = 900_000, hidden?: HiddenTest) => {
    let result: Awaited<ReturnType<typeof execAsync>>;
    try {
      result = await execAsync("bash", ["-c", command], {
        cwd: repoDir,
        env: { ...sandbox.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: repoDir },
        uid: sandbox.uid,
        gid: sandbox.gid,
        timeoutMs,
        maxOutputBytes: 64 * 1024 * 1024,
      });
    } finally {
      killUser(sandbox.uid);
    }
    for (const [path, expected] of sealed) {
      if (fingerprint(join(repoDir, path)) !== expected) throw new Error(`Gate command changed the tested checkout: ${path}`);
    }
    const record = {
      command_id: randomUUID(),
      command: redact(command, spec.secrets ?? []),
      cwd: repoDir,
      head_sha: testedSha,
      exit_code: result.code,
      output: redact(result.output, spec.secrets ?? []),
      ...(result.output_truncated ? { output_truncated: true } : {}),
    };
    const artifact = await spec.saveDiagnostic?.(record);
    return {
      command: record.command,
      command_id: record.command_id,
      exit_code: result.output_truncated ? 125 : result.code,
      output: `${result.output_truncated ? "[Diagnostic incomplete: output limit exceeded]\n" : ""}${record.output.slice(-OUTPUT_TAIL)}`,
      ...(artifact ? { artifact } : {}),
      ...(hidden
        ? {
            verdict: hiddenVerdict(
              result.output_truncated ? 125 : result.code,
              record.output,
              spec.config.hidden_tests.protocol,
              spec.mode === "before",
              hidden.criteria,
            ),
          }
        : {}),
    };
  };
  const hiddenCommand = (test: HiddenTest) =>
    spec.config.hidden_tests.command.replaceAll("{file}", shellQuote(join(spec.config.hidden_tests.dir, test.file)));

  const report: GateReport = {
    mode: spec.mode,
    oracle_version: oracleVersion,
    ...(headSha ? { head_sha: headSha } : {}),
    hidden: [],
    diff_policy: diffPolicy,
  };
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
    const result = await run(hiddenCommand(test), 900_000, test);
    const verdict = result.verdict ?? { status: "execution_failure" as const, reason: "Missing verification result" };
    report.hidden.push({
      file: test.file,
      criteria: test.criteria,
      passed: verdict.status === "pass",
      ...verdict,
      output: result.output,
      command_id: result.command_id,
      ...(result.artifact ? { artifact: result.artifact } : {}),
    });
  }
  killUser(sandbox.uid);
  return report;
}

/** No inferred red from exceptions or exit codes. Only the base-owned adapter can certify it. */
function hiddenVerdict(
  code: number,
  output: string,
  protocol?: "mork-v1",
  baseline = false,
  criteria: string[] = [],
): Pick<VerificationResult, "status" | "reason"> {
  if (!protocol)
    return code === 0
      ? baseline
        ? {
            status: "inconclusive",
            reason: "Legacy command success does not certify baseline behavior; configure a pinned mork-v1 verification adapter",
          }
        : { status: "pass", reason: "Command passed" }
      : { status: "execution_failure", reason: "Unclassified nonzero exit; configure a pinned mork-v1 verification adapter" };
  const line = output.trimEnd().split("\n").at(-1) ?? "";
  try {
    if (!line.startsWith("MORK_RESULT ")) throw new Error("Missing MORK_RESULT");
    const result = VerificationResult.parse(JSON.parse(line.slice("MORK_RESULT ".length)));
    const codes = { pass: 0, behavior_failure: 1, execution_failure: 3, inconclusive: 4 };
    if (codes[result.status] !== code) throw new Error("Exit code and verification status disagree");
    if (result.status === "pass" || result.status === "behavior_failure") {
      const evidence = VerificationEvidence.parse(result.tests);
      if (evidence.cases.some((test) => test.status !== "pass" && test.status !== "behavior_failure")) throw new Error("Incomplete case execution");
      const covered = new Set(evidence.cases.flatMap((test) => test.criteria));
      if (criteria.some((id) => !covered.has(id))) throw new Error("Adapter did not execute all declared criteria");
      const hasFailure = evidence.cases.some((test) => test.status === "behavior_failure");
      if ((result.status === "behavior_failure") !== hasFailure) throw new Error("Case verdicts and file status disagree");
    }
    return { status: result.status, reason: result.reason };
  } catch {
    return { status: "execution_failure", reason: "Missing, malformed or inconsistent mork-v1 adapter result" };
  }
}

function verificationRuntime(repoDir: string, spec: GateJob): [string, string][] {
  const paths = spec.config.hidden_tests.runtime_paths ?? [];
  if (spec.config.hidden_tests.protocol && !paths.length) throw new Error("A verification runtime must pin its adapter/configuration paths");
  return paths.map((path) => {
    if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))
      throw new Error("Invalid verification runtime path");
    const git = (...args: string[]) => mustExec("git", [...SAFE_GIT, "-C", repoDir, ...args]).trim();
    const expected = git("ls-tree", spec.repo.base_sha, "--", path);
    const actual = git("ls-tree", "HEAD", "--", path);
    if (
      !expected ||
      expected !== actual ||
      git("ls-tree", "-r", spec.repo.base_sha, "--", path)
        .split("\n")
        .some((entry) => entry.startsWith("120000 "))
    )
      throw new Error(`Candidate changes or symlinks verification runtime: ${path}`);
    return [path, expected];
  });
}

/** Candidate SHA is deliberately excluded: changing it invalidates only candidate evidence. */
export function verificationVersion(spec: Pick<GateJob, "repo" | "config" | "hidden_tests" | "contract">, runtime: [string, string][] = []): string {
  return createHash("sha256")
    .update(JSON.stringify({ base: spec.repo.base_sha, config: spec.config, tests: spec.hidden_tests, runtime, contract: spec.contract }))
    .digest("hex");
}

/** Diff options that never run a command configured by the repository. */
const NO_DRIVERS = ["--no-ext-diff", "--no-textconv"];

function gitFiles(repoDir: string): string[] {
  const paths: string[] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(repoDir, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else paths.push(path);
    }
  };
  visit(".git");
  return paths;
}

function fingerprint(path: string): string | undefined {
  const stat = lstatOrUndefined(path);
  if (stat?.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (!stat?.isFile()) return undefined;
  const digest = hashAgentFile(path);
  return digest === undefined ? undefined : `${stat.mode & 0o111}:${digest}`;
}

function snapshot(repoDir: string, paths: string[]): Map<string, string | undefined> {
  return new Map(paths.map((path) => [path, fingerprint(join(repoDir, path))]));
}

function protectCheckout(repoDir: string): void {
  const visit = (path: string, metadata: boolean) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry), metadata || entry === ".git");
      chmodSync(path, metadata ? 0o555 : 0o1777);
    } else {
      chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
    }
  };
  visit(repoDir, false);
}

/** A writable ancestor could let the sandbox rename the entire protected checkout. */
function assertProtectedAncestors(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error(`Gate checkout ancestor is writable by another user: ${current}`);
    }
    if (current === dirname(current)) break;
  }
}

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
      if (stat?.isDirectory() && process.getuid?.() !== 0) chmodSync(current, 0o755);
      rmSync(current, { recursive: true, force: true });
      mkdirSync(current, { mode: 0o755 });
    }
    if (process.getuid?.() === 0) mustExec("chown", ["0:0", current]);
    chmodSync(current, 0o1777);
  }
  for (const test of tests) writeFresh(join(current, test.file), test.content, 0o644);
  // A repository process can read hidden tests while they run, but cannot replace them.
  chmodSync(current, 0o555);
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The diff policy against the base commit. The gate judges the pushed commit
 * (`HEAD`); the implementer's `verify` previews it on its working tree, where
 * uncommitted edits and new untracked files count too.
 */
export function checkDiff(
  repoDir: string,
  spec: Pick<GateJob, "repo" | "allow_test_change"> & {
    config: Pick<RepoConfig, "test_paths" | "protected_paths"> & Partial<Pick<RepoConfig, "hidden_tests">>;
  },
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
    const runtime = spec.config.hidden_tests?.runtime_paths ?? [];
    if (runtime.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) violations.push(`changes verification runtime path ${path}`);
    const hiddenDir = spec.config.hidden_tests?.dir;
    if (hiddenDir && (path === hiddenDir || path.startsWith(`${hiddenDir}/`))) violations.push(`changes platform hidden test path ${path}`);
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
