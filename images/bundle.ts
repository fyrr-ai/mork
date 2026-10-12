// Bundle production entrypoints and two runtime smoke helpers from frozen inputs.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("usage: bun images/bundle.ts <output-directory>");
const banner = 'import { createRequire as morkCreateRequire } from "node:module"; const require = morkCreateRequire(import.meta.url);';
for (const target of ["runner", "lambda"] as const) {
  const entrypoints =
    target === "runner"
      ? ["main", "workflow-main", "verify-cli", "mutate-cli", "rpc", "gate", "dir-rules", "verify"].map((name) => `packages/runner/src/${name}.ts`)
      : ["packages/steps/lambda-steps.mjs", "packages/steps/lambda-intake.mjs", "packages/sources/lambda-slack.mjs"];
  const result = await Bun.build({
    entrypoints,
    root: ".",
    outdir: join(output, target),
    target: "node",
    format: "esm",
    // Runner helpers use import.meta.url to locate sibling CLI files.
    splitting: target === "lambda",
    naming: { entry: `[dir]/[name].${target === "runner" ? "ts" : "mjs"}`, chunk: "chunks/[name]-[hash].mjs" },
    minify: true,
    keepNames: true,
    banner,
    metafile: true,
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not bundle ${target}`);
  await Bun.write(join(output, target, "bundle-inputs.json"), JSON.stringify(result.metafile, null, 2));
}
// The local orchestration CLI is only shipped in the test target.
const test = await Bun.build({
  entrypoints: ["packages/runner/src/local-cli.ts"],
  root: ".",
  outdir: join(output, "runner-test"),
  target: "node",
  format: "esm",
  splitting: false,
  naming: "[dir]/[name].ts",
  minify: true,
  keepNames: true,
  banner,
});
if (!test.success) throw new AggregateError(test.logs, "Could not bundle the local test CLI");
mkdirSync(join(output, "runner/packages/runner/extensions"), { recursive: true });
for (const file of readdirSync("packages/runner/extensions")) {
  if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
    cpSync(join("packages/runner/extensions", file), join(output, "runner/packages/runner/extensions", file));
  }
}
