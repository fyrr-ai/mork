# 13. One GitHub token

Date: 2026-10-13 · Status: Accepted

Mork uses one GitHub machine-account token for cloning, pushing branches and managing issues and PRs. Three separately configured credentials added provisioning and rotation work; the current deployment chooses one token restricted to its allowed repositories, with the combined permissions and no Workflows write permission.

Lambdas and the trusted runner hold this token. Only Build's egress sidecar injects it into the agent's requests for the task repository. Pi and repository commands keep a clean environment. A compromised token-holding component gains all the token's permissions, rather than the narrower permissions of one of three credentials.

This replaces the separate push credential described in [ADR 4](0004-the-implementer-pushes-its-own-branch.md) and [ADR 8](0008-credentials-live-in-the-egress-sidecar.md). Their branch rules and proxy-based authentication still apply.
