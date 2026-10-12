# 6. The decision model decides live, inside hard rules

Date: 2026-10-10 · Status: Accepted

## Context

The decision layer first ran in shadow mode: every answer was recorded, but the safe default always applied. Shadow mode produces calibration data without risk, but it also means the decisions never shape a run, so nobody learns whether they help.

## Decision

Shadow mode is gone. At every decision point (triage, supervision, untestable criteria, the recommendation) the decision model's answer takes effect, within these limits:

- Hard rules decide first and can only make the outcome stricter. For the recommendation, a confident answer (≥ 0.8) sets the review level, never below what the rules require; at takeover the decision model is not asked.
- An undecided answer (unsure, over budget, API error) takes the safe default: proceed with triage, careful review, review for a criterion.
- The decision model can send a task to a person, never allow more ([ADR 1](0001-tests-decide-models-advise.md)).
- Every answer goes to the timeline with what the model saw, and PR outcomes are added later.

## Consequences

- The thresholds (0.2, 0.8) are guesses until calibrated from the timeline (`mise run timeline:export` → jevcal).
- The decision model is optional; without one, every decision is undecided and every PR gets careful review.
