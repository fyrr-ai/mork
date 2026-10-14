// The steps between containers. Step Functions owns the order, retries and
// timeouts and runs the Plan, Build and Check containers on Fargate; the
// steps here only do what needs the GitHub token or the decision model:
// start the task (with triage), decide, hand over. Build pushes its branch.
// Outputs live in the Mork bucket at conventional keys; the state carries
// the brief. Every decision-model call lands in the timeline.
import {
  Answers,
  type Brief,
  GateReport,
  HANDOVER_ERROR,
  HandoverError,
  ImplementerOutput,
  IssueDoc,
  keys,
  lastAttempt,
  MAX_REPAIR_FINDINGS,
  type Phase,
  PublicPlan,
  Review,
  RunResult,
  repairCandidates,
  repairFeedback,
} from "@mork/contracts";
import { DEFAULT_DEVELOPMENT_POLICY, type DevelopmentPolicy } from "@mork/contracts/development";
import {
  type CriterionVerdict,
  chooseRepairs,
  type DecisionPanel,
  type DecisionTrace,
  judgeCriteria,
  type Triage,
  triage,
  triageMessage,
} from "@mork/decision";
import type { Complete } from "@mork/sources";
import { executionUrl, findIssueKey, REVIEW_LEVEL_TEXT, type ReportEvent, type Reporter, type SlackStart, type TrackerIssue } from "@mork/sources";
import type { Store } from "@mork/store";
import { linkPr, recordDecision, recordTakeover, type TimelineStore } from "@mork/timeline";
import { z } from "zod";
import { type FixState, MARKER, releasePr, savePr, startFix } from "./fix.ts";
import type { GitHub } from "./github.ts";
import { CLARIFY_SYSTEM } from "./llm.ts";
import { LABELS, naming, type Origin, prLink, type StartInput } from "./origin.ts";
import { type Recommendation, recommend } from "./recommend.ts";

/** Where the state machine goes after a step. Handing over is an error, not a route. */
export { LABELS } from "./origin.ts";

export type Next = "plan" | "build" | "ask" | "done";

/** What a step or station asked the requester, and the phase to (re)run once answered. */
export type Question = { question: string; resume: "plan" | "build" | "check" };
export type Task = { id: string; repo: string; started_by: string; origin: Origin; execution_arn?: string };

export type FlowState = {
  task: Task;
  policy?: DevelopmentPolicy;
  /** Brief for the next container; Step Functions hands it over as an override. */
  brief: Brief;
  /** Triage classified the issue as a security change; raises the recommendation. */
  security?: boolean;
  next?: Next;
  /** Start's triage question (stations put theirs in `last`). */
  ask?: Question;
  outcome?: { level: string; url: string };
  /** Callback output of the container that just ran (set by the state machine). */
  last?: unknown;
  /** Error caught by the state machine (set by Catch). */
  error?: { Error?: string; Cause?: string };
  /** Fix runs after the PR: which PR, which round and why. */
  fix?: FixState;
  /** Repairs this run made so far, and how many findings they sent back to Build. */
  repair?: { rounds: number; findings: number };
};

/** Start found nothing to do (e.g. a greeting in Slack); Route goes straight to Done. */
export type Dismissed = { next: "done"; dismissed: string };

export type Deps = {
  github: GitHub;
  development?: DevelopmentPolicy;
  store: Store;
  panel: DecisionPanel;
  timeline: TimelineStore;
  llm: Complete;
  /** Link to the run's live agent log, when a log viewer is configured. */
  liveLog: (execution: string) => string | undefined;
  /** Where the task's progress goes: GitHub labels and comments, or the Slack thread and Jira. */
  reporter: (task: Task) => Promise<Reporter>;
  /** Slack tasks: the Jira issue the request names, or a new one. */
  resolveSlack: (start: SlackStart) => Promise<TrackerIssue>;
  /** Posts into a Slack request's thread before there is a task (e.g. "not a request"). */
  tellSlack: (start: SlackStart, event: ReportEvent) => Promise<void>;
  /** Posts the question to the requester and parks the task token until they answer. */
  askRequester: (task: Task, ask: Question & { prefix: string; taskToken: string }) => Promise<void>;
  log: (task: string, kind: string, detail?: Record<string, unknown>) => void;
  /** Stops the containers of a task group that are still running. */
  stopStations: (startedBy: string) => Promise<number>;
  /** Whether a Step Functions execution is still running (a fix run's claim on its PR). */
  executionRunning: (executionArn: string) => Promise<boolean>;
};

/** ECS task group that ties the containers to one Mork task. */
export function startedBy(short: string): string {
  return `mork-${short}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36);
}

function lastResult(state: FlowState): RunResult {
  const parsed = RunResult.safeParse(state.last);
  return parsed.success ? parsed.data : { ok: false, error: `unreadable container result: ${JSON.stringify(state.last)?.slice(0, 500)}` };
}

/** Sends the work back to Build with `feedback`, or to a person when the attempts are used up. */
async function retryBuild(deps: Deps, state: FlowState, feedback: string): Promise<FlowState> {
  const { brief } = state;
  if (brief.attempt >= lastAttempt(brief)) {
    throw new HandoverError(
      `The implementation did not pass the gate by attempt ${lastAttempt(brief)}. Branch: \`${brief.branch}\`.\n\nLast feedback:\n\n${feedback}`,
    );
  }
  deps.log(state.task.id, "build.retry", { attempt: brief.attempt, feedback: feedback.slice(0, 1000) });
  return { ...state, brief: { ...brief, attempt: brief.attempt + 1 }, next: "build", last: undefined };
}

export async function start(deps: Deps, input: StartInput): Promise<FlowState | Dismissed> {
  if ("fix" in input) return startFix(deps, input);
  const { github, store } = deps;
  const short =
    input.execution
      .slice(-8)
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase() || "run";
  const { repo } = input;
  let origin: Origin;
  let work: TrackerIssue;
  // A Slack message without a Jira key is triaged as written, before anything is drafted from it.
  let early: { triage: Triage; trace: DecisionTrace } | undefined;
  if ("source" in input) {
    const { execution: _, ...slack } = input;
    if (!findIssueKey(slack.ask)) {
      early = await triageMessage(deps.panel, slack.ask);
      if (early.triage.route === "ignore") {
        const id = `${repo}#slack/${short}`;
        await recordDecision(deps.timeline, { task: id, point: "triage", attempt: "message", trace: early.trace, action: early.triage });
        deps.log(id, "triage", early.triage);
        await deps.tellSlack(slack, { kind: "not_a_request" });
        return { next: "done", dismissed: early.triage.reasons.join("; ") };
      }
    }
    try {
      work = await deps.resolveSlack(slack);
    } catch (error) {
      // The requester was already told in the thread; no Jira issue, no run.
      if ((error as Error).name === "NotARequest") return { next: "done", dismissed: (error as Error).message };
      throw error;
    }
    origin = { kind: "slack", start: slack, work: { key: work.key, url: work.url, title: work.title, created: work.created } };
  } else {
    const issue = await github.issue(repo, input.issue);
    work = {
      key: `#${issue.number}`,
      title: issue.title,
      body: issue.body ?? "",
      url: `https://github.com/${repo}/issues/${issue.number}`,
      created: false,
    };
    origin = { kind: "github", issue: input.issue };
  }
  const names = naming(repo, origin, short);
  const task: Task = {
    id: names.id,
    repo,
    started_by: startedBy(short),
    origin,
    ...(input.execution_arn ? { execution_arn: input.execution_arn } : {}),
  };
  const reporter = await deps.reporter(task);
  await reporter.report({
    kind: "started",
    work,
    live_url: deps.liveLog(input.execution),
    ...(input.execution_arn ? { execution_url: executionUrl(input.execution_arn) } : {}),
  });
  const info = await github.repo(repo);
  if (!(await github.file(repo, ".mork/config.toml", info.default_branch))) {
    throw new HandoverError("The repository has no `.mork/config.toml` on its default branch, so Mork cannot run its tests.");
  }
  const baseSha = await github.branchSha(repo, info.default_branch);
  const triaged = early ?? (await triage(deps.panel, { title: work.title, body: work.body }));
  await recordDecision(deps.timeline, {
    task: task.id,
    point: "triage",
    attempt: early ? "message" : "start",
    trace: triaged.trace,
    action: triaged.triage,
  });
  deps.log(task.id, "triage", triaged.triage);
  const brief: Brief = {
    attempt: 1,
    last_attempt: (deps.development ?? DEFAULT_DEVELOPMENT_POLICY).build_attempts,
    prefix: names.prefix,
    repo: { full_name: repo, default_branch: info.default_branch, base_sha: baseSha },
    branch: names.branch,
    execution: input.execution,
    task: origin.kind === "slack" ? names.ref : `${repo}${names.ref}`,
    ...(origin.kind === "slack" ? { report: origin.start.ref } : {}),
  };
  await store.putJson(keys.issue(brief.prefix), IssueDoc.parse({ ref: names.ref, title: work.title, body: work.body }));
  if (triaged.triage.route === "clarify") {
    const questions = await deps.llm(CLARIFY_SYSTEM, `# ${work.title}\n\n${work.body}`);
    if (origin.kind === "slack") {
      // The requester is in the thread: ask, wait, then plan with the answer.
      deps.log(task.id, "task.ask", { resume: "plan" });
      return {
        task,
        brief,
        policy: deps.development ?? DEFAULT_DEVELOPMENT_POLICY,
        security: triaged.triage.security,
        next: "ask",
        ask: { question: questions, resume: "plan" },
      };
    }
    await reporter.report({ kind: "clarify", questions });
    deps.log(task.id, "task.clarify", {});
    return { task, brief, policy: deps.development ?? DEFAULT_DEVELOPMENT_POLICY, next: "done" };
  }
  deps.log(task.id, "task.start", { baseSha, title: work.title, prefix: brief.prefix });
  return { task, brief, policy: deps.development ?? DEFAULT_DEVELOPMENT_POLICY, security: triaged.triage.security, next: "plan" };
}

const SupervisionRecords = z.array(z.object({ at: z.string(), trace: z.any(), action: z.record(z.string(), z.unknown()) }));

const StationQuestion = z.object({ question: z.string().min(1), resume: z.enum(["plan", "build", "check"]) });

/**
 * Parks the task until the requester answers (the state machine waits on the
 * task token). Hands over instead when there is nobody to ask or the task has
 * asked too often.
 */
export async function ask(deps: Deps, state: FlowState, taskToken: string): Promise<void> {
  const { task, brief } = state;
  // A station's question is in `last`; Start's triage question in `ask`. After an answer `last` holds the
  // answer, so a later station question never picks up the old triage one.
  const fromStation = StationQuestion.safeParse(state.last);
  const pending = fromStation.success ? fromStation.data : state.ask;
  if (!pending) throw new Error("ask without a question");
  const answered = Answers.parse(
    await deps.store.json(keys.answers(brief.prefix)).catch((error: unknown) => {
      if ((error as { name?: string }).name === "NoSuchKey") return [];
      throw error;
    }),
  );
  const maxQuestions = (state.policy ?? DEFAULT_DEVELOPMENT_POLICY).questions.max;
  if (answered.length >= maxQuestions) {
    throw new HandoverError(`Mork already asked ${maxQuestions} questions and still needs to know:\n\n${pending.question}`);
  }
  if (task.origin.kind !== "slack") {
    throw new HandoverError(`Mork needs an answer it cannot get on GitHub yet:\n\n${pending.question}`);
  }
  await recordSupervision(deps, state);
  deps.log(task.id, "ask", { resume: pending.resume, question: pending.question.slice(0, 300), asked: answered.length + 1 });
  await deps.askRequester(task, { ...pending, prefix: brief.prefix, taskToken });
}

/** Each phase container leaves what its supervisor asked and did; the timeline keeps it. Repeats converge. */
async function recordSupervision(deps: Deps, state: FlowState): Promise<void> {
  const runs: [Phase, number][] = [
    ["plan", 1],
    ["build", state.brief.attempt],
    ["check", state.brief.attempt],
  ];
  for (const [phase, n] of runs) {
    const raw = await deps.store.json(keys.supervision(state.brief.prefix, phase, n)).catch(() => undefined);
    if (raw === undefined) continue;
    for (const [i, r] of SupervisionRecords.parse(raw).entries()) {
      await recordDecision(deps.timeline, {
        task: state.task.id,
        point: "supervision",
        attempt: `${phase}-${n}-${i + 1}`,
        trace: r.trace,
        action: r.action,
        at: new Date(r.at),
      });
    }
  }
}

/** After Check: back to Build when the gate failed, otherwise recommend and open the draft PR. */
export async function decide(deps: Deps, state: FlowState): Promise<FlowState> {
  const { store, github } = deps;
  const { brief, task } = state;
  const result = lastResult(state);
  await recordSupervision(deps, state);
  // Plan, Build and Check report their own progress; Decide reports a repair and the PR.
  if (!result.passed) {
    deps.log(task.id, "check.end", { attempt: brief.attempt, passed: false, stats: result.stats });
    return retryBuild(deps, state, await store.text(keys.feedback(brief.prefix, brief.attempt + 1)));
  }
  const reporter = await deps.reporter(task);
  const plan = PublicPlan.parse(await store.json(keys.plan(brief.prefix)));
  const gate = GateReport.parse(await store.json(keys.gate(brief.prefix, brief.attempt)));
  deps.log(task.id, "check.end", {
    attempt: brief.attempt,
    passed: true,
    head: gate.head_sha,
    repo_tests: gate.repo_tests?.exit_code,
    hidden: gate.hidden.map((h) => [h.file, h.passed]),
    stats: result.stats,
  });

  const review = Review.parse(await store.json(keys.review(brief.prefix, brief.attempt)));
  const impl = ImplementerOutput.parse(await store.json(keys.impl(brief.prefix, brief.attempt)));
  const issue = IssueDoc.parse(await store.json(keys.issue(brief.prefix)));
  const attempt = `check-${brief.attempt}`;
  // Proven defects go back to Build before a person sees the PR, as many times as the policy allows.
  // The decision model sets their priority. Changes the rules hand to a person anyway are not repaired first.
  const repairs = state.repair ?? { rounds: 0, findings: 0 };
  const takeover = (gate.diff_policy?.protected_hits ?? []).length > 0 || plan.security_sensitive || state.security === true;
  const allowed = (state.policy ?? DEFAULT_DEVELOPMENT_POLICY).repairs.rounds;
  const candidates = repairs.rounds >= allowed || takeover || brief.attempt >= lastAttempt(brief) ? [] : repairCandidates(review);
  if (candidates.length) {
    const { chosen, priorities, trace } = await chooseRepairs(
      deps.panel,
      candidates.map((f) => ({ severity: f.severity, category: f.category, where: f.where, what: f.what, excerpt: f.located?.excerpt ?? f.quote })),
      MAX_REPAIR_FINDINGS,
    );
    const defects = chosen.map((index) => candidates[index] as Review["findings"][number]);
    const findings = defects.map((f) => `${f.severity} ${f.category} ${f.where}: ${f.what}`);
    if (trace) {
      const decided = candidates.map((f, index) => ({ where: f.where, severity: f.severity, ...priorities[index] }));
      await recordDecision(deps.timeline, { task: task.id, point: "findings", attempt, trace, action: { priorities: decided, repair: findings } });
    }
    if (defects.length) {
      await store.put(keys.feedback(brief.prefix, brief.attempt + 1), repairFeedback(defects), "text/markdown");
      await reporter.report({ kind: "repair", attempt: brief.attempt, findings: defects.map((f) => `\`${f.where}\`: ${f.what.slice(0, 200)}`) });
      deps.log(task.id, "review.repair", { attempt: brief.attempt, round: repairs.rounds + 1, findings });
      const next = await retryBuild(deps, state, findings.join("\n"));
      return { ...next, repair: { rounds: repairs.rounds + 1, findings: repairs.findings + defects.length } };
    }
  }
  const untestable = plan.acceptance_criteria.filter((c) => !c.testable);
  const judged = await judgeCriteria(
    deps.panel,
    untestable.map((c) => ({ id: c.id, text: c.text, evidence: review.criteria.find((r) => r.id === c.id)?.evidence ?? [] })),
  );
  if (judged.trace) {
    await recordDecision(deps.timeline, { task: task.id, point: "criteria", attempt, trace: judged.trace, action: { verdicts: judged.verdicts } });
  }
  const { rec, trace } = await recommend({
    plan,
    gate,
    review,
    criteria: judged.verdicts,
    securityTriage: state.security === true,
    panel: deps.panel,
  });
  if (trace) await recordDecision(deps.timeline, { task: task.id, point: "recommendation", attempt, trace, action: rec });
  deps.log(task.id, "recommendation", { ...rec, criteria: judged.verdicts, answers: trace?.providers });
  if (rec.level === "takeover") {
    throw new HandoverError(
      `The change passed its tests, but the rules send it to a person:\n\n${rec.reasons.map((r) => `- ${r}`).join("\n")}\n\nBranch: \`${brief.branch}\``,
    );
  }
  // The implementer held a push token; open the PR only for the commit the gate judged.
  const head = await github.branchSha(task.repo, brief.branch);
  if (head !== gate.head_sha) {
    throw new HandoverError(`Branch \`${brief.branch}\` changed after the check (gate: \`${gate.head_sha}\`, now: \`${head}\`). No PR is opened.`);
  }
  const transcripts = transcriptsUrl(store.bucket, brief.prefix);
  const checks: ChecksEvidence = {
    gateBefore: await store
      .json(keys.gateBefore(brief.prefix))
      .then((r) => GateReport.parse(r))
      .catch(() => undefined),
    gate,
    review,
    verdicts: judged.verdicts,
    attempt: brief.attempt,
    lastAttempt: lastAttempt(brief),
    head,
    repaired: state.repair?.findings,
  };
  if (state.fix) {
    const { fix } = state;
    await github.comment(
      task.repo,
      fix.pr,
      `${MARKER}### Mork pushed a fix (round ${fix.round}): ${fix.trigger}\n\n${impl.summary}\n\n${impl.changes.map((c) => `- \`${c.path}\`: ${c.change}`).join("\n")}\n\n**Recommendation:** ${REVIEW_LEVEL_TEXT[rec.level]}\n\n${checksTable(checks)}\n\n<sub>Mork task ${task.id}</sub>`,
    );
    await github.removeLabel(task.repo, fix.pr, rec.level === "quick" ? LABELS.careful.name : LABELS.quick.name);
    await github.addLabels(task.repo, fix.pr, [rec.level === "quick" ? LABELS.quick.name : LABELS.careful.name]);
    await savePr(deps, state, { number: fix.pr, url: fix.url });
    await reporter.report({ kind: "fixed", pr_url: fix.url, summary: impl.summary });
    deps.log(task.id, "fix.end", { pr: fix.pr, round: fix.round, level: rec.level });
    return { ...state, next: "done", last: undefined, outcome: { level: rec.level, url: fix.url } };
  }
  const link = prLink(task.origin, issue.title);
  // A replayed Decide finds the PR its first run opened instead of failing on a duplicate.
  const pr =
    (await github.openPr(task.repo, brief.branch)) ??
    (await github.createDraftPr(task.repo, {
      title: link.title,
      head: brief.branch,
      base: brief.repo.default_branch,
      body: prBody(
        task,
        plan,
        gate,
        impl,
        review,
        rec,
        judged.verdicts,
        link.footer,
        transcripts,
        brief.execution ? deps.liveLog(brief.execution) : undefined,
        checks,
      ),
    }));
  await linkPr(deps.timeline, task.id, task.repo, pr.number, brief.prefix);
  await savePr(deps, state, { number: pr.number, url: pr.html_url });
  await github.addLabels(task.repo, pr.number, [rec.level === "quick" ? LABELS.quick.name : LABELS.careful.name]);
  await reporter.report({ kind: "pr", url: pr.html_url, level: rec.level, reasons: rec.reasons, transcripts_url: transcripts });
  deps.log(task.id, "task.end", { level: rec.level, url: pr.html_url });
  return { ...state, next: "done", last: undefined, outcome: { level: rec.level, url: pr.html_url } };
}

export function handoverReason(state: FlowState): string {
  const error = state.error;
  if (!error) return "unknown reason";
  let message = error.Cause ?? "";
  try {
    message = (JSON.parse(message) as { errorMessage?: string }).errorMessage ?? message;
  } catch {
    // Not JSON: a container's Handover cause or a Step Functions error such as States.Timeout.
  }
  return error.Error === HANDOVER_ERROR ? message : `Unexpected error (${error.Error ?? "?"}): \`${message.slice(0, 1500)}\``;
}

/** Comments, labels and stops whatever container of the task still runs. */
export async function handover(deps: Deps, state: FlowState): Promise<{ next: "done"; outcome: { level: "takeover" } }> {
  const task: Task = state.task ?? taskFromStartInput(state as unknown as StartInput);
  const reason = handoverReason(state);
  const stopped = task.started_by ? await deps.stopStations(task.started_by) : 0;
  await (await deps.reporter(task)).report({ kind: "handover", reason });
  if (state.fix && state.brief) {
    await deps.github.comment(
      task.repo,
      state.fix.pr,
      `${MARKER}**Mork could not finish the fix (${state.fix.trigger}).** It is over to you.\n\n${reason}`,
    );
    await releasePr(deps, state);
  }
  if (state.task) {
    await recordSupervision(deps, state);
    await recordTakeover(deps.timeline, task.id);
  }
  deps.log(task.id, "task.handover", { reason: reason.slice(0, 500), stopped });
  return { next: "done", outcome: { level: "takeover" } };
}

/** A failing Start has no task yet; its input is all there is. */
function taskFromStartInput(input: StartInput): Task {
  if ("fix" in input)
    return { id: `${input.fix.repo}#pr/${input.fix.pr}`, repo: input.fix.repo, started_by: "", origin: { kind: "github", issue: input.fix.pr } };
  const origin: Origin = "source" in input ? { kind: "slack", start: input } : { kind: "github", issue: input.issue };
  return { id: naming(input.repo, origin, "start").id, repo: input.repo, started_by: "", origin };
}

/** The task's saved agent sessions in the Mork bucket; opening it needs AWS access, nothing is public. */
export function transcriptsUrl(bucket: string, prefix: string, region = process.env.AWS_REGION ?? ""): string {
  return `https://${region ? `${region}.` : ""}console.aws.amazon.com/s3/buckets/${bucket}?${region ? `region=${region}&` : ""}prefix=${encodeURIComponent(`${prefix}/sessions/`)}`;
}

/** What the checks table reports beyond the gate after: the gate before, the attempt and the commit Decide verified. */
export type ChecksEvidence = {
  gateBefore?: GateReport;
  gate: GateReport;
  review: Review;
  verdicts: CriterionVerdict[];
  attempt: number;
  lastAttempt: number;
  head: string;
  /** Reviewer findings this run sent back to Build before this review. */
  repaired?: number;
};

/** Uber-style table of every check that ran, so the reviewer sees what is already verified. */
export function checksTable(c: ChecksEvidence): string {
  const ok = (pass: boolean) => (pass ? "✅" : "❌");
  const cmd = (r: { command: string; exit_code: number }) =>
    `${ok(r.exit_code === 0)} \`${r.command}\`${r.exit_code === 0 ? "" : ` (exit ${r.exit_code})`}`;
  const rows: [string, string, string][] = [];
  if (c.gateBefore) {
    const failed = c.gateBefore.hidden.filter((h) => !h.passed).length;
    rows.push([
      "Hidden tests fail on the base commit",
      "gate",
      `${ok(failed === c.gateBefore.hidden.length)} ${failed}/${c.gateBefore.hidden.length} failed before the change`,
    ]);
  }
  if (c.gate.setup) rows.push(["Setup", "gate", cmd(c.gate.setup)]);
  if (c.gate.repo_tests) rows.push(["Repository tests", "gate", cmd(c.gate.repo_tests)]);
  for (const check of c.gate.checks ?? []) rows.push(["Repository check", "gate", cmd(check)]);
  const hiddenPassed = c.gate.hidden.filter((h) => h.passed).length;
  rows.push(["Hidden acceptance tests", "gate", `${ok(hiddenPassed === c.gate.hidden.length)} ${hiddenPassed}/${c.gate.hidden.length} passed`]);
  const violations = c.gate.diff_policy?.violations ?? [];
  const flags = c.gate.diff_policy?.flags ?? [];
  rows.push([
    "Diff policy: existing tests, skips, platform paths",
    "gate",
    violations.length ? `❌ ${violations.join("; ")}` : flags.length ? `⚠️ ${flags.join("; ")}` : "✅ no violations",
  ]);
  const bySeverity = (sev: string) => c.review.findings.filter((f) => f.severity === sev).length;
  const [p0, p1, p2] = [bySeverity("P0"), bySeverity("P1"), bySeverity("P2")];
  rows.push(["Code review", "reviewer (LLM)", p0 + p1 + p2 === 0 ? "✅ no findings" : `${p0 ? "❌" : "⚠️"} ${p0}× P0, ${p1}× P1, ${p2}× P2`]);
  if (c.verdicts.length) {
    const passed = c.verdicts.filter((v) => v.verdict === "pass").length;
    rows.push([
      "Criteria tests cannot decide",
      "decision model",
      `${passed === c.verdicts.length ? "✅" : "⚠️"} ${passed}/${c.verdicts.length} confirmed from quotes`,
    ]);
  }
  if (c.repaired) rows.push(["Review findings sent back to Build", "workflow", `${c.repaired} before this review`]);
  rows.push(["Build attempts", "workflow", `${c.attempt} of ${c.lastAttempt}`]);
  rows.push(["Branch is the commit the gate checked", "workflow", `✅ \`${c.head.slice(0, 7)}\``]);
  const cell = (t: string) => t.replaceAll("|", "\\|").replaceAll("\n", " ");
  return ["| Check | By | Result |", "| --- | --- | --- |", ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export function prBody(
  task: Task,
  plan: PublicPlan,
  gate: GateReport,
  impl: ImplementerOutput,
  review: Review,
  rec: Recommendation,
  verdicts: CriterionVerdict[],
  footer: string,
  transcripts: string | undefined,
  liveUrl: string | undefined,
  checks: ChecksEvidence,
): string {
  const icon = { pass: "✅", fail: "❌", review: "⚠️" } as const;
  const verdictOf = (id: string, testable: boolean) => {
    if (testable) return gate.hidden.filter((h) => h.criteria.includes(id)).every((h) => h.passed) ? "✅ hidden test" : "❌ hidden test";
    const v = verdicts.find((x) => x.id === id);
    const quote = review.criteria.find((c) => c.id === id)?.evidence[0];
    const cited = quote ? `, \`${quote.where}\`: "${quote.quote.slice(0, 120)}"` : "";
    return v ? `${icon[v.verdict]} decision model: ${v.reason}${cited}` : "⚠️ not judged";
  };
  return `## Recommendation: ${REVIEW_LEVEL_TEXT[rec.level]}

${rec.reasons.map((r) => `- ${r}`).join("\n") || "- The gate passed and the reviewer has no concerns."}
${review.read_first.length ? `\n**Start reading at:** ${review.read_first.map((p) => `\`${p}\``).join(", ")}\n` : ""}
## What changed

${impl.summary}

${impl.changes.map((c) => `- \`${c.path}\`: ${c.change}`).join("\n")}

## Acceptance criteria

${plan.acceptance_criteria.map((c) => `- **${c.id}** ${c.text}: ${verdictOf(c.id, c.testable)}`).join("\n")}

## Checks performed

${checksTable(checks)}

## Review

${review.summary}
${review.findings.length ? `\n${review.findings.map((f) => `- ${f.severity} ${f.category} \`${f.where}\`${f.located ? "" : " (quote not found in the commit)"}: ${f.what}`).join("\n")}\n` : ""}${impl.deviations.length ? `\n## Deviations from the plan\n\n${impl.deviations.map((d) => `- ${d}`).join("\n")}\n` : ""}
${liveUrl ? `Live log (Grafana): ${liveUrl}\n` : ""}${transcripts ? `Agent transcripts (AWS console, secrets redacted): ${transcripts}\n\n` : ""}${footer}

<sub>Mork task ${task.id}</sub>`;
}
