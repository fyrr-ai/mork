import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mork-secrets-"));
  roots.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(
    join(root, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
operation="$2"
shift 2
name=""; value=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|--secret-id) name="$2"; shift 2 ;;
    --secret-string) value="$2"; shift 2 ;;
    *) shift ;;
  esac
done
path="$SECRET_STATE/$(printf '%s' "$name" | tr / _)"
printf '%s %s\\n' "$operation" "$name" >> "$SECRET_CALLS"
case "$operation" in
  describe-secret) [[ -f "$path" ]] ;;
  create-secret) [[ ! -f "$path" ]] || exit 1; if [[ "$value" == file:///dev/stdin ]]; then cat > "$path"; else printf '%s' "$value" > "$path"; fi ;;
  put-secret-value) [[ -f "$path" ]]; cat > "$path" ;;
  delete-secret) rm -f "$path" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const run = (args: string[] = [], token = "fixture-github-token", app = "") =>
    spawnSync("bash", [resolve("scripts/aws-secrets.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        SECRET_STATE: state,
        SECRET_CALLS: join(root, "calls"),
        MORK_SECRET_PREFIX: "fixture",
        MORK_GITHUB_TOKEN: token,
        MORK_GITHUB_APP: app,
        MORK_LLM_API_KEY: "",
        JEV_API: "",
        OPENAI_API_KEY: "",
        MORK_SLACK_SIGNING_SECRET: "",
        MORK_SLACK_BOT_TOKEN: "",
        MORK_JIRA_API_TOKEN: "",
      },
    });
  return { root, state, run };
}

test("provisioning one GitHub token twice keeps one secret and never prints its value", () => {
  const { root, state, run } = fixture();
  const first = run();
  expect(first.status).toBe(0);
  expect(first.stdout).toContain("created fixture/github-token");
  const second = run([], "updated-github-token");
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("updated fixture/github-token");
  expect(readdirSync(state).filter((name) => name.includes("github"))).toEqual(["fixture_github-token"]);
  expect(readFileSync(join(state, "fixture_github-token"), "utf8")).toBe("updated-github-token");
  expect(first.stdout + first.stderr).not.toContain("fixture-github-token");
  expect(second.stdout + second.stderr).not.toContain("updated-github-token");
  const calls = readFileSync(join(root, "calls"), "utf8");
  expect(calls.match(/create-secret fixture\/github-token/g)).toHaveLength(1);
});

test("deleting the stored GitHub credential recreates only its canonical secret", () => {
  const { state, run } = fixture();
  expect(run().status).toBe(0);
  expect(run(["--delete-github"]).status).toBe(0);
  expect(readdirSync(state).filter((name) => name.includes("github"))).toEqual(["fixture_github-token"]);
  expect(readFileSync(join(state, "fixture_github-token"), "utf8")).toBe("revoked");
});

test("App setup writes one JSON credential without creating a static token or exposing the key", () => {
  const { state, run } = fixture();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const app = JSON.stringify({ appId: "123", installationId: 456, privateKey: key });
  const first = run([], "", app);
  expect(first.status).toBe(0);
  expect(run([], "", app).status).toBe(0);
  expect(readdirSync(state).filter((name) => name.includes("github"))).toEqual(["fixture_github-app"]);
  expect(readFileSync(join(state, "fixture_github-app"), "utf8")).toBe(app);
  expect(first.stdout + first.stderr).not.toContain(key);
  expect(first.stdout + first.stderr).not.toContain(app);
});

test("invalid or conflicting App credentials fail before writing any secrets", () => {
  const { state, run } = fixture();
  const invalid = run([], "", "private-key-must-not-be-printed");
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout + invalid.stderr).not.toContain("private-key-must-not-be-printed");
  expect(run([], "static", "invalid-app").status).not.toBe(0);
  expect(readdirSync(state)).toEqual([]);
});
