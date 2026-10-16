import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mustExec } from "./git.ts";

const cli = join(import.meta.dir, "local-cli.ts");
const pi = process.env.MORK_LOCAL_E2E_PI;
const integration = pi && process.getuid?.() !== 0 ? test : test.skip;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mork-local-references-"));
  const reference = join(root, "legacy");
  const source = join(root, "source");
  for (const dir of [reference, source]) {
    mkdirSync(dir);
    mustExec("git", ["init", "-q", dir]);
  }
  const commit = (dir: string) => {
    mustExec("git", ["-C", dir, "add", "."]);
    mustExec("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    return mustExec("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
  };
  writeFileSync(join(reference, "selected.txt"), "PINNED_REFERENCE_CONTENT");
  writeFileSync(join(reference, "excluded.txt"), "EXCLUDED_REFERENCE_CONTENT");
  const sha = commit(reference);
  writeFileSync(join(reference, "selected.txt"), "DIRTY_REFERENCE_CONTENT");
  mkdirSync(join(source, ".mork"));
  writeFileSync(
    join(source, ".mork/config.toml"),
    `test="true"\n[hidden_tests]\ndir="hidden"\ncommand="node {file}"\nfile_suffix=".js"\n[[reference_repositories]]\nname="legacy"\nrepo="fixture/legacy"\nsha="${sha}"\npaths=["selected.txt"]\n`,
  );
  commit(source);
  const issue = join(root, "issue.json");
  writeFileSync(issue, JSON.stringify({ ref: "DOC-1", title: "Documentation", body: "Document the legacy behavior." }));
  return { root, reference, source, issue };
}

async function run(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, MORK_LOCAL_API_KEY: "fixture" } });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, output };
}

function args(f: ReturnType<typeof fixture>, url = "http://127.0.0.1:1") {
  return ["--trusted", "--repo", f.source, "--issue", f.issue, "--output", join(f.root, "run"), "--model", "fixture", "--llm-url", url];
}

test("local CLI refuses missing, unknown, duplicate and relative reference mappings before model calls", async () => {
  for (const [mapping, message] of [
    [[], "Missing local reference: legacy"],
    [["--reference", "unknown=/tmp"], "Unknown local reference: unknown"],
    [["--reference", "legacy=relative"], "absolute"],
    [["--reference", "legacy=/tmp", "--reference", "legacy=/tmp"], "Duplicate local reference"],
  ] as [string[], string][]) {
    const f = fixture();
    try {
      const result = await run([...args(f), ...mapping]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(message);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

integration(
  "real local CLI and Pi read selected pinned reference text; resume retains mapping",
  async () => {
    const f = fixture();
    let seen = 0;
    let child: ReturnType<typeof spawn> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
        const tools = body.messages.filter((m) => m.role === "tool");
        const last = String(tools.at(-1)?.content ?? "");
        let delta: unknown;
        if (last.includes("PINNED_REFERENCE_CONTENT")) {
          expect(last).not.toContain("DIRTY_REFERENCE_CONTENT");
          expect(last).not.toContain("EXCLUDED_REFERENCE_CONTENT");
          seen++;
          child?.kill("SIGTERM");
          delta = { role: "assistant", content: "Reference inspected." };
        } else {
          const prompt = body.messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n");
          const manifest = prompt.match(/Read (\S+manifest.json)/)?.[1];
          if (!manifest) return new Response("Manifest missing", { status: 400 });
          const code = `const f=require('fs'),p=require('path');const m=JSON.parse(f.readFileSync(${JSON.stringify(manifest)},'utf8'));console.log(m.files.map(x=>x.path).join(','));console.log(f.readFileSync(p.join(p.dirname(${JSON.stringify(manifest)}),'references/legacy/selected.txt'),'utf8'));`;
          delta = {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-reference",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: `node -e '${code.replaceAll("'", "'\\''")}'` }) },
              },
            ],
          };
        }
        const base = { id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 1 };
        return new Response(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: seen ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      for (const resume of [false, true]) {
        const options = resume
          ? ["--trusted", "--resume", join(f.root, "run"), "--model", "fixture", "--llm-url", server.url.toString()]
          : [...args(f, server.url.toString()), "--reference", `legacy=${f.reference}`];
        child = spawn(process.execPath, [cli, ...options, "--pi", pi as string], { stdio: "ignore" });
        const timeout = setTimeout(() => child?.kill("SIGKILL"), 25000);
        await new Promise((resolve) => child?.on("close", resolve));
        clearTimeout(timeout);
        expect(seen).toBe(resume ? 2 : 1);
      }
      const manifest = JSON.parse(readFileSync(join(f.root, "run/outputs/local-run.json"), "utf8"));
      expect(manifest.references).toEqual({ legacy: f.reference });
      const changed = await run([
        "--trusted",
        "--resume",
        join(f.root, "run"),
        "--model",
        "fixture",
        "--llm-url",
        server.url.toString(),
        "--reference",
        `legacy=${f.source}`,
      ]);
      expect(changed.code).not.toBe(0);
      expect(changed.output).toContain("Resume must use the saved local reference mappings");
      expect(seen).toBe(2);
    } finally {
      child?.kill("SIGKILL");
      server.stop(true);
      mustExec("chmod", ["-R", "u+rwX", f.root]);
      rmSync(f.root, { recursive: true, force: true });
    }
  },
  60000,
);
