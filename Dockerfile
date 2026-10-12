# syntax=docker/dockerfile:1.7
# One Dockerfile, three targets: runner (the Plan, Build and Check containers),
# egress (their credential-injecting proxy sidecar) and lambda (steps + intake).
FROM oven/bun:1.4.2 AS deps
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

FROM node:24-bookworm-slim AS base
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
FROM public.ecr.aws/lambda/nodejs:24 AS lambda
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=deps /opt/mork ./
COPY packages packages
CMD ["packages/steps/lambda-steps.handler"]

# Egress sidecar next to each phase container: iron-proxy holds the LLM key
# (and in Build the push token) and adds them to requests to allowed hosts.
FROM ironsh/iron-proxy:0.53.0 AS egress
COPY images/egress/base.yaml images/egress/github-push.yaml /etc/mork-egress/
COPY images/egress/entrypoint.sh /usr/local/bin/mork-egress
ENTRYPOINT ["/usr/local/bin/mork-egress"]
