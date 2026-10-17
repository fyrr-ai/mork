# 8. Credentials live in the egress sidecar

Date: 2026-10-11 · Status: Accepted

The separate push credential is superseded by [ADR 13](0013-one-github-token.md).

## Context

The agent held the LLM key and, in Build, the push token in its environment. A prompt injection in an issue, a file or a dependency could read them and send them anywhere.

## Decision

Each phase container runs next to an egress sidecar ([iron-proxy](https://github.com/ironsh/iron-proxy), Apache-2.0):

- Only the sidecar gets the LLM key and, in Build, the push token. It adds them as the `Authorization` header to requests for the LLM host and for the task's repository on `github.com`.
- The agent's processes go through it (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY` for Pi) and trust its CA, which the sidecar creates per task. Pi gets a placeholder key and git no credential helper.
- Inside the container, Pi runs as the user `agent` with a clean environment; the runner, as root, keeps its own tokens and never follows a symlink the agent owns.

An operator may also provide one service Authorization header and exact host to
a permitted phase's sidecar. This uses the same iron-proxy secret transform;
repository configuration cannot supply or redirect it. The service enforces
permissions, and deployment uses TLS. It is intentionally a single credential,
not a registry of application-specific integrations.

## Considered

- **Enforcing the network allowlist**: not possible on Fargate, which has no iptables. Requests outside the allowlist are logged, not blocked.

## Consequences

- A compromised agent can still reach the internet directly, but it has no key to use or leak.
- The push token works only for the task's repository, not for every allowlisted one.
- Each phase container has a second container and a per-task CA to start.
