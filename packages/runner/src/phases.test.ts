import { expect, test } from "bun:test";
import { Brief, keys } from "@mork/contracts";
import { DecisionPanel } from "@mork/decision";
import type { ReportEvent } from "@mork/sources";
import { Store } from "@mork/store";
import { noLogger } from "./otlp.ts";
import { check, type PhaseContext } from "./phases.ts";

class MemoryStore extends Store {
  readonly objects = new Map<string, string>();
  readonly reads: string[] = [];
  constructor() {
    super("unused");
  }
  override async put(key: string, body: string | Uint8Array): Promise<string> {
    this.objects.set(key, Buffer.from(body).toString("utf8"));
    return key;
  }
  override async bytes(key: string): Promise<Buffer> {
    this.reads.push(key);
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`Missing artifact ${key}`);
    return Buffer.from(value);
  }
}

async function failedBuild() {
  const store = new MemoryStore();
  const brief = Brief.parse({
    attempt: 2,
    prefix: "tasks/example/one",
    repo: { full_name: "example/repo", default_branch: "main", base_sha: "a".repeat(40) },
    branch: "mork/one",
  });
  await store.putJson(keys.plan(brief.prefix), {
    problem: "Implement behavior",
    plan: ["Change implementation"],
    acceptance_criteria: [{ id: "AC1", text: "Works", testable: true }],
    hidden_tests: [{ file: "acceptance.sh", criteria: ["AC1"] }],
    risks: [],
    security_sensitive: false,
  });
  await store.putJson(keys.buildResult(brief.prefix, brief.attempt), { ok: false, error: "push failed" });
  const reported: ReportEvent[] = [];
  const ctx: PhaseContext = {
    brief,
    store,
    env: {
      llmBaseUrl: "unused",
      egress: { proxy: "unused", caFile: "unused" },
      piBin: "unused",
      extensionsDir: "unused",
      get workDir(): string {
        throw new Error("A failed Build must not start a checkout");
      },
      agentHome: "unused",
    },
    sandbox: { env: {} },
    readToken: "unused",
    model: "unused",
    panel: new DecisionPanel([]),
    superviseEveryMs: 45_000,
    reporter: {
      report: async (event) => {
        reported.push(event);
      },
    },
    secrets: () => [],
    logger: noLogger,
  };
  return { ctx, store, reported };
}

test("Check returns failed feedback after an unpushed Build without reading hidden tests or checking out code", async () => {
  const { ctx, store, reported } = await failedBuild();
  expect(await check(ctx)).toEqual({ ok: true, passed: false });
  expect(store.objects.get(keys.feedback(ctx.brief.prefix, 3))).toContain("push failed");
  expect(store.reads).not.toContain(keys.hidden(ctx.brief.prefix));
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ kind: "check", passed: false });
});

test("Check rejects a corrupt Build result rather than reporting green or starting a checkout", async () => {
  const { ctx, store, reported } = await failedBuild();
  await store.putJson(keys.buildResult(ctx.brief.prefix, ctx.brief.attempt), { ok: true });
  await expect(check(ctx)).rejects.toThrow();
  expect(reported).toEqual([]);
  expect(store.objects.has(keys.feedback(ctx.brief.prefix, 3))).toBe(false);
});
