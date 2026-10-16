# 18. The issue author owns acceptance criteria

Date: 2026-10-15 · Status: Accepted; the rule that the analyst decides which criteria are testable is superseded by [ADR 19](0019-certified-verification-and-a-bounded-task.md)

## Context

The analyst wrote every acceptance criterion from the issue text. Nothing tied them to what the author asked for: Plan could reword, merge, drop or add criteria, and the PR then reported on the analyst's list. In the initial pilot the person who wrote the ticket could not see, in the ticket or the PR, which of their own conditions were met.

## Decision

An issue may number its criteria, one per line as `AC1: text`. Code reads them from the issue body, never a model, and they are the contract:

- The runner binds their ids and text deterministically. Each requires an executable hidden test unless the author prefixes it with `[evidence]`; the analyst cannot downgrade it. An ambiguous criterion is a question to the author, not a rewrite. This classification rule follows [ADR 19](0019-certified-verification-and-a-bounded-task.md).
- The analyst may suggest further checks in `proposed_criteria`. The PR shows them apart; nothing checks them and they do not affect the recommendation.
- The PR and the Jira comment list each criterion with how it was settled: a hidden test, or the decision model from quotes.

An issue without numbered criteria, such as a quick Slack request, keeps the old behaviour; the PR labels its criteria as derived by Plan. The issue Mork drafts from a Slack message uses plain bullets, so a model never writes the contract.

## Consequences

- What the author asked for is what the gate and the decision model judge, and both the ticket and the PR show the result per criterion.
- Badly written criteria now cost a clarification round instead of being silently fixed by the analyst, so tickets are prepared before they reach Mork.
- The format is a convention in the issue text; a ticket that numbers lines differently is treated as having no criteria.
