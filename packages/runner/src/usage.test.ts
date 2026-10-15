import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionPanel } from "@mork/decision";
import { runLlmStation } from "./llm.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each([false, true])("resumed session usage is an increment, with missing baseline=%s", async (missing) => {
  const dir = mkdtempSync(join(tmpdir(), "mork-usage-"));
  directories.push(dir);
  const pi = join(dir, "pi");
  writeFileSync(
    pi,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const {writeFileSync}=require('node:fs');
let prompted=false;
createInterface({input:process.stdin}).on('line',line=>{
 const command=JSON.parse(line);
 const send=value=>console.log(JSON.stringify(value));
 if(command.type==='get_session_stats')send({type:'response',success:true,id:command.id,data:!prompted&&process.env.MISSING_BASELINE==='true'?{}:{tokens:{total:prompted?160:100},cost:prompted?1.6:1}});
 else if(command.type==='prompt'){
  prompted=true;writeFileSync(process.env.MORK_OUTPUT,'{}');
  send({type:'response',success:true,id:command.id});send({type:'turn_end'});send({type:'agent_settled'});
 }else send({type:'response',success:true,id:command.id});
});
`,
  );
  chmodSync(pi, 0o755);
  const result = await runLlmStation(
    {
      station: "agent",
      parseOutput: (v) => v,
      instructions: "Test",
      message: "Continue",
      output_schema: {},
      model: "test",
      resumed: true,
      environment: { MISSING_BASELINE: String(missing) },
      supervise: { panel: new DecisionPanel([]), everyMs: 300000, task: {} },
    },
    {
      piBin: pi,
      extensionsDir: dir,
      workDir: dir,
      agentHome: join(dir, "agent"),
      llmBaseUrl: "http://localhost/v1",
      trustedLocal: { apiKey: "local" },
    },
    dir,
  );
  expect(result.ok).toBe(true);
  expect(result.stats?.turns).toBe(1);
  if (missing) {
    expect(result.stats?.tokens).toBeUndefined();
    expect(result.stats?.cost).toBeUndefined();
  } else {
    expect(result.stats?.tokens).toBe(60);
    expect(result.stats?.cost).toBeCloseTo(0.6);
  }
});
