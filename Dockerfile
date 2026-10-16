# syntax=docker/dockerfile:1.7
# Build tools and dependency trees stay in intermediate stages.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS deps
WORKDIR /opt/mork
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/decision/package.json packages/decision/
COPY packages/runner/package.json packages/runner/
COPY packages/steps/package.json packages/steps/
COPY packages/sources/package.json packages/sources/
COPY packages/store/package.json packages/store/
COPY packages/timeline/package.json packages/timeline/
RUN bun install --frozen-lockfile --production
COPY packages packages
COPY images/bundle.ts images/retain-notices.sh images/
RUN bun images/bundle.ts /bundles && sh images/retain-notices.sh /bundles/notices

# Pi ships a bundled CLI. Keep its runtime assets and explicit external modules,
# without the duplicate unbundled SDKs, TypeScript sources or installer cache.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS agent-deps
WORKDIR /agent
COPY images/runner/package.json images/runner/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY images/retain-notices.sh /retain-notices.sh
RUN sh /retain-notices.sh /pi-notices
RUN mkdir -p /pi/dist/core /pi/dist/modes/interactive /pi/node_modules/@silvia-odwyer \
 && cp node_modules/@earendil-works/pi-coding-agent/package.json /pi/ \
 && cp -a node_modules/@earendil-works/pi-coding-agent/dist/bundle /pi/dist/ \
 && cp -a node_modules/@earendil-works/pi-coding-agent/dist/core/export-html /pi/dist/core/ \
 && cp -a node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme /pi/dist/modes/interactive/ \
 && cp -a node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/assets /pi/dist/modes/interactive/ \
 && cp -aL node_modules/@silvia-odwyer/photon-node /pi/node_modules/@silvia-odwyer/ \
 && cp -aL node_modules/typebox node_modules/jiti /pi/node_modules/ \
 && cp node_modules/@earendil-works/pi-coding-agent/README.md node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md /pi/

# The runner needs actual repository tools. Copy their files and transitive ELF
# libraries from a pinned Debian/Node builder, rather than shipping apt and a distro.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS runner-rootfs
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bash python3 ripgrep fd-find binutils openssl gettext-base \
 && rm -rf /var/lib/apt/lists/* \
 && strip --strip-unneeded /usr/local/bin/node \
 && groupadd -g 10001 agent && useradd -m -u 10001 -g 10001 agent \
 && groupadd -g 10002 sandbox && useradd -m -u 10002 -g 10002 sandbox
COPY images/runner/rootfs.py /build-rootfs.py
RUN python3 /build-rootfs.py \
 && ln -s /opt/pi/dist/bundle/cli.js /rootfs/usr/local/bin/pi

# Release binaries pinned separately by architecture; never execute an amd64 OCR
# inside an ARM64 runner. Only the selected stage is built.
FROM runner-rootfs AS ocr-amd64
ADD --checksum=sha256:879d6eda27d136473f7af680ed5009516baf6236d8a0e5f5f14f3e6dececdd1f https://github.com/alibaba/open-code-review/releases/download/v1.13.0/opencodereview-linux-amd64 /ocr
RUN chmod 755 /ocr && strip --strip-unneeded /ocr

FROM runner-rootfs AS ocr-arm64
ADD --checksum=sha256:2d66c71eeea08730e1394cc39884b9644d301288443d644a02c2adebb0425b93 https://github.com/alibaba/open-code-review/releases/download/v1.13.0/opencodereview-linux-arm64 /ocr
RUN chmod 755 /ocr && strip --strip-unneeded /ocr

FROM ocr-${TARGETARCH} AS ocr-binary

FROM scratch AS runner
COPY --from=runner-rootfs /rootfs/ /
COPY --from=ocr-binary /ocr /usr/local/bin/ocr
COPY --from=agent-deps /pi /opt/pi
COPY --from=agent-deps /pi-notices /usr/share/licenses/pi/npm
COPY --from=agent-deps /agent/bun.lock /usr/share/licenses/pi/bun.lock
COPY --from=deps /bundles/runner /opt/mork
COPY --from=deps /bundles/notices /usr/share/licenses/mork/npm
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/mork/
COPY licenses /usr/share/licenses/mork/licenses/
WORKDIR /opt/mork
ENV NODE_ENV=production PATH=/usr/local/bin:/usr/bin:/bin
CMD ["node", "packages/runner/src/main.ts"]

# Retain AWS's runtime client and native bridge, without the redundant built-in
# AWS SDK, npm, shell, package manager or local Runtime Interface Emulator.
FROM public.ecr.aws/lambda/nodejs:24@sha256:3b4abf538463db1bf81d5c16415091a205deac0fbecc5558adc6eb86220c7aaa AS lambda-runtime
FROM gcr.io/distroless/cc-debian13:latest@sha256:159783207c2cd44c2aa5715961d13c8612368ac9bd450f887e3f08fc8ea461e3 AS lambda
COPY --from=runner-rootfs /usr/local/bin/node /usr/local/bin/node
COPY --from=runner-rootfs /usr/local/share/doc/node /usr/share/licenses/node
COPY --from=lambda-runtime /var/runtime/index.mjs /var/runtime/rapid-client.node /var/runtime/THIRD-PARTY-LICENSES.txt /var/runtime/
COPY --from=deps /bundles/lambda /var/task
COPY --from=deps /bundles/notices /usr/share/licenses/mork/npm
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/mork/
COPY licenses /usr/share/licenses/mork/licenses/
COPY images/lambda/entrypoint.mjs /var/runtime/entrypoint.mjs
WORKDIR /var/task
ENV NODE_ENV=production LAMBDA_TASK_ROOT=/var/task LAMBDA_RUNTIME_DIR=/var/runtime PATH=/usr/local/bin
ENTRYPOINT ["/usr/local/bin/node", "/var/runtime/entrypoint.mjs"]
CMD ["packages/steps/lambda-steps.handler"]

# The proxy is a static Go binary. BusyBox supplies only the entrypoint's shell
# and file utilities; no Alpine package manager or dynamic library tree is needed.
FROM ironsh/iron-proxy:0.53.0@sha256:51f01ab057637c28672f2025216680cdc0b61dbc58a0337f77e0ea95dd6153a6 AS proxy-binary
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092 AS egress
COPY --from=proxy-binary /usr/local/bin/iron-proxy /usr/local/bin/iron-proxy
COPY --from=proxy-binary /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/mork/
COPY licenses /usr/share/licenses/mork/licenses/
COPY images/egress/base.yaml images/egress/github-push.yaml images/egress/github-app.yaml /etc/mork-egress/
COPY images/egress/entrypoint.sh /usr/local/bin/mork-egress
ENV PATH=/usr/local/bin:/bin
ENTRYPOINT ["/usr/local/bin/mork-egress"]

# Tests mount source and development dependencies read-only over /opt/mork.
FROM runner AS runner-test
COPY --from=deps /bundles/runner-test /opt/mork
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
CMD ["bun", "test", "/opt/mork/packages/runner/src/gate.runtime.test.ts", "/opt/mork/packages/runner/src/agentfs.test.ts", "/opt/mork/packages/runner/src/git.test.ts", "/opt/mork/packages/runner/src/inputs.test.ts", "/opt/mork/packages/runner/src/phases.test.ts", "/opt/mork/packages/runner/src/github-auth.test.ts", "/opt/mork/packages/sources/src/github-auth.test.ts"]
