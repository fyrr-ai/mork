import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function store() {
  const directory = mkdtempSync(join(tmpdir(), "mork-local-store-"));
  directories.push(directory);
  return new LocalStore(directory);
}
test("local outputs survive reopening, replace atomically and keep a single claim winner", async () => {
  const first = store();
  await first.putJson("task/plan.json", { step: 1 });
  const reopened = new LocalStore(first.directory);
  expect(await reopened.json("task/plan.json")).toEqual({ step: 1 });
  await reopened.putJson("task/plan.json", { step: 2 });
  expect(await first.json("task/plan.json")).toEqual({ step: 2 });
  expect(await Promise.all([first.claim("task/claim.json", "one"), reopened.claim("task/claim.json", "two")])).toEqual([true, false]);
  expect(await reopened.json("task/claim.json")).toBe("one");
});
test("local updates retain the previous object if their updater fails", async () => {
  const files = store();
  await files.updateJson("task/state.json", () => ({ attempt: 1 }));
  await expect(
    files.updateJson("task/state.json", () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(await files.json("task/state.json")).toEqual({ attempt: 1 });
  await files.updateJson("task/state.json", (current) => ({ attempt: (current as { attempt: number }).attempt + 1 }));
  expect(await files.json("task/state.json")).toEqual({ attempt: 2 });
});
test("local object keys cannot escape their directory", async () => {
  const files = store();
  for (const key of ["../outside", "/tmp/outside", "task/../../outside", "task//file"]) {
    await expect(files.put(key, "x")).rejects.toThrow("Invalid local object key");
  }
});
test("a missing local object has the same boundary error as S3", async () => {
  await expect(store().json("missing.json")).rejects.toMatchObject({ name: "NoSuchKey" });
});

test("a no-op on a missing reservation leaves it missing", async () => {
  const files = store();
  await files.updateJson("pr.json", (current) => current);
  await expect(files.json("pr.json")).rejects.toMatchObject({ name: "NoSuchKey" });
});
