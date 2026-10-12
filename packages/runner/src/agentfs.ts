// Files the runner (root) reads from or writes into directories the agent or
// the sandbox user own. Those users can swap any path for a symlink, so root
// never follows one there. Each parent is opened with O_NOFOLLOW and pinned
// by its descriptor before the next component is opened (Linux /proc).
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_BYTES = 64 * 1024 * 1024;

/** Descriptor-relative traversal also rejects symlinks in ancestors, without a check/open race. */
function withParent<T>(path: string, use: (anchored: string) => T): T {
  const parts = resolve(path).split("/").filter(Boolean);
  const leaf = parts.pop();
  if (!leaf) throw new Error("Expected a file path");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd);
      fd = next;
    }
    return use(`/proc/self/fd/${fd}/${leaf}`);
  } finally {
    closeSync(fd);
  }
}

/** Reads a regular file without following a symlink at `path`; undefined when it is missing or not a regular file. */
export function readAgentFile(path: string, maxBytes = MAX_BYTES): string | undefined {
  return readAgentBytes(path, maxBytes)?.toString("utf8");
}

/** Binary counterpart, also rejecting symlinks in every component. */
export function readAgentBytes(path: string, maxBytes = MAX_BYTES): Buffer | undefined {
  let fd: number;
  try {
    fd = withParent(path, (anchored) => openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** SHA-256 of a regular file, with pinned path traversal and a fixed 64 KiB buffer. */
export function hashAgentFile(path: string): string | undefined {
  let fd: number;
  try {
    fd = withParent(path, (anchored) => openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(fd);
  }
}

/** Replaces whatever is at `path` (file or symlink) with a new file; O_EXCL never follows a symlink. */
export function writeFresh(path: string, data: string | Uint8Array, mode = 0o644): void {
  withParent(path, (anchored) => {
    rmSync(anchored, { force: true, recursive: true });
    writeFileSync(anchored, data, { flag: "wx", mode });
  });
}

/** Kills every process of `uid`, repeating until none is left (a forking process can outlive one pass). */
export function killUser(uid: number | undefined): void {
  if (uid === undefined) return;
  for (let pass = 0; pass < 20; pass++) {
    let found = 0;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const status = readFileSync(`/proc/${entry}/status`, "utf8");
        if (/^State:\s+Z/m.test(status)) continue;
        if (new RegExp(`^Uid:\\s+${uid}\\s`, "m").test(status)) {
          process.kill(Number(entry), "SIGKILL");
          found++;
        }
      } catch {
        // The process exited meanwhile.
      }
    }
    if (found === 0) return;
    // SIGKILL is asynchronous; give the kernel time to reap the killed processes.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
  throw new Error(`Processes of sandbox uid ${uid} survived SIGKILL`);
}
