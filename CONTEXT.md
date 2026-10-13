# Mork

Mork turns a request into a verified draft pull request. This file is the project's glossary: use these words in code, docs and issues, and avoid the listed synonyms.

## Language

**Request**:
What a person asks Mork to do: a GitHub issue labelled `mork`, or an `@mork` mention in a mapped Slack channel.
_Avoid_: job, ticket

**Tracker**:
The system where requests are recorded: GitHub issues, or Jira for Slack requests.
_Avoid_: board, backlog

**Tracker issue**:
The issue a request lives in: the labelled GitHub issue, or the Jira issue a Slack request names or Mork creates for it (`TrackerIssue` in code).
_Avoid_: work, ticket

**Source**:
A kind of place requests come from: GitHub or Slack. A source has an intake and a reporter; the flow itself does not depend on the source.

**Intake**:
The Lambda that receives a source's signed webhook, decides whether its sender may start a task, and starts a run. Trust is decided here, never from text a model can influence.

**Reporter**:
How a source shows progress to the requester: labels and comments on GitHub, short messages in the Slack thread.

**Requester**:
The person who made the request. In Slack only the requester may answer Mork's questions.
_Avoid_: user, author

**Origin**:
The source of one task and its tracker reference (`#12` or `PROJ-123`), from which the task's id, branch and PR title are derived.

**Task**:
One attempt by Mork to deliver a request, with its own id (`owner/repo#ref/short`), bucket prefix, `mork/…` branch and at most one draft PR. Starting the same request again creates a new task.
_Avoid_: job, work item

**Run**:
One pass of the workflow over a task. A task begins with its first run; after the PR, fix runs continue it.
_Avoid_: execution (outside AWS context), pipeline

**Fix run**:
A run that continues an existing task on the same branch, plan and hidden tests, after red CI, a review requesting changes or an `@mork` comment on its PR.
_Avoid_: retry, follow-up

**Execution**:
The AWS name for a run (a Step Functions execution). Use it only when talking about AWS.

**Phase**:
One of Plan, Build and Check. Each runs as one container per attempt.
_Avoid_: stage

**Container**:
A phase while it runs: one Fargate task from the shared image, next to an egress sidecar. Say "Fargate task" or "ECS task" only when talking about AWS, never "task".

**Station**:
One worker inside a phase, with its own input and output: the analyst and the gate before (Plan), the implementer (Build), the gate after and the reviewer (Check).
_Avoid_: agent (for the gate), role

**LLM station**:
A station driven by the LLM through Pi: the analyst, the implementer or the reviewer. Every LLM station is supervised while it runs.

**Gate**:
The station without an LLM. Before the change it proves the hidden tests fail; after it, it judges the pushed commit.
_Avoid_: CI, validator

**Acceptance criterion**:
One thing the change must achieve, written by the analyst (`AC1`, `AC2`…). A testable criterion gets a hidden test; an untestable one (docs, wording, readability) is judged by the reviewer from quotes and by the decision model.
_Avoid_: requirement, AC (in prose)

**Hidden test**:
A test the analyst writes for a testable acceptance criterion. It must fail on the base commit, never reaches the implementer, and only the gate runs it.
_Avoid_: acceptance test, secret test

**Gate before / Gate after**:
The gate in Plan, which proves the hidden tests fail on the base commit, and in Check, which clones the pushed branch and runs setup, tests, repository checks, hidden tests and the diff policy.

**Diff policy**:
Rules over the diff against the base commit: changing existing tests, adding skip markers or touching platform paths rejects the attempt; some changes only raise the recommendation.

**Protected path**:
A path whose change raises the recommendation to takeover; set per repository in `protected_paths`. The platform paths `.mork/`, `.github/` and `.pi/` are always off limits.

**Test path**:
A path prefix whose existing files count as tests for the diff policy (`test_paths`, default `test/`, `tests/`).

**Repository checks**:
The `checks` commands in `.mork/config.toml` (lint, typecheck…), run by `verify` and by the gate after `test`. Always say "repository checks", never "checks" alone.

**Checks table**:
The table at the top of a Mork PR listing everything that ran and its result.

**CI**:
The repository's own GitHub workflows and check suites. Red CI on a Mork PR starts a fix run.
_Avoid_: checks

**Verify**:
The implementer's tool that runs setup, tests, repository checks and a preview of the diff policy on its working tree. It never runs hidden tests and decides nothing.
_Avoid_: gate (for this), self-check

**Step**:
Work between phases, run by the `steps` Lambda: Start (with triage), Decide, Ask, Handover.
_Avoid_: stage, task

**Recommendation**:
What Mork advises the person who reviews its work: a review level and the reasons. Hard rules decide first and can only raise it; the decision model may set it only when confident.

**Review level**:
The value of a recommendation: `quick`, `careful` (the safe default) or `takeover`.
_Avoid_: risk score, priority

**Takeover**:
The highest review level: a person should take the task over. It opens no PR and always ends in a handover.

**Handover**:
Mork stops working on a task and gives it to a person: a comment with the reason, the `needs-human` label, its containers stopped, the branch kept. Caused by a takeover, exhausted attempts, an error or a failed integrity check. Mork hands over; a person takes over.
_Avoid_: escalation, failure, abort

**Decision model**:
An external service, separate from the LLM, that answers typed questions with probabilities: Jev or OpenAI Decisions. Optional; without one, every decision takes its safe default. In code one configured decision model is a `Decider`, also called a provider; the `DecisionPanel` asks all of them, uses the primary's answer and records the others for comparison.
_Avoid_: judge, classifier, LLM (for this)

**Decision point**:
A place where Mork asks the decision model: triage, supervision, a criterion judgment or the recommendation. Each answer is recorded in the timeline.

**Undecided**:
An answer that is not confident enough, or an error. It always means the safe default.

**Hard rule**:
A rule in code that decides before the decision model and can only make the outcome stricter, e.g. a protected path raises the recommendation to takeover.
_Avoid_: policy (when the decision model is meant)

**Triage**:
The first decision point in Start: is it a request at all, is it actionable, what kind of change. An unclear request gets questions instead of a plan.

**Supervision**:
The decision model watching an LLM station while it runs. On a problem it sends one steer, then stops the station. It is the only brake: containers have no turn, time or token limits.
_Avoid_: timeout, watchdog

**Steer**:
A message from a template that supervision sends a running LLM station to get it back on track.

**Timeline**:
The DynamoDB record of every decision (what each decision model saw and answered) and of each PR's outcome, used to calibrate the thresholds.
_Avoid_: audit log, history

**Plan**:
The analyst's output: problem, steps, acceptance criteria, hidden tests and risks. Build and Check read it with the hidden test content stripped. Not to be confused with the Plan phase.

**Attempt**:
One pass through Build and Check. A first run has up to 3; each fix run has 2 more and continues the numbering. The analyst has its own 2 attempts in Plan.
_Avoid_: retry, iteration

**Fix round**:
One fix run's claim on a PR, at most 2 per PR, taken with a conditional write so concurrent triggers start one run.

**Question**:
Something an LLM station or triage asks the requester through the Ask step; the run waits up to 3 days and resumes the phase that asked. At most 3 per task; GitHub tasks hand over instead.
_Avoid_: clarification (for the question itself)

**Work in progress**:
What the implementer has done when Build stops early (question, supervision stop, error, Spot reclaim): committed and pushed, so the next attempt continues from it.

**Brief**:
The small state Step Functions hands a container: attempt, bucket prefix, repository, branch and where to report. Everything else is read from the Mork bucket.

**Session**:
An LLM station's saved Pi conversation, redacted, in the Mork bucket. A station that asked or was interrupted continues its own session. The PR links its HTML export as the transcript.
_Avoid_: log, history

**Egress sidecar**:
The proxy container next to each phase container that alone holds the LLM key and, in Build, the push token, and adds them to requests for the LLM host and the task's repository.

**Guard**:
The Pi extension that blocks obvious misuse by the agent, such as pushing anything but its own branch. A safety net, not the security boundary.

**Mork bucket**:
The one S3 bucket of a deployment: task outputs at conventional keys under `tasks/`, hidden tests, agent sessions and Slack thread records.
_Avoid_: factory bucket, artifact store

The word **factory** is not part of Mork's language: the trigger label is `mork` and branches are `mork/…`.

## Relationships

- A **Request** lives in one **Tracker issue** and can have several **Tasks**, one after another.
- A **Task** has one **Origin**, one branch, at most one draft PR, one first **Run** and up to two **Fix runs**.
- Each **Run** is one **Execution** and goes through **Phases**; each **Phase** runs one **Container** per **Attempt** and holds one or two **Stations**.
- **Steps** run between **Phases**: Start before Plan, Decide after Check, Ask when a **Station** has a **Question**, Handover on any stop.
- The **Gate** decides whether the change works; the **Decision model** only advises: **Triage**, **Supervision**, untestable **Acceptance criteria** and the **Recommendation**.
- **Hard rules** run first and can only raise the **Review level**; a **Takeover** always ends in a **Handover**.

## Example dialogue

> **Dev:** "The task was handed over. Did the gate fail?"
> **Maintainer:** "No, the gate after passed on attempt 2, but the change touched a protected path, so the recommendation was takeover. Decide handed it over with the branch kept."
> **Dev:** "And the red CI on the other PR?"
> **Maintainer:** "That started a fix run: fix round 1, two more attempts on the same branch, plan and hidden tests."
