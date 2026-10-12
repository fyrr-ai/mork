# Mork vs. background coding agents at large companies

As of 2026-10-11. This document compares Mork (Slack or GitHub issue → Step Functions → Fargate Plan/Build/Check → decision model → draft PR) with the internal systems at Stripe, Ramp, Coinbase, Spotify, Shopify, Uber, Meta, Google and Airbnb, and with the products GitHub Copilot, OpenAI Codex, Devin, Cursor, Claude Code, Jules and Factory.

Markers: **[F]** first-party source (blog, paper, talk), **[S]** secondary source, **[I]** this document's own estimate. Sources are at the end.

## Summary

1. **The architecture matches where everyone is converging.** Input from Slack, an isolated container per task, deterministic checks before the PR, a draft PR on a dedicated branch, a human merges, a live log, a cap on attempts. Mork leaves out nothing essential here.
2. **Two parts of Mork have no published equivalent:**
   - **Hidden acceptance tests.** A separate analyst writes them and the implementer never sees them. The closest are Spotify ("describe the end state as tests") and Meta ACH (tests validated by mutants).
   - **A separate decision model that recommends review depth.** The closest is Meta RADAR (risk score plus trust by diff source).

   Both are differences, not proven advantages. They need to be measured.
3. **Secrets and network.** Commercial products keep the agent behind an egress allowlist and give it no credentials. Mork uses an egress sidecar: the sidecar holds the keys, the agent does not. An enforced network allowlist is not in place yet.
4. **The loop after the PR opens.** Most systems react to red CI and to review comments. Mork does too (red CI, "Request changes", `@mork` in a comment).
5. **LLM scope judge.** Spotify had one, it vetoed about 25 % of runs, and Spotify dropped it as too rigid. Mork tried one briefly and removed it.

## System overview

| System | Input | Runtime | Verification | Human and merge | Scale |
| --- | --- | --- | --- | --- | --- |
| **Stripe Minions** [F] | Slack thread, CLI, web, internal tools, a "fix with minion" button on flaky tests | Pre-warmed devbox (EC2), ~10 s start, caches already warm; QA environment with no production data and no open egress | "Blueprints": deterministic nodes (lint, push) alternating with agent nodes; lint < 5 s, then a selection from 3M+ tests in CI; **at most 2 CI rounds**, then a human | PR from a template, another engineer reviews | 1,300+ merged PRs per week |
| **Ramp Inspect** [F] | Slack (a classifier picks the repo), web with VS Code, Chrome extension, PR comments, voice | Modal sandbox with the full stack (Postgres, Redis…), repo image snapshot every 30 min, startup begins while the user is still typing | Tests, telemetry, feature flags; frontend in a real browser with before/after screenshots in the PR | The PR is opened with the **requester's token**, so the requester cannot approve it; multiplayer sessions | 50–75 % of merged PRs |
| **Coinbase Forge** [S] | Slack → Linear issue → PR → back to the thread | Not documented | Not documented | Engineers review the night's PRs in the morning | "Autonomous operation time" metric; model router by price and cache, testing GLM 5.2 as the default |
| **Spotify Honk** [F] | Fleet Management (migrations across hundreds of repos), Slack, API | Container with a minimal set of binaries; **the agent does not push**, the surrounding system pushes and posts to Slack | One `verify` tool (verifiers are enabled per repo), a stop hook blocks the PR; LLM judge **dropped** in 2026; PR only after green CI | Review is the bottleneck; they consider self-approval by the migration owner and auto-merge for docs only | 1,000 PRs in 10 days |
| **Shopify River** [F] | `@river` in **public** channels only | Session = append-only log in Postgres, harness outside the sandbox, both single-use; **Pi** is one of the profiles | Tests, CI, merge queue | A human reviews | 1 in 8 merged PRs, merge rate 36 % → 77 % in 2 months |
| **Uber Minion + uReview** [F] | Cortana (Slack, CLI, web) | Pre-built DevPods on K8s, Model Gateway with PII redaction, MCP Gateway with 1,000+ tools | Inner loop (lint auto-fix, screenshots vs Figma, a small review model), **CI only after validation**; uReview: generator + grader + suppression of categories with historically poor feedback | Draft PR with a **table of the checks that ran** | 70 % of PRs involve an agent, 11 % of PRs are opened by an agent |
| **Meta RADAR** [F] | (auto-review of diffs) | — | Diff risk score (Llama) + LLM reviewer ≥ 8/10 + "safe" categories only | **Auto-land with a veto delay**; threshold by source (AI runbook P50, bot P20, human P5), a runbook needs 60 days without a problem | 331k diffs landed, 1/3 the reverts and 1/50 the incidents of other diffs |
| **Meta ACH / TestGen** [F] | — | — | Tests must pass filters: build, pass, 5× without flakiness, coverage increase; ACH generates mutants and the tests that kill them | 73 % accepted | — |
| **Google migrations** [F] | Deterministic file discovery | Internal | Build + tests, several prompt variants in parallel, selection by validation; **an AST check rejects changes outside the scope** | Normal review, generation volume **throttled to reviewer capacity** | 80 % of migration code written by AI |
| **Airbnb** [F] | Test migration | — | Per-file state machine (refactor → Jest → lint → done), ~10 attempts, long tail of 50–100 | The last 3 % by hand | 1.5 years → 6 weeks |
| **GitHub Copilot** [F] | Issue, Jira, Linear, Slack, plan | Actions VM, 59 min, firewall with an allowlist, **blocked hosts are listed in the PR** | Self-review + code/secret/dependency scanning before the PR | Only a `copilot/*` branch, workflows wait for approval, **the requester may not approve the PR**, hidden characters in the issue are filtered | — |
| **OpenAI Codex** [F] | Slack, GitHub, Linear, CLI | Container, **internet off while the agent runs**, secrets only for setup | Best-of-N (1–4 attempts); review reports only P0/P1 findings per `AGENTS.md` | — | — |
| **Devin** [F] | Slack (two-way thread sync), Jira, Linear | VM | Devin Review (grouping of changes, bug catcher, security scan) | ACU limits per org/user; **proposes new knowledge from feedback**, a human approves it | — |
| **Cursor + Bugbot** [F] | Slack, Linear, GitHub | VM, pre-built environment, egress allowlist | Screenshots and video in the PR; Bugbot **learned rules** from reactions and comments | — | — |
| **Claude Code** [F] | Web, Slack, GitHub Actions | VM with an allowlist, **GitHub credentials never in the VM** (proxy) | PR auto-fix: watches CI and comments, escalates unclear comments; Code Review verifies each finding against the code | Severity counts that CI reads | — |

## Where Mork matches

- **Input from Slack into a thread, with reports back**: Stripe, Coinbase, Shopify, Devin, Factory. Mork's flow Slack → issue → PR → thread is almost identical to Coinbase's.
- **Isolated container per task, fixed branch, draft PR, a human merges**: everyone. Nobody has published auto-merge of free-form agent code. Meta does it for narrow "safe" categories and Spotify proposes it for docs.
- **Deterministic checks decide, the LLM generates**: Stripe blueprints, Spotify verify, Uber, Google, Airbnb. This is the same as Mork's principle "tests decide".
- **A `verify` tool for the agent**: taken from Spotify.
- **A cap on attempts**: Stripe allows 2 CI rounds. Mork allows 3 Build attempts and 2 analyst attempts.
- **Harness and state outside the sandbox**: Shopify Aquifer (session log, harness and sandbox kept separate) corresponds to Mork's Step Functions + session in S3 + container. Shopify also uses Pi.
- **Live log**: Spotify Goose Farm, Stripe web UI, Factory link in the thread. Mork uses a Grafana Live log.
- **Questions during the work**: Claude Code waits for an answer, Devin syncs the thread. Mork has `ask_human` and waits up to 3 days.

## Where Mork differs

| Mork | Closest equivalent | What follows |
| --- | --- | --- |
| Hidden acceptance tests from the analyst; the implementer does not see them | Spotify "end state as tests", Meta ACH | A strong safeguard against "bending" tests. Nobody has published evidence that it works, so it must be **measured**: share of valid tests, and how many bugs they caught that the repo's own tests would have missed |
| Gate before Build: hidden tests must fail on `main` | Meta TestGen filters (build, pass, flaky, coverage) | Mork added **mutants** as a metric. A **flakiness check** (several runs) is a possible next step |
| A decision model (Jev) recommends review depth | Meta RADAR, Uber grader | RADAR shows how such a signal can later gate auto-merge of narrow categories |
| One small, cheap model for everything (a flash-class, OpenAI-compatible LLM) | Coinbase tests a cheaper model as the default because of cost; Spotify chose its model on ~50 migrations | The others use frontier models for implementation. An **eval set** is needed to know where a flash-class model is not enough |
| The agent pushes on its own | Copilot does (branch `copilot/*`); Spotify and Claude Code do not | Mork keeps the push, but the token lives in the egress sidecar, not with the agent |

## What Mork adopted

- **A `verify` tool.** *(Spotify)* During Build the implementer can run setup, the repo's tests, the configured checks and a preview of the diff policy. Hidden tests are not included.
- **A checks table in the PR.** *(Uber)* The PR starts with a table of what ran and the result. The reviewer sees at once what has been verified.
- **Mutants for hidden tests.** *(Meta ACH, TestGen)* After the hidden tests pass, the gate makes at most 5 deterministic mutants on the added lines and runs only the hidden tests against them, within 60 s. The result is a metric in the checks table, not a gate. It measures the quality of the generated tests.
- **Fix runs after the PR.** *(Claude Code auto-fix, Stripe follow-up, Bugbot Autofix)* Red CI on the PR head, a "Request changes" review, or a comment with `@mork` from someone with write access starts a fix run on the same branch.
- **Directory-scoped `AGENTS.md`.** *(Stripe rules per directory)* Besides the root `AGENTS.md`, the agent loads `AGENTS.md` from the directories between the file it touches and the root. Rules are always read from the base commit.
- **Fargate Spot with fallback.** Phases run on Fargate Spot. An interrupted phase saves its session and work in progress, and the retry continues from there. After repeated interruptions the phase falls back to regular Fargate.
- **An egress sidecar that holds the keys.** *(Copilot firewall, Codex, Claude Code proxy, Stripe devbox without egress)* Every phase runs next to an egress sidecar. Only the sidecar gets the LLM key and the push token, and it adds them to outgoing requests. The agent still calls `git push`, but has no token in its environment.

**Tried and removed: the scope judge.** *(Spotify dropped its judge; Google uses an AST check instead)* Mork briefly ran an LLM judge that sent out-of-scope changes back to Build. It was removed because there was no data on how often it was right.

## Not adopted yet

- **Enforced network allowlist.** *(Copilot firewall, Codex, Cursor, Claude Code)* The sidecar's allowlist only logs. The agent can still reach the network directly. A hard allowlist needs a network firewall or a DNS firewall. Copilot also lists blocked requests in the PR.
- **Warm environments and a dependency cache.** *(Stripe devbox ~10 s, Ramp snapshot every 30 min, Cursor pre-built environments)* Every phase clones the repo and installs dependencies from scratch, 3–7 times per task. Options: a per-repo image with dependencies preinstalled, built from `main`, or a dependency cache in S3 or EFS. The cost is higher for heavy repositories, for example data repositories with large Python dependency sets.
- **Learning rules from reviews.** *(Shopify mines sessions into skills and `AGENTS.md`, Devin proposes knowledge, Bugbot learned rules)* Propose `AGENTS.md` changes from the timeline and from review comments as PRs that a human approves. Nothing is learned silently.
- **Fleet dashboard and review throttling.** *(Spotify Goose Farm and Fleetshift, Coinbase, Shopify, Google)* A dashboard over the timeline and Step Functions: running tasks, time to PR, share of handovers to a human, merge rate, share of valid hidden tests, PRs waiting for review. Spotify and Google both warn that **review becomes the bottleneck**. Google throttles generation to reviewer capacity, so the number of open agent PRs per team is worth tracking too.
- **Best-of-N.** *(Codex, Cursor, Google)* Run 2–3 Builds in parallel and pick the one that passes the gate with the smallest diff. Hidden tests are a natural selector. It costs more containers, so it could start only after the first failed attempt.
- **Batch migrations.** *(Spotify Fleet Management, Google, Airbnb)* A different mode from single tasks: one prompt, deterministic target selection, a per-file state machine, tuning on 5–10 samples, then the full run. Example: library upgrades across data repositories.
- **Auto-merge of narrow categories.** *(Meta RADAR)* Only after calibration:
  - auto-merge for narrow categories only (docs, tests, refactors with no behavior change),
  - a threshold by source and history: the repo or task type needs N weeks without a revert,
  - a daily cap and a delayed merge, during which a human can veto.
- **Per-task cost tracking.** *(Devin ACU, Claude review cap)* Store tokens and container time per task in the timeline.

## Other practices seen in these systems

These are listed for completeness.

- **Input hygiene against prompt injection.** *(Copilot)* Strip hidden and invisible characters and HTML comments from issue and chat text before it reaches the prompt.
- **The requester may not approve their own PR.** *(Copilot, Ramp)* The requester becomes a commit co-author and someone else is assigned as reviewer (CODEOWNERS). A repository ruleset can enforce this.
- **Domain-specific evidence in the PR.** *(screenshots at Ramp, Cursor and Uber)* UI work gets screenshots. Data repositories could get a build result on a sample, a data diff (rows and columns before/after) or a query plan.
- **More people in the thread.** *(Shopify, Ramp multiplayer)* Let more people than the requester answer the agent, and record the author of every answer.

## Design choices Mork shares with others

- **Step Functions with phases.** Shopify and Stripe both ended up separating orchestration from the sandbox and mixing deterministic and agent steps.
- **Draft PR only after the gate passes.** Spotify v2 and Uber do the same: a PR only after green checks.
- **No time limits inside, only supervision and a 2 h safety timeout.** Others use hard limits (Copilot 59 min). The cap on attempts matters more, and Mork has one.
- **Few tools for the agent.** Spotify says it directly: the more tools, the less predictable the agent. Pi with a few tools plus `verify` and `ask_human` fits this.

## Open questions

- **Is a flash-class model enough?** The others implement with frontier models. Without an eval set (for example 20 real tasks with known outcomes) the answer is unknown.
- **Does anyone measure that hidden tests catch something?** Until then it is a hypothesis. Metric: the number of attempts that passed the repo's tests but failed the hidden tests.

## Sources

- Stripe Minions, part 1 (2026-02-09): https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents
- Stripe Minions, part 2 (2026-02-19): https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2
- InfoQ on Stripe (2026-03-20): https://www.infoq.com/news/2026/03/stripe-autonomous-coding-agents/
- Ramp Inspect: https://builders.ramp.com/post/why-we-built-our-background-agent
- Modal on Ramp (2026-02-19): https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal
- Pragmatic Engineer on Ramp (2026-08-25): https://newsletter.pragmaticengineer.com/p/why-ramp-built-inspect
- Coinbase at Linear: https://linear.app/customers/coinbase
- DigitalToday on Coinbase (2026-08-09): https://www.digitaltoday.co.kr/en/view/90934/surging-ai-costs-prompt-companies-to-build-their-own-coding-ai-tools
- Spotify Honk, parts 1–4: https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1 · https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2 · https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3 · https://engineering.atspotify.com/2026/4/background-coding-agents-dataset-migrations-honk-part-4
- InfoQ, Spotify Honk rewrite (2026-03-18): https://www.infoq.com/news/2026/03/spotify-honk-rewrite/
- Spotify, Coding is no longer the constraint (2026-06): https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint
- Shopify, Under the River (2026-05-28): https://shopify.engineering/under-the-river
- Shopify Roast: https://shopify.engineering/introducing-roast
- Uber uReview (2025-08-12): https://www.uber.com/blog/ureview/
- Uber at AI Engineer World's Fair 2026: https://ai.engineer/talks/17-YSUHo6Lk-agentic-sdlc-at-uber-building-blocks-ubers
- Pragmatic Engineer on Uber (2026-03-10): https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development
- Uber AutoCover (ICSE 2026): https://conf.researchr.org/details/icse-2026/icse-2026-software-engineering-in-practice/58/Automated-Software-Test-Generation-at-Industry-Scale-Using-a-Multi-Agent-Architecture
- Meta Diff Risk Score (2025-08-06): https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/
- Meta RADAR (2026-05-28): https://arxiv.org/html/2605.30208v1
- Meta TestGen-LLM: https://arxiv.org/abs/2402.09171v1
- Meta ACH: https://arxiv.org/abs/2501.12862
- Google, AI-assisted code migrations: https://arxiv.org/html/2501.06972v1
- Airbnb, Enzyme → RTL migration: https://airbnb.tech/?p=366
- GitHub Copilot coding agent (2026-02-26): https://github.blog/2026/02/whats-new-with-github-copilot-coding-agent/
- Copilot, risks and firewall: https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations · https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
- Codex cloud environment: https://learn.chatgpt.com/docs/environments/cloud-environment
- Codex review on GitHub: https://developers.openai.com/codex/integrations/github.md
- Devin Review and Knowledge: https://docs.devin.ai/work-with-devin/devin-review · https://docs.devin.ai/product-guides/knowledge
- Cursor cloud agents and Bugbot learned rules: https://cursor.com/docs/cloud-agent · https://cursor.com/changelog/04-08-26
- Claude Code on the web and Code Review: https://code.claude.com/docs/en/claude-code-on-the-web · https://code.claude.com/docs/en/code-review
- Factory changelog: https://docs.factory.ai/changelog/1-8
