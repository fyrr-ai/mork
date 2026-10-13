# Architecture

Mork also supports [workflows defined in Terraform](workflows.md). A shared Slack
intake queues each mention, then Jev selects an allowed workflow. Each configured
workflow has its own state machine and shares the runner infrastructure. The
sections below describe the development profile and its draft-PR behavior.

Mork turns a request into a verified draft pull request. A request is a GitHub issue with the `mork` label or an `@mork` mention in a mapped Slack channel. An LLM agent plans, writes and reviews the change. Tests the implementer never sees decide whether it works. A decision model only recommends how much attention the change needs. A person always merges.

Diagrams: [workflow](diagrams/workflow.html), [verification](diagrams/verification.html), [AWS architecture](diagrams/aws-architecture.html). Terms: [glossary](../CONTEXT.md). Why it is built this way: [decision records](adr/README.md).

## Components

| Component | Choice |
| --- | --- |
| LLM | Any OpenAI-compatible chat completions API: `LLM_BASE_URL`, `LLM_API_KEY`, `MORK_MODEL`. One model does planning, coding and review |
| Agent harness | [Pi](https://pi.dev) (`pi-coding-agent`), started by the runner as `pi --mode rpc` |
| Decision model (optional) | [Jev](https://typesafe.ai) or OpenAI Decisions behind one interface. Without one, every PR gets the safe default: careful review |
| Orchestration | AWS Step Functions (Standard) |
| Phases | Plan, Build, Check: one container each on Fargate Spot, next to an egress sidecar that holds the keys |
| Steps | One Lambda (`steps`) for the work between phases: start, triage, decide, ask, handover, fix runs |
| Intake | Lambda Function URLs for GitHub webhooks and Slack events, both signature-checked |
| State | One S3 bucket for task outputs and sessions; DynamoDB table for the decision timeline |
| Trackers | GitHub issues; Jira as the tracker for Slack requests (optional) |
| Infrastructure | The Terraform module in [`infra/aws`](../infra/aws) |

## Flow

```text
GitHub webhook → intake Lambda ┐
Slack @mork    → slack Lambda  ┴→ Step Functions
  Start → Route → Plan → Build → Check → Decide → Done
                           ↑                │ gate failed (at most 3 attempts)
                           └────────────────┘
  Ask/Resume: a question in the Slack thread, waiting up to 3 days
  any error or hard rule: Catch → Handover (report, needs-human label, stop containers)
  after the PR: red CI, "Request changes" or an @mork comment start a fix run
```

1. **Intake.** The GitHub intake checks the webhook signature, that the repository is on the allowlist, and that whoever added the `mork` label has at least triage access. The Slack intake checks Slack's signature and that the channel is mapped to a repository (and, optionally, a Jira project). A Slack request names an existing issue (`@mork implement PROJ-123`) or Mork creates a Story or Bug for it.
2. **Triage** (Start). For a Slack message, the decision model first answers whether it is a request at all; a greeting starts nothing. Then it answers `actionable` and `kind`. When it is confident the task is unclear (p ≤ 0.2), the LLM writes questions: in Slack the run waits for the answer, on GitHub the issue gets the `needs-info` label. When in doubt, the run goes on.
3. **Plan, Build, Check** (below), then **Decide**: the recommendation and the draft PR.
4. **Calibration.** Every decision and every PR outcome is recorded, so the thresholds (0.2, 0.8) can be replaced by measured ones with [jevcal](https://github.com/abhixhek/jevcal).

Progress goes where the request came from: labels and comments on the GitHub issue, or short messages in the Slack thread (plus a comment on the Jira issue for the PR or the handover). The first Slack message links the Step Functions execution and, when configured, a live log in Grafana.

## Verification: tests decide, the model advises

Whether the code works is decided by tests, not by a model.

1. **Analyst** (Pi + LLM) writes the plan and a **hidden test** for every testable acceptance criterion. Hidden tests are stored under `hidden/` in the bucket, which only the Plan and Check roles can access; they never reach the implementer's checkout.
2. **Gate before** (no LLM) runs the hidden tests on the base commit. They must **fail**, because the feature does not exist yet. Tests that pass prove nothing and go back to the analyst (at most 2 analyst attempts).
3. **Implementer** (Pi + LLM) writes the code on its branch and pushes it. It can call `verify` to run the repository's setup, tests, repository checks (`checks`) and a preview of the diff policy (not the hidden tests). Directory-scoped `AGENTS.md` rules reach it before it first edits a file under that directory.
4. **Gate after** (no LLM) clones the pushed branch fresh and runs, as an unprivileged user:
   - the repository's setup, tests and repository checks (`checks`),
   - the hidden tests, written by root only after the repository's own commands ran, read-only, before each run,
   - the **diff policy**.

   **Why a diff policy when there are hidden tests.** Hidden tests check only the criteria the analyst wrote. They do not notice an implementer that breaks something else and then "fixes" the repository's own tests. Agents do this. The diff policy compares the branch with the base commit and:
   - **rejects an attempt** that changes or deletes a file under `test_paths` (default `test/`, `tests/`); new test files are fine,
   - **rejects an attempt** that adds a skip marker (`.skip(`, `.only(`, `xit(`, `@pytest.mark.skip`, `{ skip: true }`…),
   - **rejects an attempt** that touches platform paths (`.mork/`, `.github/`, `.pi/`),
   - **raises the recommendation** to careful review when the test script in `package.json` changes, and to takeover when the change touches the repository's `protected_paths`.

   A failed gate sends concrete feedback back to Build, at most 3 attempts in total; then a person takes over. Tasks that are supposed to change existing tests are handed over.
5. **Reviewer** (Pi + LLM) runs only after the gate passes. It judges what tests cannot decide (documentation, wording, readability, security) and backs each criterion with verbatim quotes (`where`, `quote`). The decision model judges each such criterion from those quotes alone ([jev-proof](https://github.com/klauswg/jev-suite/tree/master/jev-proof) pattern): p ≥ 0.80 pass, p ≤ 0.20 fail, review in between; no quote, no pass; an API error means review.
6. **Recommendation.** Hard rules decide first and can only raise the level. At takeover the decision model is not asked. Otherwise it picks a level; a confident answer (≥ 0.8) sets it, never below what the rules require; an unsure one leaves the safe default.

   | Level | When | What the person gets |
   | --- | --- | --- |
   | **Quick look** | Gate green, small low-risk diff, clean review, confident model | Draft PR, label `review:quick` |
   | **Careful review** (default) | Moderate risk, larger diff, reviewer findings, or an unsure model | Draft PR, label `review:careful` |
   | **Take over** | Gate still failing, security change, protected paths, P0 finding | No PR; label `needs-human` and the reason; the branch stays |

   The PR starts with the recommendation, the checks table (everything that ran), where to start reading, and links to the agents' transcripts.

**Containers.** Each phase runs as one container (a Fargate task) from the same image; task definition and role differ.

- **Plan:** analyst and gate before.
- **Build:** implementer. The only phase without access to the hidden tests.
- **Check:** gate after and, if it passes, the reviewer.

Inside a container the runner (root) holds the task token, AWS credentials, the GitHub token and the decision-model key. Pi runs as the user `agent` with a clean environment and no keys. The gate runs repository commands as the user `sandbox` in its own fresh clone. Tracked files, Git metadata and their parent entries remain root-owned; sticky directories allow generated outputs without allowing replacement of tracked entries. After each command the gate checks tracked bytes and Git metadata against its initial snapshot. Root opens every path component with a pinned directory descriptor and never follows an agent-owned symlink. Between steps the container kills every process of the previous user.

**Analyst quality metric:** the share of hidden tests that fail on the base commit and pass after the change.

## After the PR

Red CI (a failed check suite) on a Mork PR's head, a review that requests changes, or a PR comment that mentions `@mork` (from someone with write access) starts a **fix run**. It finds the task through the timeline and the PR record in the bucket, collects the feedback (failed CI jobs with the log tail, the review with its inline comments, or the comment) and continues the task in Build on the same branch, with the same plan and hidden tests. Each fix run has 2 build attempts, each PR at most 2 fix rounds. Decide comments on the PR with the checks table instead of opening a new one.

A round is claimed with a conditional write, so concurrent triggers start one run; repeats of the same trigger (same commit, review or comment) start nothing new; Mork's own comments carry a marker and never trigger a fix.

## Supervision, timeline, history

Patterns from [thruwire/foreman](https://github.com/thruwire/foreman), taken as patterns, not as a dependency.

- **Supervision** of every LLM station while it runs (every `supervise_seconds`, default 45 s). It is the only brake: there are no turn, time or token limits inside the containers, so work is never cut off just before it finishes. The decision model scores `worker_stuck`, `work_off_track` and `meaningful_progress`. On a problem the runner sends one steering message (Pi RPC `steer`), waits 30 s, then stops the station: the analyst gets another attempt, the implementer pushes its work in progress and Build continues with the next attempt, a stuck reviewer hands the task over. The steering text comes from templates, not from the model. A 2-hour phase timeout and a 5-minute heartbeat are the backstop.
- **Bounded evidence.** The decision model gets small typed pieces only (diff stat, test summaries, the end of the agent's output, gate results), within 30 000 bytes of state and 60 000 bytes per request.
- **Timeline** in DynamoDB: every decision under `task#<task>` with `decision#<point>#<attempt>`: what each model saw, answered, and what happened. PR webhooks add the outcome: merged without changes requested → quick, merged after changes → careful, closed or taken over → takeover. `mise run timeline:export` turns it into jevcal input.
- **Questions.** For Slack tasks every LLM station has `ask_human`, and triage asks instead of stopping. The station stops, Step Functions goes to **Ask**, which posts the question in the thread and waits up to `questions.timeout_seconds` (default 3 days); **Resume** reruns the phase that asked, and the station continues its own session with the answer. Only the requester may answer; `questions.max` bounds questions, default 3. GitHub tasks hand over instead of asking.
- **Status.** `@mork status` in a task's thread answers with the phase, how long it has been running, or what it waits for.
- **Agent history.** Every station has its own Pi session, saved to the bucket while it runs, at the end and on SIGTERM, with the container's secret values redacted, plus an HTML export. PRs link the transcripts through the AWS console; nothing is public.
- **Work in progress.** When Build stops early (question, supervision stop, error, Spot reclaim), the runner first stops the agent, then commits and pushes its work; the next attempt continues from it.

## Fargate Spot

Phases run on Fargate Spot. A reclaimed container gets SIGTERM two minutes ahead: the runner saves the session and the work in progress and reports `Mork.Interrupted`, and Step Functions reruns the phase, which continues its session. Each step configures its capacity and Spot retry budget. After that budget is exhausted for interruptions or capacity failures (`AmazonECS.Unknown`, `ECS.AmazonECSException`), its own fallback state starts the same step on on-demand Fargate. Later steps use their own capacity configuration.

## Principles

- **Authorization lives in code, not in the model.** The decision model can only send a task to a person, never allow more. A draft PR is the ceiling; merging is not among the agent's tools.
- **The agent holds no key.** Each phase container runs next to an egress sidecar ([iron-proxy](https://github.com/ironsh/iron-proxy), Apache-2.0). The sidecar holds the LLM key and, in Build, the shared GitHub token. It adds them as the `Authorization` header to requests for the LLM host and for the task's repository on `github.com`. The agent's processes go through it (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY` for Pi) and trust its CA, which the sidecar creates per task.
- **The agent pushes only its own branch.** The shared GitHub token is restricted to allowlisted repositories and has no Workflows write permission. The guard extension blocks obvious misuse; repository rulesets keep the default branch PR-only with a fresh approval and limit new branches to `mork/*`. The gate tests the pushed commit, and Decide opens the PR only for the commit the gate checked.
- **Trust is decided at intake.** Who may start a task is decided on the signed webhook, never derived from text a model can influence.
- **Independent verification.** With one LLM, independence comes from the LLM-free gate, the hidden tests, the reviewer's clean context and a different model for decisions.

See [../SECURITY.md](../SECURITY.md) for the trust boundaries and the known gaps.

## Not implemented yet

- Network enforcement outside the proxy. `egress_enforce` blocks disallowed hosts through the proxy; the agent can still bypass it and receives no proxy-held keys.
- More repository checks in `.mork/checks/*.toml`, read from the default branch.
- Reviewer assignment from CODEOWNERS; learning review rules from PR feedback.
- Detecting at Plan time that a task requires changing existing tests.
- Dependency caches or prebuilt images for faster starts.
- GitHub App authentication (today: fine-grained tokens).
- One Slack app routing to several deployments (teams).
