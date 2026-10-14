// Opt-in paid-model proof: real gate, OCR and Pi on a deliberately regressed
// numeric helper. No phase is mocked. Writes review artifacts under the supplied
// output directory so the result can be inspected after the container exits.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Brief, keys, Review } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT } from "@mork/contracts/development";
import { DecisionPanel, panelFromEnv, prioritizeFindings } from "@mork/decision";
import { noLogger } from "@mork/sources";
import { LocalStore } from "@mork/store/local";
import { mustExec, SAFE_GIT } from "./git.ts";
import { check } from "./phases.ts";

const output = process.env.MORK_REVIEW_LIVE_OUTPUT;
const live = output && process.env.MORK_LOCAL_API_KEY && process.env.MORK_REVIEW_LIVE_LLM_URL ? test : test.skip;
live(
  "real OCR and GLM confirm a regression missed by the gate",
  async () => {
    const directory = mkdtempSync(join(output as string, "live-"));
    const source = join(directory, "source");
    mkdirSync(source);
    const git = (...args: string[]) =>
      mustExec("git", [...SAFE_GIT, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, ...args]).trim();
    git("init", "-q");
    mkdirSync(join(source, ".mork"));
    writeFileSync(
      join(source, ".mork/config.toml"),
      'test = "node smoke.mjs"\n[hidden_tests]\ndir = "hidden"\ncommand = "node {file}"\nfile_suffix = ".mjs"\n',
    );
    writeFileSync(join(source, "math.mjs"), "export const add = (a, b) => Number(a) + Number(b);\n");
    writeFileSync(join(source, "README.md"), "add returns a numeric sum, including numeric strings.\n");
    writeFileSync(join(source, "smoke.mjs"), "import assert from 'node:assert/strict'; import {add} from './math.mjs'; assert.equal(add(2,3),5);\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "mork/live-review");
    writeFileSync(join(source, "math.mjs"), "export const add = (a, b, c = 0) => a + b + c;\n");
    git("add", "math.mjs");
    git("commit", "-qm", "Add third operand with a coercion regression");
    const head = git("rev-parse", "HEAD");
    const remote = join(directory, "remote.git");
    mustExec("git", ["clone", "--bare", "-q", source, remote]);
    const store = new LocalStore(join(directory, "outputs"));
    const prefix = "tasks/live";
    await store.putJson(keys.issue(prefix), {
      ref: "LIVE-1",
      title: "Support an optional third operand",
      body: "Extend add with an optional third operand. Keep existing numeric string coercion.",
    });
    await store.putJson(keys.plan(prefix), {
      problem: "Support a third operand",
      plan: ["Add an optional parameter"],
      acceptance_criteria: [{ id: "AC1", text: "add(2,3,4) is 9; preserve numeric coercion", testable: true }],
      hidden_tests: [{ file: "third.mjs", criteria: ["AC1"] }],
      risks: [],
      security_sensitive: false,
    });
    await store.putJson(keys.hidden(prefix), [
      {
        file: "third.mjs",
        criteria: ["AC1"],
        content: "import assert from 'node:assert/strict'; import {add} from '../math.mjs'; assert.equal(add(2,3,4),9);",
      },
    ]);
    await store.putJson(keys.buildResult(prefix, 1), { ok: true, head_sha: head });
    const agentHome = join(directory, "agent");
    mkdirSync(agentHome);
    const started = Date.now();
    const result = await check({
      brief: Brief.parse({
        prefix,
        attempt: 1,
        branch: "mork/live-review",
        repo: { full_name: "example/live", default_branch: "main", base_sha: base },
      }),
      step: DEFAULT_DEVELOPMENT.steps[2],
      store,
      githubToken: async () => "",
      localRepo: remote,
      env: {
        llmBaseUrl: process.env.MORK_REVIEW_LIVE_LLM_URL as string,
        piBin: "pi",
        extensionsDir: "/opt/mork/packages/runner/extensions",
        workDir: directory,
        agentHome,
        trustedLocal: { apiKey: process.env.MORK_LOCAL_API_KEY as string },
      },
      model: process.env.MORK_REVIEW_LIVE_MODEL ?? "glm-5.3-flash",
      panel: new DecisionPanel([]),
      superviseEveryMs: 300000,
      sandbox: { env: { HOME: directory, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CI: "1" } },
      reporter: { report: async () => undefined },
      secrets: () => [process.env.MORK_LOCAL_API_KEY as string],
      logger: noLogger,
    }).finally(() => rmSync(join(agentHome, ".pi-mork"), { recursive: true, force: true }));
    chmodSync(directory, 0o755);
    const review = Review.parse(await store.json(keys.review(prefix, 1)));
    const priorities = await prioritizeFindings(
      panelFromEnv(process.env),
      review.findings.map((f) => ({ severity: f.severity, category: f.category, where: f.where, verification: f.verification })),
    );
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({ result, elapsed_seconds: (Date.now() - started) / 1000, priorities: priorities.priorities, review }, null, 2),
    );
    console.log(
      JSON.stringify({
        directory,
        elapsed_seconds: (Date.now() - started) / 1000,
        stats: result.stats,
        findings: review.findings.map((f) => ({ where: f.where, verification: f.verification.status })),
      }),
    );
    expect(result).toMatchObject({ ok: true, passed: true });
    expect(result.stats?.some((s) => s.station === "criteria")).toBe(false);
    expect(review.findings.some((f) => f.verification.status === "confirmed" && f.what.toLowerCase().includes("string"))).toBe(true);
    expect(readFileSync(join(source, "math.mjs"), "utf8")).toContain("a + b + c");
  },
  900000,
);
