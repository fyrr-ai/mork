# Security

Mork runs an LLM agent on code and text it does not control: issue bodies, Slack messages, PR comments, repository files, test output. Treat the agent as untrusted. This document lists what the design relies on and what it does not protect against yet.

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainers through GitHub's private vulnerability reporting on this repository, not in a public issue.

## Boundaries

| Boundary | Enforced by | Against |
| --- | --- | --- |
| The agent holds no credential | Egress sidecar (iron-proxy) adds the LLM key and the push token on the way out; the agent's environment is clean | Credential theft through prompt injection |
| Push only to the task's repository | The sidecar injects the push token only for the task's repository paths; rulesets keep the default branch PR-only | Writing to other repositories or to the default branch |
| Hidden tests stay hidden | The Build role cannot read `hidden/`; hidden tests are written into the Check checkout only after the repository's own commands ran, root-owned and read-only, before each run | Gaming or rewriting the oracle |
| The gate cannot be talked into a result | No LLM; repository commands run as `sandbox` in a fresh clone; everything read from git happens before repository code runs, with `--no-textconv` | Code executing as root through git configuration |
| Root never follows agent-planted links | Agent-owned files are read with `O_NOFOLLOW` and written with `O_EXCL`; exports happen in root-owned directories | Escalation from the agent user to root |
| A PR only for the tested commit | Decide compares the branch head with the commit the gate tested | Pushes after the gate |
| Trust is decided at intake | Signed webhooks; label requires triage access, PR fix triggers require write access; empty secrets reject | Spoofed or unauthorized triggers |
| Human merge | Draft PRs only; the default-branch ruleset requires a fresh approval from someone other than the last pusher | Unreviewed code landing |

## Known gaps

- **Network egress is not enforced.** The sidecar logs hosts outside its allowlist; the agent can bypass the proxy and reach the internet directly (Fargate allows no iptables inside a task). It cannot get the keys this way, but it can exfiltrate the repository's source. Enforce egress with AWS Network Firewall or a dedicated VPC with Route 53 Resolver DNS Firewall.
- **IAM is per phase, not per task.** A compromised runner could read or write other tasks' outputs in the bucket, and every phase role can read the Slack bot token.
- **Other `mork/*` branches.** Inside the task's repository the push token can update other Mork branches; the proxy cannot see refs inside the git protocol.
- **Failing hidden tests reveal expectations.** Their output is fed back to the implementer so it can fix the code.
- **Slack has no user allowlist.** Anyone who can post in a mapped channel can start a task.
- **Redaction is best effort.** Session transcripts have the container's secret values removed; encoded forms are not.
