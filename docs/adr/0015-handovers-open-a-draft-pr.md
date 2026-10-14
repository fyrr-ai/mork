# 15. Handovers open a draft PR

Date: 2026-10-14 · Status: Accepted

## Context

A handover left a comment, a label and a branch. The person taking over had to find the branch and open a PR themselves, and Mork's work had no place where its reasons, checks and transcripts sat next to the code. A takeover by the recommendation threw away a change that had passed its tests.

## Decision

When Mork hands a task over and its branch has commits beyond the base commit, the Handover step opens a draft PR from that branch, or finds the one already open. The PR carries the `needs-human` label, the reason, links to the transcripts and the tracker footer, and its record is saved like any Mork PR, so `@mork`, a requested change or red CI on it start a fix run.

Tasks without pushed work (Start or Plan failed, Build never pushed) still end with the comment and the label only. Fix runs that hand over comment on their existing PR as before. A failure to open the PR is logged and does not stop the handover.

## Consequences

- Every handed-over change with code is reviewable where reviews happen; the label, not the absence of a PR, tells a person it needs them.
- Draft PRs of handovers may not pass their checks; the PR text says so.
- Moving from draft PRs to merging without a person needs the same PR in every case, so this is a step towards it.
