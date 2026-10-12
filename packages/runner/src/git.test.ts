import { expect, test } from "bun:test";
import { execAsync } from "./git.ts";

test("a command deadline stops children holding its output pipes open", async () => {
  const started = Date.now();
  const result = await execAsync("bash", ["-c", "sleep 30 & wait"], { timeoutMs: 80 });
  expect(result.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(2_000);
});
