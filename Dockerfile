# syntax=docker/dockerfile:1.7
#
# mcp-feature-test: MCP test server for elicitation dialogs and MCP Apps UIs.
#
#   docker build -t mcp-feature-test .
#   docker run --rm -p 127.0.0.1:3457:3457 mcp-feature-test        # HTTP → http://127.0.0.1:3457/mcp
#   docker run -i --rm --no-healthcheck mcp-feature-test node dist/stdio.js   # stdio
#
# See docs/docker.md for details.

# Pinned base image (tag + multi-arch index digest). Bump both together.
ARG NODE_IMAGE=node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# ---------------------------------------------------------------------------
# build: full dependency tree (incl. devDependencies) → tsc + esbuild → dist/
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Dev tooling must never download browsers or phone home during the build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY ui ./ui
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# deps: production dependencies only, no lifecycle scripts
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# runtime: node + tini + runtime deps + dist/, running as the unprivileged `node` user
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG VERSION=1.0.0
ARG REVISION=unknown
ARG CREATED=unknown
ARG SOURCE=https://github.com/linuxrrze/mcp-feature-test
LABEL org.opencontainers.image.title="mcp-feature-test" \
      org.opencontainers.image.description="Sample MCP server for testing elicitation dialogs (form + URL mode) and MCP Apps UIs in real MCP clients. Test server: no authentication." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.io/library/node:24.20.0-alpine3.24"

# tini as PID 1: forwards signals and reaps zombies, so `docker stop` and Ctrl+C
# work in both HTTP and stdio mode. npm/npx/corepack/yarn are not needed at
# runtime and are removed to reduce the attack surface (and CVE scanner noise);
# note this does not shrink the base layers themselves.
# hadolint ignore=DL3018
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
# Files stay owned by root (read-only for the runtime user).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3457 \
    FLOW_PORT=3458 \
    FLOW_HOST=0.0.0.0
# PUBLIC_URL: externally reachable base URL (default http://127.0.0.1:$PORT).
#   Set it whenever the server is published on another host/port or behind a proxy.
# FLOW_HOST: bind address of the stdio-mode URL-flow listener (see docs/docker.md).

# uid/gid 1000 = the `node` user of the base image (numeric for runAsNonRoot checks).
USER 1000:1000
EXPOSE 3457 3458

# HTTP mode only (GET / → 200 text/plain). Disable for stdio: --no-healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3457)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/http.js"]
