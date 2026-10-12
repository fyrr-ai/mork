# Sources and background

As of 2026-10-10. Vendor figures are not independently verified.

## Starting projects

- **[vercel-labs/eve-software-factory-template](https://github.com/vercel-labs/eve-software-factory-template)** (Foreman, MIT). The analysis is in [eve-foreman/](eve-foreman/README.md).
- **[aws-samples/sample-autonomous-cloud-coding-agents](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents)** (MIT-0, CDK, Python agent on the Claude Agent SDK). Mork took:
  - the Fargate pattern: ARM64, build task 4 vCPU / 16 GB, read-only task 2 vCPU / 8 GB, payload through S3, `clientToken = taskId`,
  - rules from the Cedar policies, the output scanner and the verify steps.

  Mork did not take, and why:
  - **a shared PAT**, with `GH_TOKEN` in the agent's environment,
  - **the DNS Firewall**, which is in ALERT mode only by default,
  - **a hanging Fargate task** that nobody stops after a timeout,
  - **missing approval tables on ECS**, so a soft-deny always denies,
  - **acceptance-criteria judging**, which exists only in the design documents.

## Decision models

| Model | Where it runs | Notes |
| --- | --- | --- |
| [TypeSafe Jev](https://docs.typesafe.ai/api) | TypeSafe API (`POST /v1/systemone`), OpenRouter, Vercel AI Gateway | Early access since 2026-09-15. Question types `choice`, `score`, `noul`. Limit of 32k/64k tokens. Not on Bedrock |
| [OpenAI Decisions](https://letsdatascience.com/news/openai-opens-decisions-api-public-beta-b69a1e40) | OpenAI API (`POST /v1/decisions`, `gpt-6-luna`) | Public beta since 2026-10-06, EEA residency, ZDR. GPT-6 Luna is on Bedrock only in `us-east-1`; the Decisions API is not confirmed there |
| [Strands Decider](https://github.com/strands-labs/strands-decider) | Self-hosted (AWS Strands Labs) | Apache-2.0, same `/v1/systemone` contract. Sizes 2B–26B-A4B, 4,096-token window. Part of the training data has non-commercial terms, so check the license terms before production use |

## Agent harness (why Pi)

| Harness | For | Against |
| --- | --- | --- |
| [Pi](https://pi.dev/docs/latest/rpc) (chosen) | Small, TS SDK, custom OpenAI-compatible provider, `steer` in RPC | No sandbox and no permission system, loads `.pi/` from the repo, limits must be written by hand |
| [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode) | `--output-schema`, built-in sandbox, ignores provider config from the repo | Tuned for OpenAI models, risk of tool incompatibility with other OpenAI-compatible LLMs |
| [OpenCode](https://opencode.ai/docs/permissions/) | `@ai-sdk/openai-compatible` provider, allow/ask/deny rules | The rules are not a sandbox, runs as a server |
| OpenHands SDK | Experience from SWE-bench and issue resolution | The sandbox needs Docker (does not fit Fargate), heavy, the API changes quickly |
| Strands harness SDK | Hooks to cancel a tool call | A construction kit, not a coding agent |

Security analysis of Pi: [agent-safehouse](https://agent-safehouse.dev/docs/agent-investigations/pi).

## Jev ecosystem ([awesome-jev](https://github.com/yibie/awesome-jev))

The list itself says that inclusion is not an endorsement. The projects are weeks old and mostly single-author. Mork uses design patterns from these projects; the table does not establish code-level provenance. Third-party licenses and notices are recorded in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

| Project | License | What Mork takes |
| --- | --- | --- |
| [thruwire/foreman](https://github.com/thruwire/foreman) | MIT | Agent supervision (stuck / off-track / progress → steer → retry), evidence providers with byte budgets, an append-only timeline. The authors state that they have not verified the accuracy of Jev's judgments |
| [jev-proof](https://github.com/klauswg/jev-suite/tree/master/jev-proof) | MIT | A gate for untestable criteria: PASS/FAIL/REVIEW, "no evidence, no pass" |
| [jev-review](https://github.com/devagrawal09/jev-review) | MIT | Questions about change risk and owner selection |
| [DiffJury](https://github.com/raihankhan-rk/diffjury) | no license | Inspiration only: questions about PR risk |
| [Jev-Code-Reviewer](https://github.com/egma-ai/jev-code-reviewer) | MIT | Hunk reading order P0/P1/P2 |
| [jevcal](https://github.com/abhixhek/jevcal) | MIT | Threshold calibration, escalation share, a CI safeguard. States that TypeSafe restricts publishing Jev performance numbers |
| [Decision Models Showdown](https://github.com/ivipinmishra/decision-models-showdown) | no license | Inspiration only: Jev vs OpenAI on the same questions |
| [jevcompat](https://github.com/mandu5/jevcompat) | MIT | Contract tests for `/v1/systemone` |

Conclusion of the survey: nobody has shown that Jev reliably recognizes correct code. Strong verification is always deterministic. That is why in Mork tests decide whether the code works, and Jev only recommends.
