# 16. Supervision asks on signals

Date: 2026-10-14 · Status: Accepted · Supersedes the interval in [ADR 5](0005-supervision-instead-of-limits.md)

## Context

Supervision asked the decision model about every running LLM station every 45 seconds: about 160 questions in a two-hour Build, nearly all answered "fine". Each answer can steer or stop the station, and no one had measured how often that helped, which is the same risk as the removed scope judge ([ADR 10](0010-no-scope-judge.md)).

## Decision

Supervision stays the only brake, but the runner decides when to ask from cheap signals in Pi's event stream, checked every 15 seconds:

- the same tool call three times in a row,
- three tool errors in a row,
- for the implementer, a diff that has not changed for 10 minutes,
- otherwise at least every `supervise_seconds`, now 300 by default.

A signal asks again only after new tool calls. After a steer, the next question waits out the 30-second grace and decides whether to stop, as before. Every record in the timeline names the signal that asked.

## Consequences

- The decision model is asked roughly ten times less often, and mostly when something looks wrong.
- A station stuck in a way the signals miss is caught up to five minutes later than before.
- The triggers are guesses; the recorded signal next to each answer shows which ones find real problems.
