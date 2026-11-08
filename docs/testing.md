# Testing

The suites use Node's built-in test runner (`node:test`), with no test framework. They run against the compiled output in `dist/`, and `npm test` builds first.

```sh
npm test                   # build + unit + integration + UI (about 35 s)
npm run test:unit          # in-process, fast
npm run test:integration   # spawns dist/stdio.js / dist/http.js
npm run test:ui            # headless Chromium
npm run screenshots        # regenerate docs/images/*.png
node --test --test-name-pattern="wizard" "test/integration/*.test.mjs"   # filter by test name
```

## Layout

| Path | What it covers |
| --- | --- |
| `test/helpers.mjs` | Scripted test client (`makeClient`: a "user" that accepts, declines or cancels dialogs), spawning the stdio and HTTP servers on free ports, JSON log collection, Chromium discovery |
| `test/unit/log.test.mjs` | Logger: JSON vs. text format, levels, `silent` |
| `test/unit/clients.test.mjs` | Capability summary (empty `elicitation: {}` means form only, UI extension mimeTypes, sampling, roots, tasks, unknown keys), stable fingerprints, registry dedupe (2026-07-28 logged on first sight only, 2025-era once per connection), ordering |
| `test/unit/flows.test.mjs` | URL-flow store and pages: unguessable IDs, HTML escaping, empty token → 400, completion and `onComplete`, "already completed", second POST → 409 without a second notification, unknown ID → 404, oversized body → 413, other methods → 405, hardening headers (CSP, frame and referrer policy), store cap |
| `test/unit/server.test.mjs` | Form schemas (every variant contains only spec-allowed primitives, defaults valid, all string formats), every `elicit_format_probe` schema is deliberately **not** spec-conforming, tool list and metadata, app-only visibility, MCP App resource (mimeType, `_meta`, self-contained), friendly errors for clients without elicitation, `inspect_client`, `list_seen_clients`, tool-call logging, unique Dialog Lab submission IDs and the submission size cap, token masking. Files: the `io.modelcontextprotocol/files` capability, the `test://files/{name}` template (listing, completion, reads, refusal of unknown and `..` names), `dialog_lab_upload` (size, SHA-256, invalid base64, **file content never in the log**), `upload_file_experimental` (`x-mcp-file` schema, digest/size/missing-data/base64/`maxSize` errors, empty file). Runs in-process over `InMemoryTransport` (2025 handshake) |
| `test/unit/files.test.mjs` | Generated files are valid: PNG chunk CRCs and inflated size, WAV header, PDF xref offsets and string escaping, CRC-32 check value. Strict base64 decoding (padding, whitespace, `data:` prefix, base64url), the size check before decoding, `UPLOAD_MAX_BYTES` parsing and the derived request-body limit |
| `test/unit/banner.test.mjs` | Container startup banner: printed from the file if present, silent otherwise, and in stdio mode only on stderr (stdout stays empty) |
| `test/unit/http-config.test.mjs` | `ALLOWED_HOSTS` parsing and which Host/Origin validation applies (including the `public-url` mode); the 2025-era session cap (least recently used session closed) |
| `test/integration/matrix.mjs` | The protocol matrix, run for **stdio × {2026-07-28, 2025-11-25}** and **HTTP × {2026-07-28, 2025-11-25}**: era negotiation, capability log line, accept/decline/cancel for every elicitation tool, wizard step dependencies and cancellation at later steps, URL flow (page submitted; early accept with the page submitted afterwards, as Open WebUI does; never submitted → `isError` after `FLOW_WAIT_MS`; cancelled while waiting; declined), legacy push with the `notifications/elicitation/complete` notification (2025) or a clear refusal (2026), progress, cancellation through `AbortSignal` (checked in the server log), MCP App metadata and resource, submit → results round trip, `return_files` (block order, valid PNG/PDF/WAV bytes, the `resource_link` read back with matching size), a 5 MiB `dialog_lab_upload` (above the SDK's 4 MiB HTTP default and near the stdio buffer default), an inline `upload_file_experimental` call, `elicit_format_probe` (`pattern` accepted, decline, `color` refused by the SDK client: a thrown `-32602` on 2026-07-28, an `isError` result from the shim on 2025, and `all` stopping after the first round), a client without elicitation, `list_seen_clients`, log dedupe |
| `test/integration/stdio.test.mjs` | Runs the matrix over stdio, plus: no log output on stdout, `FLOW_HOST`/`FLOW_PUBLIC_URL`, `FLOW_PORT` busy → fallback |
| `test/integration/http.test.mjs` | Runs the matrix over HTTP (one server for both eras), plus: `/` and 404s, 2025-era session errors (400 without a session, 404 for an unknown session, 404 after `DELETE`), unsupported methods → 405, Host/Origin validation, `ALLOWED_HOSTS`, `HOST=0.0.0.0` with a local or public `PUBLIC_URL`, **requestState tampering** (a captured wizard retry replayed with a modified state → `-32602`), many frontends deduplicated in the log, graceful SIGTERM/SIGINT, port already in use, the **request-body cap** (`UPLOAD_MAX_BYTES=1000` → 413 for a 2 MB body; upload of 1001 bytes is a tool error, 1000 bytes pass), and the raw 2026-07-28 wire showing that probe schemas (nested object, `pattern`) leave the server unchanged |
| `test/ui/host.ts` | Minimal MCP Apps host: `AppBridge` + `PostMessageTransport` from `@modelcontextprotocol/ext-apps/app-bridge`, with the app in a sandboxed `srcdoc` iframe. Host capabilities are configurable (`openDialogLab(browser, { hostCapabilities, env })`). Bundled on the fly with esbuild |
| `test/ui/harness.mjs` | Starts the real server over stdio, reads the `ui://` resource, opens it in Chromium, and proxies the app's `tools/call` to the real MCP client |
| `test/ui/dialog-lab.test.mjs` | Clicks through the Dialog Lab: tool input applied, stars, colour, slider, ranking, comment, sketch → **Submit** (checked on the server via `dialog_lab_results`), **chat message**, **model context**, **fullscreen**, **downloads** (JSON text, PNG blob, `resource_link` that is then read from the server), **file upload** (150 KB through `setInputFiles`, SHA-256 shown), a host **without `downloadFile`** (buttons stay disabled, also after other actions) with `UPLOAD_MAX_BYTES=1000` (oversized upload shows the server's error), no page errors, and light/dark themes |

## Design rules

- **Free ports only.** HTTP servers use `PORT=0` and report the real port in the `http.listening` JSON log event. Flow listeners use `FLOW_PORT=0`.
- **No sleeps for synchronisation.** Tests wait for specific JSON log events (`LogCollector.waitFor`) or conditions, with timeouts.
- **Child processes are always cleaned up.** stdio servers exit when the client closes the transport. HTTP servers are stopped in `after()` hooks (SIGTERM, then SIGKILL after 5 s).
- **Logs as a test oracle.** Servers run with `LOG_FORMAT=json LOG_LEVEL=debug`, and tests check `client.seen`, `client.connected` and `tool.result` events. Cancellation, for example, is verified by the server logging `outcome: "cancelled"` for `slow_task`.
- Test files run one at a time (`--test-concurrency=1`). This keeps the output readable; the files do not share state.

## Browser (UI) tests

The UI test needs a Chromium binary, which playwright-core does not download. It looks in this order:

1. `$CHROMIUM_PATH`
2. playwright-core's expected browser location, then any `chromium_headless_shell-*` or `chromium-*` folder in `$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`
3. `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome(-stable)`

If none is found, the suite is **skipped** with a message (`# UI tests skipped: no Chromium found …`), and the other suites still pass. To install one:

```sh
npx playwright-core install chromium-headless-shell
```

Two quirks of the harness, both handled in code:

- The host context (theme, display modes) is passed to the `AppBridge` **constructor**. Calling `setHostContext()` before `connect()` throws "Not connected".
- The app HTML is inlined into the host page as a JSON `<script>`, with `<` escaped. `page.addInitScript` did not deliver it reliably together with `setContent`.

`npm run screenshots` uses the same harness to write `docs/images/dialog-lab-{light,dark}.png` and `docs/images/url-flow-{light,dark}.png`.

## CI

`.github/workflows/docker-image.yml` runs `npm test` on every push and pull request that touches the code, with a headless Chromium installed so the UI suite runs (a skipped UI suite fails the job). It then builds the Docker image and smoke-tests it; see [docker.md](docker.md#ci-and-published-images).

## What the tests do not cover

- **Real clients.** No suite drives Claude Desktop, Claude Code, VS Code, Cursor or Open WebUI. The scripted client is the official TypeScript SDK client, which can show that the server follows the spec, not that a particular client renders dialogs. For Open WebUI see [openwebui.md](openwebui.md).
- **Real hosts for the MCP App.** The browser test host is a minimal `AppBridge` host. Real hosts add their own sandbox proxy, CSP and size handling.
- **Non-spec probes with a lenient client.** The official TypeScript client refuses every `elicit_format_probe` schema except `pattern`, so the "accepted" path of the other probes (and a complete `all` run) is only exercised by real clients.
- **Real host message limits.** Uploads are tested up to 5 MiB through the test host; what a real host allows between iframe and server is what the Dialog Lab is for.
- **The 2025-06-18 protocol version.** Only 2025-11-25 is tested for the 2025 era, using the SDK default for `mode: 'legacy'`.
