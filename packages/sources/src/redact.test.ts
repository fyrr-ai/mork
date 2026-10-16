import { expect, test } from "bun:test";

test("the dependency-free public redactor preserves literal, escaped and minimum-length behavior", async () => {
  const { redact } = await import("@mork/sources/redact");
  const secret = 'credential-"quoted"-value';
  expect(redact(`literal ${secret}`, [secret])).toBe("literal [redacted]");
  expect(JSON.parse(redact(JSON.stringify({ value: secret }), [secret]))).toEqual({ value: "[redacted]" });
  expect(redact("abc", ["", "abc"])).toBe("abc");
  expect(redact("abc", ["", "abc"], 1)).toBe("[redacted]");
});
