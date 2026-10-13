// Small GitHub REST client for the Lambdas, the only part of Mork that writes
// issues and pull requests; the runner shares the GitHub token, and Build pushes its
// branch through the egress sidecar.

import type { GitHubTokenSource } from "@mork/sources";

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  readonly #token: GitHubTokenSource;

  constructor(token: GitHubTokenSource) {
    this.#token = token;
  }

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token(this.#repo(path))}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "mork",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new GitHubError(response.status, `GitHub ${method} ${path}: ${response.status} ${(await response.text()).slice(0, 500)}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  #repo(path: string): string {
    const repo = /^\/repos\/([^/]+\/[^/?]+)/.exec(path)?.[1];
    if (!repo) throw new Error("GitHub API requests must name a repository");
    return repo;
  }

  repo(full: string) {
    return this.api<{ default_branch: string; full_name: string }>("GET", `/repos/${full}`);
  }

  async branchSha(full: string, branch: string): Promise<string> {
    const ref = await this.api<{ object: { sha: string } }>("GET", `/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  }

  issue(full: string, number: number) {
    return this.api<{
      number: number;
      title: string;
      body: string | null;
      user: { login: string };
      labels: Array<{ name: string }>;
      pull_request?: unknown;
    }>("GET", `/repos/${full}/issues/${number}`);
  }

  async file(full: string, path: string, ref: string): Promise<string | undefined> {
    try {
      const file = await this.api<{ content: string; encoding: string }>("GET", `/repos/${full}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }

  async ensureLabel(full: string, name: string, color: string, description: string): Promise<void> {
    try {
      await this.api("POST", `/repos/${full}/labels`, { name, color, description });
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
    }
  }

  addLabels(full: string, number: number, labels: string[]) {
    return this.api("POST", `/repos/${full}/issues/${number}/labels`, { labels });
  }

  async removeLabel(full: string, number: number, label: string): Promise<void> {
    try {
      await this.api("DELETE", `/repos/${full}/issues/${number}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
  }

  comment(full: string, number: number, body: string) {
    return this.api<{ html_url: string }>("POST", `/repos/${full}/issues/${number}/comments`, { body });
  }

  /** The user's role on the repository; undefined when they have none. Other errors throw, so the webhook is retried. */
  async permission(full: string, login: string): Promise<string | undefined> {
    try {
      const p = await this.api<{ role_name?: string; permission?: string }>(
        "GET",
        `/repos/${full}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      return p.role_name ?? p.permission;
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 403)) return undefined;
      throw error;
    }
  }

  pull(full: string, number: number) {
    return this.api<{ number: number; state: string; html_url: string; head: { sha: string; ref: string } }>("GET", `/repos/${full}/pulls/${number}`);
  }

  /** Failed check runs on `sha`, each with its output and, for GitHub Actions jobs, the tail of the job log. */
  async failedChecks(full: string, sha: string): Promise<{ name: string; summary: string; log: string }[]> {
    const { check_runs } = await this.api<{
      check_runs: Array<{
        id: number;
        name: string;
        conclusion: string | null;
        output: { title: string | null; summary: string | null; text: string | null };
        app?: { slug?: string };
      }>;
    }>("GET", `/repos/${full}/commits/${sha}/check-runs?filter=latest&per_page=100`);
    const failed = check_runs.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out").slice(0, 5);
    return Promise.all(
      failed.map(async (r) => ({
        name: r.name,
        summary: [r.output.title, r.output.summary, r.output.text].filter(Boolean).join("\n").slice(0, 2_000),
        log: r.app?.slug === "github-actions" ? await this.jobLogTail(full, r.id) : "",
      })),
    );
  }

  /** Last lines of a GitHub Actions job log (the API redirects to a short-lived URL). */
  async jobLogTail(full: string, jobId: number, lines = 120): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${full}/actions/jobs/${jobId}/logs`, {
      headers: { authorization: `Bearer ${await this.#token(full)}`, accept: "application/vnd.github+json", "user-agent": "mork" },
    });
    if (!response.ok) return "";
    return (await response.text()).split("\n").slice(-lines).join("\n");
  }

  /** A review and its inline comments. */
  async review(full: string, pr: number, id: number): Promise<{ by: string; body: string; comments: { where: string; body: string }[] }> {
    const review = await this.api<{ user: { login: string }; body: string | null }>("GET", `/repos/${full}/pulls/${pr}/reviews/${id}`);
    const comments = await this.api<Array<{ path: string; line: number | null; original_line: number | null; body: string }>>(
      "GET",
      `/repos/${full}/pulls/${pr}/reviews/${id}/comments?per_page=100`,
    );
    return {
      by: review.user.login,
      body: review.body ?? "",
      comments: comments.map((c) => ({ where: `${c.path}:${c.line ?? c.original_line ?? "?"}`, body: c.body })),
    };
  }

  /** The open PR whose head is `branch` in the same repository, if any. */
  async openPr(full: string, branch: string): Promise<{ number: number; html_url: string } | undefined> {
    const owner = full.split("/")[0];
    const prs = await this.api<Array<{ number: number; html_url: string }>>(
      "GET",
      `/repos/${full}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    return prs[0];
  }

  createDraftPr(full: string, pr: { title: string; head: string; base: string; body: string }) {
    return this.api<{ number: number; html_url: string }>("POST", `/repos/${full}/pulls`, { ...pr, draft: true });
  }
}
