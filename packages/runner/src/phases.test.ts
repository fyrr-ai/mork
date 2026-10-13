import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brief, keys } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT } from "@mork/contracts/development";
import { DecisionPanel } from "@mork/decision";
import type { ReportEvent } from "@mork/sources";
import { LocalStore } from "@mork/store/local";
import { noLogger } from "./otlp.ts";
import { check, type PhaseContext } from "./phases.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class TrackedStore extends LocalStore {
  readonly reads: string[] = [];
  override async bytes(key: string): Promise<Buffer> {
    this.reads.push(key);
    return super.bytes(key);
  }
}

async function failedBuild() {
  const directory = mkdtempSync(join(tmpdir(), "mork-phases-"));
  directories.push(directory);
  const store = new TrackedStore(directory);
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
    step: DEFAULT_DEVELOPMENT.steps[2],
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
  expect(await store.text(keys.feedback(ctx.brief.prefix, 3))).toContain("push failed");
  expect(store.reads).not.toContain(keys.hidden(ctx.brief.prefix));
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ kind: "check", passed: false });
});

test("Check rejects a corrupt Build result rather than reporting green or starting a checkout", async () => {
  const { ctx, store, reported } = await failedBuild();
  await store.putJson(keys.buildResult(ctx.brief.prefix, ctx.brief.attempt), { ok: true });
  await expect(check(ctx)).rejects.toThrow();
  expect(reported).toEqual([]);
  await expect(store.text(keys.feedback(ctx.brief.prefix, 3))).rejects.toMatchObject({ name: "NoSuchKey" });
});
