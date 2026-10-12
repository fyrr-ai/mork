# 11. Phases run on Fargate Spot

Date: 2026-10-11 · Status: Accepted

## Context

A phase container runs for minutes to an hour and is cheaper on Fargate Spot, but Spot reclaims a container with two minutes' notice. Before this decision a reclaimed container exited silently, the phase waited for the 5-minute heartbeat timeout, and the task was handed over.

## Decision

Phases run on Fargate Spot and survive a reclaim:

- On SIGTERM the runner stops the agent, saves its session and pushes its work in progress, then fails the phase as `Mork.Interrupted`.
- Step Functions reruns the phase; the station continues its saved session with a short "you were restarted" prompt.
- After four interruptions or capacity failures in a row (`AmazonECS.Unknown`, `ECS.AmazonECSException`), the phase moves to on-demand Fargate (`SpotFallback`).

## Consequences

- Every station must be resumable from its session and the branch; new stations have to keep that property.
- The SIGTERM path has a 90-second budget, which bounds how much work the shutdown hooks may do.
