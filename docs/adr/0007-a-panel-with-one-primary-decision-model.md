# 7. A panel with one primary decision model

Date: 2026-10-10 · Status: Accepted

## Context

Mork supports two decision models behind one interface: Jev and OpenAI Decisions. Choosing between them, or calibrating one, needs both answers to the same questions on real tasks.

## Decision

The `DecisionPanel` asks every configured decision model the same question with the same bounded evidence. The primary (`MORK_DECISION_PRIMARY`, default the first configured) decides; the others are only recorded in the timeline next to it.

## Consequences

- With one decision model configured, the panel is a thin wrapper and costs nothing.
- A second decision model doubles the decision calls but never changes a run, so it can be tried safely.
- The timeline stores answers per provider (`providers`), which is why code calls a decision model a provider; changing that shape needs a migration of the export.
