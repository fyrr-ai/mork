import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("applying rulesets twice updates the same complete branch and tag restrictions", () => {
  const root = mkdtempSync(join(tmpdir(), "mork-rulesets-"));
  roots.push(root);
  const state = join(root, "state.json");
  writeFileSync(state, "[]");
  writeFileSync(
    join(root, "gh"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const file = process.env.RULESET_STATE;
const state = JSON.parse(await Bun.file(file).text());
const method = args[args.indexOf('-X') + 1];
if (!args.includes('-X')) {
  console.log(JSON.stringify(state));
} else {
  const input = JSON.parse(await Bun.file(args[args.indexOf('--input') + 1]).text());
  if (method === 'POST') state.push({...input, id: state.length + 1});
  else {
    const path = args.find(a => a.startsWith('repos/'));
    const id = Number(path.split('/').at(-1));
    const index = state.findIndex(row => row.id === id);
    if (index < 0) process.exit(44);
    state[index] = {...input, id};
  }
  await Bun.write(file, JSON.stringify(state));
}
`,
    { mode: 0o755 },
  );
  for (let n = 0; n < 2; n++) {
    const result = spawnSync("bash", [resolve("scripts/rulesets.sh"), "acme/widgets"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RULESET_STATE: state },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(n === 0 ? "created ruleset" : "updated ruleset");
  }
  const rulesets = JSON.parse(readFileSync(state, "utf8")) as {
    name: string;
    target: string;
    rules: { type: string }[];
    bypass_actors?: { actor_id: number; bypass_mode: string }[];
    conditions: { ref_name: { include: string[]; exclude: string[] } };
  }[];
  expect(rulesets).toHaveLength(3);
  for (const name of ["mork: agent branches only", "mork: protect tags"]) {
    const ruleset = rulesets.find((r) => r.name === name);
    expect(ruleset?.rules.map((r) => r.type)).toEqual(["creation", "update", "deletion"]);
    expect(ruleset?.bypass_actors?.map((a) => a.actor_id)).toEqual([2, 5]);
  }
  expect(rulesets.find((r) => r.target === "tag")?.conditions.ref_name).toEqual({ include: ["~ALL"], exclude: [] });
  expect(rulesets.find((r) => r.name === "mork: agent branches only")?.conditions.ref_name.exclude).toEqual([
    "refs/heads/mork/**",
    "~DEFAULT_BRANCH",
  ]);
});
