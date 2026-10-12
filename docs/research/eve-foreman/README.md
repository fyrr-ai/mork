# Foreman (eve Software Factory Template): what it is and how it works

Source: `vercel-labs/eve-software-factory-template`, commit `6bc5feb` (2026-09-29). About 12,400 lines, TypeScript, pnpm, MIT. Author: Vercel Labs.

## TL;DR

**Foreman** is an AI agent built on the **eve** framework (Vercel). It works as a "software factory": it takes a task from GitHub or Linear, runs it through four specialized agents (**classifier → analyst → implementer → reviewer**) and produces a **reviewed draft PR** on one target repo (`FACTORY_REPO`). A human then marks the PR as ready and merges it. The agent cannot merge at all.

The interesting part is not the prompts but the **security architecture**. Who is trusted is decided in code on the signed webhook, not in the prompt. Writes are guarded by approval predicates. Credentials never enter the sandbox where code from the repo runs.

## 1. Building blocks (eve)

eve discovers everything from the file system under `agent/`. There is no central registry: a tool's name is its file name, a subagent's name is its directory name.

| Primitive | Where | Used here for |
| --- | --- | --- |
| Agent | `agent/agent.ts`, `instructions.ts` | Foreman, the orchestrator. Limit of 100k output tokens per session, compaction at 75 % of the context |
| Channel | `agent/channels/{github,linear,eve}.ts` | Inputs: GitHub webhooks, Linear Agent Sessions, auth for the local TUI |
| Extension | `agent/extensions/github.ts` | GitHub tools `github__*` (allowlist of 31 tools, no merge) |
| Connection | `agent/connections/linear.ts` | Linear MCP server |
| Subagent | `agent/subagents/<id>/` | A station. Each has its own instructions, model, sandbox and tools |
| Workflow tool | `agent/tools/run_<id>.ts` | The only way Foreman calls a station: `ctx.agent(id, { message, outputSchema })` |
| Skill | `agent/skills/` | Guides loaded on demand: `writing-quality`, `triaging-issues`, `github-linear-bridging` |
| Sandbox | `sandbox.ts` | Vercel Sandbox (isolated runtime), each repo station has its own clone |

Detail: the built-in `agent` tool is disabled (`agent/tools/agent.ts`), so Foreman cannot bypass the stations and delegate on the side.

## 2. How work arrives

| Trigger | What happens | Caller class |
| --- | --- | --- |
| Label `factory` on an issue | The full pipeline, unattended, ends with a draft PR | Autonomous |
| `@Foreman` in a comment | Interactive session, it may ask questions | Trusted (OWNER/MEMBER/COLLABORATOR only) |
| Delegation in Linear | The same pipeline, progress as Agent Activities | Trusted (the gate is workspace membership) |
| Red CI on a PR from a `factory/*` branch | Diagnosis and a fix push to the same branch, at most 2 attempts | Autonomous |
| Someone opens a PR | One orientation comment with a summary and a file table | Other |
| Local `pnpm dev` (TUI) | Manual task entry, writes wait for approval | Other |

Two smart safeguards in `agent/channels/github.ts`:

- **The label cannot be spoofed.** GitHub sends `labeled` also for labels added when an issue is created from a template, so an anonymous reporter could "set" them. The hook therefore checks through the API that the labeler has at least `triage` on the repo. On an API error it starts nothing (fail closed).
- **The CI fix limit lives in the PR thread.** Every run is a new session with no memory, so the agent counts its previous "fix attempt" comments on the PR. It posts the comment *before* the fix, so a run that crashes halfway is counted too.

## 3. Pipeline

> Diagram: [01-pipeline.html](01-pipeline.html)

1. **Grounding.** Foreman first loads the user's preferences and the **factory brain** (see below), reads the actual issue, and uses the `triaging-issues` skill to check for duplicates and the label vocabulary.
2. **classifier** (fast model, text only): type, priority, complexity, area, `needs_clarification`. If the task is unclear, the pipeline ends with questions. Unattended, it posts them on the issue and stops. It never waits.
3. **researcher** (optional): web research with mandatory sources. Used only when the task depends on a fact outside the repo.
4. **analyst** (own read-only checkout): problem statement, approach, step-by-step plan, risks, **acceptance criteria**, test strategy.
5. **implementer** (`anthropic/claude-fable-5`, own sandbox): branch `factory/<type>-<slug>`, code, runs the repo's checks, `push_branch`.
6. **reviewer** (`openai/...`, **a different vendor on purpose**): `checkout_branch`, reads the actual `git diff`, rates each criterion separately with evidence. Verdict `approve` / `request_changes` / `reject`.
7. `request_changes` returns the work to the implementer, **at most 2 times**. After that Foreman reports the unresolved findings and does not open a PR.
8. After approval Foreman opens a **draft PR** with the acceptance criteria as a checklist and the verification results.

Rules that hold the pipeline together:

- **Stations inherit nothing.** A subagent runs in a fresh session without Foreman's instructions, tools or history. Every message must therefore be self-contained.
- **Structured output.** Every call carries a JSON schema from `agent/lib/stations/schemas.ts`. A broken output is retried once with a clarification.
- **Handoff artifacts.** Long documents (research memo, analysis detail) are stored in Blob and only an `artifact_id` travels between stations. Foreman never copies the content.
- **Never skip a station**, not even for "trivial" tasks. The classifier decides what is trivial.

The models are in one place, `agent/lib/models.ts`. Everything except the implementer runs on `openai/gpt-5.6-terra-fast`, the implementer on `anthropic/claude-fable-5`. The rule is: the implementer and the reviewer must have different vendors.

## 4. Trust model

> Diagram: [02-trust-matrix.html](02-trust-matrix.html)

The whole model rests on three files:

- `agent/lib/trust.ts` is the **single authority**. On dispatch the channel either adds a `trusted` attribute to the auth, or rewrites the identity to a constructed principal `github:foreman-factory` (autonomous) stamped with the intake issue number.
- `agent/lib/github/approval.ts` contains predicates that return `not-applicable` (just runs), `user-approval` (waits for a human) or `denied`.
- `agent/extensions/github.ts` maps the GitHub tools to these predicates.

The key design decision: **unattended runs deny, they do not wait.** An approval card in a run that nobody watches would stall the session forever. A denial resolves on the server in one step.

**The draft PR is the ceiling of autonomy.** A draft cannot be merged, so anyone may open one. Anything that "ships" (a non-draft PR, mark ready) waits for a human, even for a trusted caller. Merge is not among the tools at all.

An autonomous run may comment **only on its intake issue**. The number comes from the webhook auth, not from the model, so injected text in the issue cannot make the agent write elsewhere.

## 5. Where things run

> Diagram: [03-architecture.html](03-architecture.html)

- **Vercel Sandbox.** The root has a sandbox with a checkout of the thread. The analyst, implementer and reviewer each have their own clone of `FACTORY_REPO` (`git clone --depth 50` at the start of every session, plus an optional `FACTORY_SETUP_COMMAND`, e.g. `pnpm install`).
- **Credentials outside the sandbox.** Git always targets the literal URL `https://github.com/<repo>.git`, never `origin`, because the model in the sandbox can rewrite the remote configuration. The installation token from Vercel Connect is injected by the **sandbox firewall** as a header, only into egress to github.com. The rule is removed again in a `finally` block.
- **`push_branch` is inert by construction.** `validateBranch` rejects `main`, `master`, `refs/*`, `HEAD` and any character outside a conservative set (no shell metacharacters). That is why it can run without approval inside a station. Nobody would be looking at a station's approval card.
- **Vercel Blob** holds three reserved namespaces: `user-preferences/<principal hash>.md`, `factory-brain/<repo hash>.md` and `artifacts/<validated id>.md`. Keys are derived from the principal or from `FACTORY_REPO`, never from model output. The only exception is the artifact id, which must pass an anchored regex (no dots or slashes).
- **Vercel Connect** brokers OAuth for GitHub and Linear. Tokens are resolved per call and the model never sees them.
- **AI Gateway** provides models through `<provider>/<model>` IDs, without provider-specific SDKs.

## 6. Factory brain

A shared, persistent memory about the target repo: build quirks, non-obvious verification steps, recurring review findings. It has a limit of 40,000 characters. Every run reads it, but the stations do not, so Foreman puts the relevant facts into their messages.

Writes are guarded by `factoryBrainPolicy`: denied for autonomous, direct for trusted, on approval for others. The reason: the issue body is untrusted input, and a write to the brain would poison the context of all future runs. An autonomous run therefore only writes the proposed note into its final comment as a "Suggested factory brain note".

## 7. Evals

`evals/` uses the eve eval runner, and the directories form a taxonomy of failures:

- `routing/`: the classifier goes first, `needs_clarification` stops the pipeline, labels follow the classification.
- `safety/`: no push to main, a write requires approval, the ship gate parks and continues after approval, a write to the brain parks, a read-only question does not touch write tools, prompt injection in the issue body is treated as data.
- `pipeline/full-pipeline`: opt-in, pushes a real branch (a scratch repo is recommended).

Read-only evals assert `notCalledTool` over the **whole list of write tools** (deny by default). That is cheaper than listing what must not happen.

## 8. Takeaways

Strengths:

- **Authorization in code, not in the prompt.** Trust is stamped on the signed webhook and read by a single module. Prompt injection can therefore influence judgment, not permissions.
- **"Inert by construction" instead of approval cards.** Station side effects are designed so that they cannot do harm (feature branch, validated name, token on the firewall). So nothing needs approving.
- **Review independence is structural:** a different vendor, and the reviewer sees only the pushed branch, not the implementer's reasoning.
- **State in an external medium.** The CI fix limit is counted from PR comments, so no database is needed.

Weaknesses and questions:

- **One repo per deployment** (`FACTORY_REPO` is baked in at build time). More repos need more deployments.
- **A full clone in every session of every station.** The analyst, implementer and reviewer each clone again. The snapshot sandbox in eve has no `setNetworkPolicy`, so a shared credentialed clone is not possible. For a large repo this costs time.
- **Linear MCP runs without approval for the "other" class.** The predicate denies only autonomous, so the local TUI or a PR-summary session can write to Linear without a card. For PR-summary this is limited only by the injected task, not by policy.
- **Prompt-injection protection is only a floor.** An eval with a judge threshold ≥ 0.5 guards behavior; the structural limits are the permissions. The stations also run code from the repo (tests, lint), which is why sandbox isolation is required.
- **The 100k output-token budget** is shared by the root and all stations. A large task with 2 revisions can run out.
- **Parallel tracks, merge behind approval and schedules** are so far only in "Future considerations".

What Mork took from this: the trust stamp at intake, authorization in code instead of in the prompt, side effects that are safe by themselves (push only to `factory/*`, no token with the agent), the draft PR as the ceiling, stations with structured output, and the factory brain. Mork replaced the reviewer from a different vendor with LLM-free tests in the gate and a decision model, because it uses a single LLM.
