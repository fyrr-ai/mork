# Releasing source

Publish a clean source export. A working checkout can contain internal branches, deployment settings or history that should never be pushed to a public repository.

## Verify and export

```sh
mise run install
mise run check
mise run test:sandbox
mise run images:check
mise run security:scan
```

Review [SECURITY.md](../SECURITY.md) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). `check` includes mocked AWS plans, not a deployed AWS test. The sandbox task runs real privilege-boundary tests locally. `images:check` builds all production images and imports their Node entrypoints without runtime network. Neither task proves that a fresh deployment receives webhooks or that GitHub enforces installed rulesets.

Commit the reviewed files, then export to a new directory outside the checkout:

```sh
mise run release:export -- /absolute/path/to/mork-public
```

The exporter refuses tracked changes and untracked, unignored files. It copies committed HEAD through `git archive`, initializes a new repository with one root commit, and scans that history with Gitleaks. It includes no original Git objects, refs, remotes or ignored files. Existing destinations are never overwritten. The source checkout stays intact. Set `MORK_RELEASE_AUTHOR` and `MORK_RELEASE_EMAIL` to your chosen public author identity if you do not want the default collective identity.

Review the export's content and history, install its frozen dependencies, and rerun `mise run check` there. Configure its remote as `fyrr-ai/mork` only when publishing that reviewed export. If the destination already has private import history, making it public without replacing that history would expose the old content. Avoid `git push --mirror` from the working checkout.

Gitleaks detects credential patterns, not every internal identifier or permission to publish code. Review URLs, manifests, fixtures, image metadata and binary assets as well. Upstream copyright names in the retained licenses are required attribution. Local deployment values belong in ignored `mise.local.toml`, never in release files.

## Repository settings

Before making the repository public, enable GitHub private vulnerability reporting so the link in `SECURITY.md` works. Confirm contributor access, Actions permissions and default-branch protection. Publication and repository settings are separate from this local export; these tasks do not push or change visibility.

## Verification limits

This hardening adds deterministic regression evidence for callback retries, signing placeholders, decision responses, symlink traversal, protected gate checkouts, deployment bootstrap and offline infrastructure plans. The source is still experimental.

Network egress enforcement and tests on real AWS were intentionally excluded from this work. IAM remains scoped per phase across task prefixes. Full local LLM orchestration is not implemented; `gate:local` exercises verification. Image redistribution requires an inventory of transitive binary and system dependencies beyond the retained top-level notices. These are limits to assess before a production rollout or distributing prebuilt images, rather than claims of a 10/10 security boundary.
