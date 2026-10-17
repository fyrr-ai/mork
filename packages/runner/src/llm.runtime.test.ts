import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DecisionPanel } from "@mork/decision";
import { mustExec } from "./git.ts";
import { type LlmJob, runLlmStation } from "./llm.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Pi is the external process edge. The real RPC client, station, verify CLI and git all run. */
function fixture(outputs: unknown[] = [{ summary: "done", changes: [], verification: [], deviations: [] }]) {
  const dir = mkdtempSync(join(tmpdir(), "mork-station-runtime-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => mustExec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args]).trim();
  git("init", "-q");
  writeFileSync(join(repo, "value"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "mork/test");
  writeFileSync(join(repo, "value"), "candidate");
  git("commit", "-qam", "candidate");
  const remote = join(dir, "remote.git");
  mustExec("git", ["init", "--bare", "-q", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "mork/test");
  const remoteHead = () => mustExec("git", ["--git-dir", remote, "rev-parse", "refs/heads/mork/test"]).trim();
  const pi = join(dir, "pi");
  writeFileSync(
    pi,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const {writeFileSync,existsSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const outputs=${JSON.stringify(outputs)};let prompts=0;
if(process.env.PROBE_READY){const r=spawnSync('repo-tool-probe',[],{encoding:'utf8'});writeFileSync(process.env.PROBE_READY,String(r.status));}
createInterface({input:process.stdin}).on('line',async line=>{
 const c=JSON.parse(line); const send=v=>console.log(JSON.stringify(v));
 if(c.type==='prompt'){
  if(process.env.WAIT_FOR_PUBLICATION){
   const file=process.env.WAIT_FOR_PUBLICATION;let i=0;while(!existsSync(file)&&i++<200)await new Promise(r=>setTimeout(r,10));
   if(existsSync(file)){const p=JSON.parse(require('node:fs').readFileSync(file,'utf8'));writeFileSync(${JSON.stringify(join(dir, "published"))},JSON.stringify({publication:p,output:require('node:fs').readFileSync(p.artifact,'utf8')}));}
  }
  writeFileSync(process.env.MORK_OUTPUT,JSON.stringify(outputs[Math.min(prompts++,outputs.length-1)]));
  writeFileSync(${JSON.stringify(join(dir, "prompts"))},String(prompts));
  send({type:'response',success:true,id:c.id});send({type:'turn_end'});send({type:'agent_settled'});
 }else send({type:'response',success:true,id:c.id,data:{}});
});
`,
  );
  chmodSync(pi, 0o755);
  const env = {
    piBin: pi,
    extensionsDir: resolve(import.meta.dir, "../extensions"),
    workDir: dir,
    agentHome: join(dir, "home"),
    llmBaseUrl: "http://localhost/v1",
    trustedLocal: { apiKey: "fixture" },
  } as const;
  const spec: LlmJob = {
    station: "implementer",
    repo: { full_name: "fixture/repo", default_branch: "main", base_sha: base },
    instructions: "test",
    message: "test",
    output_schema: {},
    model: "fixture",
    supervise: { panel: new DecisionPanel([]), everyMs: 300000, task: {} },
    push: { branch: "mork/test", remoteHead: async () => remoteHead() },
    verify: {
      repo: { full_name: "fixture/repo", default_branch: "main", base_sha: base },
      config: { test: "true", checks: [], test_paths: [], protected_paths: [] },
      setupMarker: join(dir, "setup.done"),
    },
  };
  return { dir, repo, git, env, spec, remoteHead };
}

test("failed verify on the final correction never reports successful Build", async () => {
  const f = fixture();
  if (!f.spec.verify) throw new Error("Fixture must configure verify");
  f.spec.verify.config.test = "echo 'real test failed'; exit 1";
  const result = await runLlmStation(f.spec, f.env, f.repo);
  expect(readFileSync(join(f.dir, "prompts"), "utf8")).toBe("3");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("verify");
});

test("semantic output repair uses the same running Pi process", async () => {
  const f = fixture([{ value: "invalid" }, { value: "covered" }]);
  const seen: string[] = [];
  const spec: LlmJob = {
    ...f.spec,
    station: "agent",
    repo: undefined,
    push: undefined,
    verify: undefined,
    parseOutput: (v) => v,
    validateOutput: async (v) => {
      const value = (v as { value: string }).value;
      seen.push(value);
      return value === "covered" ? undefined : "AC1 has no executable check";
    },
  };
  const result = await runLlmStation(spec, f.env, f.repo);
  expect(result.ok).toBe(true);
  expect(result.output).toEqual({ value: "covered" });
  expect(seen).toEqual(["invalid", "covered"]);
});

test.each([0, 1])("configured correction budget %i limits total submissions", async (maxCorrections) => {
  const f = fixture([{ value: "invalid" }, { value: "covered" }]);
  const result = await runLlmStation(
    {
      ...f.spec,
      station: "agent",
      repo: undefined,
      push: undefined,
      verify: undefined,
      parseOutput: (value) => value,
      maxCorrections,
      validateOutput: async (value) => ((value as { value: string }).value === "covered" ? undefined : "Missing runtime coverage"),
    },
    f.env,
    f.repo,
  );
  expect(result.ok).toBe(maxCorrections === 1);
  expect(readFileSync(join(f.dir, "prompts"), "utf8")).toBe(String(maxCorrections + 1));
});

test.each([false, true])("readiness runs before Pi with stable home-local PATH, resumed=%s", async (resumed) => {
  const f = fixture();
  const probe = join(f.dir, "probe");
  f.spec.resumed = resumed;
  f.spec.environment = { PROBE_READY: probe };
  f.spec.readiness = {
    command:
      'mkdir -p "$HOME/.local/bin"; printf \'#!/bin/sh\\nexit 0\\n\' > "$HOME/.local/bin/repo-tool-probe"; chmod +x "$HOME/.local/bin/repo-tool-probe"',
  };
  const result = await runLlmStation(f.spec, f.env, f.repo);
  expect(result.ok).toBe(true);
  expect(readFileSync(probe, "utf8")).toBe("0");
});

test("a scratch file created by verify cannot become a successful WIP delivery", async () => {
  const f = fixture();
  if (!f.spec.verify) throw new Error("Fixture must configure verify");
  f.spec.verify.config.test = "echo diagnostic > scratch.log";
  const result = await runLlmStation(f.spec, f.env, f.repo);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("uncommitted");
  expect(f.git("log", "-1", "--format=%s")).toBe("mork: work in progress");
  expect(f.remoteHead()).toBe(f.git("rev-parse", "HEAD"));
});

test("successful finalization returns the verified pushed SHA and creates no rescue commit", async () => {
  const f = fixture();
  const head = f.remoteHead();
  const result = await runLlmStation(f.spec, f.env, f.repo);
  expect(result).toMatchObject({ ok: true, headSha: head });
  expect(f.remoteHead()).toBe(head);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(f.git("status", "--porcelain")).toBe("");
});

test("a remote change after verify prevents successful finalization", async () => {
  const f = fixture();
  let calls = 0;
  f.spec.push = { branch: "mork/test", remoteHead: async () => (++calls === 1 ? f.git("rev-parse", "HEAD") : "f".repeat(40)) };
  const result = await runLlmStation(f.spec, f.env, f.repo);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("origin");
});

test("failed readiness stops before starting Pi", async () => {
  const f = fixture();
  f.spec.readiness = { command: "echo 'missing dependency'; exit 3" };
  const result = await runLlmStation(f.spec, f.env, f.repo);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("missing dependency");
  expect(existsSync(join(f.dir, "prompts"))).toBe(false);
});

test("root publishes full redacted verify diagnostics before the next model response", async () => {
  const f = fixture();
  const logdir = join(f.env.agentHome, "out/verify");
  f.spec.environment = { WAIT_FOR_PUBLICATION: join(logdir, "fixture.published.json") };
  f.spec.readiness = {
    command: `mkdir -p '${logdir}'; printf 'FIRST_CAUSE secret-fixture\\n' > '${logdir}/fixture.log'; printf '%s' '{"command_id":"fixture","command":"fixture verify","exit_code":1,"head_sha":"${f.git("rev-parse", "HEAD")}"}' > '${logdir}/fixture.json'`,
  };
  f.spec.secrets = () => ["secret-fixture"];
  const saved: { command: string; output: string }[] = [];
  f.spec.saveDiagnostic = async (record) => {
    saved.push(record);
    return `stored/${record.command_id}`;
  };
  expect((await runLlmStation(f.spec, f.env, f.repo)).ok).toBe(true);
  const published = JSON.parse(readFileSync(join(f.dir, "published"), "utf8"));
  expect(published.publication.artifact).toContain("/diagnostics/");
  expect(published.output).toContain("FIRST_CAUSE [redacted]");
  expect(saved.some((record) => record.command === "fixture verify" && record.output.includes("FIRST_CAUSE [redacted]"))).toBe(true);
  expect(JSON.stringify(saved)).not.toContain("secret-fixture");
});

test("diagnostics resolve SHA when Git distrusts the worker-owned checkout", async () => {
  const f = fixture();
  const head = f.git("rev-parse", "HEAD");
  const previous = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  const saved: string[] = [];
  try {
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    const result = await runLlmStation(
      {
        ...f.spec,
        station: "agent",
        push: undefined,
        verify: undefined,
        parseOutput: (value) => value,
        readiness: { command: "true" },
        saveDiagnostic: async (record) => {
          expect(record.head_sha).toBe(head);
          saved.push(record.head_sha);
          return "saved";
        },
      },
      f.env,
      f.repo,
    );
    expect(result.ok).toBe(true);
    expect(saved).toEqual([head]);
  } finally {
    if (previous === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previous;
  }
});

test("diagnostics reject a failed Git command instead of saving its stderr as SHA", async () => {
  const f = fixture();
  let saved = false;
  await expect(
    runLlmStation(
      {
        ...f.spec,
        station: "agent",
        push: undefined,
        verify: undefined,
        readiness: { command: "rm -rf .git" },
        saveDiagnostic: async () => {
          saved = true;
          return "saved";
        },
      },
      f.env,
      f.repo,
    ),
  ).rejects.toThrow("rev-parse");
  expect(saved).toBe(false);
});
