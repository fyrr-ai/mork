# Architecture decision records

Decisions that are hard to reverse, surprising without their context, or the result of a real trade-off. Each record keeps its number; a changed decision gets a new record that supersedes the old one. Words follow the glossary in [CONTEXT.md](../../CONTEXT.md).

| # | Decision |
| --- | --- |
| 1 | [Tests decide whether the change works; models only advise](0001-tests-decide-models-advise.md) |
| 2 | [One LLM for every station](0002-one-llm-for-every-station.md) |
| 3 | [Step Functions orchestrate one container per phase](0003-step-functions-and-one-container-per-phase.md) |
| 4 | [The implementer pushes its own branch](0004-the-implementer-pushes-its-own-branch.md) |
| 5 | [Supervision instead of turn and time limits](0005-supervision-instead-of-limits.md) |
| 6 | [The decision model decides live, inside hard rules](0006-the-decision-model-decides-live.md) |
| 7 | [A panel with one primary decision model](0007-a-panel-with-one-primary-decision-model.md) |
| 8 | [Credentials live in the egress sidecar](0008-credentials-live-in-the-egress-sidecar.md) |
| 9 | [A diff policy next to hidden tests](0009-a-diff-policy-next-to-hidden-tests.md) |
| 10 | [No scope judge](0010-no-scope-judge.md) |
| 11 | [Phases run on Fargate Spot](0011-phases-run-on-fargate-spot.md) |
| 12 | [Fix runs after the PR](0012-fix-runs-after-the-pr.md) |
| 13 | [One GitHub token](0013-one-github-token.md) |
