# 12. Fix runs after the PR

Date: 2026-10-11 · Status: Accepted

## Context

Mork stopped at the draft PR. Red CI or a review requesting changes then needed a person to fix code they did not write, while most comparable agents keep working on their PRs.

## Decision

Red CI on a Mork PR's head, a review requesting changes, or a PR comment mentioning `@mork` from someone with write access starts a fix run:

- It continues the same task: same branch, plan and hidden tests, with the feedback (failed CI jobs with the log tail, the review and its inline comments, or the comment) for Build.
- Each fix run has 2 attempts; each PR at most 2 fix rounds. Decide comments on the PR with the checks table instead of opening a new one.
- A fix round is claimed with an S3 conditional write, so concurrent triggers start one run. Repeats of the same trigger (commit, review or comment) start nothing new, and Mork's own comments carry a marker so they never trigger a fix.

## Consequences

- A task's PR record (`pr.json`) in the Mork bucket must outlive the first run; when it expires, triggers are dismissed.
- Every webhook path that can start a run has to be idempotent, which is now a rule for new triggers too.
