# Mork

Mork is a serverless software factory on AWS. Ask in Slack (`@mork add …`) or label a GitHub issue `factory`, and Mork plans the change, writes it, verifies it and opens a draft pull request with a recommendation of how carefully to review it. A person always merges.

- **Tests decide, not models.** An analyst agent writes hidden acceptance tests that must fail before the change; the implementer never sees them; an LLM-free gate runs them, the repository's own tests and checks, a diff policy and mutation checks.
- **Any OpenAI-compatible LLM** does planning, coding and review through the [Pi](https://pi.dev) agent harness.
- **An optional decision model** ([Jev](https://typesafe.ai) or OpenAI Decisions) triages requests, judges what tests cannot, supervises running agents and recommends the review depth. Hard rules always win.
- **The agent holds no keys.** An egress sidecar adds the LLM key and a narrowed push token to outgoing requests.
- **It keeps working after the PR:** red CI, requested changes or an `@mork` comment start a fix run on the same branch.
- **Serverless:** Step Functions, Fargate Spot tasks and Lambdas; nothing runs while it waits.

```text
Slack @mork / GitHub label → Start (triage) → Plan → Build → Check → Decide → draft PR
                                          ↑ hidden tests       ↓ gate + review
                                          └─── retry ──────────┘
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How it works: flow, verification, supervision, principles |
| [docs/deployment.md](docs/deployment.md) | Deploying to AWS, adding a repository, Slack |
| [docs/configuration.md](docs/configuration.md) | Terraform variables, secrets, `.mork/config.toml`, environment |
| [SECURITY.md](SECURITY.md) | Trust boundaries and known gaps |
| [docs/diagrams/](docs/diagrams/) | Workflow, verification and AWS diagrams (open in a browser) |
| [docs/research/](docs/research/) | Comparison with other background coding agents, sources |

## Layout

| Path | Contents |
| --- | --- |
| `packages/contracts` | Schemas shared between processes (zod) |
| `packages/steps` | Lambdas: GitHub intake, Start, Decide, Ask, Handover, fix runs |
| `packages/sources` | Slack intake and reporting, Jira as tracker |
| `packages/runner` | The Plan, Build and Check containers: Pi as user `agent`, the LLM-free gate as user `sandbox`, Pi extensions (`guard`, `submit_result`, `verify`, `ask`, `dir-rules`) |
| `packages/decision` | Decision models (Jev, OpenAI Decisions) behind one interface, policies, evidence budgets |
| `packages/timeline` | Decision timeline in DynamoDB and export for calibration |
| `packages/store` | The factory bucket |
| `images/egress` | Egress sidecar (iron-proxy) configuration |
| `infra/aws` | Terraform module for the whole deployment |
| `scripts/` | Deploy, secrets, rulesets, execution watcher |
| `Dockerfile` | Targets `runner`, `egress`, `lambda` |

## Development

```sh
mise install
bun install --frozen-lockfile
mise run check    # tests, typecheck, lint
```

Tests run with Bun; the containers and Lambdas run on Node 24 with TypeScript type stripping, without a build step.

## Status

Mork is young. It has been tested end to end on AWS, including Spot interruptions, fix runs and concurrent triggers, but only on small repositories. Read [SECURITY.md](SECURITY.md) before pointing it at code that matters.
