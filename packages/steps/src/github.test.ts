import { expect, spyOn, test } from "bun:test";
import { GitHub } from "./github.ts";

test("commit titles use a repository-scoped request and only its first line", async () => {
  const original = globalThis.fetch;
  const repo = "o/r";
  const sha = "b".repeat(40);
  let message = "docs(readme): link config\n\nDetails about the change.";
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== `https://api.github.com/repos/${repo}/commits/${sha}`) return original(input, init);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    return Response.json({ commit: { message } });
  });
  try {
    const github = new GitHub(async (requestedRepo) => {
      expect(requestedRepo).toBe(repo);
      return "fixture-token";
    });
    expect(await github.commitTitle(repo, sha)).toBe("docs(readme): link config");
    message = "\nOnly a body, no subject";
    await expect(github.commitTitle(repo, sha)).rejects.toThrow();
  } finally {
    transport.mockRestore();
  }
});

test("CI feedback includes every failed check page and current commit statuses, and reports pending work", async () => {
  const requested: string[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    if (url.pathname.endsWith("/check-runs")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json({
        total_count: 101,
        check_runs:
          page === 1
            ? Array.from({ length: 100 }, (_, i) => ({
                id: i,
                name: `check-${i}`,
                status: "completed",
                conclusion: "failure",
                output: { summary: `failure-${i}` },
              }))
            : [{ id: 100, name: "last-check", status: "in_progress", conclusion: null, output: {} }],
      });
    }
    if (url.pathname.endsWith("/statuses"))
      return Response.json([
        { context: "external", state: "failure", description: "external failed", target_url: "https://ci.example/run/1" },
        { context: "external", state: "success", description: "old result" },
      ]);
    if (url.pathname.endsWith("/check-suites"))
      return Response.json({ total_count: 1, check_suites: [{ id: 8, status: "queued", app: { slug: "github-actions" } }] });
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ total_count: 0, workflow_runs: [] });
    throw new Error(`Unexpected HTTP request: ${url.pathname}`);
  });
  try {
    const github = new GitHub(async () => "fixture-token");
    const result = await github.ciChecks("o/r", "a".repeat(40));
    expect(result.failed).toHaveLength(101);
    expect(result.failed.at(-1)?.summary).toContain("external failed");
    expect(result.pending).toEqual(["last-check", "github-actions suite 8"]);
    expect(requested.some((path) => path.includes("page=2"))).toBe(true);
  } finally {
    transport.mockRestore();
  }
});

test("completed check runs without a verdict are reported as inconclusive with a reason, never as failures", async () => {
  const sha = "d".repeat(40);
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/check-runs")) {
      return Response.json({
        total_count: 6,
        check_runs: [
          { id: 1, name: "unit", status: "completed", conclusion: "success", output: {} },
          { id: 2, name: "e2e", status: "completed", conclusion: "cancelled", output: {} },
          { id: 3, name: "deploy", status: "completed", conclusion: "action_required", output: { title: "Review required" } },
          { id: 4, name: "lint", status: "completed", conclusion: "stale", output: {} },
          { id: 5, name: "build", status: "completed", conclusion: "startup_failure", output: {} },
          { id: 6, name: "odd", status: "completed", conclusion: "something_new", output: {} },
        ],
      });
    }
    if (url.pathname.endsWith("/statuses")) return Response.json([]);
    if (url.pathname.endsWith("/check-suites")) {
      return Response.json({
        total_count: 2,
        check_suites: [
          { id: 8, status: "queued", app: { slug: "github-actions" }, latest_check_runs_count: 0 },
          { id: 9, status: "completed", app: { slug: "github-actions" }, latest_check_runs_count: 6 },
        ],
      });
    }
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ total_count: 0, workflow_runs: [] });
    throw new Error(`Unexpected HTTP request: ${url.pathname}`);
  });
  try {
    const result = await new GitHub(async () => "fixture-token").ciChecks("o/r", sha);
    expect(result.failed).toEqual([]);
    expect(result.inconclusive.map((c) => c.name)).toEqual(["e2e", "deploy", "lint", "build", "odd"]);
    for (const check of result.inconclusive) expect(check.reason).toContain(check.conclusion);
    expect(result.inconclusive[0]?.reason).toContain("cancelled");
    expect(result.inconclusive[1]?.reason).toContain("approval");
    expect(result.inconclusive[4]?.reason).toContain("something_new");
    // A queued suite that has not created a check run yet stays pending, named so a person can investigate.
    expect(result.pending).toEqual(["github-actions suite 8 (queued, no check runs yet; investigate if it never completes)"]);
  } finally {
    transport.mockRestore();
  }
});

test("inconclusive reporting is bounded", async () => {
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/check-runs")) {
      return Response.json({
        total_count: 60,
        check_runs: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `job-${i}`, status: "completed", conclusion: "cancelled", output: {} })),
      });
    }
    if (url.pathname.endsWith("/statuses")) return Response.json([]);
    if (url.pathname.endsWith("/check-suites")) return Response.json({ total_count: 0, check_suites: [] });
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ total_count: 0, workflow_runs: [] });
    throw new Error(`Unexpected HTTP request: ${url.pathname}`);
  });
  try {
    const result = await new GitHub(async () => "fixture-token").ciChecks("o/r", "e".repeat(40));
    expect(result.failed).toEqual([]);
    expect(result.inconclusive).toHaveLength(20);
    expect(result.inconclusive_total).toBe(60);
  } finally {
    transport.mockRestore();
  }
});

for (const scenario of [
  "green",
  "pending",
  "different-workflow",
  "different-event",
  "different-branch",
  "other-app",
  "unknown-suite",
  "wrong-sha",
  "attempt",
  "api-error",
  "api-forbidden",
  "pagination",
  "same-suite",
  "ambiguous-number",
  "missing-suite",
  "truncated-history",
  "malformed-history",
  "latest-cancelled",
] as const) {
  test(`Actions supersession uses workflow identity, never global job names: ${scenario}`, async () => {
    const sha = "a".repeat(40);
    const workflow = (id: number, suite: number, number: number) => ({
      id,
      check_suite_id: suite,
      workflow_id: 7,
      run_number: number,
      run_attempt: 1,
      event: "pull_request",
      head_branch: "migration",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    });
    const old = workflow(10, 100, 20);
    const current = { ...workflow(11, 101, 21), ...(scenario === "pending" ? { status: "in_progress", conclusion: null } : {}) };
    if (scenario === "different-workflow") current.workflow_id = 8;
    if (scenario === "different-event") current.event = "push";
    if (scenario === "different-branch") current.head_branch = "another";
    if (scenario === "wrong-sha") current.head_sha = "b".repeat(40);
    if (scenario === "attempt") {
      current.id = old.id;
      current.run_number = old.run_number;
      current.run_attempt = 2;
    }
    if (scenario === "same-suite") current.check_suite_id = old.check_suite_id;
    if (scenario === "ambiguous-number") current.run_number = old.run_number;
    const check = (id: number, suite: number, conclusion: string) => ({
      id,
      name: "same-name",
      status: "completed",
      conclusion,
      output: {},
      app: { slug: "github-actions" },
      check_suite: { id: suite },
    });
    const cancelled = check(1, 100, "cancelled");
    const checks = [cancelled, check(2, 100, "failure"), check(3, 101, scenario === "latest-cancelled" ? "cancelled" : "success")];
    if (scenario === "missing-suite") cancelled.check_suite.id = 999;
    if (scenario === "other-app") cancelled.app.slug = "external-ci";
    const requested: string[] = [];
    const transport = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      requested.push(url.pathname + url.search);
      if (url.pathname.endsWith("/check-runs")) return Response.json({ total_count: checks.length, check_runs: checks });
      if (url.pathname.endsWith("/check-suites"))
        return Response.json({
          total_count: scenario === "unknown-suite" ? 3 : 2,
          check_suites: [
            { id: 100, status: "queued", app: { slug: "github-actions" } },
            { id: 101, status: "completed", app: { slug: "github-actions" } },
            ...(scenario === "unknown-suite" ? [{ id: 999, status: "queued", app: { slug: "github-actions" }, latest_check_runs_count: 0 }] : []),
          ],
        });
      if (url.pathname.endsWith("/actions/runs")) {
        expect(url.searchParams.get("head_sha")).toBe(sha);
        if (scenario === "api-error" || scenario === "api-forbidden")
          return Response.json({ message: "unavailable" }, { status: scenario === "api-error" ? 503 : 403 });
        if (scenario === "malformed-history") return Response.json({ total_count: 1, workflow_runs: [{ ...current, workflow_id: undefined }] });
        if (scenario === "truncated-history") return Response.json({ total_count: 101, workflow_runs: [current, old] });
        const workflows =
          scenario === "pagination"
            ? [old, ...Array.from({ length: 99 }, (_, i) => ({ ...workflow(30 + i, 300 + i, 1), workflow_id: 30 + i })), current]
            : [current, old];
        const page = Number(url.searchParams.get("page"));
        return Response.json({ total_count: workflows.length, workflow_runs: workflows.slice((page - 1) * 100, page * 100) });
      }
      if (url.pathname.endsWith("/statuses")) return Response.json([]);
      if (url.pathname.endsWith("/logs")) return new Response("job failed");
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    try {
      const result = new GitHub(async () => "fixture-token").ciChecks("o/r", sha);
      if (scenario === "api-error" || scenario === "api-forbidden") {
        await expect(result).rejects.toThrow(scenario === "api-error" ? "503" : "403");
        return;
      }
      if (scenario === "malformed-history") {
        await expect(result).rejects.toThrow();
        return;
      }
      if (scenario === "truncated-history") {
        await expect(result).rejects.toThrow("Incomplete");
        return;
      }
      const actual = await result;
      const unrelated = ["different-workflow", "different-event", "different-branch", "wrong-sha", "same-suite", "ambiguous-number"].includes(
        scenario,
      );
      expect(actual.failed).toHaveLength(unrelated ? 1 : 0);
      expect(actual.inconclusive_total).toBe(
        unrelated || scenario === "other-app" || scenario === "missing-suite" || scenario === "latest-cancelled" ? 1 : 0,
      );
      expect(actual.pending.length > 0).toBe(unrelated || scenario === "pending" || scenario === "unknown-suite");
      if (scenario === "unknown-suite") expect(actual.pending.join(" ")).toContain("suite 999");
      if (scenario === "pagination") expect(requested.some((path) => path.includes("/actions/runs?") && path.includes("page=2"))).toBe(true);
    } finally {
      transport.mockRestore();
    }
  });
}
