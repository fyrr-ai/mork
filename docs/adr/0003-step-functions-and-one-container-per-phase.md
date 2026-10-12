# 3. Step Functions orchestrate one container per phase

Date: 2026-10-10 · Status: Accepted

## Context

The first version had a conductor: a long-running service that drove each station, kept the state of every task and talked to GitHub. It had to be always on, survive restarts and be scaled, and a task waiting three days for an answer still occupied it.

## Decision

AWS Step Functions (Standard) is the orchestrator, with one flat state machine:

- Each phase (Plan, Build, Check) is one Fargate container started with `ecs:runTask.waitForTaskToken`. Stations of a phase run in that container one after another.
- Work between phases is a step in one `steps` Lambda: Start, Decide, Ask, Handover.
- The state machine carries only the brief. Every output lives in the Mork bucket at keys fixed by convention (`packages/contracts` `keys`), so a container reads what it needs and writes its own.

## Considered

- **A conductor service**: rejected, see above.
- **Nested state machines per phase**: rejected in favour of one flat machine.
- **One container per station**, each claiming its input from a Step Functions activity: the version right after the conductor, replaced by one container per phase. That means fewer container starts, and one IAM role per phase is enough to keep the hidden tests away from Build.

## Consequences

- Nothing runs while Mork waits: an Ask can wait three days for the price of a paused execution.
- Retries, timeouts and the catch-all Handover are declared in the state machine, not written in code.
- Mork is tied to AWS. Another cloud would need another orchestrator; the containers and contracts would stay.
- The bucket's key layout is a contract between processes and changes need care.
