# Changelog

## 0.1.0

Prepared for release; not published.

- Give the reviewer the changed files and rules by file type, verify each finding's quote in the reviewed commit, and send proven defects that Jev rates must-fix back to Build before the PR (`repairs.rounds`, 3 by default, each with its own Build attempt).
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
