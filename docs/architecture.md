# Architecture

How mcp-feature-test serves one set of tools to two protocol generations over two transports, and what to know about its security.

```
             ┌─────────────── src/stdio.ts ────────────────┐
 stdio ────► │ serveStdio(factory)  – era picked by the     │
             │ first message, one McpServer per connection  │──┐
             └──────────────────────────────────────────────┘  │   createFeatureTestServer()
             ┌──────────── src/httpServer.ts ───────────────┐  ├─► src/server.ts  (tools, prompt, ui:// resource)
 HTTP ─────► │ /mcp  2026-07-28 → createMcpHandler (per req) │──┘     ├─ src/clients.ts (capability log, registry)
 :3457       │       2025-era   → session transport map      │        ├─ src/flows.ts   (URL-elicitation pages)
             │ /flow/<uuid> → flows.ts   /  → banner         │        ├─ src/log.ts     (stderr logger)
             └──────────────────────────────────────────────┘        └─ src/files.ts   (sample files, upload limits)
```

## Protocol eras

| | 2025-era (2025-06-18, 2025-11-25) | 2026-07-28 ("modern") |
| --- | --- | --- |
| Handshake | `initialize` + `notifications/initialized` | none (optional `server/discover`) |
| Client info and capabilities | sent once in `initialize` | sent in **every request** under `_meta`: `io.modelcontextprotocol/clientInfo`, `…/clientCapabilities`, `…/protocolVersion` |
| Asking the user something | server→client request `elicitation/create` while the tool call is pending (push) | the tool call **returns** `resultType: "input_required"` with `inputRequests`. The client asks the user and **retries** the call with `inputResponses` (multi round-trip) |
| Server state between rounds | in memory on the connection | `requestState`: opaque, echoed back by the client |
| HTTP | sessionful (`Mcp-Session-Id`) | stateless |

A client picks its era: the official TypeScript client uses the 2025 handshake by default and negotiates 2026-07-28 only with `versionNegotiation: { mode: { pin: '2026-07-28' } }` (or `'auto'`).

`createFeatureTestServer()` is a factory. Under `serveStdio` it runs once per connection. Under `createMcpHandler` it runs **once per HTTP request**, so anything that must outlive a request (Dialog Lab submissions, URL flows, the seen-clients registry, the `requestState` signing key) lives at module level.

## input_required vs. push elicitation, and the legacy shim

Sequence diagrams of both elicitation modes (form and URL) on both protocol generations are in [elicitation.md](elicitation.md).

Every elicitation tool except `elicit_url_legacy_push` is written once, in the 2026-07-28 style:

```ts
const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
if (view.kind === 'elicit') { /* handle accept / decline / cancel */ }
return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) } });
```

- **On 2026-07-28** the SDK sends that result to the client. The client shows the dialog and calls the tool again with `inputResponses` (and `requestState`, if the server set one).
- **On 2025-era connections** the SDK's **legacy shim** intercepts the `input_required` result. It sends an `elicitation/create` request for each input request, collects the answers, and calls the handler again with them as `inputResponses`. The handler code can't tell the difference. `elicit_parallel`'s two requests are sent one after the other.

`elicit_url_legacy_push` deliberately uses the old API (`ctx.mcpReq.elicitInput` plus `createElicitationCompletionNotifier`), so you can test whether a 2025-era client handles `notifications/elicitation/complete`. On 2026-07-28 that API throws, because there is no server→client request channel, so the tool returns an explanatory error first.

Before asking anything, every elicitation tool checks the client's declared capabilities: `elicitation.form` (or an empty `elicitation: {}`) for forms, and `elicitation.url` for URL mode. If the capability is missing, the tool returns `isError` with an explanation instead of failing with a protocol error. Otherwise the SDK would raise `MissingRequiredClientCapabilityError` on 2026-07-28, or the elicitation request would fail on 2025-era connections.

## requestState signing

`elicit_wizard` and `elicit_url` keep their progress in `requestState`, which the client stores and returns. A client could tamper with it, for example to skip the confirmation step or to reference another user's flow ID. To prevent that, the state is minted with the SDK's `createRequestStateCodec` (HMAC with a random 32-byte key generated at startup, 15-minute TTL), and the server is constructed with `requestState: { verify: stateCodec.verify }`. A modified, truncated or expired state is rejected with JSON-RPC `-32602 Invalid or expired requestState` before the handler runs. The integration suite replays a captured wizard request with a flipped byte to check this.

Because the key is random per process, state does not survive a restart, and several replicas behind a load balancer would need a shared key. Neither matters for a test server.

## HTTP routing

`src/httpServer.ts` serves one endpoint for both eras:

1. `GET /` returns a plain-text banner. `/flow/<uuid>` serves the URL-elicitation pages (GET shows the form, POST submits it). Every other path returns 404.
2. On `/mcp`, Host/Origin validation runs (see below).
3. `isLegacyRequest(request, body)` from the SDK classifies the request. Requests with a valid 2026-07-28 `_meta` envelope go to `createMcpHandler(factory, { legacy: 'reject' })`: stateless, a new server instance per request.
4. 2025-era traffic goes to a map of `NodeStreamableHTTPServerTransport`s keyed by `Mcp-Session-Id`. An `initialize` without a session creates one (new server instance and transport). A request with an unknown session ID gets **404** (the client should re-initialize). A non-initialize request without a session ID gets **400**. `DELETE` closes a session.

The legacy path stays sessionful because the shim's `elicitation/create` requests need a channel back to the client while the tool call is still pending.

## Capability logging

`instrumentRequests()` in `src/server.ts` wraps `server.server.setRequestHandler` before any tool is registered, so every handler the McpServer installs runs through an observer. The SDK's own validation and the `input_required` / legacy-shim loop still sit outside this wrapper, so on 2025-era connections each shim round is observed too. The observer:

- reads client info and capabilities from `ctx.mcpReq.envelope` (2026-07-28) or from `server.server.getClientVersion()` / `getClientCapabilities()` (2025-era),
- updates the registry in `src/clients.ts`, keyed by a SHA-256 fingerprint of name, version, protocol version, era, transport and capabilities (with sorted keys). The first sighting of a 2026-07-28 combination is logged as `client.seen`,
- logs each `tools/call` round: `tool.input_required` (with the requested input keys and modes) or `tool.result` (user answers, outcome, duration).

2025-era connections are logged from the SDK's `server.server.oninitialized` hook (`client.connected`). `list_seen_clients` exposes the registry, which holds at most 200 entries.

## MCP Apps flow

For the difference between the server and the app it ships, see [MCP server vs. MCP App](server-vs-app.md).

```
host                                   server                          app (iframe)
 │ tools/list ───────────────────────►  open_dialog_lab: _meta.ui.resourceUri = ui://feature-test/dialog-lab.html
 │ resources/read ui://… ─────────────►  text/html;profile=mcp-app (single file, JS inlined)
 │ tools/call open_dialog_lab ────────►  text + structuredContent {question, items}
 │ render iframe(srcdoc) ─────────────────────────────────────────────►  App.connect()  (ui/initialize)
 │ ui/notifications/tool-input + tool-result ─────────────────────────►  fills question + ranking
 │ ◄── tools/call dialog_lab_submit (app-only) ─────────────────────────  "Submit to server"
 │ tools/call ───────────────────────►  stores submission
 │ ◄── ui/message, ui/update-model-context, ui/request-display-mode, ui/download-file
```

- The UI (`ui/dialog-lab.html` + `ui/dialog-lab.ts`) is bundled with esbuild into **one self-contained HTML file** (`dist/ui/dialog-lab.html`), so the host needs no CSP `resourceDomains` configuration.
- `dialog_lab_submit` has `_meta.ui.visibility: ["app"]`. Hosts should not offer it to the model, only to the app. The server cannot enforce this; it depends on the host. To the server it is an ordinary tool, so any client can call it.
- `dialog_lab_upload` is app-only in the same way. The **File upload** card reads the file with `FileReader`, sends base64 through `tools/call`, and compares the returned size and SHA-256 with its own (`crypto.subtle`, when the frame is a secure context). The download buttons are enabled only when `hostCapabilities.downloadFile` is present and send a text resource, a blob resource and a `resource_link` respectively.
- The app follows the host theme (`hostContext.theme` → `data-theme`) and host CSS variables. The browser test checks light and dark.
- `registerAppTool` also writes the deprecated flat key `_meta["ui/resourceUri"]` for older hosts.

## Files

There is no file upload in the MCP spec, and form elicitation has no file (or colour) field. What exists, and what this server exercises:

| Direction | Mechanism | Tool |
| --- | --- | --- |
| server → client | Tool result content: `resource` (embedded, `text` or base64 `blob`), `resource_link` (the client reads it with `resources/read`), `image`, `audio` | `return_files` |
| server → client | Resource template `test://files/{name}` (`resources/templates/list`, `resources/list` via the template's `list` callback, `completion/complete` for `name`) | `return_files` links into it |
| app → host → user | MCP Apps `ui/download-file` with `contents: (EmbeddedResource \| ResourceLink)[]`, only when the host advertises `hostCapabilities.downloadFile` | Dialog Lab download buttons |
| user → app → server | `<input type=file>` → base64 → `tools/call dialog_lab_upload` (app-only) | Dialog Lab **File upload** |
| user → client → server | Experimental `io.modelcontextprotocol/files` draft: a tool argument marked `x-mcp-file` (`maxSize`), value `{id, name?, mimeType, size, digest?, data?}`, inline base64 up to the server's `maxInlineBytes` | `upload_file_experimental` |

`src/files.ts` generates the sample files in code (a gradient PNG with real CRCs, a one-page PDF with correct xref offsets, an 8-bit PCM WAV, CSV and Markdown), so there are no binary fixtures in the repository.

The server advertises `capabilities.extensions["io.modelcontextprotocol/files"] = { maxInlineBytes: UPLOAD_MAX_BYTES }`. It implements only inline transfer: a non-empty file without `data` is a tool error (the draft's out-of-band `upload_required` flow is not implemented, and `upload` is not advertised).

### Non-spec form fields (`elicit_format_probe`)

The probe schemas are passed to `inputRequired.elicit()` as **plain JSON**, so they travel exactly like the spec-conforming ones: as `input_required` on 2026-07-28 and through the legacy shim's `elicitation/create` on 2025-era connections. One probe per round, with the remaining probes and the results so far in HMAC-signed `requestState`.

What the SDK does with them (checked in `@modelcontextprotocol/server` 2.4.0 and `client` 2.4.0):

- **Server SDK:** a raw JSON `requestedSchema` is **not** validated before it is sent. Only a Standard Schema (zod) is converted and checked, and that conversion throws for shapes outside the spec, which is why the probes are plain JSON. On 2025-era connections the shim forwards accepted content **without** validating it against the schema (`validateAcceptedContent: false`), so a format such as `color` doesn't trip the server-side AJV validator. Nothing was worked around: spec-conforming clients get exactly the same requests.
- **Client SDK:** the official TypeScript client parses every elicitation request with the spec schema. It refuses unknown formats, `object` properties and free arrays (`-32602 Invalid elicitation request`), and silently strips unknown keywords such as `pattern` before the app's handler sees the request.
- **How a refusal surfaces:** on 2026-07-28 the client fails the whole `tools/call` locally; the server is never told. On 2025-era connections the shim turns the client's JSON-RPC error into a tool result with `isError` ("Fulfilling input required by 'tools/call' failed: …"). Either way the tool cannot report the refused probe itself, so the report says so, and the server log shows the last `tool.input_required` probe.

## Security notes

This is a **test server**. It stores nothing persistently, and its "secrets" are fake. Some of the mechanisms still matter if you expose it:

- **URL-mode elicitation is for data that must not pass through the client or the model.** The token entered on the `/flow/<uuid>` page goes directly to the server. The MCP client only learns that the user finished (`accept`). The tool result contains only a masked form (`sk…56`).
- **Flow URLs are bearer capabilities.** Their IDs are random UUIDv4s. Anyone who has the URL can complete the flow, so don't post them anywhere public. A flow can be completed only once: a second POST gets **409** and neither replaces the token nor sends a second `notifications/elicitation/complete`. Flows expire after one hour, at most 1000 are kept (the oldest are dropped first), and POST bodies over 64 KiB get **413**. The pages are sent with `Content-Security-Policy: default-src 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `nosniff`, and other HTTP methods get **405**.
- **Tool results never contain the token.** They show its length and a masked form (`sk…56`); tokens shorter than 12 characters are shown as `****` only. Logs contain neither the token nor its masked form.
- **The server does not bind the flow to the user who opened it.** A production server must check that the browser session completing the flow belongs to the same user as the MCP session that started it (the URL-elicitation section of the spec requires this to prevent phishing and session fixation). This demo skips the check: there are no user accounts.
- **Clients should show the full URL and ask before opening it.** The spec requires this; whether a given client does it is something you can observe with `elicit_url`.
- **DNS rebinding:** the HTTP server validates the `Host` and `Origin` headers on `/mcp`. It accepts localhost names when bound to localhost or when `PUBLIC_URL` is local (so `docker run -p 127.0.0.1:3457:3457` stays protected), and exactly the names in `ALLOWED_HOSTS` when that is set. With a non-local bind address, a non-local `PUBLIC_URL` and no `ALLOWED_HOSTS`, it accepts the `PUBLIC_URL` hostname plus the localhost names (mode `public-url`), as the 2026-07-28 Streamable HTTP transport requires Origin validation. Validation is only off (with a warning) if `PUBLIC_URL` is not a valid URL.
- **No authentication.** Anyone who can reach the HTTP port can call the tools and read `dialog_lab_results` and `list_seen_clients`. Keep the server on localhost or a trusted network.
- **Memory is bounded.** MCP request bodies above `UPLOAD_MAX_BYTES` as base64 plus 1 MiB (about 14.3 MiB by default) get **413**, enforced by `src/httpServer.ts` because it parses the body itself. At most 500 2025-era HTTP sessions are kept; beyond that the least recently used one is closed (its client gets 404 and re-initializes). The seen-clients registry keeps 200 entries, and `dialog_lab_submit` keeps the last 50 submissions of at most 1 MiB each (larger ones are rejected with `isError`). Other HTTP methods than GET, POST and DELETE on `/mcp` get **405**.
- **requestState** is HMAC-signed with a TTL (see above), so clients cannot forge wizard or flow state.
- **Uploads are size-capped and never stored or logged.** `dialog_lab_upload` and `upload_file_experimental` decode strict base64 only (no whitespace, no `data:` prefix), check the decoded size against `UPLOAD_MAX_BYTES` (default 10 MiB) **before** decoding, hash the bytes and drop them. Logs (`upload.received`, `upload.rejected`) carry only size, SHA-256 and the base64 length. The HTTP server rejects request bodies above `UPLOAD_MAX_BYTES` as base64 plus 1 MiB with **413** while reading, and the stdio message buffer is raised to the same size (the SDK default is 10 MB, which a 10 MiB file in base64 would exceed and close the connection).
- **The sample-file template has no path to traverse.** `test://files/{name}` looks the name up in a fixed in-memory list. Unknown names, `..` and encoded separators are `-32602` errors; nothing touches the filesystem.
- **The MCP App** runs in the host's sandboxed iframe, uses no external resources, and talks to the host only through `postMessage` (JSON-RPC).
