// Real Buildx -> standalone SOCI -> registry proof. This task is opt-in because
// it builds an image and starts a registry process bound only to localhost.
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const work = mkdtempSync(join(tmpdir(), "mork-soci-proof-"));
mkdirSync(join(work, "registry"));
const registry = Bun.spawn(["crane", "registry", "serve", "--address", "127.0.0.1:0", "--disk", join(work, "registry")], {
  stdout: "ignore",
  stderr: "pipe",
});
function run(args: string[], cwd = work): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} exited ${result.exitCode}: ${result.stderr.toString().slice(-4000)}`);
  return result.stdout.toString();
}
try {
  const reader = registry.stderr.getReader();
  let logs = "";
  let port: string | undefined;
  while (!port) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Local registry exited before starting: ${logs}`);
    logs += new TextDecoder().decode(chunk.value);
    port = /serving on port (\d+)/.exec(logs)?.[1];
  }
  reader.releaseLock();
  const image = `127.0.0.1:${port}/mork-soci:verified`;
  const context = join(work, "context");
  mkdirSync(context);
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\nCOPY payload /payload\n");
  // Above the default 10MiB compressed-layer indexing threshold.
  writeFileSync(join(context, "payload"), randomBytes(16 * 1024 * 1024));
  const archive = join(work, "source.tar");
  const builder = process.env.MORK_SOCI_BUILDER ? ["--builder", process.env.MORK_SOCI_BUILDER] : [];
  run([
    "docker",
    "buildx",
    "build",
    ...builder,
    "--platform",
    "linux/amd64",
    "--provenance=false",
    "--output",
    `type=oci,dest=${archive},compression=gzip,force-compression=true`,
    context,
  ]);
  const source = join(work, "source");
  mkdirSync(source);
  run(["tar", "-xf", archive, "-C", source]);
  const sourceIndex = JSON.parse(readFileSync(join(source, "index.json"), "utf8"));
  const originalDigest: string = sourceIndex.manifests[0].digest;
  const original = JSON.parse(readFileSync(join(source, "blobs", "sha256", originalDigest.slice(7)), "utf8"));
  run(["bash", resolve("scripts/soci-publish.sh"), archive, image, "current"]);
  const published = JSON.parse(run(["crane", "manifest", image]));
  const artifact = published.manifests.find((entry: { artifactType?: string }) => entry.artifactType === "application/vnd.amazon.soci.index.v2+json");
  const application = published.manifests.find(
    (entry: { artifactType?: string }) => entry.artifactType !== "application/vnd.amazon.soci.index.v2+json",
  );
  assert(artifact && application, "Published graph must contain both application and SOCI v2 artifact");
  const converted = JSON.parse(run(["crane", "manifest", `127.0.0.1:${port}/mork-soci@${application.digest}`]));
  const index = JSON.parse(run(["crane", "manifest", `127.0.0.1:${port}/mork-soci@${artifact.digest}`]));
  assert.deepEqual(converted.layers, original.layers, "SOCI must preserve filesystem layer descriptors");
  assert.deepEqual(converted.config, original.config, "SOCI must preserve image configuration");
  assert.notEqual(application.digest, originalDigest, "SOCI v2 changes the application manifest digest");
  assert(index.layers.length > 0, "The fixture must produce a zTOC rather than an empty index");
  const digest = run(["crane", "digest", image]).trim();
  assert.equal(run(["crane", "digest", `127.0.0.1:${port}/mork-soci:current`]).trim(), digest, "Moving tag must retain the entire indexed graph");
  run(["bash", resolve("scripts/soci-publish.sh"), archive, image, "current"]);
  assert.equal(run(["crane", "digest", image]).trim(), digest, "Republishing the same OCI archive must converge on the same indexed image");
  const downloaded = join(work, "downloaded");
  run(["crane", "pull", "--format", "oci", image, downloaded]);
  assert(JSON.parse(readFileSync(join(downloaded, "index.json"), "utf8")).manifests.length > 0, "Indexed graph can be pulled back from the registry");
  console.log(
    JSON.stringify({
      verified: true,
      soci: run(["soci", "--version"]).trim(),
      crane: run(["crane", "version"]).trim(),
      digest,
      ztocs: index.layers.length,
      filesystem_layers_unchanged: true,
      aws_contacted: false,
    }),
  );
} finally {
  registry.kill();
  await registry.exited;
  rmSync(work, { recursive: true, force: true });
}
