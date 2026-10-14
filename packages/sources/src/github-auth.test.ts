import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { GitHub } from "../../steps/src/github.ts";
import { GitHubAuth, githubAuthFromEnv } from "./github-auth.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const app = JSON.stringify({ appId: "12345", installationId: 99, privateKey: pem });
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture() {
  let now = Date.now();
  let status = 201;
  let calls = 0;
  const repos: string[][] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/app/installations/99/access_tokens");
      const [header, payload, signature] = (request.headers.get("authorization") ?? "").slice(7).split(".") as [string, string, string];
      expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("RS256");
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      expect(claims).toEqual({ iss: "12345", iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540 });
      repos.push((await request.json()).repositories);
      calls++;
      return Response.json({ token: `ghs_installation_${calls}`, expires_at: new Date(now + 60 * 60_000).toISOString() }, { status });
    },
  });
  servers.push(server);
  const request: typeof fetch = (url, init) => fetch(new URL(new URL(String(url)).pathname, server.url), init);
  const auth = new GitHubAuth({ GITHUB_APP: app }, { request, now: () => now });
  return {
    auth,
    repos,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    fail: () => {
      status = 403;
    },
  };
}

test("a signed App JWT mints one repository-scoped token and deduplicates concurrent requests", async () => {
  const f = fixture();
  expect(await Promise.all([f.auth.token("example-org/mork"), f.auth.token("example-org/mork")])).toEqual(["ghs_installation_1", "ghs_installation_1"]);
  expect(f.calls()).toBe(1);
  expect(await f.auth.token("example-org/other")).toBe("ghs_installation_2");
  expect(f.repos).toEqual([["mork"], ["other"]]);
});

test("warm clients refresh before expiry and retain every issued token for redaction", async () => {
  const f = fixture();
  expect(await f.auth.token("example-org/mork")).toBe("ghs_installation_1");
  f.advance(54 * 60_000);
  expect(await f.auth.token("example-org/mork")).toBe("ghs_installation_1");
  f.advance(2 * 60_000);
  expect(await f.auth.token("example-org/mork")).toBe("ghs_installation_2");
  expect(f.auth.secrets()).toEqual(expect.arrayContaining([app, pem, "ghs_installation_1", "ghs_installation_2"]));
});

test("failed renewal rejects instead of using a stale token, then permits a fresh retry", async () => {
  const f = fixture();
  await f.auth.token("example-org/mork");
  f.advance(56 * 60_000);
  f.fail();
  await expect(f.auth.token("example-org/mork")).rejects.toThrow("GitHub App token request failed (403)");
  await expect(f.auth.token("example-org/mork")).rejects.toThrow("GitHub App token request failed (403)");
  expect(f.calls()).toBe(3);
});

test("a temporary GitHub server error is retried without exposing credentials", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    if (calls === 1) return new Response(pem, { status: 500 });
    return Response.json({ token: "recovered-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, { status: 201 });
  };
  const auth = new GitHubAuth({ GITHUB_APP: app }, { request });
  expect(await auth.token("example-org/mork")).toBe("recovered-token");
  expect(calls).toBe(2);
  expect(await auth.token("example-org/mork")).toBe("recovered-token");
  expect(calls).toBe(2);
});

test("invalid configuration and echoed credential responses never appear in errors", async () => {
  expect(() => new GitHubAuth({ GITHUB_APP: `bad-${pem}` })).toThrow("GITHUB_APP must contain valid");
  expect(() => new GitHubAuth({ GITHUB_APP: app, GITHUB_TOKEN: "static" })).toThrow("not both");
  expect(() => new GitHubAuth({ GITHUB_TOKEN: "revoked" })).toThrow("required");
  let failedCalls = 0;
  const request: typeof fetch = async () => {
    failedCalls++;
    return new Response(pem, { status: 500 });
  };
  const auth = new GitHubAuth({ GITHUB_APP: app }, { request });
  await expect(auth.token("example-org/mork")).rejects.toThrow("GitHub App token request failed (500)");
  expect(failedCalls).toBe(3);
  await expect(auth.token("https://github.com/example-org/mork")).rejects.toThrow("owner/repo");
  await expect(githubAuthFromEnv({ GITHUB_APP_SECRET_ID: "app", GITHUB_TOKEN_SECRET_ID: "token" })).rejects.toThrow("not both");
});

test("the GitHub REST client requests the repository's credential for API calls and Actions logs", async () => {
  const repos: string[] = [];
  const github = new GitHub(async (repo) => {
    repos.push(repo);
    throw new Error("credential boundary");
  });
  await expect(github.repo("example-org/mork")).rejects.toThrow("credential boundary");
  await expect(github.jobLogTail("example-org/other", 1)).rejects.toThrow("credential boundary");
  expect(repos).toEqual(["example-org/mork", "example-org/other"]);
});

test("static tokens remain supported without App API calls", async () => {
  const auth = await githubAuthFromEnv({ GITHUB_TOKEN: "static-token" });
  expect(await auth.token("example-org/mork")).toBe("static-token");
});

test("expired or malformed installation tokens are rejected at the response boundary", async () => {
  for (const body of [{ token: "expired-token", expires_at: "2000-01-01T00:00:00Z" }, { token: "secret-must-not-appear" }]) {
    const request: typeof fetch = async () => Response.json(body);
    const auth = new GitHubAuth({ GITHUB_APP: app }, { request });
    await expect(auth.token("example-org/mork")).rejects.toThrow(body.expires_at ? "too close to expiry" : "invalid installation token");
    expect(auth.secrets()).not.toContain(body.token);
  }
});
