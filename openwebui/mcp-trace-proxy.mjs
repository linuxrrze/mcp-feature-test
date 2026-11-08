#!/usr/bin/env node
/**
 * Tiny logging reverse proxy for MCP Streamable HTTP traffic (no dependencies).
 *
 *   TARGET=http://127.0.0.1:3600 PORT=3603 node openwebui/mcp-trace-proxy.mjs
 *
 * Point the MCP client (Open WebUI) at http://127.0.0.1:3603/mcp. Every request and
 * response is forwarded unchanged; one JSON line per JSON-RPC message is printed to
 * stdout (direction, HTTP status, method, id, protocol version, capabilities, error),
 * so you can see exactly what the client declares and which requests it answers.
 * SSE responses are parsed line by line and logged as they stream.
 * Env: TARGET, PORT, HOST, TRACE_FULL=1 (log full params/results), FORCE_LEGACY=1 (see below).
 */
import { createServer, request as httpRequest } from 'node:http';

const PORT = Number(process.env.PORT ?? 3603);
const HOST = process.env.HOST ?? '127.0.0.1';
const TARGET = new URL(process.env.TARGET ?? 'http://127.0.0.1:3600');
const FULL = process.env.TRACE_FULL === '1';
// FORCE_LEGACY=1: answer `server/discover` with "method not found" so 2026-07-28 clients
// fall back to the 2025-era initialize handshake (tests the elicitation/create push path).
const FORCE_LEGACY = process.env.FORCE_LEGACY === '1';

function summarize(dir, msg, extra = {}) {
    if (!msg || typeof msg !== 'object') return;
    if (Array.isArray(msg)) return msg.forEach(m => summarize(dir, m, extra));
    const p = msg.params ?? {};
    const meta = p._meta ?? {};
    const out = { t: new Date().toISOString(), dir, ...extra };
    if (msg.method) out.method = msg.method;
    if (msg.id !== undefined) out.id = msg.id;
    if (p.protocolVersion) out.protocolVersion = p.protocolVersion;
    if (p.capabilities) out.capabilities = p.capabilities;
    if (p.clientInfo) out.clientInfo = p.clientInfo;
    for (const [k, v] of Object.entries(meta)) if (/protocol|capabilit|clientInfo/i.test(k)) out[`_meta.${k}`] = v;
    if (p.name) out.tool = p.name;
    if (p.uri) out.uri = p.uri;
    if (p.inputResponses) out.inputResponses = p.inputResponses;
    if (msg.result) {
        const r = msg.result;
        if (r.protocolVersion) out.protocolVersion = r.protocolVersion;
        if (r.resultType) out.resultType = r.resultType;
        if (r.inputRequests) out.inputRequests = Object.keys(r.inputRequests);
        if (r.isError) out.isError = true;
        if (FULL) out.result = r;
    }
    if (msg.error) out.error = msg.error;
    if (FULL && msg.params) out.params = msg.params;
    console.log(JSON.stringify(out));
}

const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        let parsed;
        try {
            parsed = body.length ? JSON.parse(body.toString('utf8')) : undefined;
        } catch {
            /* not JSON */
        }
        const reqInfo = { http: `${req.method} ${req.url}`, session: req.headers['mcp-session-id'], hdrProto: req.headers['mcp-protocol-version'] };
        if (parsed) summarize('client->server', parsed, reqInfo);
        else if (req.method !== 'POST') console.log(JSON.stringify({ t: new Date().toISOString(), dir: 'client->server', ...reqInfo }));

        if (FORCE_LEGACY && parsed?.method === 'server/discover') {
            // Pretend to be a 2025-era server so the client falls back to `initialize`.
            const err = { jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Method not found (FORCE_LEGACY)' } };
            summarize('proxy->client', err, { status: 200 });
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(err));
            return;
        }

        const headers = { ...req.headers, host: TARGET.host };
        delete headers.origin; // the test server validates localhost origins
        const up = httpRequest(
            { host: TARGET.hostname, port: TARGET.port, path: req.url, method: req.method, headers },
            upRes => {
                res.writeHead(upRes.statusCode ?? 502, upRes.headers);
                const ct = String(upRes.headers['content-type'] ?? '');
                const status = upRes.statusCode;
                let buf = '';
                const jsonChunks = [];
                upRes.on('data', c => {
                    res.write(c);
                    if (ct.includes('text/event-stream')) {
                        buf += c.toString('utf8');
                        let i;
                        while ((i = buf.indexOf('\n')) >= 0) {
                            const line = buf.slice(0, i).trimEnd();
                            buf = buf.slice(i + 1);
                            if (line.startsWith('data:')) {
                                try {
                                    summarize('server->client', JSON.parse(line.slice(5)), { status, sse: true });
                                } catch {
                                    /* partial */
                                }
                            }
                        }
                    } else jsonChunks.push(c);
                });
                upRes.on('end', () => {
                    res.end();
                    if (jsonChunks.length) {
                        const s = Buffer.concat(jsonChunks).toString('utf8');
                        try {
                            summarize('server->client', JSON.parse(s), { status });
                        } catch {
                            console.log(JSON.stringify({ t: new Date().toISOString(), dir: 'server->client', status, raw: s.slice(0, 300) }));
                        }
                    } else if (!ct.includes('text/event-stream')) {
                        console.log(JSON.stringify({ t: new Date().toISOString(), dir: 'server->client', status, empty: true }));
                    }
                });
            }
        );
        up.on('error', e => {
            console.log(JSON.stringify({ t: new Date().toISOString(), error: String(e) }));
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
        up.end(body);
    });
});

server.listen(PORT, HOST, () => console.error(`[mcp-trace-proxy] http://${HOST}:${PORT} -> ${TARGET.origin}`));
