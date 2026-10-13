import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAuth } from "@mork/sources";
import { withGitHubTokenFile } from "./github-auth.ts";
import { onShutdown } from "./shutdown.ts";

test("Build publishes refreshed credentials atomically in a root-only file while it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mork-app-token-"));
  chmodSync(dir, 0o755);
  const file = join(dir, "github-token");
  const auth = new GitHubAuth({ GITHUB_TOKEN: "first-token" });
  let current = "first-token";
  auth.token = async () => current;
  try {
    await withGitHubTokenFile(
      auth,
      "example-org/mork",
      file,
      async () => {
        expect(readFileSync(file, "utf8")).toBe("first-token");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        if (process.getuid?.() === 0) {
          const read = spawnSync(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1])", file], { uid: 10001, gid: 10001 });
          expect(read.status).not.toBe(0);
          expect(read.stderr.toString()).toContain("EACCES");
        }
        current = "renewed-token";
        const deadline = Date.now() + 1000;
        while (readFileSync(file, "utf8") !== current && Date.now() < deadline) await Bun.sleep(10);
        expect(readFileSync(file, "utf8")).toBe("renewed-token");
      },
      10,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed background renewal runs shutdown hooks and fails the phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mork-app-failure-"));
  const auth = new GitHubAuth({ GITHUB_TOKEN: "first-token" });
  let calls = 0;
  auth.token = async () => {
    if (++calls > 1) throw new Error("renewal failed");
    return "first-token";
  };
  let stopped = false;
  let finish: () => void = () => {};
  const off = onShutdown(async () => {
    stopped = true;
    finish();
  });
  try {
    await expect(
      withGitHubTokenFile(
        auth,
        "example-org/mork",
        join(dir, "github-token"),
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        10,
      ),
    ).rejects.toThrow("renewal failed");
    expect(stopped).toBe(true);
  } finally {
    off();
    rmSync(dir, { recursive: true, force: true });
  }
});
