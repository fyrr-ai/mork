# 10. No scope judge

Date: 2026-10-11 · Status: Accepted

## Context

For one day Decide had a scope judge: the reviewer listed changes the request did not ask for, the decision model weighed them, and a confident "out of scope" sent the work back to Build with what to revert. Spotify removed the same kind of judge from its background agent because it was too rigid and blocked valid changes. Ours had never been measured.

## Decision

The scope judge is removed. The reviewer no longer lists out-of-scope changes, Check no longer stores a diff excerpt for it, and the timeline has no "scope" decision point. The implementer's `verify` tool, added together with it, stays.

## Consequences

- Unrequested changes reach the person reviewing the PR; the reviewer's findings and the diff size still raise the recommendation.
- A scope check can come back once the timeline shows how often PRs are rejected for scope; it should start as a recorded decision point, not as a gate.
