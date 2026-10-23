# Changelog

## 0.1.0

- Reject certificates chaining to the compromised eMudhra intermediates: the egress proxy uses iron-proxy 0.54.0 (Go 1.27.3, patched Alpine CA bundle), the runner and Lambda use Node 24.22.1 with Debian ca-certificates 20250419+deb13u1, and image builds use Bun 1.4.4.

- Treat acceptance criteria an issue numbers as `AC1: text` as the author's contract: Plan keeps them verbatim and only decides testability, its own ideas appear separately as unchecked proposals, and the PR and Jira comment report each criterion's result.

- Retain criteria citations from either checkout, normalize their repository paths and check the named immutable revision before passing evidence to the decision model.

- Keep the original Slack request alongside a referenced Jira issue so planning retains supplied context and constraints; ask for missing external data before choosing a test or storage contract.

- Give PR titles a Conventional Commit scope and reserve space for the tracker reference within 100 characters.
- Accept document-evidence plans without hidden tests and skip unnecessary before-gate setup; repository checks still run after Build.
- Select the sole allowed Slack workflow without a routing question; retry transient GitHub App token failures up to three requests.

Prepared for release; not published.

- Use the pushed commit's subject as the PR title and append its tracking reference, preserving repository title conventions during normal delivery and handover.
- Accept OCR's skipped result without claiming review coverage. Keep small plans brief and check documentation criteria through evidence instead of hidden text snapshots. Restore the runner's awk alias.
- Retain glibc compatibility libraries and ship OpenSSL and envsubst in the runner so repository tools and offline checks can run.

- Choose where logs go with `log_destination`: CloudWatch log groups (default) or only the OTLP collector, including Lambda events and the egress proxy audit. Lambdas join the VPC to reach an internal collector. Alarms and the Slack failure queue are created only with `alarm_actions`.
- Ask the decision model about a running station only on cheap signals (repeated tool call, tool errors in a row, implementer diff unchanged for 10 minutes) or every 5 minutes, instead of every 45 seconds.
- Open a draft PR labelled `needs-human` on every handover whose branch has work, so the person taking over starts from a PR and `@mork` can continue it.
- Use Open Code Review 1.13.0 at medium effort as the only defect finder. Verify claims against baseline and head, keep unknown findings at careful review, deduplicate root causes, and ask Jev for urgency only from confirmed evidence. Run a separate acceptance-criteria checker only for non-testable criteria. The existing three repair rounds and draft PR delivery remain.
- Configure the original development workflow and generic agent, command and approval workflows through Terraform; route one Slack app exclusively through Jev.
- Configure prompts, domains, Spot fallback and retry budgets per container step.
- Run development Plan/Build/Check and configured workflows locally with real Pi.
- Reduce images with bundled entrypoints, scratch/distroless runtimes and optional SOCI v2 publication.
- Recover interrupted PR reservations atomically and preserve newer owners during delayed completion.
- Validate rendered runner configurations and output schemas before applying a saved plan; report bootstrap failures through the task callback.
- Pin image digests and steps Lambda versions, retain task-definition revisions and permissions needed by running workflows.
- Catch terminal notification failures and preserve their original workflow error.
- Remove the inactive dynamic-IAM experiment. Roles remain shared across runs within each phase or configured step.
- Breaking configuration changes: replace phase/Spot/question variables with `workflows.development`; replace `image_tag` with `image_digests`. See the deployment migration guide.

- Initial public-source preparation of the AWS Step Functions workflow, container
  runner, GitHub and Slack intake, verification gate and decision-model adapters.
- Use the `mork` trigger label and `mork/` branch prefix.
- Add the domain glossary and twelve architecture decision records.
- Add contribution guidance, issue templates, license notices and CI checks.
- Reject placeholder signing secrets and malformed decision-model answers.
- Recover Slack answers after transient failures and preserve answers during concurrent retries.
- Protect gate source and Git metadata, reject ancestor symlinks, and bound subprocess cleanup.
- Fix first-deployment image uploads, Function URL permissions, workflow timeout validation and branch/tag restrictions.
- Add local gate verification, offline infrastructure plans and container sandbox tests.
- Pin base image digests and retain licenses in each image.
- Export source with a clean root commit for publication.

No versioned release has been published in this changelog.
