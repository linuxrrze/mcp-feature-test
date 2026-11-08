# Running mcp-feature-test in Docker

The image runs the server in **Streamable HTTP mode** by default (`node dist/http.js`, port 3457, endpoint `/mcp`). The same image can also run in **stdio mode** (`node dist/stdio.js`) for clients that launch MCP servers as subprocesses.

> **This is a test server with no authentication.** Any client that reaches the port can call every tool. Keep it on localhost or a trusted network (see [Security](#security)).

## Published image

CI publishes the image to the GitHub Container Registry:

```sh
docker pull ghcr.io/linuxrrze/mcp-feature-test           # latest build of main
docker pull ghcr.io/linuxrrze/mcp-feature-test:1.0.0     # package.json version
docker pull ghcr.io/linuxrrze/mcp-feature-test:1.0.0-20261108   # one specific (dated) build, for rollbacks
```

In all examples below you can use `ghcr.io/linuxrrze/mcp-feature-test` instead of a locally built `mcp-feature-test`. The image is built for `linux/amd64`.

## Build

```sh
docker build -t mcp-feature-test .

# optional: stamp OCI labels
docker build -t mcp-feature-test:1.0.0 \
  --build-arg VERSION=1.0.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  --build-arg CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg SOURCE=https://github.com/linuxrrze/mcp-feature-test .
```

The build is multi-stage:

| Stage     | What it does |
|-----------|--------------|
| `build`   | `npm ci` (all dependencies), then `npm run build` (tsc + esbuild bundle of `dist/ui/dialog-lab.html`) |
| `deps`    | `npm ci --omit=dev --ignore-scripts`: production dependencies only |
| `runtime` | `node:24-alpine` (pinned by tag and digest) + `tini` + production `node_modules` + `dist/`, running as uid 1000 (`node`) |

Dev tooling (TypeScript, esbuild, tsx, test tooling such as playwright-core) never reaches the final image. npm, npx, corepack and yarn are removed from the runtime stage. `package-lock.json` has to be in sync with `package.json`, because `npm ci` fails otherwise.

To update Node, change `NODE_IMAGE` at the top of the `Dockerfile` (tag **and** digest), or override it for a one-off build with `--build-arg NODE_IMAGE=node:24-alpine`.

## Run: HTTP mode (default)

```sh
docker run --rm -p 127.0.0.1:3457:3457 mcp-feature-test
# MCP endpoint: http://127.0.0.1:3457/mcp
curl http://127.0.0.1:3457/          # "mcp-feature-test is running."
```

If you publish on a different host port or hostname, set `PUBLIC_URL` to the base URL the user's browser will use:

```sh
docker run --rm -p 127.0.0.1:8080:3457 -e PUBLIC_URL=http://localhost:8080 mcp-feature-test
```

`PUBLIC_URL` is used to build the links for URL-mode elicitation (`<PUBLIC_URL>/flow/<uuid>`). Those links are opened by the **user's browser**, not by the container or the MCP client, so a wrong `PUBLIC_URL` produces a dead link while every other tool keeps working.

The image declares a `HEALTHCHECK` (`GET /` must return 200) that `docker ps` and compose report:

```sh
docker inspect --format '{{.State.Health.Status}}' <container>
```

### docker compose

`compose.yaml` runs HTTP mode, publishes on `127.0.0.1` only and applies some hardening (read-only root filesystem, all capabilities dropped, `no-new-privileges`):

```sh
docker compose up -d --build
docker compose ps                     # STATUS shows (healthy)

# a different host port or a public URL behind a proxy:
HOST_PORT=8080 docker compose up -d
PUBLIC_URL=https://mcp-test.example.org docker compose up -d
```

You can also put these variables in a `.env` file next to `compose.yaml`.

## Run: stdio mode

Override the command and keep stdin open with `-i`. Do not use `-t`, because a TTY corrupts the JSON-RPC stream.

```sh
docker run -i --rm --no-healthcheck mcp-feature-test node dist/stdio.js
```

`--no-healthcheck` stops Docker from probing the HTTP port, which does not exist in stdio mode. Without it the container works but shows as `unhealthy`. stdout is the protocol channel and all logs go to stderr. `tini` is PID 1, so the container exits when the client closes stdin or presses Ctrl+C.

### URL-mode elicitation in stdio mode

In stdio mode the `/flow/<uuid>` pages are served by a small second listener on `FLOW_PORT` (3458) that starts on first use. To open these pages from the host browser, the port has to be published (`-p 127.0.0.1:3458:3458`) **and** the listener has to bind to an interface the port mapping can reach.

> **Note:** the listener binds to `FLOW_HOST` (default `127.0.0.1`; the image sets `0.0.0.0` so Docker's port forwarding can reach it) and advertises `http://127.0.0.1:<FLOW_PORT>` in URL-elicitation links. If the browser must use a different address or host port, set `FLOW_PUBLIC_URL` (e.g. `-e FLOW_PUBLIC_URL=http://127.0.0.1:4458` together with `-p 127.0.0.1:4458:3458`). If `FLOW_PORT` is already taken inside the container, the server falls back to a random free port and logs a warning; that port is not published, so keep one server per container.

Publish the flow port so URL-elicitation pages open from the host browser:

```sh
docker run -i --rm --no-healthcheck -p 127.0.0.1:3458:3458 mcp-feature-test node dist/stdio.js
```

Only one container at a time can publish host port 3458. If two clients start the server at the same moment, give each one its own host port and set `FLOW_PUBLIC_URL` to match.

## Environment variables

| Variable     | Default in image | Mode  | Meaning |
|--------------|------------------|-------|---------|
| `HOST`       | `0.0.0.0`        | HTTP  | Bind address inside the container. Host/Origin localhost checks still apply while `PUBLIC_URL` is a localhost URL (see [Security](#security)). |
| `ALLOWED_HOSTS` | (unset)       | HTTP  | Comma-separated hostnames accepted in `Host`/`Origin`, e.g. `mcp.example.com`. Set it when `PUBLIC_URL` is not localhost; otherwise validation is off and a warning is logged. |
| `PORT`       | `3457`           | HTTP  | Listen port inside the container. If you change it, change `-p …:<PORT>` to match. The healthcheck follows it. |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | HTTP | Externally reachable base URL, without `/mcp` or a trailing slash. Used for URL-elicitation links and in the `GET /` banner. |
| `FLOW_PORT`  | `3458`           | stdio | Port of the lazily started URL-flow listener. |
| `FLOW_HOST`  | `0.0.0.0`        | stdio | Bind address of that listener. |
| `FLOW_PUBLIC_URL` | (derived)   | stdio | Base URL used in URL-elicitation links, if the browser must use another address/port. |
| `FLOW_WAIT_MS` | `300000` | both | How long the URL tools wait for the browser page after the client already answered `accept`. |
| `UPLOAD_MAX_BYTES` | `10485760` | both | Largest decoded file the upload tools accept; also sizes the HTTP body limit (base64 of this plus 1 MiB → 413 above) and the stdio message buffer. |
| `NODE_ENV`   | `production`     | both  | |
| `LOG_FORMAT`, `LOG_LEVEL` | (server default) | both | `LOG_LEVEL` = debug/info/warn/error/silent (default info), `LOG_FORMAT` = text/json (default text). Client capabilities and tool calls are logged. Logs go to stderr, so `docker logs` shows them. |

## Connecting clients

### HTTP

Point any Streamable HTTP client at `http://localhost:3457/mcp`, or at `<PUBLIC_URL>/mcp`.

- **Claude Code:** `claude mcp add --transport http feature-test http://localhost:3457/mcp`
- **VS Code** (`.vscode/mcp.json`):
  ```json
  { "servers": { "feature-test": { "type": "http", "url": "http://localhost:3457/mcp" } } }
  ```
- **Claude Desktop / claude.ai:** a remote connector (Settings → Connectors) has to be reachable from Anthropic's servers over public HTTPS, so put it behind a reverse proxy with a public `PUBLIC_URL`. For a local-only setup use the stdio configuration below.
- **MCP Inspector:** `npx @modelcontextprotocol/inspector`, then choose transport "Streamable HTTP" and URL `http://localhost:3457/mcp`.

The server supports both 2026-07-28 clients (stateless) and 2025-era clients (sessionful, `Mcp-Session-Id`) on the same endpoint.

### stdio (Docker as the server command)

Build the image first, because the client won't build it. Each client session starts a fresh container (`--rm`).

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "feature-test": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--no-healthcheck", "mcp-feature-test", "node", "dist/stdio.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "feature-test": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "--no-healthcheck", "mcp-feature-test", "node", "dist/stdio.js"]
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add feature-test -- docker run -i --rm --no-healthcheck mcp-feature-test node dist/stdio.js
```

To pass options, add `"-e", "LOG_LEVEL=debug"` or `"-p", "127.0.0.1:3458:3458"` (for URL-elicitation pages) before the image name.

## Reverse proxy and PUBLIC_URL

- Set `PUBLIC_URL` to the public base URL, for example `https://mcp-test.example.org`. Clients then use `https://mcp-test.example.org/mcp`.
- **Path prefix:** the server serves `/`, `/mcp` and `/flow/…` at its root. If you mount it under a prefix such as `https://example.org/mcp-test/`, have the proxy strip the prefix and include it in `PUBLIC_URL` (`PUBLIC_URL=https://example.org/mcp-test`).
- **Streaming:** responses can be Server-Sent Events, and legacy sessions also keep a long-lived `GET /mcp` stream open. Turn off response buffering and allow long read timeouts. For nginx:
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:3457;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Connection "";
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 1h;
  }
  ```
  Pass the `Mcp-Session-Id`, `Mcp-Protocol-Version` and `Last-Event-ID` headers through unchanged. Most proxies do this by default.
- **Single replica:** legacy sessions and URL flows are kept in memory. Run one replica, or use sticky sessions, which still won't share flow state.
- **TLS** terminates at the proxy. The container itself only speaks plain HTTP.

## Security

- **No authentication.** Every tool is open to anyone who can reach `/mcp`. The URL-flow pages accept any "token" and keep it in memory. Don't store real secrets in them.
- **Binding.** Inside the container the server binds `0.0.0.0`, which is needed for Docker port forwarding. Its localhost Host/Origin validation (DNS-rebinding protection) stays active as long as `PUBLIC_URL` is a localhost URL (the default); for any other `PUBLIC_URL`, set `ALLOWED_HOSTS`, otherwise validation is off. In addition:
  - Publish on loopback only: `-p 127.0.0.1:3457:3457` (the compose default). A plain `-p 3457:3457` exposes the server on every host interface, and Docker's iptables rules bypass most host firewalls.
  - A browser on the same machine could still reach a loopback-published port through DNS rebinding. Don't keep the container running longer than you need it.
  - On a shared network, put it behind a reverse proxy with authentication (basic auth, an SSO proxy, or an IP allow-list).
- **Container hardening.** The image runs as uid 1000 (non-root), contains no npm, and keeps application files root-owned and read-only. The compose file adds `read_only: true`, `cap_drop: [ALL]` and `no-new-privileges`. The same flags work with `docker run`: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`.

## CI and published images

[`.github/workflows/docker-image.yml`](../.github/workflows/docker-image.yml) follows the conventions of the `*-rebuild.yml` workflows in the docker-images repository; its helper scripts in `.github/scripts/` (`base-digest.sh`, `add-banner.sh`, `trivy-scan.sh`) are copies of `docker-images/.gitea/scripts/`.

| Trigger | What happens |
|---------|--------------|
| push to `main` (image-relevant paths only) | tests, build, startup banner, smoke test, Trivy, push to GHCR |
| pull request | the same, without pushing |
| daily schedule | rebuild and push only if the `node:<tag>` base image was re-published (its digest differs from the pin in the `Dockerfile`); afterwards the bot commits the new digest pin |
| manual run (`workflow_dispatch`) | like a push; only `main` publishes |

Steps of the image job:

1. **Tests**: `npm test` with a headless Chromium, so the MCP App UI tests run too (the job fails if they were skipped).
2. **Build** with `NODE_IMAGE=<tag>@<current digest>` and the OCI labels (version from `package.json`, commit, date, source).
3. **Startup banner**: `add-banner.sh` in *builtin* mode (`LABEL de.linux-ng.image-banner=builtin`): it only adds `/usr/local/share/image-banner.txt`, and the server prints it to **stderr** on start (`src/banner.ts`). The usual shell-wrapper banner would print to stdout and break stdio mode, where stdout is the MCP protocol channel.
4. **Smoke test**: the HTTP endpoint answers, and in stdio mode an `initialize` request gets a clean JSON-RPC reply on stdout.
5. **Trivy**: fails on fixable CRITICAL/HIGH findings. Accepted findings go into a `.trivyignore` file at the repository root, with a reason.
6. **Push**: `:<version>`, `:<version>-<YYYYMMDD>` (rollback) and `:latest`.

To release a new version, bump `version` in `package.json`. A rebuild without a version bump re-publishes the same version tag; the dated tag keeps the previous build available.

The first push creates the package as **private** on GHCR. To allow anonymous `docker pull`, set the package's visibility to public under *Your profile → Packages → mcp-feature-test → Package settings*.
