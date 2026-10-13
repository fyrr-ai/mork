# Mork and other agent platforms

Checked against public sources on 13 October 2026. This is a comparison of
published designs and Mork's current implementation.
Stripe, Uber, Ramp, Spotify and Shopify describe internal systems; GitHub Copilot
is a hosted product, and Meta RADAR is a review and landing system.

## Reading the README matrix

The [matrix source](diagrams/readme-comparison.html) keeps the CTO presentation's
layout. Its markers distinguish documented capabilities, partial coverage,
unconfirmed features and known absences. Each column describes the system named
in the source links below; the Meta column covers RADAR, and Copilot includes
its cloud agent and [code review](https://docs.github.com/en/copilot/responsible-use/agents).

- The tests row covers deterministic verification during the workflow. It does
  not assert that every system waits for checks before creating its first draft PR.
- The hidden-tests row means acceptance tests withheld from the implementing
  agent. Published test generation or an abstract verification tool alone does
  not establish that boundary.
- Shopify describes sandboxes that are sometimes warm and often fresh, so its
  warm-environment marker is partial. Meta's automatic landing is restricted to
  eligible changes. Ramp's PR discussion is documented; automatic CI repair is
  unconfirmed in the linked post.
- Copilot's firewall and Mork's proxy have different coverage limits. Mork's
  direct egress remains open. The partial markers are explained in the security
  sources, and do not establish equivalent protection.

## Shared patterns and differences

| System and source | Published design | Mork's implementation and limits |
| --- | --- | --- |
| [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) | Blueprints combine deterministic operations and agent loops. Agents use prepared EC2 devboxes; humans review their changes. | Agent, command and approval steps run under Step Functions. Development has a fixed Plan/Build/Check order. Fargate tasks start per step; there is no warm workspace pool. |
| [Uber's software factory](https://ai.engineer/talks/17-YSUHo6Lk-agentic-sdlc-at-uber-building-blocks-ubers) | Shared model and tool gateways, prepared DevPods, validation before CI, and a table of checks for reviewers. The talk describes components at different rollout stages. | Mork has a sidecar for model and push credentials, a development verification tool, a gate and a PR checks table. It has no shared MCP gateway, context graph or prepared DevPod pool. |
| [Uber uReview](https://www.uber.com/us/en/blog/ureview/) | Specialized reviewers generate findings; subsequent stages grade, merge duplicates and filter categories using feedback. | Mork runs a reviewer after the gate passes and records evidence for its decisions. It does not implement uReview's feedback-trained category filters. |
| [Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) | Full-stack sandboxes, prepared repositories, browser verification, screenshots and collaborative sessions. | Mork starts containers with configured tools and saves results. Service access and browser checks require supplied tools or commands; a live browser preview and multiplayer editor are not built in. |
| [Spotify Honk](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) | A verification tool wraps component-specific checks. Verifiers run again before a PR; failed verification stops publication. | Build can call `verify` for repository checks. A separate gate also runs acceptance tests withheld from Build. Post-PR CI and review feedback can trigger bounded fix runs. |
| [Shopify River / Aquifer](https://shopify.engineering/under-the-river) | Durable sessions survive disposable execution. Different agent profiles share the platform, and the agent loop runs outside the sandbox. | Workflows share orchestration, images and artifact storage. Step results and sessions persist in S3. Pi runs inside the Fargate task as a separate user; this is a different boundary from Aquifer's external agent loop. |
| [Meta RADAR](https://arxiv.org/abs/2605.30208) | Eligibility rules, risk scoring, automated review and deterministic validation allow qualifying changes to land automatically. | A separate decision model recommends review depth under hard rules. Thresholds are not yet calibrated from production outcomes, and Mork never merges its generated PRs. |
| [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github) · [security controls](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations) | GitHub Actions provides the execution environment. Draft PRs require human review, and a firewall limits network access. | Mork deploys in your AWS account and uses an OpenAI-compatible provider of your choice. Its proxy allowlist does not block traffic that bypasses the proxy. See [security boundaries](../SECURITY.md). |

Additional entry-point sources: [Stripe's Slack-to-PR flow](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents),
[Spotify's Slack interface](https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint)
and [Copilot in Slack](https://docs.github.com/en/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack).

## What Mork emphasizes

- **Workflow configuration.** Instructions, tools, models, credentials and limits
  belong to the job's steps. Generic workflows combine agents, commands and human
  approvals. Development keeps its Plan/Build/Check contracts and draft PR delivery.
- **Acceptance tests outside Build.** The analyst writes tests that must fail on
  the base commit. Build cannot read their files. Check runs them against the
  pushed commit; failure feedback can still reveal the expected behavior.
- **Evidence for human review.** The PR records repository checks, acceptance
  tests, diff policy and code-review findings. Fix runs update the same branch
  and post another checks table.
- **A separate decision model.** It advises on review depth and supervises
  development runs. Hard rules can only increase caution. The timeline records
  decisions and outcomes for later calibration.

The public sources describe different tasks and environments. Measuring relative
accuracy or performance requires comparable production tasks; Mork has no such
benchmark yet. See [architecture](architecture.md) and
[workflow configuration](workflows.md) for the implementation.

## Useful practices Mork does not yet provide

| Practice | Published example | Current gap |
| --- | --- | --- |
| Prepared workspaces | Stripe devboxes, Uber DevPods and Ramp snapshots | SOCI packaging is available, but it does not prepare a repository or warm its dependency caches. Startup gains still need measurement. |
| Review feedback used to tune findings | Uber uReview | Mork records decisions and outcomes, but does not automatically learn which finding categories to suppress. |
| Browser evidence for UI work | Ramp Inspect and Uber's feature walkthrough | Screenshots and application checks must be supplied through tools or commands. |
| Network enforcement | [Copilot firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall) | Mork's proxy rules cannot prevent direct egress. Network-level enforcement remains deployment work. Copilot's documented firewall also has coverage limits. |

Mork is experimental. Its current workflows have local integration and
production-image tests; this revision has not been validated on a fresh AWS
deployment. Published adoption and throughput figures for other systems do not
establish Mork's performance or readiness.
