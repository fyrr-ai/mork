import { renameSync, writeFileSync } from "node:fs";
import type { GitHubAuth } from "@mork/sources";
import { runShutdown } from "./shutdown.ts";

/** Keep the Build proxy's root-only token file current while the phase runs. */
export async function withGitHubTokenFile<T>(auth: GitHubAuth, repo: string, file: string, work: () => Promise<T>, intervalMs = 30_000): Promise<T> {
  let last: string | undefined;
  let active = true;
  let refreshing = false;
  const refresh = async () => {
    const token = await auth.token(repo);
    if (!active || token === last) return;
    writeFileSync(`${file}.tmp`, token, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    last = token;
  };
  await refresh();
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    void refresh()
      .catch(fail)
      .finally(() => {
        refreshing = false;
      });
  }, intervalMs);
  try {
    return await Promise.race([work(), failed]);
  } catch (error) {
    // Stop Pi and its children before reporting a credential failure to Step Functions.
    await runShutdown();
    throw error;
  } finally {
    active = false;
    clearInterval(timer);
  }
}
