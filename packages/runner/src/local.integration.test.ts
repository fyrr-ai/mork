// Opt-in proof using the real Pi executable and a local OpenAI-compatible
// streaming server. No phase or LLM runner is mocked, and no paid API is called.

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT } from "@mork/contracts/development";
import { LocalStore } from "@mork/store/local";
import { execAsync, mustExec, SAFE_GIT } from "./git.ts";

const pi = process.env.MORK_LOCAL_E2E_PI;
const integration = pi && process.getuid?.() !== 0 ? test : test.skip;
type Message = { role: string; content?: unknown };

function completion(model: string, tool?: { name: string; arguments: unknown }): Response {
  const base = { id: "chatcmpl-local-fixture", object: "chat.completion.chunk", created: 1, model };
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }],
      }
    : { role: "assistant", content: "Finished." };
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

integration(
  "real Pi resumes after SIGTERM, plans hidden tests, pushes two Build attempts and passes Check without AWS",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "mork-local-workflow-"));
    const source = join(directory, "source");
    mkdirSync(source);
    const git = (...args: string[]) =>
      mustExec("git", [...SAFE_GIT, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, ...args]).trim();
    git("init", "-q");
    mkdirSync(join(source, ".mork"));
    mkdirSync(join(source, "test"));
    writeFileSync(join(source, "math.mjs"), "export const add = (a, b) => a - b;\n");
    writeFileSync(join(source, ".gitignore"), ".fixture-ready\n");
    writeFileSync(
      join(source, "test", "smoke.test.mjs"),
      "import assert from 'node:assert/strict'; import {add} from '../math.mjs'; assert.equal(typeof add, 'function');\n",
    );
    writeFileSync(
      join(source, ".mork", "config.toml"),
      `setup = "touch .fixture-ready"\ntest = "test -f .fixture-ready && node --test test/smoke.test.mjs"\nchecks = ["node --check math.mjs"]\n[hidden_tests]\ndir = "hidden"\ncommand = "node --test {file}"\nfile_suffix = ".test.mjs"\n`,
    );
    git("add", ".");
    git("commit", "-qm", "base");
    const original = git("rev-parse", "HEAD");
    const issueFile = join(directory, "issue.json");
    writeFileSync(issueFile, JSON.stringify({ ref: "LOCAL-1", title: "Fix addition", body: "add must return the sum of its two inputs." }));
    const definitionFile = join(directory, "development.json");
    const definition = structuredClone(DEFAULT_DEVELOPMENT);
    definition.steps[1].attempts = 2;
    for (const step of definition.steps) {
      step.instructions += `\nCONFIGURED_${step.kind.toUpperCase()}_PROMPT`;
      step.model = `fixture-${step.kind}`;
      step.tools = ["read", "bash"];
    }
    writeFileSync(definitionFile, JSON.stringify(definition));
    const seen: Array<{ station: string; model: string; messages: Message[] }> = [];
    let firstRequest = true;
    let modelStarted: () => void = () => {};
    const modelPending = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== "Bearer local-fixture-key") return new Response("Wrong fixture key", { status: 401 });
        const body = (await request.json()) as { model: string; messages: Message[] };
        if (firstRequest) {
          firstRequest = false;
          modelStarted();
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
        }
        const system = JSON.stringify(body.messages.filter((message) => message.role === "system"));
        const station = system.includes("You are the analyst") ? "analyst" : system.includes("You are the implementer") ? "implementer" : "reviewer";
        seen.push({ station, model: body.model, messages: body.messages });
        const turns = body.messages.filter((message) => message.role === "tool").length;
        const users = JSON.stringify(body.messages.filter((message) => message.role === "user"));
        if (station === "analyst") {
          if (turns === 0) return completion(body.model, { name: "bash", arguments: { command: "cat math.mjs" } });
          if (turns === 1)
            return completion(body.model, {
              name: "submit_result",
              arguments: {
                json: JSON.stringify({
                  problem: "Addition subtracts",
                  plan: ["Correct the add implementation"],
                  acceptance_criteria: [{ id: "AC1", text: "add(2,3) returns 5", testable: true }],
                  hidden_tests: [
                    {
                      file: "addition.test.mjs",
                      criteria: ["AC1"],
                      content:
                        "import assert from 'node:assert/strict'; import {add} from '../math.mjs'; assert.equal(add(2,3),5); // HIDDEN_FIXTURE_ASSERTION\n",
                    },
                  ],
                  risks: [],
                  security_sensitive: false,
                }),
              },
            });
        } else if (station === "implementer") {
          if (turns === 0) {
            const retry = users.includes("Your previous attempt did not pass the gate");
            const code = retry ? "export const add = (a, b) => a + b;" : "export const add = (a, b) => a + b + 1;";
            return completion(body.model, {
              name: "bash",
              arguments: {
                command: `printf '%s\\n' '${code}' > math.mjs`,
              },
            });
          }
          if (turns === 1) return completion(body.model, { name: "verify", arguments: {} });
          if (turns === 2) {
            const branch = /Your branch: `([^`]+)`/.exec(users)?.[1];
            if (!branch) return new Response("Missing work branch", { status: 400 });
            return completion(body.model, {
              name: "bash",
              arguments: { command: `git add math.mjs && git commit -m 'fixture implementation' && git push origin ${branch}` },
            });
          }
          if (turns === 3)
            return completion(body.model, {
              name: "submit_result",
              arguments: {
                json: JSON.stringify({
                  summary: "Corrected addition",
                  changes: [{ path: "math.mjs", change: "Use addition" }],
                  verification: [{ command: "node --check math.mjs", result: "Passed" }],
                  deviations: [],
                }),
              },
            });
        } else {
          if (turns === 0) return completion(body.model, { name: "bash", arguments: { command: `git diff ${original}...HEAD` } });
          if (turns === 1)
            return completion(body.model, {
              name: "submit_result",
              arguments: { json: JSON.stringify({ summary: "Addition is corrected", criteria: [], findings: [], read_first: ["math.mjs:1"] }) },
            });
        }
        return completion(body.model);
      },
    });
    try {
      const task = join(directory, "task");
      const cli = process.env.MORK_LOCAL_E2E_CLI ?? join(import.meta.dir, "local-cli.ts");
      const connection = ["--trusted", "--model", "fixture", "--llm-url", `http://127.0.0.1:${server.port}/v1`, "--pi", pi as string];
      const runtime = process.env.MORK_LOCAL_E2E_RUNTIME ?? process.execPath;
      const interrupted = spawn(
        runtime,
        [cli, ...connection, "--repo", source, "--issue", issueFile, "--output", task, "--definition", definitionFile],
        {
          env: { ...process.env, MORK_LOCAL_API_KEY: "local-fixture-key", AWS_EC2_METADATA_DISABLED: "true" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let interruptedLog = "";
      interrupted.stdout.on("data", (chunk) => {
        interruptedLog += chunk;
      });
      interrupted.stderr.on("data", (chunk) => {
        interruptedLog += chunk;
      });
      const stopped = new Promise<number | null>((resolve) => interrupted.once("close", resolve));
      const deadline = setTimeout(() => interrupted.kill("SIGKILL"), 15000);
      try {
        await Promise.race([
          modelPending,
          stopped.then(() => {
            throw new Error(interruptedLog || "Runner exited before model request");
          }),
        ]);
        interrupted.kill("SIGTERM");
        expect(await stopped, interruptedLog).toBe(143);
        expect(existsSync(join(task, ".run.lock"))).toBe(false);
        expect(existsSync(join(task, "agent", ".pi-mork", "models.json"))).toBe(false);
      } finally {
        clearTimeout(deadline);
        interrupted.kill("SIGKILL");
      }
      const started = await execAsync(runtime, [cli, ...connection, "--resume", task], {
        env: { ...process.env, MORK_LOCAL_API_KEY: "local-fixture-key", AWS_EC2_METADATA_DISABLED: "true" },
        timeoutMs: 90_000,
      });
      expect(started.code, started.output).toBe(0);
      const store = new LocalStore(join(task, "outputs"));
      const state = (await store.json("local-run.json")) as { result: { ok: boolean; attempt: number; head_sha: string; branch: string } };
      expect(state.result).toMatchObject({ ok: true, attempt: 2 });
      expect(await store.json(keys.gateBefore("tasks/local"))).toMatchObject({ hidden: [{ passed: false }] });
      expect(await store.json(keys.gate("tasks/local", 1))).toMatchObject({ hidden: [{ passed: false }] });
      expect(await store.json(keys.gate("tasks/local", 2))).toMatchObject({ head_sha: state.result.head_sha, hidden: [{ passed: true }] });
      expect(await store.json(keys.review("tasks/local", 2))).toMatchObject({ summary: "Addition is corrected", findings: [] });
      expect(mustExec("git", [...SAFE_GIT, "--git-dir", join(task, "remote.git"), "rev-parse", state.result.branch]).trim()).toBe(
        state.result.head_sha,
      );
      expect(seen.some((request) => request.station === "analyst")).toBe(true);
      for (const [station, kind] of [
        ["analyst", "plan"],
        ["implementer", "build"],
        ["reviewer", "check"],
      ]) {
        const requests = seen.filter((request) => request.station === station);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.model === `fixture-${kind}`)).toBe(true);
        expect(requests.every((request) => JSON.stringify(request.messages).includes(`CONFIGURED_${kind?.toUpperCase()}_PROMPT`))).toBe(true);
      }
      expect(((await store.json("local-run.json")) as { brief: { last_attempt: number } }).brief.last_attempt).toBe(2);
      expect(seen.some((request) => request.station === "reviewer")).toBe(true);
      expect(JSON.stringify(seen.filter((request) => request.station === "implementer"))).not.toContain("HIDDEN_FIXTURE_ASSERTION");
      expect(JSON.stringify(seen.filter((request) => request.station === "implementer"))).toContain("verify: PASSED");
      expect(JSON.stringify(seen.filter((request) => request.station === "implementer"))).not.toContain("verify: FAILED");
      expect(git("rev-parse", "HEAD")).toBe(original);
      expect(git("status", "--porcelain")).toBe("");
      const session = await store.text(`${keys.session("tasks/local", "build-2-implementer")}.jsonl`);
      expect(session).toContain("submit_result");
      expect(session).not.toContain("local-fixture-key");
      expect(existsSync(join(task, "agent", ".pi-mork", "models.json"))).toBe(false);
      const calls = seen.length;
      // Resume uses the saved definition even after the input file is changed.
      definition.steps[1].attempts = 1;
      writeFileSync(definitionFile, JSON.stringify(definition));
      const resumed = await execAsync(runtime, [cli, ...connection, "--resume", task], { timeoutMs: 10_000 });
      expect(resumed.code, resumed.output).toBe(0);
      expect(seen.length).toBe(calls);
      expect(readFileSync(join(source, "math.mjs"), "utf8")).toContain("a - b");
    } finally {
      server.stop(true);
      mustExec("chmod", ["-R", "u+rwX", directory]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
