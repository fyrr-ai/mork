import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mustExec } from "./git.ts";
import { verifyRuntimeManifest } from "./runtime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mork-runtime-"));
  roots.push(directory);
  const git = (...args: string[]) => mustExec("git", args, { cwd: directory }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  mkdirSync(join(directory, ".mork"));
  writeFileSync(join(directory, ".mork/config.toml"), "test='true'\n");
  writeFileSync(join(directory, "mise.lock"), "locked runtime\n");
  symlinkSync("mise.lock", join(directory, "link"));
  git("add", ".");
  git("commit", "-qm", "runtime inputs");
  const baseSha = git("rev-parse", "HEAD");
  const manifest = {
    schema: 1,
    platform: "linux/arm64",
    base_mork_digest: `sha256:${"1".repeat(64)}`,
    inputs: { ".mork/config.toml": sha256("test='true'\n"), "mise.lock": sha256("locked runtime\n") },
  };
  const manifestPath = join(directory, "manifest.json");
  const publish = (value: unknown) => writeFileSync(manifestPath, JSON.stringify(value));
  publish(manifest);
  return { directory, baseSha, git, manifest, manifestPath, publish };
}

test("prepared runtime matches immutable base blobs despite a changed checkout and default branch", () => {
  const f = fixture();
  writeFileSync(join(f.directory, "mise.lock"), "candidate changed lock\n");
  f.git("add", ".");
  f.git("commit", "-qm", "later default branch");
  expect(() => verifyRuntimeManifest(f.directory, f.baseSha, f.manifestPath)).not.toThrow();
  expect(() => verifyRuntimeManifest(f.directory, f.git("rev-parse", "HEAD"), f.manifestPath)).toThrow(/runtime.*input|input.*runtime/i);
});

test("runtime manifest fails closed for malformed, unsafe, missing and symlink inputs", () => {
  const f = fixture();
  for (const value of [
    {},
    { ...f.manifest, platform: "linux/amd64" },
    { ...f.manifest, base_mork_digest: "latest" },
    { ...f.manifest, inputs: {} },
    { ...f.manifest, inputs: { "../outside": "1".repeat(64) } },
    { ...f.manifest, inputs: { "missing.lock": "1".repeat(64) } },
    { ...f.manifest, inputs: { link: sha256("mise.lock") } },
  ]) {
    f.publish(value);
    expect(() => verifyRuntimeManifest(f.directory, f.baseSha, f.manifestPath)).toThrow();
  }
});

test("a prepared image must declare the repository config in its runtime input identity", () => {
  const f = fixture();
  f.publish({ ...f.manifest, inputs: { "mise.lock": f.manifest.inputs["mise.lock"] } });
  expect(() => verifyRuntimeManifest(f.directory, f.baseSha, f.manifestPath)).toThrow(/config/i);
});
