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
| `decision_providers` | `[]` | Ordered `{ name, base_url, model }` with name `jev` or `openai`; the first decides, the others are recorded; empty means no decision model |
| `repo_allowlist` | — | Repositories Mork may work on |
| `slack_channels` | `{}` | Channel ID → `{ repo, jira_project, jira_components }` |
| `jira_base_url`, `jira_email` | `""` | Jira Cloud site and service account for Slack tasks |
| `phase_seconds` | 7200 each | Backstop timeout per phase |
| `station_size` | 2048 CPU, 8192 MiB, 40 GiB | Fargate size of a phase container |
| `spot_attempts` | 4 | Spot retries before a phase moves to on-demand Fargate |
| `supervise_seconds` | 45 | How often the supervisor checks a running station |
| `answer_seconds` | 259200 | How long a question waits for an answer |
| `egress_allow` | `[]` | Extra hosts for the egress sidecar's allowlist |
| `egress_enforce` | `false` | Block instead of log requests outside the allowlist |
| `otlp_endpoint`, `otlp_cidr_block` | `null` | Live log over OTLP/HTTP |
| `otel_resource_attributes` | `""` | Extra attributes on the live log |
| `grafana_url`, `grafana_loki_uid` | `null`, `loki` | Link to the live log in Grafana and its Loki data source |
| `bucket_expiration_days` | 90 | Retention of task outputs and sessions |
| `image_tag` | `current` | Tag the deploy script moves |

## Secrets

All secrets are `<secret_prefix>/<name>`. `scripts/aws-secrets.sh` reads each value from an environment variable and never prints it; unset ones get a placeholder the first time so the stack can be applied.

| Secret | Variable for the script | Held by | Scope |
| --- | --- | --- | --- |
| `llm-api-key` | `MORK_LLM_API_KEY` | egress sidecar, steps Lambda | the LLM API |
| `github-token` | `MORK_GITHUB_TOKEN` | Lambdas | issues, pull requests, labels, comments, checks |
| `github-read-token` | `MORK_GITHUB_READ_TOKEN` | runner in the containers | read-only contents; must differ from `github-token` |
| `github-push-token` | `MORK_GITHUB_PUSH_TOKEN` | egress sidecar in Build | Contents read/write on the allowlisted repositories, no Workflows |
| `webhook-secret` | generated | GitHub intake | webhook signatures |
| `jev-api-key`, `openai-api-key` | `JEV_API`, `OPENAI_API_KEY` | steps Lambda, runner | decision models (optional) |
| `slack-signing-secret`, `slack-bot-token` | `MORK_SLACK_SIGNING_SECRET`, `MORK_SLACK_BOT_TOKEN` | Slack Lambda, steps, runner | Slack source (optional) |
| `jira-api-token` | `MORK_JIRA_API_TOKEN` | Slack Lambda, steps | Jira tracker (optional) |

Use a GitHub App or fine-grained tokens owned by a machine account, not by a repository admin (an admin token bypasses rulesets).

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
| `WEBHOOK_SECRET`, `GITHUB_TOKEN` | GitHub intake and steps |
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
| `MORK_BUCKET`, `GITHUB_READ_TOKEN`, `MORK_MODEL`, `LLM_BASE_URL` | Inputs, clone, LLM |
| `MORK_SUPERVISE_SECONDS` | Supervision interval |
| `MORK_EGRESS_PROXY`, `MORK_EGRESS_CA` | Sidecar address and CA (defaults `http://127.0.0.1:3128`, `/mork-egress/ca.crt`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`, `MORK_ENV` | Live log (optional) |
| `PI_BIN`, `MORK_EXTENSIONS`, `MORK_WORK`, `MORK_AGENT_*`, `MORK_SANDBOX_*` | Image layout; defaults match the Dockerfile |

**Egress sidecar (`images/egress`)**

| Variable | Purpose |
| --- | --- |
| `MORK_LLM_HOST`, `LLM_API_KEY` | Host the LLM key is injected for |
| `GITHUB_PUSH_TOKEN`, `MORK_REPO` | Build only: the push token, injected for this repository only |
| `MORK_EGRESS_ALLOW` | Extra allowlisted hosts, comma separated |
| `MORK_EGRESS_WARN` | `true` logs requests outside the allowlist, `false` blocks them |

**Scripts**

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MORK_NAME` | all | Deployment name (default `mork`) |
| `MORK_ACCOUNT` | `deploy.sh` | Refuse to deploy into another AWS account |
| `MORK_ECR_PREFIX`, `MORK_FUNCTIONS` | `deploy.sh` | Override image repository prefix and Lambda names |
| `MORK_STATE_MACHINE` | `watch-execution.sh` | State machine to follow |
| `MORK_SECRET_PREFIX` | `aws-secrets.sh` | Secret name prefix |

Keep these in `mise.local.toml` (not committed), together with `AWS_PROFILE` and `AWS_REGION`.
