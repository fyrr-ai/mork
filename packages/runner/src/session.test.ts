import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@mork/store";
import { redact, SessionLog } from "./session.ts";

describe("session redaction", () => {
  test("every occurrence of every secret is replaced", () => {
    const text = '{"out":"LLM_API_KEY=sk-abcdefgh12345 and ghp_TOKENVALUE99 again sk-abcdefgh12345"}';
    expect(redact(text, ["sk-abcdefgh12345", "ghp_TOKENVALUE99"])).toBe('{"out":"LLM_API_KEY=[redacted] and [redacted] again [redacted]"}');
  });
  test("short or empty values are not treated as secrets", () => {
    expect(redact("abc def", ["", "abc"])).toBe("abc def");
  });
  test("JSON-escaped credentials remain redacted without breaking the JSON", () => {
    const secret = 'password"with\\quotes';
    expect(JSON.parse(redact(JSON.stringify({ token: secret }), [secret]))).toEqual({ token: "[redacted]" });
  });
});

function memoryStore() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    store: {
      bucket: "b",
      put: async (key: string, body: string | Uint8Array) => {
        objects.set(key, Buffer.from(body));
        return key;
      },
      bytes: async (key: string) => {
        const v = objects.get(key);
        if (!v) throw new Error(`no ${key}`);
        return v;
      },
    } as unknown as Store,
  };
}

describe("session log", () => {
  test("uploads the redacted session, exports HTML, and restores it for a rerun", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mork-session-"));
    const { objects, store } = memoryStore();
    // A fake `pi --export <in> <out>` that copies the input, so the test needs no Pi.
    const fakePi = join(dir, "fake-pi.sh");
    writeFileSync(fakePi, '#!/bin/sh\ncp "$2" "$3"\n', { mode: 0o755 });
    const log = new SessionLog({
      file: join(dir, "s", "build-1-implementer.jsonl"),
      key: "tasks/x/sessions/build-1-implementer",
      store,
      secrets: ["sk-secret-value-123"],
      piBin: fakePi,
      piEnv: {},
      staging: join(dir, "staging"),
    });
    writeFileSync(log.file, '{"tool":"bash","out":"LLM_API_KEY=sk-secret-value-123"}\n');
    await log.finish();
    expect(objects.get("tasks/x/sessions/build-1-implementer.jsonl")?.toString()).toBe('{"tool":"bash","out":"LLM_API_KEY=[redacted]"}\n');
    expect(objects.get("tasks/x/sessions/build-1-implementer.html")?.toString()).not.toContain("sk-secret-value-123");

    const again = new SessionLog({
      file: join(dir, "t", "build-1-implementer.jsonl"),
      key: "tasks/x/sessions/build-1-implementer",
      store,
      secrets: [],
      piBin: fakePi,
      piEnv: {},
      staging: join(dir, "staging"),
    });
    expect(await again.restore()).toBe(true);
    expect(readFileSync(again.file, "utf8")).toContain("[redacted]");
    const none = new SessionLog({
      file: join(dir, "u", "x.jsonl"),
      key: "tasks/x/sessions/missing",
      store,
      secrets: [],
      piBin: fakePi,
      piEnv: {},
      staging: join(dir, "staging"),
    });
    expect(await none.restore()).toBe(false);
  });

  test("root follows no symlink the agent plants in its session directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mork-session-link-"));
    const { objects, store } = memoryStore();
    const fakePi = join(dir, "fake-pi.sh");
    writeFileSync(fakePi, '#!/bin/sh\ncp "$2" "$3"\n', { mode: 0o755 });
    const target = join(dir, "root-owned.txt");
    writeFileSync(target, "precious");
    const log = new SessionLog({
      file: join(dir, "s", "plan-1-analyst.jsonl"),
      key: "tasks/x/sessions/plan-1-analyst",
      store,
      secrets: [],
      piBin: fakePi,
      piEnv: {},
      staging: join(dir, "staging"),
    });
    // A session that is a symlink is neither read nor uploaded.
    mkdirSync(join(dir, "s"), { recursive: true });
    symlinkSync(target, log.file);
    await log.finish();
    expect(objects.has("tasks/x/sessions/plan-1-analyst.jsonl")).toBe(false);
    // Restoring replaces the symlink instead of writing through it.
    objects.set("tasks/x/sessions/plan-1-analyst.jsonl", Buffer.from("{}\n"));
    expect(await log.restore()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(lstatSync(log.file).isSymbolicLink()).toBe(false);
  });
});
