import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Brief, keys } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT } from "@mork/contracts/development";
import { DecisionPanel } from "@mork/decision";
import { noLogger } from "@mork/sources";
import { LocalStore } from "@mork/store/local";
import { mustExec } from "./git.ts";
import { check, type PhaseContext, plan } from "./phases.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    mustExec("chmod", ["-R", "u+rwX", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mork-plan-runtime-"));
  dirs.push(dir);
  const source = join(dir, "source");
  mkdirSync(join(source, ".mork"), { recursive: true });
  writeFileSync(join(source, "adapter.sh"), 'bash "$1"\n');
  writeFileSync(
    join(source, ".mork/config.toml"),
    'test="true"\n[hidden_tests]\ndir="hidden"\ncommand="bash adapter.sh {file}"\nfile_suffix=".sh"\nprotocol="mork-v1"\nruntime_paths=["adapter.sh"]\n',
  );
  const git = (...args: string[]) => mustExec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", source, ...args]).trim();
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const output = (testable: boolean, content: string) => ({
    problem: "p",
    plan: ["implement"],
    acceptance_criteria: [{ id: "AC1", text: "model reworded", testable }],
    hidden_tests: content ? [{ file: "behavior.sh", criteria: ["AC1"], content }] : [],
    risks: [],
    security_sensitive: false,
  });
  const outputs = [
    output(false, ""),
    output(
      true,
      `echo 'FIRST_CAUSE_HARNESS'; seq 1 3000; echo 'MORK_RESULT {"status":"execution_failure","reason":"missing environment","tests":{}}'; exit 3`,
    ),
    output(
      true,
      `echo 'MORK_RESULT {"status":"behavior_failure","reason":"rows differ","tests":{"readiness":{"ready":true},"cases":[{"id":"rows","criteria":["AC1"],"status":"behavior_failure"}]}}'; exit 1`,
    ),
  ];
  const pi = join(dir, "pi");
  writeFileSync(
    pi,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
const outputs=${JSON.stringify(outputs)};let n=0;fs.appendFileSync(${JSON.stringify(join(dir, "starts"))},'start\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line),send=v=>console.log(JSON.stringify(v));
 if(c.type==='prompt'){
  const d=c.message.match(/Full diagnostic: (\\S+)/);
  if(d){let value;try{value=JSON.parse(fs.readFileSync(d[1],'utf8')).output}catch{value='unreadable'}fs.writeFileSync(${JSON.stringify(join(dir, "seen-diagnostic"))},JSON.stringify({prompt:c.message,output:value}));}
  const dm=c.message.match(/Read (\\S+diagnostics\\/manifest-\\S+json)/);
  if(dm){const entries=JSON.parse(fs.readFileSync(dm[1],'utf8'));const outputs=entries.map(e=>JSON.parse(fs.readFileSync(e.artifact,'utf8')).output);fs.writeFileSync(${JSON.stringify(join(dir, "seen-rehydrated"))},JSON.stringify(outputs));}
  const m=c.message.match(/Read (\\S+manifest.json)/);
  if(m){const manifest=JSON.parse(fs.readFileSync(m[1],'utf8'));const answer=JSON.parse(fs.readFileSync(path.join(path.dirname(m[1]),manifest.files.find(f=>f.path.startsWith('answers/')).path),'utf8'));fs.writeFileSync(${JSON.stringify(join(dir, "seen-input"))},JSON.stringify({prompt:c.message,answer}));}
  fs.writeFileSync(process.env.MORK_OUTPUT,JSON.stringify(outputs[Math.min(n++,outputs.length-1)]));fs.writeFileSync(${JSON.stringify(join(dir, "prompts"))},String(n));
  send({type:'response',success:true,id:c.id});send({type:'turn_end'});send({type:'agent_settled'});
 }else send({type:'response',success:true,id:c.id,data:{}});
});
`,
  );
  chmodSync(pi, 0o755);
  const store = new LocalStore(join(dir, "store"));
  const brief = Brief.parse({
    attempt: 1,
    prefix: "tasks/fixture",
    repo: { full_name: "fixture/repo", default_branch: "main", base_sha: base },
    branch: "mork/test",
  });
  await store.putJson(keys.issue(brief.prefix), { ref: "PROJ-1", title: "Behavior", body: "AC1: Replay preserves all rows" });
  const answer = "synthetic schema\n".repeat(10000);
  await store.putJson(keys.answers(brief.prefix), [{ question: "schema?", answer }]);
  const ctx: PhaseContext = {
    brief,
    step: { ...DEFAULT_DEVELOPMENT.steps[0], attempts: 3 },
    store,
    localRepo: source,
    env: {
      piBin: pi,
      extensionsDir: resolve(import.meta.dir, "../extensions"),
      workDir: join(dir, "work"),
      agentHome: join(dir, "home"),
      llmBaseUrl: "http://localhost/v1",
      trustedLocal: { apiKey: "fixture" },
    },
    sandbox: { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } },
    githubToken: async () => "",
    model: "fixture",
    panel: new DecisionPanel([]),
    superviseEveryMs: 300000,
    reporter: { report: async () => undefined },
    secrets: () => [],
    logger: noLogger,
  };
  return { dir, ctx, store, answer, git, source, pi };
}

test("the real Plan repairs downgrade and invalid baseline in the same session, binds AC and hydrates full inputs", async () => {
  const f = await fixture();
  expect(await plan(f.ctx)).toMatchObject({ ok: true });
  expect(readFileSync(join(f.dir, "starts"), "utf8")).toBe("start\n");
  expect(readFileSync(join(f.dir, "prompts"), "utf8")).toBe("3");
  const saved = (await f.store.json(keys.plan(f.ctx.brief.prefix))) as { acceptance_criteria: unknown[]; oracle_version: string };
  expect(saved.acceptance_criteria).toEqual([{ id: "AC1", text: "Replay preserves all rows", testable: true }]);
  expect(saved.oracle_version).toMatch(/^[0-9a-f]{64}$/);
  const seen = JSON.parse(readFileSync(join(f.dir, "seen-input"), "utf8"));
  expect(seen.answer.answer).toBe(f.answer);
  expect(seen.prompt).toContain("manifest.json");
  expect(seen.prompt).not.toContain(f.answer);
  const diagnostic = JSON.parse(readFileSync(join(f.dir, "seen-diagnostic"), "utf8"));
  expect(diagnostic.output).toContain("FIRST_CAUSE_HARNESS");
  expect(diagnostic.prompt).not.toContain("FIRST_CAUSE_HARNESS");
});

test("a new station rehydrates stored diagnostics into local readable files", async () => {
  const f = await fixture();
  await plan(f.ctx);
  const directory = join(f.ctx.env.workDir, "diagnostics");
  if (existsSync(directory)) {
    mustExec("chmod", ["-R", "u+rwX", directory]);
    rmSync(directory, { recursive: true, force: true });
  }
  await plan(f.ctx);
  expect(readFileSync(join(f.dir, "seen-rehydrated"), "utf8")).toContain("FIRST_CAUSE_HARNESS");
});

test("candidate verification cannot reuse a baseline for changed hidden content", async () => {
  const f = await fixture();
  await plan(f.ctx);
  f.git("switch", "-qc", "mork/test");
  writeFileSync(join(f.source, "value"), "candidate");
  f.git("add", ".");
  f.git("commit", "-qm", "candidate");
  await f.store.putJson(keys.buildResult(f.ctx.brief.prefix, 1), { ok: true, head_sha: f.git("rev-parse", "HEAD") });
  const hidden = (await f.store.json(keys.hidden(f.ctx.brief.prefix))) as { content: string }[];
  const first = hidden[0];
  if (!first) throw new Error("Fixture must have a hidden test");
  first.content += "\n# changed oracle\n";
  await f.store.putJson(keys.hidden(f.ctx.brief.prefix), hidden);
  const result = await check({ ...f.ctx, step: DEFAULT_DEVELOPMENT.steps[2] });
  expect(result).toMatchObject({ passed: false, invalid_verification: true });
  expect(await f.store.text(keys.feedback(f.ctx.brief.prefix, 2))).toContain("identity changed");
});

test("changing an accepted oracle requires independent review and invalidates old baseline", async () => {
  const f = await fixture();
  await plan(f.ctx);
  const original = (await f.store.json(keys.plan(f.ctx.brief.prefix))) as { oracle_version: string };
  writeFileSync(f.pi, readFileSync(f.pi, "utf8").replace("rows differ", "changed expectation"));
  await expect(plan(f.ctx)).rejects.toThrow("Independent review");
  const baseline = (await f.store.json(keys.gateBefore(f.ctx.brief.prefix))) as { oracle_version: string };
  expect(baseline.oracle_version).not.toBe(original.oracle_version);
  expect(await f.store.json(keys.plan(f.ctx.brief.prefix))).toMatchObject(original);
});
