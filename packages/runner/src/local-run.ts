// Both trusted local entrypoints own one lock and their subprocesses until cleanup ends.
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runShutdown } from "./shutdown.ts";

export async function withLocalRun<T>(directory: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const path = join(directory, ".run.lock");
  const lock = openSync(path, "wx", 0o600);
  const controller = new AbortController();
  let released = false;
  let shutdown: Promise<void> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(lock);
    rmSync(path, { force: true });
  };
  const stop = (code: number) => {
    if (shutdown) return;
    controller.abort(new Error("Local workflow interrupted"));
    shutdown = runShutdown();
    void shutdown.finally(() => {
      release();
      process.exit(code);
    });
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await work(controller.signal);
  } finally {
    await shutdown;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    release();
  }
}
