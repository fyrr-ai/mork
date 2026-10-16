import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execAsync } from "./git.ts";

test("the production verify bundle loads in Node without pulling AWS clients into Pi's extension", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mork-verify-package-"));
  try {
    const built = await execAsync(process.execPath, ["images/bundle.ts", directory], { cwd: resolve(import.meta.dir, "../../.."), timeoutMs: 60000 });
    expect(built.code).toBe(0);
    const graph = JSON.parse(readFileSync(join(directory, "runner/bundle-inputs.json"), "utf8"));
    const output = Object.entries(graph.outputs).find(([path]) => path.endsWith("packages/runner/src/verify.ts"))?.[1] as
      | { inputs: Record<string, unknown> }
      | undefined;
    expect(output).toBeDefined();
    expect(Object.keys(output?.inputs ?? {}).filter((path) => /node_modules\/(?:@aws-sdk|@smithy)\//.test(path))).toEqual([]);
    const uri = pathToFileURL(join(directory, "runner/packages/runner/src/verify.ts")).href;
    const loaded = await execAsync("node", [
      "--input-type=module",
      "-e",
      `const m=await import(${JSON.stringify(uri)}); if(typeof m.runVerify!=='function'||typeof m.verifyText!=='function')process.exit(1)`,
    ]);
    expect(loaded.code).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
