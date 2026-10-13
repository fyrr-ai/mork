// Trusted local Plan/Build/Check. The real phases use a private filesystem
// store and a task-owned bare Git remote, with no AWS or GitHub API calls.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Brief, BuildResult, IssueDoc, keys, lastAttempt, parseRepoConfig } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT, DevelopmentWorkflow } from "@mork/contracts/development";
import { DecisionPanel } from "@mork/decision";
import { LocalStore } from "@mork/store/local";
import { z } from "zod";
import { exec, mustExec, remoteHead, SAFE_GIT } from "./git.ts";
import { withLocalRun } from "./local-run.ts";
import { noLogger } from "./otlp.ts";
import { build, check, type PhaseContext, plan } from "./phases.ts";

const Result = z.object({
  ok: z.boolean(),
  branch: z.string(),
  attempt: z.number().int().positive(),
  head_sha: z.string().optional(),
  error: z.string().optional(),
});
export type LocalResult = z.infer<typeof Result>;
const Manifest = z.object({
  brief: Brief,
  definition: DevelopmentWorkflow.default(DEFAULT_DEVELOPMENT),
  next: z.enum(["plan", "build", "check", "done"]),
  result: Result.optional(),
});
const MANIFEST_KEY = "local-run.json";

export type LocalOptions = {
  directory: string;
  definition?: unknown;
  model: string;
  llmBaseUrl: string;
  apiKey: string;
  piBin: string;
} & ({ resume: true; source?: never; issue?: never; base?: never } | { resume?: false; source: string; issue: IssueDoc; base?: string });

export async function runLocalWorkflow(options: LocalOptions): Promise<LocalResult> {
  if (process.platform !== "linux") throw new Error("Local workflows need Linux; use a Linux container on other systems");
  if (process.getuid?.() === 0) throw new Error("Trusted local workflows must run as a non-root user");
  const directory = resolve(options.directory);
  if (!options.resume) mkdirSync(directory, { mode: 0o700 });
  return withLocalRun(directory, async (signal) => {
    const store = new LocalStore(join(directory, "outputs"));
    const remote = join(directory, "remote.git");
    let manifest: z.infer<typeof Manifest>;
    if (options.resume) {
      manifest = Manifest.parse(await store.json(MANIFEST_KEY));
    } else {
      const source = resolve(options.source);
      const base = mustExec("git", [
        ...SAFE_GIT,
        "-C",
        source,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${options.base ?? "HEAD"}^{commit}`,
      ]).trim();
      parseRepoConfig(mustExec("git", [...SAFE_GIT, "-C", source, "show", `${base}:.mork/config.toml`]));
      mustExec("git", ["init", "--bare", "-q", remote]);
      mustExec("git", [...SAFE_GIT, "-C", remote, "fetch", "-q", "--", source, `${base}:refs/heads/base`]);
      // The task's bare remote never inherits the source repository's remotes.
      const defaultBranch = exec("git", [...SAFE_GIT, "-C", source, "symbolic-ref", "--short", "HEAD"]).output.trim();
      const definition = DevelopmentWorkflow.parse(options.definition ?? DEFAULT_DEVELOPMENT);
      const brief = Brief.parse({
        last_attempt: definition.steps[1].attempts,
        attempt: 1,
        prefix: "tasks/local",
        repo: { full_name: "local/repository", default_branch: defaultBranch || "main", base_sha: base },
        branch: `mork/local-${randomUUID().slice(0, 8)}`,
      });
      manifest = { brief, definition, next: "plan" };
      await store.putJson(keys.issue(brief.prefix), IssueDoc.parse(options.issue));
      await store.putJson(MANIFEST_KEY, manifest);
    }
    if (manifest.next === "done") {
      if (!manifest.result) throw new Error("Completed local run has no result");
      return manifest.result;
    }
    const workDir = join(directory, "work");
    const agentHome = join(directory, "agent");
    mkdirSync(workDir, { mode: 0o700, recursive: true });
    mkdirSync(agentHome, { mode: 0o700, recursive: true });
    const ctx: PhaseContext = {
      brief: manifest.brief,
      step: manifest.definition.steps[0],
      store,
      localRepo: remote,
      githubToken: async () => "",
      model: options.model,
      panel: new DecisionPanel([]),
      superviseEveryMs: 45_000,
      reporter: {
        report: async (event) => {
          console.error(JSON.stringify(event));
        },
      },
      secrets: () => [options.apiKey],
      logger: noLogger,
      env: {
        llmBaseUrl: options.llmBaseUrl,
        trustedLocal: { apiKey: options.apiKey },
        piBin: options.piBin,
        extensionsDir: fileURLToPath(new URL("../extensions", import.meta.url)),
        workDir,
        agentHome,
      },
      sandbox: { env: { HOME: workDir, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", CI: "1" } },
    };
    const save = async (next: z.infer<typeof Manifest>["next"], result?: LocalResult) => {
      manifest = { brief: ctx.brief, definition: manifest.definition, next, ...(result ? { result } : {}) };
      await store.putJson(MANIFEST_KEY, manifest);
    };
    if (manifest.next === "plan") {
      ctx.step = manifest.definition.steps[0];
      signal.throwIfAborted();
      const planned = await plan(ctx);
      signal.throwIfAborted();
      if (!planned.ok || planned.question) throw new Error(planned.error ?? "Local Plan did not finish");
      await save("build");
    }
    while (ctx.brief.attempt <= lastAttempt(ctx.brief)) {
      signal.throwIfAborted();
      if (manifest.next === "build") {
        // A crash after Build wrote its result must not run that completed station twice.
        const built = BuildResult.safeParse(await store.json(keys.buildResult(ctx.brief.prefix, ctx.brief.attempt)).catch(() => undefined));
        ctx.step = manifest.definition.steps[1];
        if (!built.success || !built.data.ok) await build(ctx);
        await save("check");
      }
      ctx.step = manifest.definition.steps[2];
      signal.throwIfAborted();
      const checked = await check(ctx);
      signal.throwIfAborted();
      if (checked.ok && checked.passed) {
        const head = remoteHead(ctx.brief.repo.full_name, "", ctx.brief.branch, remote);
        const result: LocalResult = { ok: true, branch: ctx.brief.branch, attempt: ctx.brief.attempt, head_sha: head };
        await save("done", result);
        return result;
      }
      if (ctx.brief.attempt === lastAttempt(ctx.brief)) break;
      ctx.brief = { ...ctx.brief, attempt: ctx.brief.attempt + 1 };
      await save("build");
    }
    const result: LocalResult = {
      ok: false,
      branch: ctx.brief.branch,
      attempt: ctx.brief.attempt,
      error: "Build attempts exhausted; inspect outputs for feedback",
    };
    await save("done", result);
    return result;
  });
}
