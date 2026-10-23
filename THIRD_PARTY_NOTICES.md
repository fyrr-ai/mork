# Third-party notices

Mork's own code is licensed under [Apache-2.0](LICENSE). Third-party software
keeps its original license. This file records dependency licenses and credits
research references. It does not change those terms.

## Components used at runtime

| Component | Use | License and retained text |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/v1.1.0) | Runner's coding-agent CLI, version 1.1.0 | MIT, copyright 2025 Mario Zechner. [License](licenses/pi.LICENSE) |
| [iron-proxy](https://github.com/ironsh/iron-proxy/tree/v0.54.0) | Egress sidecar, version 0.54.0 | Apache-2.0. [License](licenses/iron-proxy.LICENSE) |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3/tree/v3.908.0) | AWS clients | Apache-2.0. [License supplement](licenses/aws-sdk-js-v3.LICENSE) |
| [Open Code Review](https://github.com/alibaba/open-code-review/tree/v1.13.0) | OCR 1.13.0 review engine and its embedded language rules | Apache-2.0, copyright 2026 Alibaba. [License](licenses/open-code-review.LICENSE) |
| [Zod](https://github.com/colinhacks/zod) | Input schemas | MIT. See the installed package's `LICENSE` |
| [smol-toml](https://github.com/squirrelchat/smol-toml) | Repository configuration parsing | BSD-3-Clause. See the installed package's `LICENSE` |

`bun.lock` fixes workspace dependency versions. Installed dependencies include
additional MIT, Apache-2.0 and 0BSD components. Preserve each package's license,
copyright and notice files when packaging dependencies. The AWS SDK supplement
covers SDK packages whose npm archive omits its own license text.

## Research acknowledgements

The table below records projects consulted for the design. Mork's code names
the Foreman supervision pattern and the jev-proof evidence pattern. The available
history does not identify exact
copied portions. These acknowledgements and retained texts do not assert that
any particular Mork file was copied from those projects.

| Project | Recorded design reference | License and copyright |
| --- | --- | --- |
| [thruwire/foreman](https://github.com/thruwire/foreman) | Supervision and bounded evidence | [MIT](licenses/foreman.LICENSE), copyright 2026 thruwire |
| [klauswg/jev-suite, jev-proof](https://github.com/klauswg/jev-suite/tree/master/jev-proof) | Evidence-based criteria verdicts | [MIT](licenses/jev-suite.LICENSE), copyright 2026 klauswg |
| [vercel-labs/eve-software-factory-template](https://github.com/vercel-labs/eve-software-factory-template) | Workflow research | [MIT](licenses/eve-software-factory-template.LICENSE), copyright 2026 Vercel, Inc. |
| [AWS autonomous cloud coding agents](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents) | Fargate and verification patterns | [MIT-0](licenses/aws-autonomous-coding-agents.LICENSE), copyright 2026 Amazon.com, Inc. or its affiliates |
| [devagrawal09/jev-review](https://github.com/devagrawal09/jev-review) | Change-risk questions | [MIT](licenses/jev-review.LICENSE), copyright 2026 Dev Agrawal |
| [egma-ai/jev-code-reviewer](https://github.com/egma-ai/jev-code-reviewer) | Review reading order | [MIT](licenses/jev-code-reviewer.LICENSE), copyright 2026 Jev-Reviewer contributors |
| [abhixhek/jevcal](https://github.com/abhixhek/jevcal) | Calibration patterns | [MIT](licenses/jevcal.LICENSE), copyright 2026 abhixhek |
| [mandu5/jevcompat](https://github.com/mandu5/jevcompat) | Decision API contract tests | [MIT](licenses/jevcompat.LICENSE), copyright 2026 Youngmin Ko |

Projects without a license in the research table are design references only.
Do not incorporate their code without permission. See
[licenses/README.md](licenses/README.md) for the exact source revisions and hashes
of the retained license texts.

## Container builds and redistribution

This repository supplies source and Docker build instructions. Users build their
own images; this notice does not certify license compliance for redistributing
those images.

The Docker targets include third-party binaries and operating-system packages.
Keep the original package notices, Pi's installed license and Debian's
`/usr/share/doc` copyright files. Include this notice, `NOTICE`, `LICENSE` and
`licenses/` in every final Mork image.

Before distributing images, inventory their actual packages and bundled binaries,
retain all required notices and satisfy any source-distribution obligations.
The iron-proxy upstream image contains a Go binary with transitive dependencies;
its top-level Apache-2.0 license alone does not inventory those dependencies.
Its [source at version 0.54.0](https://github.com/ironsh/iron-proxy/tree/v0.54.0)
includes the dependency list and build instructions. Node, the Lambda base image,
Alpine and Debian packages also keep their own terms.

The runner ships the Open Code Review 1.13.0 linux-amd64 release binary, verified
against SHA-256 `879d6eda27d136473f7af680ed5009516baf6236d8a0e5f5f14f3e6dececdd1f`.
Its upstream source and Go dependency list are available at
[version 1.13.0](https://github.com/alibaba/open-code-review/tree/v1.13.0).
