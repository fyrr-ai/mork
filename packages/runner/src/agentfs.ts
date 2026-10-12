// Files the runner (root) reads from or writes into directories the agent or
// the sandbox user own. Those users can swap any path for a symlink, so root
// never follows one there: reads open with O_NOFOLLOW and accept only regular
// files, writes remove the path and create it exclusively.
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";

const MAX_BYTES = 64 * 1024 * 1024;

/** Reads a regular file without following a symlink at `path`; undefined when it is missing or not a regular file. */
export function readAgentFile(path: string, maxBytes = MAX_BYTES): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Replaces whatever is at `path` (file or symlink) with a new file; O_EXCL never follows a symlink. */
export function writeFresh(path: string, data: string | Uint8Array, mode = 0o644): void {
  rmSync(path, { force: true, recursive: true });
  writeFileSync(path, data, { flag: "wx", mode });
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
        if (new RegExp(`^Uid:\\s+${uid}\\s`, "m").test(status)) {
          process.kill(Number(entry), "SIGKILL");
          found++;
        }
      } catch {
        // The process exited meanwhile.
      }
    }
    if (found === 0) return;
  }
}
