# Configuration

Nothing about a deployment is hard-coded. A deployment is configured in three places:

1. the Terraform module's variables ([`infra/aws/variables.tf`](../infra/aws/variables.tf)), which set the environment of every Lambda and container;
2. secrets in AWS Secrets Manager, created by [`scripts/aws-secrets.sh`](../scripts/aws-secrets.sh);
3. `.mork/config.toml` and `AGENTS.md` in each repository Mork works on.

## Terraform variables

Required: `vpc_id`, `vpc_cidr_block`, `vpc_private_subnet_ids`, `repo_allowlist`, `llm_base_url`, `model`. Everything else has a default; see `variables.tf` for descriptions.

| Variable | Default | Purpose |
| --- | --- | --- |
| `name` | `mork` | Prefix of every resource |
| `environment` | `dev` | Environment label on logs |
| `llm_base_url`, `model` | — | The OpenAI-compatible LLM |
| `secret_prefix` | `mork` | Secrets Manager names are `<prefix>/<name>` |
| `github_auth_mode` | `token` | `app` uses a GitHub App installation; `token` uses a static token |
| `decision_providers` | `[]` | Development decision panel; Jev is required for Slack routing and is its sole provider |
| `repo_allowlist` | — | Repositories Mork may work on |
| `slack_channels` | `{}` | Channel ID → allowed workflows and default hint; development also needs repo and Jira project |
| `workflows` | `{}` | [Development and generic steps, prompts, domains, capacity, retry policy and delivery](workflows.md) |
| `routing_confidence` | `0.85` | Minimum Jev confidence before starting a workflow |
| `jira_base_url`, `jira_email` | `""` | Jira Cloud site and service account for Slack tasks |
| `station_size` | 2048 CPU, 8192 MiB, 40 GiB | Fargate size of a phase container |
| `supervise_seconds` | 45 | How often the supervisor checks a running station |
| `egress_enforce` | `false` | Block instead of log requests outside the allowlist |
| `otlp_endpoint`, `otlp_cidr_block` | `null` | Live log over OTLP/HTTP |
| `otel_resource_attributes` | `""` | Extra attributes on the live log |
| `grafana_url`, `grafana_loki_uid` | `null`, `loki` | Link to the live log in Grafana and its Loki data source |
| `bucket_expiration_days` | 120 | Retention of task outputs and sessions |
| `image_digests` | `{}` for ECR bootstrap only | Required runner, egress and lambda sha256 digests for full apply |
| `tags` | `{}` | Extra resource tags, merged with Service and Environment |

## Secrets

All secrets are `<secret_prefix>/<name>`. `scripts/aws-secrets.sh` reads each value from an environment variable and never prints it; unset ones get a placeholder the first time so the stack can be applied.

| Secret | Variable for the script | Held by | Scope |
| --- | --- | --- | --- |
| `llm-api-key` | `MORK_LLM_API_KEY` | egress sidecar, steps Lambda | the LLM API |
| `github-token` | `MORK_GITHUB_TOKEN` | Lambdas, runner and Build egress sidecar | Contents read/write, issues and pull requests read/write, checks and Actions read; no Workflows write |
| `github-app` | `MORK_GITHUB_APP` | Lambdas and trusted runners | JSON containing App ID, installation ID and the RSA private key; used instead of `github-token` |
| `webhook-secret` | generated | GitHub intake | webhook signatures |
| `jev-api-key`, `openai-api-key` | `JEV_API`, `OPENAI_API_KEY` | steps Lambda, runner; Jev also in the Slack worker | decision models; Jev required for Slack |
| `slack-signing-secret`, `slack-bot-token` | `MORK_SLACK_SIGNING_SECRET`, `MORK_SLACK_BOT_TOKEN` | Slack Lambda, steps, runner | Slack source (optional) |
| `jira-api-token` | `MORK_JIRA_API_TOKEN` | Slack Lambda, steps | Jira tracker (optional) |

Choose one GitHub credential type. Do not give the identity admin permissions, Workflows write permission or ruleset bypass.

### GitHub App

Set `github_auth_mode = "app"` in the deployment and store this JSON in `<secret_prefix>/github-app`:

```json
{"appId":"12345","installationId":67890,"privateKey":"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"}
```

Create the App under the organization that should own it. Set Contents, Issues and Pull requests to read/write, and Checks and Actions to read-only. Install it on selected repositories that match `repo_allowlist`. The App ID is in the App's General settings; the installation ID is the number in its installation settings URL. Generate an RSA private key in the App's General settings. The OAuth client secret is not used.

`MORK_GITHUB_APP` passes this JSON to `mise run secrets:put`, which validates it before writing any secrets. Configure no `MORK_GITHUB_TOKEN` in this mode. Terraform references the secret ARN, never its value.

Lambdas and trusted runners sign an App JWT and request an installation token scoped to the task repository. Tokens are cached and refreshed five minutes before expiry. Concurrent requests for the same repository share one mint request; renewal failures propagate rather than silently reusing a stale token. Warm Lambdas fetch a current token for each GitHub API call, and runners do so before each authenticated fetch or remote-head check.

In Build, the trusted runner also maintains `/mork-egress/github-token`, a root-owned file with mode `0600`. The proxy reads it with a 30-second cache and injects authentication only for the task repository's Git URLs. The proxy receives no App private key. The runner refreshes the file during long phases and stops the agent on renewal failure. Plan and Check do not grant proxy Git authentication. Every issued token is included in session/log redaction.

Installations are configured per deployment; automatic installation discovery is not implemented. Rotating the App private key requires updating the secret and restarting consumers so cached configuration is replaced. App webhooks may use the existing intake URL and webhook secret, or repository webhooks may remain configured separately.

### Static token

The default `github_auth_mode = "token"` supports one fine-grained machine-account token restricted to the repositories in `repo_allowlist`, with the permissions listed above. All consumers share its permissions. The runner holds it outside the agent's environment; only Build's proxy injects it into requests for the task repository. A manually supplied short-lived token still needs manual renewal.

## Repository configuration

Each repository needs `.mork/config.toml` on its default branch. Mork always reads it from the base commit, never from the agent's branch.

```toml
test = "npm test"                 # required
# setup = "npm ci"                # install before the tests
# checks = ["npm run lint"]       # further commands; verify and the gate run them
protected_paths = []              # a change here sends the task to a person
test_paths = ["test/", "tests/"]  # existing tests the agent must not change (default)

[hidden_tests]
dir = "test-hidden"               # where the gate writes the hidden tests
command = "node --test {file}"    # must contain {file}
file_suffix = ".test.mjs"
```

Rules for the agent go in `AGENTS.md`: the root file and files in subdirectories (a subdirectory's rules reach the agent before it first edits a file there).

## Environment reference

The Terraform module sets these; they are listed for running the code elsewhere. A variable `X` can be given as `X_SECRET_ID` (a Secrets Manager ARN or name) instead.

**Lambdas (`packages/steps`, `packages/sources`)**

| Variable | Purpose |
| --- | --- |
| `STATE_MACHINE_ARN` | Workflow the intakes start |
| `REPO_ALLOWLIST` | Comma-separated `owner/repo` |
| `WEBHOOK_SECRET`, `GITHUB_TOKEN` or `GITHUB_APP` | GitHub intake and steps; App credentials can use `GITHUB_APP_SECRET_ID` |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_CHANNELS` (JSON) | Slack source |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira tracker |
| `LLM_BASE_URL`, `LLM_API_KEY`, `MORK_MODEL` | One-shot LLM calls (clarifying questions, issue drafts) |
| `MORK_BUCKET`, `MORK_TIMELINE_TABLE`, `ECS_CLUSTER` | Storage and the cluster to stop tasks in |
| `MORK_GRAFANA_URL`, `MORK_GRAFANA_LOKI_UID` | Live-log link (optional; Loki data source uid defaults to `loki`) |

**Decision models (`packages/decision`)**

| Variable | Purpose |
| --- | --- |
| `JEV_API` (or `TYPESAFE_API_KEY`), `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL` | Jev |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_DECISIONS_MODEL` | OpenAI Decisions |
| `MORK_DECISION_PRIMARY` | Which configured provider decides; the others are recorded |

**Phase containers (`packages/runner`)**

| Variable | Purpose |
| --- | --- |
| `MORK_PHASE`, `MORK_BRIEF`, `MORK_TASK_TOKEN` | Set per run by Step Functions |
| `MORK_BUCKET`, `GITHUB_TOKEN` or `GITHUB_APP`, `MORK_MODEL`, `LLM_BASE_URL` | Inputs, GitHub authentication, LLM |
| `MORK_SUPERVISE_SECONDS` | Supervision interval |
| `MORK_EGRESS_PROXY`, `MORK_EGRESS_CA` | Sidecar address and CA (defaults `http://127.0.0.1:3128`, `/mork-egress/ca.crt`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`, `MORK_ENV` | Live log (optional) |
| `PI_BIN`, `MORK_EXTENSIONS`, `MORK_WORK`, `MORK_AGENT_*`, `MORK_SANDBOX_*` | Image layout; defaults match the Dockerfile |

**Egress sidecar (`images/egress`)**

| Variable | Purpose |
| --- | --- |
| `MORK_LLM_HOST`, `LLM_API_KEY` | Host the LLM key is injected for |
| `GITHUB_TOKEN`, `MORK_REPO` | Build only: the shared GitHub token, injected for this repository only |
| `GITHUB_TOKEN_FILE`, `MORK_REPO` | Build in App mode: root-owned renewable token file; no App private key in the proxy |
| `MORK_EGRESS_ALLOW` | This step’s allowed domains, comma separated; the LLM host is added automatically |
| `MORK_EGRESS_WARN` | `true` logs requests outside the allowlist, `false` blocks them |

**Scripts**

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MORK_NAME` | all | Deployment name (default `mork`) |
| `MORK_ACCOUNT` | `deploy.sh` | Refuse to deploy into another AWS account |
| `MORK_ECR_PREFIX`, `MORK_FUNCTIONS` | `deploy.sh` | Override image repository prefix and Lambda names |
| `MORK_INFRA_DIR` | mise infra tasks | Configured root module, default `infra/aws/examples/basic` |
| `MORK_STATE_MACHINE` | `watch-execution.sh` | State machine to follow |
| `MORK_SECRET_PREFIX` | `aws-secrets.sh` | Secret name prefix |

Keep these in `mise.local.toml` (not committed), together with `AWS_PROFILE` and `AWS_REGION`.
