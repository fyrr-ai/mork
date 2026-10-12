# 9. A diff policy next to hidden tests

Date: 2026-10-10 · Status: Accepted

## Context

Hidden tests check only the acceptance criteria the analyst wrote. They do not notice an implementer that breaks something else and then "fixes" the repository's own tests to match, or skips them. Agents do this.

## Decision

The gate compares the pushed branch with the base commit and applies a diff policy:

- An attempt is rejected when it changes or deletes a file under a test path (new test files are fine), adds a skip marker (`.skip(`, `.only(`, `xit(`, `@pytest.mark.skip`…), or touches the platform paths `.mork/`, `.github/`, `.pi/`.
- The recommendation is raised to careful when the test script in `package.json` changes, and to takeover when the change touches a protected path.
- The implementer can preview the policy with `verify`, so it learns the rules before the gate.

## Consequences

- Requests that should change existing tests cannot pass and are handed over. Detecting them in Plan is not implemented yet.
- `test_paths` and `protected_paths` are per-repository settings that read from the default branch, so the agent's branch cannot loosen them.
