// Small GitHub REST client for the Lambdas, the only part of Mork that writes
// issues and pull requests; the runner shares the GitHub token, and Build pushes its
// branch through the egress sidecar.

import type { GitHubTokenSource } from "@mork/sources";
import { z } from "zod";

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What one immutable head's CI says: failures to fix, work still running, and runs that reached no verdict. */
export type CiChecks = {
  failed: { name: string; summary: string; log: string }[];
  pending: string[];
  /** Completed runs with no verdict on the code; reported, never fixed automatically. Bounded to MAX_INCONCLUSIVE. */
  inconclusive: { name: string; conclusion: string; reason: string }[];
  inconclusive_total: number;
};

export const MAX_INCONCLUSIVE = 20;
const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);

/** Why a completed run is not a verdict, in words a person can act on. */
export function inconclusiveReason(conclusion: string | null): string {
  switch (conclusion) {
    case "cancelled":
      return "cancelled before it finished (superseded or stopped by a person); re-run it to get a verdict";
    case "action_required":
      return "action_required: the workflow waits for a person's approval or review before it can run";
    case "stale":
      return "stale: the run belongs to an earlier state of the branch; a new run is needed";
    case "startup_failure":
      return "startup_failure: the workflow could not start (invalid workflow file or runner setup), not a verdict on the change";
    default:
      return `${conclusion ?? "no conclusion"}: not a verdict on the change; inspect the run on GitHub`;
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

  async commitTitle(full: string, sha: string): Promise<string> {
    const commit = z.object({ commit: z.object({ message: z.string() }) }).parse(await this.api<unknown>("GET", `/repos/${full}/commits/${sha}`));
    return z.string().trim().min(1).parse(commit.commit.message.split(/\r?\n/, 1)[0]);
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

  /** Check API filter=latest can retain suites from earlier workflow invocations. */
  async #actionSuites(full: string, sha: string): Promise<{ superseded: Set<number>; pending: string[] }> {
    const workflowRun = z.object({
      id: z.number().int().positive(),
      workflow_id: z.number().int().positive(),
      check_suite_id: z.number().int().positive(),
      run_number: z.number().int().positive(),
      run_attempt: z.number().int().positive(),
      event: z.string().min(1),
      head_branch: z.string().nullable(),
      head_sha: z.string(),
      status: z.string(),
    });
    const all: z.infer<typeof workflowRun>[] = [];
    for (let page = 1; ; page++) {
      const result = z
        .object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(workflowRun) })
        .parse(await this.api<unknown>("GET", `/repos/${full}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100&page=${page}`));
      all.push(...result.workflow_runs);
      if (all.length >= result.total_count) break;
      // Bound the lookup to 1,000 records and never infer completeness from a truncated response.
      if (page >= 10 || result.workflow_runs.length < 100) throw new Error("Incomplete GitHub Actions workflow history for CI head");
    }
    const groups = new Map<string, z.infer<typeof workflowRun>[]>();
    for (const run of all) {
      if (run.head_sha !== sha) continue;
      const identity = JSON.stringify([run.workflow_id, run.event, run.head_branch]);
      const group = groups.get(identity) ?? [];
      group.push(run);
      groups.set(identity, group);
    }
    const superseded = new Set<number>();
    const retained = new Set<number>();
    const pending: string[] = [];
    for (const group of groups.values()) {
      for (const run of group) {
        const replaced = group.some(
          (newer) =>
            newer.run_number > run.run_number || (newer.id === run.id && newer.run_number === run.run_number && newer.run_attempt > run.run_attempt),
        );
        if (replaced) superseded.add(run.check_suite_id);
        else {
          retained.add(run.check_suite_id);
          // The Actions endpoint can observe a new invocation before Checks creates its first run/suite.
          if (run.status !== "completed")
            pending.push(`github-actions workflow ${run.workflow_id} run ${run.run_number} attempt ${run.run_attempt} (${run.status})`);
        }
      }
    }
    // Rerunning jobs may reuse a suite ID: it must remain when any current invocation owns it.
    for (const suite of retained) superseded.delete(suite);
    return { superseded, pending };
  }

  /** Failed check runs on `sha`, each with its output and, for GitHub Actions jobs, the tail of the job log. */
  /** All latest results for one immutable head, including legacy status contexts. */
  async ciChecks(full: string, sha: string): Promise<CiChecks> {
    type Run = {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      output: { title?: string | null; summary?: string | null; text?: string | null };
      app?: { slug?: string };
      check_suite?: { id: number };
    };
    const runs: Run[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ total_count: number; check_runs: Run[] }>(
        "GET",
        `/repos/${full}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      runs.push(...result.check_runs);
      if (runs.length >= result.total_count || result.check_runs.length < 100) break;
    }
    type Suite = { id: number; status: string; app?: { slug?: string }; latest_check_runs_count?: number };
    const suites: Suite[] = [];
    // Queued workflows may not have created their first check run yet.
    for (let page = 1; ; page++) {
      const result = await this.api<{ total_count: number; check_suites: Suite[] }>(
        "GET",
        `/repos/${full}/commits/${sha}/check-suites?per_page=100&page=${page}`,
      );
      suites.push(...result.check_suites);
      if (suites.length >= result.total_count || result.check_suites.length < 100) break;
    }
    const actions =
      runs.some((r) => r.app?.slug === "github-actions") || suites.some((s) => s.app?.slug === "github-actions")
        ? await this.#actionSuites(full, sha)
        : { superseded: new Set<number>(), pending: [] };
    const currentRuns = runs.filter((r) => r.app?.slug !== "github-actions" || !actions.superseded.has(r.check_suite?.id ?? -1));
    const pending = currentRuns.filter((r) => r.status !== "completed").map((r) => r.name);
    pending.push(...actions.pending);
    for (const suite of suites) {
      if (suite.status === "completed" || (suite.app?.slug === "github-actions" && actions.superseded.has(suite.id))) continue;
      // Unmapped/other-app suites remain pending; a job name is never evidence of supersession.
      const empty = suite.latest_check_runs_count === 0 ? ` (${suite.status}, no check runs yet; investigate if it never completes)` : "";
      pending.push(`${suite.app?.slug ?? "check"} suite ${suite.id}${empty}`);
    }
    const completed = currentRuns.filter((r) => r.status === "completed");
    // Only a verdict on the code counts as a failure; a run that never judged it is inconclusive and spends no Build.
    const failures = completed.filter((r) => FAILURE_CONCLUSIONS.has(r.conclusion ?? ""));
    const undecided = completed.filter((r) => !FAILURE_CONCLUSIONS.has(r.conclusion ?? "") && !PASS_CONCLUSIONS.has(r.conclusion ?? ""));
    const inconclusive = undecided.slice(0, MAX_INCONCLUSIVE).map((r) => ({
      name: r.name,
      conclusion: r.conclusion ?? "none",
      reason: inconclusiveReason(r.conclusion),
    }));
    type Status = { context: string; state: string; description: string | null; target_url: string | null };
    const latest = new Map<string, Status>();
    for (let page = 1; ; page++) {
      const statuses = await this.api<Status[]>("GET", `/repos/${full}/commits/${sha}/statuses?per_page=100&page=${page}`);
      // GitHub returns newest first; older statuses of a context must not override it.
      for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status);
      if (statuses.length < 100) break;
    }
    for (const status of latest.values()) if (status.state === "pending") pending.push(status.context);
    const failed = await Promise.all(
      failures.map(async (r) => ({
        name: r.name,
        summary: [r.output.title, r.output.summary, r.output.text].filter(Boolean).join("\n").slice(0, 2_000),
        log: pending.length === 0 && r.app?.slug === "github-actions" ? await this.jobLogTail(full, r.id) : "",
      })),
    );
    for (const status of latest.values())
      if (["failure", "error"].includes(status.state)) {
        failed.push({ name: status.context, summary: [status.description, status.target_url].filter(Boolean).join("\n"), log: "" });
      }
    return { failed, pending, inconclusive, inconclusive_total: undecided.length };
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
