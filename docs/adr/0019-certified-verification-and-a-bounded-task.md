# 19. Verification is certified by the repository's oracle, and a task is bounded

Date: 2026-10-16 · Status: Accepted · Supersedes the classification rule of [ADR 18](0018-the-issue-author-owns-acceptance-criteria.md)

## Context

The first migration pilot delivered no successful task. Several failures came from verification and workflow control. Hidden tests that failed on the base commit because of a missing module, a server that did not start or a wrapped setup error were accepted as proof that the feature was missing. The analyst could mark a runtime criterion untestable and the gate then had nothing to check. A plan that reworded an author's criterion cost a fresh checkout and a new analysis. After a handover, a failed check suite started another fix run on the branch a person had just taken over. The implementer saw only the last 1 500 characters of a test run, and the cause of a failure was above that tail.

## Decision

- **Only a certified result counts.** Hidden tests run through an oracle the repository owns: the `mork-v1` adapter and the runtime paths it pins, taken from the base commit and kept at their base contents during the change. The oracle reports pass, behavior failure, execution failure or inconclusive, and status and exit code must agree. The gate before requires a certified baseline verdict: a certified red for missing behavior or a pass for existing behavior. The gate after accepts only certified passes. An exit code alone, an `AssertionError` alone, or a legacy script without the protocol certifies nothing. The oracle version binds the hidden cases, runtime paths, author criteria and all requester answers. A new factual reply during Build conservatively invalidates baseline evidence. Changing the oracle is a separately reviewed prerequisite; a changed oracle version invalidates earlier baseline and candidate evidence and hands the task over.
- **Author criteria are immutable and executable.** The runner binds the author's ids and text into the plan; the analyst decides nothing about their wording and cannot make one evidence-only. Only the author's `[evidence]` prefix allows judging a criterion from quotes. Invalid verification is repaired in the same planning session, with the diagnostics, for at most `attempts - 1` corrections; the implementer never rewrites hidden expectations.
- **One PR record owns automation and budget.** Handover, fix claims and resume all go through one conditional write on the task's PR record. A handover closes automation before any container is stopped or a PR published; CI and review events on a closed task are dismissed; only an explicit `@mork resume` by someone with write access reopens it. A task has one finite build budget over its first run, repairs and fix runs; a fix round claims its share with ownership, and nothing replenishes it. A CI head is claimed once, only after every check has settled and at least one run is a verdict.
- **Diagnostics are complete, redacted and partitioned.** Every verification command keeps its command id, checkout SHA, working directory and complete redacted output outside the checkout, with a bounded excerpt in the prompt. Public diagnostics from repository commands are readable by every station; root Plan and Check retain full oracle diagnostics from hidden tests, while only the analyst receives them as model inputs. Other model stations receive public diagnostics only.

## Considered options

- Keep exit-code semantics and ask the analyst to write more careful tests: the same classes of broken verification recurred in every pilot task, so the decision cannot stay with the model.
- Let the platform judge whether a failure is a real red from its output: that puts a heuristic where the repository has the knowledge; the adapter protocol moves it to the repository and keeps the platform LLM-free.
- Keep fix runs independent of handover: cheaper, but a person taking over a branch cannot work while Mork keeps pushing to it.

## Consequences

- Runtime-testable criteria require an adapter and a pinned runtime before Mork can certify their baseline. A task with no testable criteria can proceed through evidence checks without hidden tests.
- Plans cost fewer restarts, but a repository whose oracle cannot run is handed over at Plan instead of at Check.
- Budgets are conservative: a fix round's reserved attempts stay reserved even when unused.
- Automatic CI wake-ups come from completed check suites; a legacy commit status that completes later does not wake the task by itself.
