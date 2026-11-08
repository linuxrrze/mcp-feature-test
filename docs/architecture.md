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
             │ /flow/<uuid> → flows.ts   /  → banner         │        └─ src/log.ts     (stderr logger)
             └──────────────────────────────────────────────┘
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
- The app follows the host theme (`hostContext.theme` → `data-theme`) and host CSS variables. The browser test checks light and dark.
- `registerAppTool` also writes the deprecated flat key `_meta["ui/resourceUri"]` for older hosts.

## Security notes

This is a **test server**. It stores nothing persistently, and its "secrets" are fake. Some of the mechanisms still matter if you expose it:

- **URL-mode elicitation is for data that must not pass through the client or the model.** The token entered on the `/flow/<uuid>` page goes directly to the server. The MCP client only learns that the user finished (`accept`). The tool result contains only a masked form (`sk…56`).
- **Flow URLs are bearer capabilities.** Their IDs are random UUIDv4s. Anyone who has the URL can complete the flow, so don't post them anywhere public. Flows expire after one hour, and POST bodies are capped at 64 KiB.
- **The server does not bind the flow to the user who opened it.** A production server must check that the browser session completing the flow belongs to the same user as the MCP session that started it (the URL-elicitation section of the spec requires this to prevent phishing and session fixation). This demo skips the check: there are no user accounts.
- **Clients should show the full URL and ask before opening it.** The spec requires this; whether a given client does it is something you can observe with `elicit_url`.
- **DNS rebinding:** the HTTP server validates the `Host` and `Origin` headers on `/mcp`. It accepts localhost names when bound to localhost or when `PUBLIC_URL` is local (so `docker run -p 127.0.0.1:3457:3457` stays protected), and exactly the names in `ALLOWED_HOSTS` when that is set. With a non-local bind address, a non-local `PUBLIC_URL` and no `ALLOWED_HOSTS`, validation is off and a warning is logged.
- **No authentication.** Anyone who can reach the HTTP port can call the tools and read `dialog_lab_results` and `list_seen_clients`. Keep the server on localhost or a trusted network.
- **requestState** is HMAC-signed with a TTL (see above), so clients cannot forge wizard or flow state.
- **The MCP App** runs in the host's sandboxed iframe, uses no external resources, and talks to the host only through `postMessage` (JSON-RPC).
