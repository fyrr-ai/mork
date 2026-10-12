# syntax=docker/dockerfile:1.7
# One Dockerfile, three targets: runner (the Plan, Build and Check containers),
# egress (their credential-injecting proxy sidecar) and lambda (steps + intake).
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

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/mork/
COPY licenses /usr/share/licenses/mork/licenses/
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bash python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mork
# Bun's isolated layout keeps links in packages/*/node_modules, so copy the whole tree.
COPY --from=deps /opt/mork ./
COPY packages packages
ENV NODE_ENV=production

# Pi runs as `agent`, repository commands in the gate as `sandbox`; the runner
# process (root) holds the task token, AWS credentials, the read token and the
# decision-API keys. The agent holds no key: the egress sidecar adds the LLM
# key and, in Build, the push token to its requests.
FROM base AS runner
ARG PI_VERSION=1.1.0
RUN npm install -g --no-fund --no-audit @earendil-works/pi-coding-agent@${PI_VERSION} \
 && groupadd -g 10001 agent && useradd -m -u 10001 -g 10001 agent \
 && groupadd -g 10002 sandbox && useradd -m -u 10002 -g 10002 sandbox \
 && mkdir /work
CMD ["node", "packages/runner/src/main.ts"]

# Steps between containers and webhook intakes (GitHub, Slack).
FROM public.ecr.aws/lambda/nodejs:24@sha256:3b4abf538463db1bf81d5c16415091a205deac0fbecc5558adc6eb86220c7aaa AS lambda
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/mork/
COPY licenses /usr/share/licenses/mork/licenses/
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=deps /opt/mork ./
COPY packages packages
CMD ["packages/steps/lambda-steps.handler"]

# Egress sidecar next to each phase container: iron-proxy holds the LLM key
# (and in Build the push token) and adds them to requests to allowed hosts.
FROM ironsh/iron-proxy:0.53.0@sha256:51f01ab057637c28672f2025216680cdc0b61dbc58a0337f77e0ea95dd6153a6 AS egress
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/mork/
COPY licenses /usr/share/licenses/mork/licenses/
COPY images/egress/base.yaml images/egress/github-push.yaml /etc/mork-egress/
COPY images/egress/entrypoint.sh /usr/local/bin/mork-egress
ENTRYPOINT ["/usr/local/bin/mork-egress"]

# Local sandbox regression target. Test sources are mounted read-only at run time.
FROM runner AS runner-test
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
CMD ["bun", "test", "packages/runner/src/gate.runtime.test.ts", "packages/runner/src/agentfs.test.ts", "packages/runner/src/git.test.ts", "packages/runner/src/phases.test.ts"]
