import { expect, test } from "bun:test";
import { execAsync } from "./git.ts";

test("bounded capture reports incomplete output explicitly and retains the exact tail", async () => {
  const result = await execAsync(process.execPath, ["-e", "process.stdout.write('ROOT'+'.'.repeat(10000)+'END')"], { maxOutputBytes: 64 });
  expect(result.output_truncated).toBe(true);
  expect(Buffer.byteLength(result.output)).toBe(64);
  expect(result.output.endsWith("END")).toBe(true);
});

test("diagnostic capture keeps the first cause when within its explicit limit", async () => {
  const result = await execAsync(process.execPath, ["-e", "process.stdout.write('ROOT'+'.'.repeat(10000)+'END')"], { maxOutputBytes: 20000 });
  expect(result.output_truncated).not.toBe(true);
  expect(result.output.startsWith("ROOT")).toBe(true);
  expect(result.output.endsWith("END")).toBe(true);
});

test("a command deadline stops children holding its output pipes open", async () => {
  const started = Date.now();
  const result = await execAsync("bash", ["-c", "sleep 30 & wait"], { timeoutMs: 80 });
  expect(result.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(2_000);
});
