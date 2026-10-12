import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashAgentFile, readAgentFile, writeFresh } from "./agentfs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mork-agentfs-"));
  dirs.push(dir);
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "secret"), "do not read or overwrite");
  symlinkSync(join(dir, "outside"), join(dir, "parent"));
  return dir;
}

test("a read rejects an ancestor symlink", () => {
  const dir = fixture();
  expect(readAgentFile(join(dir, "parent", "secret"))).toBeUndefined();
  expect(readAgentFile(join(dir, "outside", "secret"))).toBe("do not read or overwrite");
});
test("a write rejects an ancestor symlink without touching its target", () => {
  const dir = fixture();
  expect(() => writeFresh(join(dir, "parent", "secret"), "changed")).toThrow();
  expect(readFileSync(join(dir, "outside", "secret"), "utf8")).toBe("do not read or overwrite");
});
test("a leaf symlink can be replaced without overwriting its target", () => {
  const dir = fixture();
  symlinkSync(join(dir, "outside", "secret"), join(dir, "leaf"));
  expect(readAgentFile(join(dir, "leaf"))).toBeUndefined();
  writeFresh(join(dir, "leaf"), "fresh");
  expect(readAgentFile(join(dir, "leaf"))).toBe("fresh");
  expect(readAgentFile(join(dir, "outside", "secret"))).toBe("do not read or overwrite");
});

test("hashing rejects leaf and ancestor symlinks", () => {
  const dir = fixture();
  symlinkSync(join(dir, "outside", "secret"), join(dir, "leaf"));
  expect(hashAgentFile(join(dir, "leaf"))).toBeUndefined();
  expect(hashAgentFile(join(dir, "parent", "secret"))).toBeUndefined();
  expect(hashAgentFile(join(dir, "outside", "secret"))).toBe(createHash("sha256").update("do not read or overwrite").digest("hex"));
});

test("hashing reads the complete large file with bounded buffer allocation", () => {
  const dir = fixture();
  const path = join(dir, "large.bin");
  const block = Buffer.alloc(64 * 1024, 0xab);
  const tail = Buffer.from([0, 0xff, 0x7f]);
  const expected = createHash("sha256");
  const fd = openSync(path, "wx");
  try {
    // Larger than readAgentFile's default truncation limit.
    for (let i = 0; i < 1025; i++) {
      writeSync(fd, block);
      expected.update(block);
    }
    writeSync(fd, tail);
    expected.update(tail);
  } finally {
    closeSync(fd);
  }
  const allocations = spyOn(Buffer, "alloc");
  try {
    expect(hashAgentFile(path)).toBe(expected.digest("hex"));
    expect(allocations.mock.calls.length).toBeGreaterThan(0);
    expect(Math.max(...allocations.mock.calls.map(([size]) => size))).toBeLessThanOrEqual(64 * 1024);
  } finally {
    allocations.mockRestore();
  }
});
