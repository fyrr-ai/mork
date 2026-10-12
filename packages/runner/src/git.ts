// Git helpers shared by the runner and the gate. Credentials go in through the
// environment of the one git process (GIT_CONFIG_*), never as arguments (any
// user can read another process's command line) and never into a repository config.
import { spawn, spawnSync } from "node:child_process";

export type Exec = { code: number; output: string };

export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; uid?: number; gid?: number; timeoutMs?: number; input?: string } = {},
): Exec {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    uid: options.uid,
    gid: options.gid,
    input: options.input,
    timeout: options.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { code: result.status ?? (result.error ? 127 : 1), output };
}

/**
 * Like `exec`, but does not block the event loop, so heartbeats to Step
 * Functions and the SIGTERM handler keep running while a long command does.
 */
export function execAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; uid?: number; gid?: number; timeoutMs?: number } = {},
): Promise<Exec> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      uid: options.uid,
      gid: options.gid,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      // Keep the tail only: callers want the end of the output.
      while (size > 16 * 1024 * 1024 && chunks.length > 1) size -= (chunks.shift() as Buffer).length;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = options.timeoutMs
      ? setTimeout(() => {
          // Kill the shell's process group, including children holding output
          // pipes open. A child that starts its own group must not extend the
          // timeout either; the caller cleans up the sandbox uid afterward.
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          child.stdout.destroy();
          child.stderr.destroy();
          resolve({ code: 124, output: Buffer.concat(chunks).toString("utf8") });
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

export function mustExec(command: string, args: string[], options: Parameters<typeof exec>[2] = {}): string {
  const result = exec(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${redact(args).join(" ")} exited ${result.code}: ${result.output.slice(-2000)}`);
  }
  return result.output;
}

function redact(args: string[]): string[] {
  return args.map((a) => (a.startsWith("http.extraHeader=") ? "http.extraHeader=<redacted>" : a));
}

/** Environment that gives one git process the token; /proc/<pid>/environ is readable only by its owner. */
export function authEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

export function repoUrl(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}

/** Hardened git invocation for repositories whose config we do not control. */
export const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "safe.directory=*"];

/** Commit `branch` points to on GitHub, or undefined when it does not exist. */
export function remoteHead(fullName: string, token: string, branch: string): string | undefined {
  const out = mustExec("git", [...SAFE_GIT, "ls-remote", "--heads", repoUrl(fullName), `refs/heads/${branch}`], {
    timeoutMs: 120_000,
    env: authEnv(token),
  }).trim();
  return out ? out.split(/\s+/)[0] : undefined;
}

/**
 * Creates `dir` with the base commit (and optionally a branch) fetched from
 * GitHub. Leaves HEAD detached at `checkout` (a sha or `refs/remotes/...`).
 */
export function fetchRepo(opts: { dir: string; fullName: string; token: string; baseSha: string; branch?: string; localRepo?: string }): void {
  const git = (...args: string[]) => mustExec("git", [...SAFE_GIT, "-C", opts.dir, ...args]);
  mustExec("git", ["init", "-q", opts.dir]);
  const refspecs = [opts.baseSha];
  if (opts.branch) refspecs.push(`+refs/heads/${opts.branch}:refs/remotes/origin/${opts.branch}`);
  mustExec("git", [...SAFE_GIT, "-C", opts.dir, "fetch", "-q", "--depth=200", "--", opts.localRepo ?? repoUrl(opts.fullName), ...refspecs], {
    timeoutMs: 300_000,
    env: opts.localRepo ? process.env : authEnv(opts.token),
  });
  git("checkout", "-q", opts.branch ? `refs/remotes/origin/${opts.branch}` : opts.baseSha);
}
