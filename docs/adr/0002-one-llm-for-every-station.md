# 2. One LLM for every station

Date: 2026-10-10 · Status: Accepted

## Context

Many agent systems use a stronger model to plan, a cheaper one to code and a different vendor to review, so that one model's blind spots are caught by another. Each extra model is another key, another API shape, another cost and another thing to keep in sync.

## Decision

One OpenAI-compatible chat completions API (`LLM_BASE_URL`, `LLM_API_KEY`, `MORK_MODEL`) drives every LLM station: the analyst, the implementer and the reviewer, plus drafting tracker issues and clarifying questions. Independence comes from elsewhere:

- the gate, which has no LLM, decides whether the change works ([ADR 1](0001-tests-decide-models-advise.md)),
- the hidden tests are written by a station the implementer cannot read,
- the reviewer starts with a clean context,
- the decision model is a separate service of a different kind.

## Consequences

- A deployment needs one LLM endpoint; any self-hosted or vendor model with an OpenAI-compatible API works.
- Model quality is a single setting; a weak model shows up as more attempts and handovers, not as wrong PRs.
- Per-station models are not supported. Adding them later is a configuration change, not a redesign.
