import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brief, keys, parseRepoConfig } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT } from "@mork/contracts/development";
import { DecisionPanel } from "@mork/decision";
import { noLogger } from "@mork/sources";
import { LocalStore } from "@mork/store/local";
import { runGate } from "./gate.ts";
import { mustExec } from "./git.ts";
import { check } from "./phases.ts";

for (const scenario of [
  { hidden: true, setup: true },
  { hidden: false, setup: true },
  { hidden: false, setup: false },
]) {
  test(`real Check classifies failed ${scenario.setup ? "setup" : "repository test"}, hidden=${scenario.hidden}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mork-check-readiness-")),
      repo = join(dir, "source");
    mkdirSync(join(repo, ".mork"), { recursive: true });
    const git = (...args: string[]) => mustExec("git", ["-C", repo, ...args]).trim();
    try {
      const text = `setup=${JSON.stringify(scenario.setup ? "test ! -f broken" : "true")}\ntest=${JSON.stringify(scenario.setup ? "true" : "test ! -f broken")}\n[hidden_tests]\ndir="hidden"\ncommand="bash adapter.sh {file}"\nfile_suffix=".json"\nprotocol="mork-v1"\nruntime_paths=["adapter.sh"]\n`;
      writeFileSync(join(repo, ".mork/config.toml"), text);
      writeFileSync(
        join(repo, "adapter.sh"),
        `echo 'MORK_RESULT {"status":"pass","reason":"fixture","tests":{"readiness":{"ready":true},"cases":[{"id":"case","criteria":["AC1"],"status":"pass"}]}}'\n`,
      );
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
      const brief = Brief.parse({
        attempt: 1,
        prefix: "tasks/test",
        branch: "mork/test",
        repo: { full_name: "fixture/repo", default_branch: "main", base_sha: git("rev-parse", "HEAD") },
      });
      const hidden = scenario.hidden ? [{ file: "case.json", criteria: ["AC1"], content: "{}" }] : [];
      const criteria = [{ id: "AC1", text: "Behavior", testable: scenario.hidden }],
        sandbox = { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } };
      const before = await runGate(
        {
          mode: "before",
          repo: brief.repo,
          config: parseRepoConfig(text),
          hidden_tests: hidden,
          allow_test_change: false,
          localRepo: repo,
          contract: { criteria, inputs: [] },
        },
        "",
        join(dir, "before"),
        sandbox,
      );
      git("checkout", "-qb", "mork/test");
      writeFileSync(join(repo, "broken"), "");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "candidate");
      const store = new LocalStore(join(dir, "store"));
      await store.putJson(keys.plan(brief.prefix), {
        problem: "p",
        plan: ["p"],
        acceptance_criteria: criteria,
        hidden_tests: hidden.map(({ file, criteria }) => ({ file, criteria })),
        risks: [],
        security_sensitive: false,
        oracle_version: before.oracle_version,
      });
      await store.putJson(keys.hidden(brief.prefix), hidden);
      await store.putJson(keys.gateBefore(brief.prefix), before);
      await store.putJson(keys.buildResult(brief.prefix, 1), { ok: true, head_sha: git("rev-parse", "HEAD") });
      const result = await check({
        brief,
        step: DEFAULT_DEVELOPMENT.steps[2],
        store,
        localRepo: repo,
        githubToken: async () => "",
        model: "unused",
        panel: new DecisionPanel([]),
        superviseEveryMs: 300000,
        reporter: { report: async () => {} },
        secrets: () => [],
        logger: noLogger,
        env: { workDir: join(dir, "work"), agentHome: join(dir, "agent"), piBin: "/unused", extensionsDir: "/unused" },
        sandbox,
      });
      expect(result).toMatchObject({ ok: true, passed: false });
      expect(result.invalid_verification).toBe(scenario.setup ? true : undefined);
      const feedback = await store.text(keys.feedback(brief.prefix, 2));
      expect(feedback).toContain(scenario.setup ? "Setup failed" : "test");
      if (scenario.hidden) expect(feedback).toContain("Declared hidden verification did not complete: case.json");
    } finally {
      mustExec("chmod", ["-R", "u+rwX", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
