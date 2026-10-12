import { describe, expect, test } from "bun:test";
import { exportJevcal, levelLabel, linkPr, MemoryStore, recordDecision, recordOutcome, recordTakeover, type Trace } from "./index.ts";

const trace: Trace = { used: "none", state: { diff_size: 12 }, questions: {}, providers: {} };
const task = "acme/widgets#5/abcd1234";

describe("timeline", () => {
  test("a retried step overwrites its own decision", async () => {
    const store = new MemoryStore();
    await recordDecision(store, { task, point: "recommendation", attempt: "check-1", trace, action: { level: "careful" } });
    await recordDecision(store, { task, point: "recommendation", attempt: "check-1", trace, action: { level: "careful" } });
    expect(store.items.size).toBe(1);
  });

  test("outcomes attach through the PR link; redelivery converges; foreign PRs are ignored", async () => {
    const store = new MemoryStore();
    await linkPr(store, task, "acme/widgets", 6);
    expect(await recordOutcome(store, { repo: "acme/widgets", pr: 6, delivery: "d1", outcome: "merged" })).toBe(true);
    await recordOutcome(store, { repo: "acme/widgets", pr: 6, delivery: "d1", outcome: "merged" });
    expect(await recordOutcome(store, { repo: "acme/widgets", pr: 99, delivery: "d2", outcome: "merged" })).toBe(false);
    const items = await store.query(`task#${task}`);
    expect(items.filter((i) => i.kind === "outcome")).toHaveLength(1);
  });

  test("level labels follow what the human did", () => {
    expect(levelLabel(["merged"])).toBe("quick");
    expect(levelLabel(["changes_requested", "merged"])).toBe("careful");
    expect(levelLabel(["closed"])).toBe("takeover");
    expect(levelLabel(["taken_over"])).toBe("takeover");
    expect(levelLabel(["approved"])).toBeUndefined();
  });

  test("jevcal export joins decisions with outcomes", async () => {
    const store = new MemoryStore();
    await recordDecision(store, { task, point: "recommendation", attempt: "check-1", trace, action: {} });
    await recordDecision(store, { task, point: "triage", attempt: "start", trace, action: {} });
    await linkPr(store, task, "acme/widgets", 6);
    await recordOutcome(store, { repo: "acme/widgets", pr: 6, delivery: "d1", outcome: "merged" });
    expect(await exportJevcal(store, "recommendation")).toEqual([
      { id: `${task}/decision#recommendation#check-1`, state: '{"diff_size":12}', labels: { level: "quick" } },
    ]);
    const other = "o/r#1/x";
    await recordDecision(store, { task: other, point: "recommendation", attempt: "check-1", trace, action: {} });
    await recordTakeover(store, other);
    const rows = await exportJevcal(store, "recommendation");
    expect(rows.find((r) => r.id.startsWith(other))?.labels).toEqual({ level: "takeover" });
    expect((await exportJevcal(store, "triage"))[0]?.labels).toEqual({});
  });
});
