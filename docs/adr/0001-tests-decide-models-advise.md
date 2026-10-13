# 1. Tests decide whether the change works; models only advise

Date: 2026-10-10 · Status: Accepted

## Context

An LLM agent that writes code will also claim the code works. Asking another model to confirm it adds an opinion, not evidence, and an agent under pressure to finish will weaken or skip tests to make them pass.

## Decision

Whether a change works is decided by tests, run by the gate, which has no LLM:

- The analyst writes a hidden test for every testable acceptance criterion. The gate before must see them fail on the base commit; the implementer never sees them.
- The gate after runs the repository's setup, tests and repository checks, the hidden tests and the diff policy on a fresh clone of the pushed commit.
- The decision model and the reviewer only judge what tests cannot (untestable criteria, review depth) and only advise: the result is a recommendation, never an approval.
- The ceiling is a draft PR. Merging is not among the agent's tools; a person always merges.

## Consequences

- A repository needs a test command and a way to run one hidden test file (`hidden_tests` in `.mork/config.toml`) before Mork can work on it.
- Tasks that are supposed to change existing tests are handed over: the diff policy cannot tell a legitimate test change from a weakened one.
- Hidden tests are only as good as the analyst.
