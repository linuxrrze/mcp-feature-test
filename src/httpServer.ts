/**
 * Streamable HTTP server (library part; `http.ts` is the CLI entry point).
 *
 * Two protocol generations are served side by side on one endpoint:
 *  - 2026-07-28 clients → stateless `createMcpHandler` (elicitation via input_required)
 *  - 2025-era clients   → classic sessionful Streamable HTTP transport, so that
 *    server→client `elicitation/create` requests can travel over the session.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, isInitializeRequest, isLegacyRequest } from '@modelcontextprotocol/server';
import {
    NodeStreamableHTTPServerTransport,
    hostHeaderValidation,
    localhostHostValidation,
    localhostOriginValidation,
    originValidation,
    toNodeHandler,
    toWebRequest
} from '@modelcontextprotocol/node';
import { maxRequestBodyBytes } from './files.js';
import { handleFlowRequest, setFlowBaseUrl } from './flows.js';
import { errorData, logger } from './log.js';
import { createFeatureTestServer } from './server.js';

export interface HttpServerOptions {
    /** 0 picks a free port. Default 3457. */
    port?: number;
    /** Bind address. Default 127.0.0.1. */
    host?: string;
    /** Externally visible base URL (behind a proxy / in Docker). Default derived from host + actual port. */
    publicUrl?: string;
    /**
     * Hostnames accepted in the Host and Origin headers (DNS-rebinding protection).
     * When omitted: localhost names are enforced if the server binds to localhost
     * or `publicUrl` points at localhost; otherwise nothing is enforced.
     */
    allowedHosts?: string[];
}

export interface RunningHttpServer {
    server: Server;
    /** Base URL, e.g. http://127.0.0.1:3457 (the MCP endpoint is `${url}/mcp`). */
    url: string;
    port: number;
    close(): Promise<void>;
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Read `ALLOWED_HOSTS`-style input: comma separated, whitespace tolerant, empty → undefined. */
export function parseAllowedHosts(raw: string | undefined): string[] | undefined {
    const list = (raw ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    return list.length ? list : undefined;
}

type Validator = (req: IncomingMessage, res: ServerResponse) => boolean;

/** Decide which Host/Origin validation applies (exported for unit tests). */
export function chooseValidation(opts: { host: string; publicUrl: string; allowedHosts?: string[] }): {
    mode: 'allow-list' | 'localhost' | 'none';
    validators: Validator[];
} {
    if (opts.allowedHosts?.length) {
        return { mode: 'allow-list', validators: [hostHeaderValidation(opts.allowedHosts), originValidation(opts.allowedHosts)] };
    }
    let publicHost = '';
    try {
        publicHost = new URL(opts.publicUrl).hostname;
    } catch {
        /* invalid PUBLIC_URL: treat as non-local */
    }
    if (LOCAL_NAMES.has(opts.host) || LOCAL_NAMES.has(publicHost)) {
        return { mode: 'localhost', validators: [localhostHostValidation(), localhostOriginValidation()] };
    }
    return { mode: 'none', validators: [] };
}

class BodyTooLargeError extends Error {
    constructor(readonly limit: number) {
        super(`request body larger than ${limit} bytes`);
    }
}

/** Read and parse a POST body, refusing anything above `limit` bytes (see maxRequestBodyBytes). */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
    if (req.method !== 'POST') return undefined;
    if (Number(req.headers['content-length']) > limit) throw new BodyTooLargeError(limit);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const c of req) {
        received += (c as Buffer).length;
        if (received > limit) throw new BodyTooLargeError(limit);
        chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return raw; // let the SDK answer with a proper parse error
    }
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
    const host = options.host ?? '127.0.0.1';
    const maxBody = maxRequestBodyBytes();
    const modern = createMcpHandler(() => createFeatureTestServer({ transport: 'http' }), {
        legacy: 'reject',
        onerror: e => logger.warn('http.modern', e.message, errorData(e))
    });
    const modernNode = toNodeHandler(modern);

    /** 2025-era sessions: sessionId → transport */
    const legacySessions = new Map<string, NodeStreamableHTTPServerTransport>();
    let validators: Validator[] = [];
    let publicUrl = '';

    const httpServer = createServer(async (req, res) => {
        try {
            const path = new URL(req.url ?? '/', 'http://x').pathname;

            if (path.startsWith('/flow/')) {
                if (!handleFlowRequest(req, res)) res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
                return;
            }
            if (path === '/' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/plain' }).end(`mcp-feature-test is running.\nMCP endpoint: ${publicUrl}/mcp\n`);
                return;
            }
            if (path !== '/mcp') {
                res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
                return;
            }
            for (const validate of validators) if (!validate(req, res)) return;

            let body: unknown;
            try {
                body = await readJsonBody(req, maxBody);
            } catch (e) {
                if (!(e instanceof BodyTooLargeError)) throw e;
                logger.warn('http.body', `rejected a request body above ${e.limit} bytes`, { limit: e.limit });
                res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32600, message: `Request body too large (limit ${e.limit} bytes, derived from UPLOAD_MAX_BYTES)` },
                        id: null
                    })
                );
                return;
            }
            const webReq = await toWebRequest(req, body);

            if (!(await isLegacyRequest(webReq, body))) {
                await modernNode(req, res, body);
                return;
            }

            // ---- 2025-era sessionful path ----
            const sid = req.headers['mcp-session-id'];
            let transport = typeof sid === 'string' ? legacySessions.get(sid) : undefined;

            if (!transport) {
                if (req.method === 'POST' && isInitializeRequest(body)) {
                    const t = new NodeStreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: id => {
                            legacySessions.set(id, t);
                            logger.debug('http.session', `legacy session ${id} opened`, { sessionId: id });
                        }
                    });
                    t.onclose = () => {
                        if (t.sessionId) {
                            legacySessions.delete(t.sessionId);
                            logger.debug('http.session', `legacy session ${t.sessionId} closed`, { sessionId: t.sessionId });
                        }
                    };
                    await createFeatureTestServer({ transport: 'http' }).connect(t);
                    transport = t;
                } else {
                    const unknown = typeof sid === 'string';
                    res.writeHead(unknown ? 404 : 400, { 'content-type': 'application/json' }).end(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            error: { code: -32000, message: unknown ? 'Unknown session' : 'Missing session; send initialize first' },
                            id: null
                        })
                    );
                    return;
                }
            }
            await transport.handleRequest(req, res, body);
        } catch (e) {
            logger.error('http.error', 'request failed', errorData(e));
            if (!res.headersSent) res.writeHead(500).end('internal error');
        }
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port ?? 3457, host, () => {
            httpServer.off('error', reject);
            resolve();
        });
    });
    const port = (httpServer.address() as AddressInfo).port;
    const localName = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
    publicUrl = (options.publicUrl ?? `http://${localName}:${port}`).replace(/\/$/, '');
    setFlowBaseUrl(publicUrl);
    const validation = chooseValidation({ host, publicUrl, allowedHosts: options.allowedHosts });
    validators = validation.validators;

    logger.info('http.listening', `Streamable HTTP MCP endpoint: ${publicUrl}/mcp`, {
        url: `${publicUrl}/mcp`,
        port,
        host,
        hostValidation: validation.mode,
        allowedHosts: options.allowedHosts ?? null
    });
    if (validation.mode === 'none') {
        logger.warn('http.security', 'Host/Origin validation is OFF (non-local bind and PUBLIC_URL). Set ALLOWED_HOSTS to enable DNS-rebinding protection.');
    }

    return {
        server: httpServer,
        url: publicUrl,
        port,
        async close() {
            await modern.close();
            for (const t of legacySessions.values()) await t.close().catch(() => {});
            httpServer.closeAllConnections();
            await new Promise<void>(r => httpServer.close(() => r()));
        }
    };
}
