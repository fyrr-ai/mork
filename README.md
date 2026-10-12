# Mork

[Configured workflows](docs/workflows.md) let one Slack app route through Jev to
separate workflows defined in Terraform, with development operations, agent, command and approval steps.

Mork runs agent workflows on AWS. Its development workflow takes a Slack request (`@mork add …`) or a GitHub issue labeled `mork`, plans the change, writes it, verifies it and opens a draft pull request with a recommendation of how carefully to review it. A person always merges.

- **Tests decide, not models.** An analyst agent writes hidden acceptance tests that must fail before the change; the implementer never sees them; an LLM-free gate runs them, the repository's own tests and repository checks, a diff policy and mutants.
- **Any OpenAI-compatible LLM** does planning, coding and review through the [Pi](https://pi.dev) agent harness.
- **Jev routes Slack requests** to workflows allowed in that channel. The development decision panel can use [Jev](https://typesafe.ai) or OpenAI Decisions for triage, review and supervision. Hard rules always win.
- **Development credentials stay in the sidecar.** It adds the LLM key and a narrowed push token to outgoing requests. Configured steps receive only their explicitly granted service credentials.
- **It keeps working after the PR:** red CI, requested changes or an `@mork` comment start a fix run on the same branch.
- **Serverless:** Step Functions, Fargate tasks and Lambdas; nothing runs while it waits. Each container step configures Spot or on-demand capacity, its own fallback and allowed domains.

```text
Slack @mork / GitHub label → Start (triage) → Plan → Build → Check → Decide → draft PR
                                          ↑ hidden tests       ↓ gate + review
                                          └─── retry ──────────┘
```

## Documentation

| Document | Contents |
| --- | --- |
| [CONTEXT.md](CONTEXT.md) | Glossary: the words Mork's code and docs use |
| [docs/architecture.md](docs/architecture.md) | How it works: flow, verification, supervision, principles |
| [docs/adr/](docs/adr/) | Architecture decisions and why they were made |
| [docs/deployment.md](docs/deployment.md) | Deploying to AWS, adding a repository, Slack |
| [docs/workflows.md](docs/workflows.md) | Configure development, analysis, dashboards and approval steps |
| [docs/image-startup.md](docs/image-startup.md) | SOCI packaging and startup measurement |
| [docs/configuration.md](docs/configuration.md) | Terraform variables, secrets, `.mork/config.toml`, environment |
| [SECURITY.md](SECURITY.md) | Trust boundaries and known gaps |
| [docs/local-verification.md](docs/local-verification.md) | Run the real gate without AWS |
| [docs/releasing.md](docs/releasing.md) | Clean source export and release checks |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor setup and review |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party licenses and provenance |
| [docs/diagrams/](docs/diagrams/) | Workflow, verification and AWS diagrams (open in a browser) |
| [docs/research/](docs/research/) | Comparison with other background coding agents, sources |

## Layout

| Path | Contents |
| --- | --- |
| `packages/contracts` | Schemas shared between processes (zod) |
| `packages/steps` | Lambdas: GitHub intake, development and configured workflow actions, PR repair runs |
| `packages/sources` | Slack intake and reporting, Jira as tracker |
| `packages/runner` | The Plan, Build and Check containers: Pi as user `agent`, the LLM-free gate as user `sandbox`, Pi extensions (`guard`, `submit_result`, `verify`, `ask`, `dir-rules`) |
| `packages/decision` | Decision models (Jev, OpenAI Decisions) behind one interface, policies, evidence budgets |
| `packages/timeline` | Decision timeline in DynamoDB and export for calibration |
| `packages/store` | The Mork bucket |
| `images/runner`, `images/lambda` | Minimal rootfs and runtime assets |
| `images/bundle.ts` | Frozen dependency bundling and bundle input metadata |
| `images/egress` | Egress sidecar (iron-proxy) configuration |
| `infra/aws` | Terraform module for the whole deployment |
| `scripts/` | Deploy, secrets, rulesets, execution watcher |
| `Dockerfile` | Targets `runner`, `egress`, `lambda` |

## Development

```sh
mise trust
mise install
mise run install
mise run check    # tests, types, lint, scripts, offline infrastructure plans
```

Tests run with Bun. Production images bundle TypeScript into JavaScript with Bun and execute it on Node 24. `workflow:local` runs the development workflow without AWS; `workflow:configured` runs generic steps. See [local verification](docs/local-verification.md).

## Status

Mork is experimental. The current configured workflows have local Pi integration, production-image smoke tests, sandbox tests and mocked AWS plans. Earlier development versions were exercised on AWS with small repositories; that does not validate this revision or a fresh deployment. Read [SECURITY.md](SECURITY.md) before pointing it at code that matters.

## License

[Apache License 2.0](LICENSE).
