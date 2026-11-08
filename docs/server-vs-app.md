# MCP server vs. MCP App

An **MCP server** is a program that offers tools, resources and prompts over the protocol. An **MCP App** is not a separate program: it is an interactive web UI that a server ships as a resource and that the client (the *host*) shows in the chat. Through the host, the app can call tools on its own server.

In this project, mcp-feature-test is the server, and the **Dialog Lab** is the app it brings along.

## The MCP server

- **Talks to** the MCP client (Claude Desktop, VS Code, Open WebUI, …), over **stdio** (the client launches it as a subprocess) or **Streamable HTTP**.
- **Offers** tools (functions the model calls, for example `elicit_confirm` or `slow_task`), resources (data readable by URI) and prompts (here `try_all_dialogs`).
- **Reaches the user only indirectly.** Tool results go to the model. With elicitation the server can ask the user questions, but the client draws the dialog: the server sends only a JSON schema, so the client decides how the form looks and which field types it offers.
- **Runs as an ordinary process** with its own permissions (files, network, secrets).

## The MCP App

The MCP Apps extension (`io.modelcontextprotocol/ui`, proposed as SEP-1865; this project follows the ext-apps spec 2026-01-26) defines the app side.

- **What it is:** an HTML page published as a `ui://` resource with the MIME type `text/html;profile=mcp-app`. Here that is `ui://feature-test/dialog-lab.html`, a single self-contained file built from `ui/dialog-lab.html` and `ui/dialog-lab.ts`.
- **How it appears:** a tool points to it with `_meta.ui.resourceUri`. When the model calls `open_dialog_lab`, the host loads the resource and renders it in the chat.
- **Where it runs:** in the client, inside a sandboxed iframe, not on the server. It has no connection of its own to the server.
- **Who it talks to:** only the host, via `postMessage` (a JSON-RPC dialect). Through the host the Dialog Lab can
  - call server tools (`app.callServerTool`, sent as `tools/call`; a host may ask the user to confirm first, as Open WebUI does),
  - post a message into the chat (`app.sendMessage`, `ui/message`),
  - add to the model's context (`app.updateModelContext`, `ui/update-model-context`),
  - switch to fullscreen (`app.requestDisplayMode`, `ui/request-display-mode`),
  - offer a file download (`app.downloadFile`, `ui/download-file`),
  - and receive the tool input and result (`ontoolinput`, `ontoolresult`) and the host theme (`onhostcontextchanged`).

  Each of these works only if the host supports it; [Open WebUI](openwebui.md), for example, answers *Method not found* to `ui/update-model-context` and `ui/download-file`.
- **What it can show:** any UI the browser can draw. The Dialog Lab has a colour picker, a slider, a star rating, a date field, a drag-to-rank list and a sketch canvas; other apps could add live previews or file pickers. Elicitation, by contrast, is limited to the field types of its schema.

## Comparison

| | MCP server | MCP App |
| --- | --- | --- |
| What | A process (Node, Python, …) | An HTML/JS page |
| Runs | On the host machine or in a container | In the client, in a sandboxed iframe |
| Provided by | The client or the user starts it | The server, as a `ui://` resource |
| Talks to | The client (stdio or HTTP, MCP JSON-RPC) | Only the host (`postMessage`); reaches the server only through the host |
| Used by | Mostly the model (tool calls) | The human, directly |
| UI | None of its own; the client builds dialogs from a schema | Its own, freely designed |
| Standalone | Yes | No: always belongs to a server and needs a host with MCP Apps support |
| Spec status | Core specification | Optional extension; the client must declare support |

## The flow in this project

1. The model calls `open_dialog_lab`. The tool definition says, via `_meta.ui.resourceUri`, that its result should be shown with `ui://feature-test/dialog-lab.html`.
2. The host reads that resource from the server (`resources/read`, possibly ahead of time) and shows it in a sandboxed iframe, passing in the tool input and result.
3. The user fills it in: stars, colour, slider, date, ranking, sketch.
4. On *Submit to server* the app sends `callServerTool("dialog_lab_submit", …)` to the host, which forwards it to the server as an ordinary `tools/call`. `dialog_lab_submit` is app-only (`_meta.ui.visibility: ["app"]`), so hosts should not offer it to the model. The server cannot enforce that: to the server it is an ordinary tool.
5. The model reads the result with `dialog_lab_results`.

[docs/architecture.md](architecture.md#mcp-apps-flow) shows the same flow at the message level.

## Which one to use

- **Server plus elicitation only**, when your questions fit a simple form. It works in more clients and needs no UI code.
- **Add an MCP App** when you need real interaction (visual input, live preview, several steps on one page, file selection) and the client supports the extension. Clients without support show only the tool's text result, which is why `open_dialog_lab` also returns a plain-text fallback that tells the model no UI appeared if the client does not render MCP Apps.
