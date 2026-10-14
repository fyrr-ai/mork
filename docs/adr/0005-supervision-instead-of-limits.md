# 5. Supervision instead of turn and time limits

Date: 2026-10-10 · Status: Accepted; when supervision asks is superseded by [ADR 16](0016-supervision-asks-on-signals.md)

## Context

Agent runners usually stop an agent after a fixed number of turns, tokens or minutes. Any fixed limit is wrong for some task: it cuts off work just before it finishes, or lets a stuck agent burn tokens until it is reached.

## Decision

Containers have no turn, time or token limits. Every LLM station is supervised instead:

- Every `supervise_seconds` (default 45 s) the decision model scores the running station on `worker_stuck`, `work_off_track` and `meaningful_progress`, from bounded evidence.
- On a problem the runner sends one steer from a template, waits 30 s, then stops the station: the analyst gets another attempt, the implementer's work in progress is pushed and Build continues with the next attempt, a stuck reviewer hands over.
- A 2-hour phase timeout and a 5-minute heartbeat in Step Functions are the backstop.

## Consequences

- Without a decision model there is no supervision, and only the 2-hour timeout stops a stuck station.
- The steering text is never written by a model, so supervision cannot inject instructions.
- Cost per task is not capped in advance; it is visible afterwards in the session stats.
