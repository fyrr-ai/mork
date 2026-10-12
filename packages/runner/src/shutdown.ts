// Work a stopping container must not lose. ECS sends SIGTERM (handover,
// timeout) and waits stopTimeout before SIGKILL; main.ts runs these hooks then.
type Hook = () => Promise<void>;
const hooks = new Set<Hook>();

/** Registers `hook` until the returned function is called. */
export function onShutdown(hook: Hook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/** Runs every registered hook once, each failure only logged. */
export async function runShutdown(): Promise<void> {
  const pending = [...hooks];
  hooks.clear();
  for (const hook of pending) {
    try {
      await hook();
    } catch (error) {
      console.error(JSON.stringify({ kind: "shutdown.hook_failed", error: (error as Error).message }));
    }
  }
}
