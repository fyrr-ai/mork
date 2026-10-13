# 4. The implementer pushes its own branch

Date: 2026-10-10 · Status: Accepted

The separate push credential is superseded by [ADR 13](0013-one-github-token.md).

## Context

At first Build had no push access. The implementer's work left the container as a git bundle in the bucket and a separate Push step applied it to GitHub. That was one more step to retry and one more place where the tested commit and the pushed commit could differ.

## Decision

The implementer pushes its own `mork/…` branch:

- The push token is narrowed: allowlisted repositories, Contents read/write, no Workflows. Since [ADR 8](0008-credentials-live-in-the-egress-sidecar.md) only the egress sidecar holds it, and only for the task's repository.
- The guard allows only `git push origin <its branch>`, without force; the runner verifies GitHub holds its last commit.
- Repository rulesets keep the default branch PR-only with a fresh approval and limit the Write-role agent to creating, updating and deleting `mork/*` branches, with no tag writes.
- The gate after tests the pushed commit, and Decide opens the PR only while the branch still points at the commit the gate tested.

## Considered

- **Push step with a bundle**: replaced, see above.

## Consequences

- Work in progress survives an early stop: the runner pushes it, and the next attempt continues from the branch.
- The token can still update other `mork/*` branches in the same repository; the proxy cannot see refs inside the git protocol (listed in `SECURITY.md`).
- Rulesets are available for public repositories on GitHub Free. Private repositories need an eligible paid plan. The agent account must have Write access and no bypass.
