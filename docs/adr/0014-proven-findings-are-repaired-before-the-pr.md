# 14. Proven findings are repaired before the PR

Date: 2026-10-14 · Status: Accepted

## Context

Only a failed gate sent work back to Build. A reviewer finding changed the recommendation and the PR text, and a P0 ended the task without a PR and without an attempt to fix it. A person then had to ask Mork for a fix it could have made itself.

Reviewer findings are opinions ([ADR 1](0001-tests-decide-models-advise.md)), and acting on unmeasured opinions is what the scope judge got wrong ([ADR 10](0010-no-scope-judge.md)). A prototype on six changes measured two things. The reviewer finds real defects but sets their severity unreliably: of nine defects that human reviewers rated high or critical, it rated five as P0 or P1. Jev, asked for the priority of each finding from the finding and the code around its quote, rated all nine as must-fix and two of three minor ones as minor.

## Decision

The runner checks what it can without a model: every finding carries a category and a quote, and the runner looks the quote up in the reviewed commit. The reviewer's task lists the changed files and the rules for their file types, and the review records which changed files it did not read.

After a green gate, Decide sends findings back to Build when all of this holds:

- the finding is a bug or a security issue and its quote is in the commit,
- the decision model is confident (p ≥ 0.8 for P0 or P1) that it must be fixed before merge; when it is unsure or unavailable, the reviewer's P0 or P1 counts instead, and a confident "minor" overrides the reviewer,
- the run has a repair round left (`repairs.rounds` in the development workflow, 3 by default, 0 turns repairs off),
- the rules would not hand the task to a person anyway (protected path, security-sensitive change).

At most three findings go back per round, the most urgent first. Each repair round adds a Build attempt of its own, so a gate failure never costs a repair and a repair never costs a gate retry; the run timeout counts these attempts. The gate judges the result, and the review after the last round goes to the PR. Every priority the decision model gave is recorded in the timeline under `findings`.

The recommendation uses the same priorities instead of the reviewer's severity: a finding rated must-fix keeps the PR at careful review, a minor one raises nothing, and a reviewer P0 alone no longer takes the task over. Reviewers often call a P1 or a non-issue P0, and a takeover throws away a tested change.

## Consequences

- A false finding costs a Build attempt and may change working code; the gate limits the damage to what tests cover.
- The implementer may leave a finding unfixed and say why in `deviations`; nothing checks that a repaired finding is gone except the next review.
- Findings without a matching quote stay in the PR text and never trigger a repair.
- Fix runs after the PR ([ADR 12](0012-fix-runs-after-the-pr.md)) get their own repair rounds.
- Protected paths and security-sensitive changes still take the task over; only the reviewer's severity lost that power.
- Merging without a person is the goal; these priorities are one of the signals it will rest on.
- The 0.8 threshold is a guess until the timeline links these priorities to PR outcomes.
