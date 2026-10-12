# Security

Mork runs an LLM agent on code and text it does not control: issue bodies, Slack messages, PR comments, repository files, test output. Treat the agent as untrusted. This document lists what the design relies on and what it does not protect against yet.

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainers through GitHub's private vulnerability reporting on this repository, not in a public issue.

## Boundaries

The table describes the development workflow. [Configured workflows](docs/workflows.md)
use separate roles per step and expose only the named predecessor artifacts.
Their agents and commands receive no runner AWS credentials. An administrator
can explicitly grant other service credentials to a step through Secrets Manager;
that step can use and disclose those credentials. Tool allowlists control which Pi
tools are exposed, while a bash tool can still run programs and write files.

| Boundary | Enforced by | Against |
| --- | --- | --- |
| The agent holds no credential | Egress sidecar (iron-proxy) adds the LLM key and the push token on the way out; the agent's environment is clean | Credential theft through prompt injection |
| Push only to the task's repository | The sidecar injects the push token only for the task's repository paths; rulesets keep the default branch PR-only and block a Write-role agent from changing other branches or tags | Writing to other repositories or to the default branch |
| Hidden tests stay hidden | The Build role cannot read `hidden/`; hidden tests are written into the Check checkout only after the repository's own commands ran, root-owned and read-only, before each run | Gaming or rewriting the oracle |
| The gate cannot be talked into a result | No LLM; repository commands run as `sandbox` in a fresh clone; tracked files and git metadata are root-owned and read-only with sticky parent directories; fingerprints are checked after each command; git inspection happens before commands run, with `--no-textconv` | Code executing as root through git configuration |
| Root never follows agent-planted links | Each ancestor is opened with `O_NOFOLLOW` and pinned by a directory descriptor; files use `O_NOFOLLOW` on read and `O_EXCL` on write; exports happen in root-owned directories | Escalation from the agent user to root |
| A PR only for the tested commit | Decide compares the branch head with the commit the gate tested | Pushes after the gate |
| Trust is decided at intake | Signed webhooks; label requires triage access, PR fix triggers require write access; empty and placeholder signing secrets reject | Spoofed or unauthorized triggers |
| Human merge | Draft PRs only; the default-branch ruleset requires a fresh approval from someone other than the last pusher | Unreviewed code landing |

## Known gaps

- **Repository commands can manipulate test execution.** The gate protects tracked source and metadata, but dependencies, interpreters, generated outputs and test exit codes still execute repository-controlled code. A malicious test runner can falsely report success. Filesystem protection proves that commands could not rewrite the checked source; it does not prove the test runner itself is honest.
- **Local gate privileges.** `gate:local` runs commands as your current non-root user and detects tracked-file changes. It has no separate sandbox identity, network isolation or protection for your home directory. Run it only on trusted repositories. The fd-based file helpers and production sandbox require Linux with `/proc`.
- **Network egress is not enforced.** The sidecar logs hosts outside its allowlist; the agent can bypass the proxy and reach the internet directly (Fargate allows no iptables inside a task). It cannot get the keys this way, but it can exfiltrate the repository's source. Enforce egress with AWS Network Firewall or a dedicated VPC with Route 53 Resolver DNS Firewall.
- **IAM is per phase or configured step.** A compromised development runner could access other tasks' phase outputs; generic step roles reach their workflow's permitted artifacts across executions. Development phase roles can read the Slack bot token. Per-execution isolation is not wired into these roles.
- **Other `mork/*` branches.** Inside the task's repository the push token can update other Mork branches; the proxy cannot see refs inside the git protocol.
- **Failing hidden tests reveal expectations.** Their output is fed back to the implementer so it can fix the code.
- **Slack has no user allowlist.** Anyone who can post in a mapped channel can start a task.
- **Redaction is best effort.** Raw secret values and their JSON-escaped forms are removed. Other encodings can remain.
