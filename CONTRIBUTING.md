# Contributing

Mork is an experimental coding agent. Read [README.md](README.md), the
[glossary](CONTEXT.md) and [architecture](docs/architecture.md) before changing
workflow behavior. Record architectural tradeoffs in [docs/adr/](docs/adr/).

## Local setup

Use Linux for runtime tests, which rely on `/proc` and descriptor-relative file access. Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
mise trust
mise install
mise run install
mise run check
```

`mise run install` uses the committed Bun lockfile. Use the mise tasks for tests,
type checking, lint and infrastructure validation. Local checks require no AWS
credentials. Deployment instructions are in [docs/deployment.md](docs/deployment.md).
Keep deployment settings in the ignored `mise.local.toml`.

## Changes and pull requests

Keep changes focused on one problem. Parse external input at the boundary and
keep business logic direct. Use the terms in `CONTEXT.md` and the existing package
boundaries. Remove replaced APIs and migrate their callers in the same change.

Reproduce defects before changing code. Add a regression test when it proves the
failure and the fix. For security boundaries, exercise the real filesystem or
executable path; mocks alone do not establish isolation.

Run `mise run check` before opening a pull request. Describe the behavior change,
verification results and any deployment or compatibility requirements. CI runs
the same checks. Maintainers review changes before merging.

Do not commit credentials, account identifiers, private repository contents,
deployment URLs or unsanitized session transcripts. Report security issues using
[SECURITY.md](SECURITY.md).

## Licensing

Contributions are submitted under the repository's [Apache-2.0 license](LICENSE).
Only contribute material you have permission to license. When adapting external
code, record its source, revision, affected files and license in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and retain its copyright and
license text. An idea or design reference does not establish copied-code
provenance.
