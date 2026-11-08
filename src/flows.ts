/**
 * Tiny in-process web app used by the URL-mode elicitation demo.
 *
 * URL-mode elicitation asks the client to open a URL in the user's browser
 * (instead of rendering a form inside the client). Typical real-world uses are
 * OAuth sign-in, payment, or entering a secret that must never pass through the
 * MCP client/LLM. Here the "hosted flow" is a local page where the user enters a
 * fake API token; the MCP server then reads the result from this store.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorData, logger } from './log.js';

export interface Flow {
    id: string;
    purpose: string;
    createdAt: number;
    completedAt?: number;
    token?: string;
    /** Called when the browser flow finishes (sends notifications/elicitation/complete on 2025 connections). */
    onComplete?: () => void | Promise<void>;
}

const flows = new Map<string, Flow>();

let baseUrl: string | undefined;
let standaloneStarting: Promise<string> | undefined;

/** Used by the HTTP entry point: flows are served from the main HTTP server. */
export function setFlowBaseUrl(url: string): void {
    baseUrl = url.replace(/\/$/, '');
}

/**
 * Used by the stdio entry point: lazily start a small listener for the flow pages.
 *
 * Env: FLOW_PORT (default 3458; 0 = any free port), FLOW_HOST (bind address,
 * default 127.0.0.1; use 0.0.0.0 inside Docker), FLOW_PUBLIC_URL (base URL the
 * user's browser should open, e.g. when the port is published differently).
 * If FLOW_PORT is busy (e.g. a second stdio instance) a free port is used instead.
 */
async function ensureBaseUrl(): Promise<string> {
    if (baseUrl) return baseUrl;
    standaloneStarting ??= startStandalone().catch(e => {
        standaloneStarting = undefined; // allow a retry on the next flow
        throw e;
    });
    return standaloneStarting;
}

function listen(port: number, host: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const srv = createServer((req, res) => {
            if (!handleFlowRequest(req, res)) res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        });
        srv.once('error', reject);
        srv.listen(port, host, () => {
            srv.off('error', reject);
            srv.unref();
            resolve((srv.address() as AddressInfo).port);
        });
    });
}

async function startStandalone(): Promise<string> {
    const host = process.env.FLOW_HOST ?? '127.0.0.1';
    const wanted = Number(process.env.FLOW_PORT ?? 3458);
    let actualPort: number;
    try {
        actualPort = await listen(wanted, host);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || wanted === 0) throw e;
        actualPort = await listen(0, host);
        logger.warn('flows', `FLOW_PORT ${wanted} is in use; using port ${actualPort} instead`, { wanted, port: actualPort });
    }
    const localName = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    baseUrl = (process.env.FLOW_PUBLIC_URL ?? `http://${localName}:${actualPort}`).replace(/\/$/, '');
    logger.info('flows.listening', `URL-elicitation web flows on ${baseUrl}/flow/…`, { url: baseUrl, host, port: actualPort });
    return baseUrl;
}

/** Flows older than this are forgotten (keeps a long-running HTTP server from growing forever). */
const FLOW_TTL_MS = 60 * 60_000;
/** Upper bound on pending/completed flows kept in memory (oldest are dropped first). */
export const MAX_FLOWS = 1000;
/** Largest accepted POST body of a flow page. */
export const MAX_FLOW_BODY_BYTES = 64 * 1024;

function pruneFlows(now = Date.now()): void {
    for (const [id, f] of flows) if (now - f.createdAt > FLOW_TTL_MS) flows.delete(id);
    // Map iteration is insertion order, so the first keys are the oldest flows.
    for (const id of flows.keys()) {
        if (flows.size < MAX_FLOWS) break;
        flows.delete(id);
    }
}

export async function createFlow(purpose: string): Promise<{ flow: Flow; url: string }> {
    pruneFlows();
    const flow: Flow = { id: randomUUID(), purpose, createdAt: Date.now() };
    const url = `${await ensureBaseUrl()}/flow/${flow.id}`;
    flows.set(flow.id, flow);
    return { flow, url };
}

export function getFlow(id: string): Flow | undefined {
    return flows.get(id);
}

/** Resolvers waiting for a flow to be completed in the browser. */
const waiters = new Map<string, Set<() => void>>();

/**
 * Wait until the browser page of a flow has been submitted.
 *
 * Clients may answer a URL-mode elicitation with "accept" as soon as the user
 * opens the link (the spec allows it, and Open WebUI does exactly that), so an
 * accept does not mean the hosted flow is finished. Resolves `true` when the
 * flow is (or becomes) completed, `false` on timeout, unknown flow, or abort.
 */
export function waitForFlow(id: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const flow = flows.get(id);
    if (!flow) return Promise.resolve(false);
    if (flow.completedAt) return Promise.resolve(true);
    if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
        let set = waiters.get(id);
        if (!set) waiters.set(id, (set = new Set()));
        const finish = (ok: boolean) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            set!.delete(onDone);
            if (set!.size === 0) waiters.delete(id);
            resolve(ok);
        };
        const onDone = () => finish(true);
        const onAbort = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        set.add(onDone);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** How long a tool waits for the browser page after the client already said "accept" (env FLOW_WAIT_MS, default 5 min). */
export function flowWaitMs(): number {
    const v = Number(process.env.FLOW_WAIT_MS);
    return Number.isFinite(v) && v >= 0 ? v : 5 * 60_000;
}

/**
 * Headers for every flow page: never cached, not frameable (clickjacking on the
 * token form), no Referer (the flow URL is a bearer capability), no scripts,
 * and the form may only post back to this server.
 */
const PAGE_HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
} as const;

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 :root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1c1e21;--muted:#666;--acc:#4f46e5}
 @media (prefers-color-scheme:dark){:root{--bg:#16171a;--card:#212226;--fg:#e8e8ea;--muted:#9a9aa0;--acc:#8b85ff}}
 body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
 .card{background:var(--card);border-radius:14px;padding:28px;max-width:420px;width:100%;box-shadow:0 4px 24px #0002}
 h1{font-size:20px;margin:0 0 6px} p{color:var(--muted);margin:0 0 18px}
 label{display:block;font-weight:600;margin-bottom:6px} input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #8886;font:inherit;background:transparent;color:inherit}
 button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
 .ok{font-size:42px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

/** Returns true when the request was handled. */
export function handleFlowRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/flow\/([0-9a-f-]{36})$/);
    if (!m) return false;
    const flow = flows.get(m[1]);
    const send = (status: number, html: string) =>
        res.writeHead(status, { ...PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(html);

    if (!flow) {
        send(404, page('Unknown flow', '<h1>Unknown or expired flow</h1><p>Start the tool again from your MCP client.</p>'));
        return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.writeHead(405, { ...PAGE_HEADERS, allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed');
        return true;
    }
    if (req.method === 'POST') {
        if (flow.completedAt) {
            // A flow completes exactly once: no token overwrite, no second completion notification.
            send(409, page('Already completed', '<h1>Already completed</h1><p>This flow was already submitted. Start the tool again from your MCP client.</p>'));
            return true;
        }
        let body = '';
        let size = 0;
        let tooLarge = false;
        req.on('data', (c: Buffer) => {
            if (tooLarge) return;
            size += c.length;
            if (size > MAX_FLOW_BODY_BYTES) {
                tooLarge = true;
                body = '';
                res.writeHead(413, { ...PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('request body too large');
                return;
            }
            body += c;
        });
        req.on('end', () => {
            if (tooLarge || flow.completedAt) {
                if (!res.headersSent) send(409, page('Already completed', '<h1>Already completed</h1><p>This flow was already submitted.</p>'));
                return;
            }
            const token = new URLSearchParams(body).get('token')?.trim() ?? '';
            if (!token) {
                send(400, page('Missing token', '<h1>Please enter a token</h1><p><a href="">Back</a></p>'));
                return;
            }
            flow.token = token;
            flow.completedAt = Date.now();
            for (const done of [...(waiters.get(flow.id) ?? [])]) done();
            logger.info('flow.completed', `browser flow ${flow.id} completed`, { flowId: flow.id });
            void Promise.resolve(flow.onComplete?.()).catch(e => logger.warn('flow.notify', 'completion notification failed', errorData(e)));
            send(
                200,
                page(
                    'Done',
                    `<div class="ok">✅</div><h1>All set</h1><p>The token was stored on the MCP server and never passed through your MCP client.<br><br><b>Return to your MCP client</b> and confirm/accept the request so the tool can continue.</p>`
                )
            );
        });
        return true;
    }
    if (flow.completedAt) {
        send(200, page('Done', '<div class="ok">✅</div><h1>Already completed</h1><p>You can close this tab and return to your MCP client.</p>'));
        return true;
    }
    send(
        200,
        page(
            'Connect fake service',
            `<h1>🔐 Connect “Fake Service”</h1>
<p>${esc(flow.purpose)}<br>This page simulates a hosted sign-in or secret-entry flow (URL-mode elicitation). Anything typed here goes straight to the MCP server, not to the MCP client or the model.</p>
<form method="post"><label for="t">API token (any text)</label>
<input id="t" name="token" type="password" autocomplete="off" placeholder="e.g. sk-test-123" autofocus required>
<button type="submit">Connect</button></form>`
        )
    );
    return true;
}
