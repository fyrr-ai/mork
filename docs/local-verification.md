# Local verification

Run the actual gate without AWS, a decision API or an LLM. This verifies supplied hidden tests and the pushed-equivalent git branch. It does not run Plan, Build or a reviewer.

The local CLI runs repository commands as your current non-root user in a disposable checkout. Use a trusted repository on Linux with `/proc`; this is not a sandbox for hostile repositories. The production runner uses separate users. See [SECURITY.md](../SECURITY.md).

## Before and after

Install the tools and frozen dependencies with `mise install` and `mise run install`. Your repository's base commit must contain `.mork/config.toml`; the CLI reads that version so a branch cannot change its verification configuration.

Supply a JSON array of hidden tests. For example:

```json
[
  {
    "file": "feature.test.mjs",
    "content": "import assert from 'node:assert/strict'; import {answer} from '../src/answer.mjs'; assert.equal(answer(), 42);",
    "criteria": ["AC1"]
  }
]
```

Each file must use the suffix configured in `.mork/config.toml`. The configured `hidden_tests.command` runs it. This example assumes `hidden_tests.dir = "test-hidden"` and `command = "node --test {file}"`.

```sh
mise run gate:local -- --repo /path/to/repo --base BASE_COMMIT --hidden /path/to/tests.json --mode before
mise run gate:local -- --repo /path/to/repo --base BASE_COMMIT --hidden /path/to/tests.json --branch mork/example --mode after
```

Before mode succeeds only when setup succeeds and every supplied hidden test fails on the base commit. After mode runs repository tests, repository checks, hidden tests, diff policy and optional mutants. It succeeds when the gate passes. Output is JSON with `passed` and `gate`; exit status is 0 for a pass and 1 for a failed verdict. Invalid input or command tampering also fails the process.

Commit the branch before running after mode. Uncommitted edits are not tested. The output includes `head_sha` so you can identify the commit that was checked. Setup may install dependencies and therefore use the network.

## Privilege-boundary regression tests

```sh
mise run test:sandbox
```

This builds the runner test image, then runs the gate and filesystem regression tests as root with commands dropped to the image's `sandbox` user, matching production. The repository is mounted read-only and the test container has `--network none`; fixtures live in temporary directories. Image building can download base images, packages and Pi. It never deploys or calls an AWS account.

## Complete development workflow

`mise run workflow:local -- --help` describes the trusted local Plan/Build/Check runner. It uses a local Git checkout, filesystem artifacts and a real Pi process, with the [same configured development definition](../packages/contracts/src/development.json) as AWS. Supply your OpenAI-compatible endpoint and model through the CLI's documented options and its API key through `MORK_LOCAL_API_KEY`. Keep keys out of committed configuration. It records the workflow manifest so a later invocation can resume after an interruption. Publication remains a local result; it does not create a GitHub PR.

`test:sandbox` also runs its compiled CLI through production Node/Pi with a deterministic loopback model fixture, two Build attempts and a passing Check. `mise run workflow:configured -- --help` describes local generic workflows, including command execution, persisted results and approval resumption. Local runs execute with the host user's permissions and require trusted repositories and commands.

SIGINT and SIGTERM stop the local run's owned subprocesses and release `.run.lock` before exit. Resume uses the saved manifest and completed outputs. SIGKILL or a machine crash cannot run cleanup. Before removing a stale `.run.lock`, confirm that its original runner and descendants have stopped. Never remove the lock of an active run.
