// Opt-in proof using the real Pi executable and a local OpenAI-compatible
// streaming server. No phase or LLM runner is mocked, and no paid API is called.

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brief, keys } from "@mork/contracts";
import { DEFAULT_DEVELOPMENT } from "@mork/contracts/development";
import { DecisionPanel } from "@mork/decision";
import { noLogger } from "@mork/sources";
import { LocalStore } from "@mork/store/local";
import { execAsync, mustExec, SAFE_GIT } from "./git.ts";
import { type PhaseContext, plan } from "./phases.ts";

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
  "real Pi produces a documentation plan on its first attempt without installing repository tools",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "mork-doc-plan-"));
    const source = join(directory, "source");
    mkdirSync(join(source, ".mork"), { recursive: true });
    const git = (...args: string[]) =>
      mustExec("git", [...SAFE_GIT, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, ...args]).trim();
    git("init", "-q");
    writeFileSync(join(source, "README.md"), "# Project\n");
    writeFileSync(
      join(source, ".mork", "config.toml"),
      'setup = "exit 42"\ntest = "true"\n[hidden_tests]\ndir = "hidden"\ncommand = "node {file}"\nfile_suffix = ".mjs"\n',
    );
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const output = {
      problem: "Document the Slack channel",
      plan: ["Add the channel to README.md"],
      acceptance_criteria: [{ id: "AC1", text: "README names the channel", testable: false }],
      hidden_tests: [],
      risks: [],
      security_sensitive: false,
    };
    let submissions = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string; messages: Message[] };
        if (body.messages.some((m) => m.role === "tool")) return completion(body.model);
        submissions++;
        return completion(body.model, { name: "submit_result", arguments: { json: JSON.stringify(output) } });
      },
    });
    try {
      const store = new LocalStore(join(directory, "outputs"));
      const brief = Brief.parse({
        attempt: 1,
        prefix: "tasks/docs",
        repo: { full_name: "fixture/docs", default_branch: "main", base_sha: base },
        branch: "mork/docs",
      });
      await store.putJson(keys.issue(brief.prefix), { ref: "DOC-1", title: "Document the channel", body: "Add the Slack channel to README.md" });
      const ctx: PhaseContext = {
        brief,
        step: DEFAULT_DEVELOPMENT.steps[0],
        store,
        localRepo: source,
        env: {
          llmBaseUrl: `http://127.0.0.1:${server.port}/v1`,
          trustedLocal: { apiKey: "local-fixture-key" },
          piBin: pi as string,
          extensionsDir: "/opt/mork/packages/runner/extensions",
          workDir: join(directory, "work"),
          agentHome: join(directory, "home"),
        },
        sandbox: { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, CI: "1" } },
        githubToken: async () => "fixture",
        model: "fixture",
        panel: new DecisionPanel([]),
        superviseEveryMs: 300000,
        reporter: { report: async () => undefined },
        secrets: () => [],
        logger: noLogger,
      };
      expect(await plan(ctx)).toMatchObject({ ok: true });
      expect(submissions).toBe(1);
      expect(await store.json(keys.hidden(brief.prefix))).toEqual([]);
      expect(await store.json(keys.plan(brief.prefix))).toMatchObject(output);
      expect(await store.json(keys.gateBefore(brief.prefix))).toEqual({ mode: "before", hidden: [] });
    } finally {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);

integration(
  "real Pi resumes after SIGTERM, plans hidden tests, retries a red gate, repairs an OCR finding after verification and passes Check without AWS",
  async () => {
    const ocrCompletion = (model: string, name: string, args: unknown) =>
      new Response(
        JSON.stringify({
          id: "ocr-fixture",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "ocr-call", type: "function", function: { name, arguments: JSON.stringify(args) } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const directory = mkdtempSync(join(tmpdir(), "mork-local-workflow-"));
    const source = join(directory, "source");
    mkdirSync(source);
    const git = (...args: string[]) =>
      mustExec("git", [...SAFE_GIT, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, ...args]).trim();
    git("init", "-q");
    mkdirSync(join(source, ".mork"));
    mkdirSync(join(source, "test"));
    writeFileSync(join(source, "math.mjs"), "export const add = (a, b) => a - b;\n");
    writeFileSync(join(source, "README.md"), "add returns a numeric sum, including numeric strings.\n");
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
    writeFileSync(
      issueFile,
      JSON.stringify({
        ref: "LOCAL-1",
        title: "Fix addition",
        body: "add must return the numeric sum of its two inputs, including numeric strings.",
      }),
    );
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
    let firstVerification = true;
    let verificationStarted: () => void = () => {};
    const verificationPending = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== "Bearer local-fixture-key") return new Response("Wrong fixture key", { status: 401 });
        const body = (await request.json()) as { model: string; messages: Message[]; tools?: { function: { name: string } }[] };
        if (firstRequest) {
          firstRequest = false;
          modelStarted();
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
        }
        const system = JSON.stringify(body.messages.filter((message) => message.role === "system"));
        const toolNames = body.tools?.map((t) => t.function.name) ?? [];
        const station =
          toolNames.includes("code_comment") || toolNames.includes("approve_all_comments") || toolNames.includes("task_done")
            ? "ocr"
            : system.includes("You are the analyst")
              ? "analyst"
              : system.includes("You are the implementer")
                ? "implementer"
                : system.includes("You are the finding verifier")
                  ? "verifier"
                  : "criteria";
        if (process.env.MORK_E2E_VERBOSE) console.log("fixture", station, toolNames.join(","));
        if (station === "verifier" && firstVerification) {
          firstVerification = false;
          verificationStarted();
          return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
        }
        seen.push({ station, model: body.model, messages: body.messages });
        const turns = body.messages.filter((message) => message.role === "tool").length;
        const users = JSON.stringify(body.messages.filter((message) => message.role === "user"));
        if (station === "ocr") {
          if (toolNames.includes("approve_all_comments")) return ocrCompletion(body.model, "approve_all_comments", {});
          if (
            !JSON.stringify(body.messages).includes("Number(a)") &&
            toolNames.includes("code_comment") &&
            !body.messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes('"name":"code_comment"'))
          )
            return ocrCompletion(body.model, "code_comment", {
              comments: [
                {
                  path: "math.mjs",
                  start_line: 1,
                  end_line: 1,
                  existing_code: "export const add = (a, b) => a + b;",
                  content: "Strings are concatenated instead of added",
                  category: "bug",
                  severity: "high",
                },
              ],
            });
          return ocrCompletion(body.model, "task_done", {});
        }
        if (station === "criteria" && turns === 0) {
          const baselineDir = /baseline checkout is at (\/[^\s"\\]+)\./.exec(users)?.[1];
          if (!baselineDir) return new Response("Criteria checker was not given a baseline checkout", { status: 500 });
          return completion(body.model, { name: "read", arguments: { path: `${baselineDir}/math.mjs` } });
        }
        if (station === "criteria" && turns === 1) {
          if (!JSON.stringify(body.messages.filter((m) => m.role === "tool")).includes("a - b"))
            return new Response("Criteria checker could not read immutable baseline", { status: 500 });
          return completion(body.model, { name: "read", arguments: { path: "README.md" } });
        }
        if (station === "criteria" && turns === 2)
          return completion(body.model, {
            name: "submit_result",
            arguments: {
              json: JSON.stringify({
                criteria: [
                  { id: "AC2", pass: true, evidence: [{ where: "README.md:1", quote: "add returns a numeric sum, including numeric strings." }] },
                ],
              }),
            },
          });
        if (station === "criteria") return completion(body.model);
        if (station === "analyst") {
          if (turns === 0) return completion(body.model, { name: "bash", arguments: { command: "cat math.mjs" } });
          if (turns === 1)
            return completion(body.model, {
              name: "submit_result",
              arguments: {
                json: JSON.stringify({
                  problem: "Addition subtracts",
                  plan: ["Correct the add implementation"],
                  acceptance_criteria: [
                    { id: "AC1", text: "add(2,3) returns 5", testable: true },
                    { id: "AC2", text: "README documents numeric strings", testable: false },
                  ],
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
            const code = users.includes("The reviewer found defects in your change")
              ? "export const add = (a, b) => Number(a) + Number(b);"
              : users.includes("The attempt did not pass the gate")
                ? "export const add = (a, b) => a + b;"
                : "export const add = (a, b) => a + b + 1;";
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
          if (turns === 0) return completion(body.model, { name: "read", arguments: { path: "/etc/passwd" } });
          if (turns === 1) return completion(body.model, { name: "read", arguments: { path: "math.mjs" } });
          if (turns === 2)
            return completion(body.model, {
              name: "submit_result",
              arguments: {
                json: JSON.stringify({
                  findings: (() => {
                    const text = body.messages
                      .filter((m) => m.role === "user")
                      .map((m) =>
                        typeof m.content === "string"
                          ? m.content
                          : (m.content as { type: string; text: string }[])
                              .filter((p) => p.type === "text")
                              .map((p) => p.text)
                              .join("\n"),
                      )
                      .join("\n");
                    const ids = [...text.matchAll(/"id":\s*"(F[1-9]\d*)"/g)].map((m) => m[1]);
                    const resolved = JSON.stringify(body.messages).includes("Number(a)");
                    return ids.map((id, index) => ({
                      id,
                      verification:
                        index > 0
                          ? { status: "duplicate", of: ids[0], reason: "Same concatenation root cause" }
                          : resolved
                            ? {
                                status: "refuted",
                                reason: "Numeric coercion has been restored",
                                evidence: [
                                  { revision: "head", path: "math.mjs", line: 1, quote: "export const add = (a, b) => Number(a) + Number(b);" },
                                ],
                              }
                            : {
                                status: "confirmed",
                                reason: "The changed operator concatenates numeric strings",
                                expected: "Numeric strings produce a numeric sum",
                                scenario: "add('2','3') concatenates strings",
                                evidence: [
                                  { revision: "base", path: "math.mjs", line: 1, quote: "export const add = (a, b) => a - b;" },
                                  { revision: "head", path: "math.mjs", line: 1, quote: "export const add = (a, b) => a + b;" },
                                ],
                              },
                    }));
                  })(),
                }),
              },
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
      const interruptAt = async (args: string[], pending: Promise<void>) => {
        const interrupted = spawn(runtime, [cli, ...connection, ...args], {
          cwd: directory,
          env: { ...process.env, MORK_LOCAL_API_KEY: "local-fixture-key", AWS_EC2_METADATA_DISABLED: "true" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let log = "";
        interrupted.stdout.on("data", (chunk) => {
          log += chunk;
        });
        interrupted.stderr.on("data", (chunk) => {
          log += chunk;
        });
        const stopped = new Promise<number | null>((resolve) => interrupted.once("close", resolve));
        const deadline = setTimeout(() => interrupted.kill("SIGKILL"), 15000);
        try {
          await Promise.race([
            pending,
            stopped.then(() => {
              throw new Error(log || "Runner exited before model request");
            }),
          ]);
          interrupted.kill("SIGTERM");
          expect(await stopped, log).toBe(143);
          expect(existsSync(join(task, ".run.lock"))).toBe(false);
          expect(existsSync(join(task, "agent", ".pi-mork", "models.json"))).toBe(false);
        } finally {
          clearTimeout(deadline);
          interrupted.kill("SIGKILL");
        }
      };
      await interruptAt(["--repo", source, "--issue", issueFile, "--output", task, "--definition", definitionFile], modelPending);
      await interruptAt(["--resume", task], verificationPending);
      const ocrCallsBeforeResume = seen.filter((r) => r.station === "ocr").length;
      const started = await execAsync(runtime, [cli, ...connection, "--resume", task], {
        cwd: directory,
        env: { ...process.env, MORK_LOCAL_API_KEY: "local-fixture-key", AWS_EC2_METADATA_DISABLED: "true" },
        timeoutMs: 90_000,
      });
      expect(started.code, started.output).toBe(0);
      // Check 2 restores the same OCR claim set; only Check 3 makes one new clean review call.
      expect(seen.filter((r) => r.station === "ocr").length).toBe(ocrCallsBeforeResume + 1);
      const store = new LocalStore(join(task, "outputs"));
      const state = (await store.json("local-run.json")) as { result: { ok: boolean; attempt: number; head_sha: string; branch: string } };
      expect(state.result).toMatchObject({ ok: true, attempt: 3 });
      expect(await store.json(keys.gateBefore("tasks/local"))).toMatchObject({ hidden: [{ passed: false }] });
      expect(await store.json(keys.gate("tasks/local", 1))).toMatchObject({ hidden: [{ passed: false }] });
      expect(await store.json(keys.gate("tasks/local", 2))).toMatchObject({ hidden: [{ passed: true }] });
      expect(await store.json(keys.review("tasks/local", 2))).toMatchObject({
        unreviewed_files: [],
        findings: [{ located: { line: 1 }, verification: { status: "confirmed" } }, { verification: { status: "duplicate", of: "F1" } }],
      });
      expect(await store.json(keys.review("tasks/local", 2))).toMatchObject({
        criteria: [{ id: "AC2", evidence: [{ where: "README.md:1", quote: "add returns a numeric sum, including numeric strings." }] }],
      });
      expect(await store.text(keys.feedback("tasks/local", 3))).toContain("Strings are concatenated instead of added");
      expect(await store.json(keys.gate("tasks/local", 3))).toMatchObject({ head_sha: state.result.head_sha, hidden: [{ passed: true }] });
      expect(await store.json(keys.review("tasks/local", 3))).toMatchObject({ findings: [{ verification: { status: "refuted" } }] });
      expect(mustExec("git", [...SAFE_GIT, "--git-dir", join(task, "remote.git"), "rev-parse", state.result.branch]).trim()).toBe(
        state.result.head_sha,
      );
      expect(seen.some((request) => request.station === "analyst")).toBe(true);
      for (const [station, kind] of [
        ["analyst", "plan"],
        ["implementer", "build"],
        ["verifier", "check"],
        ["criteria", "check"],
      ]) {
        const requests = seen.filter((request) => request.station === station);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.model === `fixture-${kind}`)).toBe(true);
        expect(requests.every((request) => JSON.stringify(request.messages).includes(`CONFIGURED_${kind?.toUpperCase()}_PROMPT`))).toBe(true);
      }
      expect(((await store.json("local-run.json")) as { brief: { last_attempt: number } }).brief.last_attempt).toBe(3);
      expect(seen.some((request) => request.station === "ocr")).toBe(true);
      expect(JSON.stringify(seen.filter((request) => request.station === "verifier"))).toContain("Read only the supplied repository checkouts");
      expect(seen.some((request) => request.station === "reviewer")).toBe(false);
      expect(JSON.stringify(seen.filter((request) => request.station === "implementer"))).not.toContain("HIDDEN_FIXTURE_ASSERTION");
      expect(JSON.stringify(seen.filter((request) => request.station === "implementer"))).toContain("verify: PASSED");
      expect(JSON.stringify(seen.filter((request) => request.station === "implementer"))).not.toContain("verify: FAILED");
      expect(git("rev-parse", "HEAD")).toBe(original);
      expect(git("status", "--porcelain")).toBe("");
      const session = await store.text(`${keys.session("tasks/local", "build-3-implementer")}.jsonl`);
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
