import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { RuntimeManifest, TaskRuntime } from "@mork/contracts";
import { SAFE_GIT } from "./git.ts";

export const RUNTIME_MANIFEST = "/opt/mork-runtime/manifest.json";

/** Compare image inputs with immutable base objects, never the candidate working tree. */
export function verifyRuntimeManifest(directory: string, baseSha: string, manifestPath: string): RuntimeManifest {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("Runtime input verification requires an exact base SHA");
  const manifest = RuntimeManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!(".mork/config.toml" in manifest.inputs)) throw new Error("Runtime manifest must pin .mork/config.toml");
  for (const [path, expected] of Object.entries(manifest.inputs)) {
    const git = (...args: string[]) =>
      execFileSync("git", [...SAFE_GIT, ...args], { cwd: directory, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    let contents: Buffer;
    try {
      const entry = git("ls-tree", baseSha, "--", path).toString("utf8");
      if (!/^100(?:644|755) blob /.test(entry)) throw new Error("not a regular blob");
      contents = git("show", `${baseSha}:${path}`);
    } catch {
      throw new Error(`Prepared runtime input is missing or not a regular base file: ${path}`);
    }
    if (createHash("sha256").update(contents).digest("hex") !== expected)
      throw new Error(`Prepared runtime input does not match base ${baseSha}: ${path}`);
  }
  return manifest;
}

/** Runs before repository setup, Pi and gate commands, including local workers in a prepared image. */
export function preflightRuntime(directory: string, baseSha: string, runtime?: TaskRuntime): void {
  if (runtime) {
    TaskRuntime.parse(runtime);
    if (`${process.platform}/${process.arch}` !== runtime.platform)
      throw new Error(`Pinned runtime requires ${runtime.platform}; worker is ${process.platform}/${process.arch}`);
  }
  if (!runtime?.repository_runtime && !existsSync(RUNTIME_MANIFEST)) return;
  if (!existsSync(RUNTIME_MANIFEST)) throw new Error(`Repository runtime manifest is missing: ${RUNTIME_MANIFEST}`);
  const manifest = verifyRuntimeManifest(directory, baseSha, RUNTIME_MANIFEST);
  if (`${process.platform}/${process.arch}` !== manifest.platform)
    throw new Error(`Prepared runtime requires ${manifest.platform}; worker is ${process.platform}/${process.arch}`);
}
