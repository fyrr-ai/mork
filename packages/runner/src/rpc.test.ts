import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execAsync } from "./git.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("Node callers catch missing and non-executable Pi and stop without hanging", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mork-pi-error-"));
  directories.push(directory);
  const denied = join(directory, "denied");
  writeFileSync(denied, "#!/bin/sh\n");
  chmodSync(denied, 0o644);
  const rpc = new URL("./rpc.ts", import.meta.url).href;
  for (const [bin, expected] of [
    [join(directory, "absent"), "ENOENT"],
    [denied, "EACCES"],
  ]) {
    const code = `import { PiRpc } from ${JSON.stringify(rpc)};
      const pi = new PiRpc({bin:${JSON.stringify(bin)}, args:[], cwd:${JSON.stringify(directory)}, env:{}});
      try { await Promise.all([pi.command({type:'prompt'}), pi.waitSettled()]); process.exitCode=1; }
      catch (error) { console.log(error.code); }
      finally { await Promise.all([pi.stop(), pi.stop()]); }`;
    const result = await execAsync("node", ["--input-type=module", "-e", code], { timeoutMs: 3000 });
    expect(result.code, result.output).toBe(0);
    expect(result.output.trim()).toBe(expected);
  }
});
