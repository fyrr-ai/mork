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

Review [SECURITY.md](../SECURITY.md) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). `check` includes mocked AWS plans, not a deployed AWS test. The sandbox task runs real privilege-boundary tests locally. `images:check` builds all production images and runs their Node entrypoints, real Pi and Lambda runtime client without runtime network. Neither task proves that a fresh deployment receives webhooks or that GitHub enforces installed rulesets.

Commit the reviewed files, then export to a new directory outside the checkout:

```sh
MORK_RELEASE_AUTHOR="Your public name" MORK_RELEASE_EMAIL="your-public-email@example.com" \
mise run release:export -- /absolute/path/to/mork-public
```

The exporter refuses tracked changes and untracked, unignored files. It copies committed HEAD through `git archive`, initializes a new repository with one root commit, and scans that history with Gitleaks. It includes no original Git objects, refs, remotes or ignored files. Existing destinations are never overwritten. The source checkout stays intact. The exporter requires `MORK_RELEASE_AUTHOR` and `MORK_RELEASE_EMAIL`; it never chooses a GitHub identity for you. It reads the release version from `package.json` and creates the matching local tag in the export. The current version is `0.1.0`, prepared for its first release. Neither the tag nor the export is published automatically.

Review the export's content and history, install its frozen dependencies, and rerun `mise run check` there. Configure its remote as `fyrr-ai/mork` only when publishing that reviewed export. If the destination already has private import history, making it public without replacing that history would expose the old content. Avoid `git push --mirror` from the working checkout.

Gitleaks detects credential patterns, not every internal identifier or permission to publish code. Review URLs, manifests, fixtures, image metadata and binary assets as well. Upstream copyright names in the retained licenses are required attribution. Local deployment values belong in ignored `mise.local.toml`, never in release files.

## Repository settings

Before making the repository public, enable GitHub private vulnerability reporting so the link in `SECURITY.md` works. Confirm contributor access, Actions permissions and default-branch protection. Publication and repository settings are separate from this local export; these tasks do not push or change visibility.

## Verification limits

This hardening adds deterministic regression evidence for callback retries, signing placeholders, decision responses, symlink traversal, protected gate checkouts, deployment bootstrap and offline infrastructure plans. The source is still experimental.

Network egress enforcement and tests on real AWS were intentionally excluded from this work. IAM is shared across runs within a development phase or a configured step. Per-execution IAM roles are not implemented. `workflow:local` runs Plan, Build and Check with real Pi against a trusted local repository; its integration test uses a loopback model fixture. This proves local orchestration, not the quality of a remote model.

Images retain original notices, package metadata, lockfiles and bundle inputs. OS package installation still uses the Debian repositories at build time, so a pinned base digest alone does not make later rebuilds identical. Review the complete binary and system dependency inventory before distributing prebuilt images. The current source remains an experimental release.
