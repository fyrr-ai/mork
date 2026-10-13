import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { z } from "zod";
import { loadSecrets } from "./secrets.ts";

const REFRESH_BEFORE_MS = 5 * 60_000;
const AppConfig = z.object({
  appId: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()]).transform(String),
  installationId: z.number().int().positive().safe(),
  privateKey: z.string().min(1),
});
const InstallationToken = z.object({ token: z.string().min(1), expires_at: z.string().datetime() });
export type GitHubTokenSource = (repo: string) => Promise<string>;
type Credential = { kind: "token"; token: string } | { kind: "app"; appId: string; installationId: number; key: KeyObject; privateKey: string };

/** Trusted processes share one installation identity; every minted token is scoped to one repository. */
export class GitHubAuth {
  readonly #credential: Credential;
  readonly #request: typeof fetch;
  readonly #now: () => number;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #pending = new Map<string, Promise<string>>();
  readonly #secrets = new Set<string>();

  constructor(env: NodeJS.ProcessEnv, options: { request?: typeof fetch; now?: () => number } = {}) {
    this.#request = options.request ?? fetch;
    this.#now = options.now ?? Date.now;
    if (env.GITHUB_APP && env.GITHUB_TOKEN) throw new Error("Configure either GITHUB_APP or GITHUB_TOKEN, not both");
    if (env.GITHUB_APP) {
      try {
        const config = AppConfig.parse(JSON.parse(env.GITHUB_APP));
        const key = createPrivateKey(config.privateKey);
        if (key.asymmetricKeyType !== "rsa") throw new Error("RSA key required");
        this.#credential = { kind: "app", ...config, key };
        this.#secrets.add(env.GITHUB_APP);
        this.#secrets.add(config.privateKey);
      } catch {
        throw new Error("GITHUB_APP must contain valid appId, installationId and an RSA privateKey");
      }
    } else {
      const token = env.GITHUB_TOKEN?.trim();
      if (!token || ["unset", "revoked"].includes(token.toLowerCase())) throw new Error("GITHUB_TOKEN or GITHUB_APP is required");
      this.#credential = { kind: "token", token };
      this.#secrets.add(token);
    }
  }

  secrets = (): string[] => [...this.#secrets];

  token: GitHubTokenSource = async (repo) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("GitHub authentication requires an owner/repo name");
    if (this.#credential.kind === "token") return this.#credential.token;
    const cached = this.#tokens.get(repo);
    if (cached && cached.expiresAt - this.#now() > REFRESH_BEFORE_MS) return cached.token;
    const pending = this.#pending.get(repo);
    if (pending) return pending;
    const mint = this.#mint(repo);
    this.#pending.set(repo, mint);
    try {
      return await mint;
    } finally {
      this.#pending.delete(repo);
    }
  };

  async #mint(repo: string): Promise<string> {
    const credential = this.#credential;
    if (credential.kind !== "app") throw new Error("GitHub App configuration is required");
    const now = Math.floor(this.#now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: credential.appId })).toString("base64url");
    const message = `${header}.${payload}`;
    const jwt = `${message}.${sign("RSA-SHA256", Buffer.from(message), credential.key).toString("base64url")}`;
    const response = await this.#request(`https://api.github.com/app/installations/${credential.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "mork",
      },
      body: JSON.stringify({ repositories: [repo.split("/")[1]] }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("GitHub App token request failed");
    });
    // Never include response bodies or signed JWTs in failures: a proxy may echo credentials.
    if (!response.ok) throw new Error(`GitHub App token request failed (${response.status})`);
    let issued: z.infer<typeof InstallationToken>;
    try {
      issued = InstallationToken.parse(await response.json());
    } catch {
      throw new Error("GitHub App returned an invalid installation token");
    }
    const expiresAt = Date.parse(issued.expires_at);
    if (expiresAt - this.#now() <= REFRESH_BEFORE_MS) throw new Error("GitHub App returned an installation token too close to expiry");
    this.#secrets.add(issued.token);
    this.#tokens.set(repo, { token: issued.token, expiresAt });
    return issued.token;
  }
}

export async function githubAuthFromEnv(env: NodeJS.ProcessEnv): Promise<GitHubAuth> {
  if ((env.GITHUB_APP || env.GITHUB_APP_SECRET_ID) && (env.GITHUB_TOKEN || env.GITHUB_TOKEN_SECRET_ID))
    throw new Error("Configure either GitHub App credentials or a GitHub token, not both");
  await loadSecrets(env, ["GITHUB_APP", "GITHUB_TOKEN"]);
  return new GitHubAuth(env);
}
