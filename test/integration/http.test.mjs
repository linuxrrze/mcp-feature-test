// dist/http.js spawned as a child process on a free port.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { connectHttp, ERAS, makeClient, MODERN, startHttp, textOf } from '../helpers.mjs';
import { eraSuite } from './matrix.mjs';

/** Raw HTTP request (lets us set Host, which fetch() does not allow). */
function rawRequest(url, { method = 'POST', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const legacyToolsList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

describe('http', () => {
    let srv;
    before(async () => {
        srv = await startHttp();
    });
    after(async () => {
        await srv?.stop();
    });

    for (const era of ERAS) {
        eraSuite({
            transport: 'http',
            era,
            logs: () => srv.logs,
            connect: async client => ({ ...(await connectHttp(client, srv.mcpUrl)), base: srv.base })
        });
    }

    describe('endpoints', () => {
        it('GET / describes the server', async () => {
            const res = await fetch(`${srv.base}/`);
            assert.equal(res.status, 200);
            assert.match(await res.text(), new RegExp(`MCP endpoint: ${srv.mcpUrl}`));
        });
        it('unknown paths are 404', async () => {
            for (const p of ['/nope', '/mcp/extra', '/flow/', '/flow/not-a-uuid']) {
                assert.equal((await fetch(srv.base + p)).status, 404, p);
            }
        });
        it('unknown flow ids are 404', async () => {
            const res = await fetch(`${srv.base}/flow/00000000-0000-4000-8000-000000000000`);
            assert.equal(res.status, 404);
            assert.match(await res.text(), /Unknown or expired flow/);
        });
    });

    describe('2025-era session handling', () => {
        it('rejects a request without session (and without initialize) with 400', async () => {
            const res = await fetch(srv.mcpUrl, { method: 'POST', headers: JSON_HEADERS, body: legacyToolsList });
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.error.code, -32000);
            assert.match(body.error.message, /Missing session/);
        });
        it('rejects an unknown session id with 404', async () => {
            const res = await fetch(srv.mcpUrl, {
                method: 'POST',
                headers: { ...JSON_HEADERS, 'mcp-session-id': 'does-not-exist' },
                body: legacyToolsList
            });
            assert.equal(res.status, 404);
            assert.match((await res.json()).error.message, /Unknown session/);
        });
        it('issues a session id on initialize and forgets it after DELETE', async () => {
            const { client } = makeClient('legacy', { name: 'session-check' });
            const conn = await connectHttp(client, srv.mcpUrl);
            const sid = client.transport.sessionId;
            assert.ok(sid, 'session id assigned');
            await client.transport.terminateSession();
            await conn.close();
            const res = await fetch(srv.mcpUrl, { method: 'POST', headers: { ...JSON_HEADERS, 'mcp-session-id': sid }, body: legacyToolsList });
            assert.equal(res.status, 404);
        });
    });

    describe('Host / Origin validation (DNS-rebinding protection)', () => {
        it('rejects a foreign Host header on a localhost bind', async () => {
            const res = await rawRequest(srv.mcpUrl, { headers: { ...JSON_HEADERS, host: 'evil.example' }, body: legacyToolsList });
            assert.equal(res.status, 403);
        });
        it('rejects a foreign Origin header', async () => {
            const res = await rawRequest(srv.mcpUrl, { headers: { ...JSON_HEADERS, origin: 'http://evil.example' }, body: legacyToolsList });
            assert.equal(res.status, 403);
        });
        it('accepts a localhost Origin', async () => {
            const res = await rawRequest(srv.mcpUrl, { headers: { ...JSON_HEADERS, origin: 'http://localhost:5173' }, body: legacyToolsList });
            assert.equal(res.status, 400, 'passes validation, then fails for lack of a session');
        });
        it('does not apply to the flow pages or /', async () => {
            const res = await rawRequest(`${srv.base}/`, { method: 'GET', headers: { host: 'evil.example' } });
            assert.equal(res.status, 200);
        });
    });

    describe('requestState integrity (2026-07-28)', () => {
        it('rejects a tampered requestState and accepts the genuine one', async () => {
            const sent = [];
            const recordingFetch = async (url, init) => {
                if (init?.body) sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
                return fetch(url, init);
            };
            const { client } = makeClient('modern', { name: 'tamper-check' });
            const conn = await connectHttp(client, srv.mcpUrl, { fetch: recordingFetch });
            try {
                await client.callTool({ name: 'elicit_wizard', arguments: {} });
            } finally {
                await conn.close();
            }
            const retry = sent.find(s => s.body.method === 'tools/call' && s.body.params?.requestState);
            assert.ok(retry, 'the client retried with requestState');
            const replay = async requestState => {
                const body = { ...retry.body, id: 999, params: { ...retry.body.params, requestState } };
                const res = await fetch(retry.url, { method: 'POST', headers: retry.headers, body: JSON.stringify(body) });
                const text = await res.text();
                const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find(l => l.startsWith('data:')).slice(5));
                return json;
            };
            const genuine = await replay(retry.body.params.requestState);
            assert.equal(genuine.error, undefined, JSON.stringify(genuine));

            const s = retry.body.params.requestState;
            const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
            for (const bad of [flipped, 'garbage', `${s}x`]) {
                const res = await replay(bad);
                assert.equal(res.error?.code, -32602, JSON.stringify(res));
                assert.match(res.error.message, /Invalid or expired requestState/);
            }
        });
    });

    describe('non-spec probe schemas on the wire (2026-07-28)', () => {
        it('the server SDK sends elicit_format_probe schemas unchanged; the SDK client is what refuses them', async () => {
            const sent = [];
            const recordingFetch = async (url, init) => {
                if (init?.body) sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
                return fetch(url, init);
            };
            const { client } = makeClient('modern', { name: 'probe-wire' });
            const conn = await connectHttp(client, srv.mcpUrl, { fetch: recordingFetch });
            try {
                await assert.rejects(client.callTool({ name: 'elicit_format_probe', arguments: { variant: 'nested_object' } }), /Invalid elicitation request/);
            } finally {
                await conn.close();
            }
            const first = sent.find(s => s.body.method === 'tools/call');
            const raw = async variant => {
                const body = { ...first.body, id: 998, params: { ...first.body.params, arguments: { variant } } };
                const res = await fetch(first.url, { method: 'POST', headers: first.headers, body: JSON.stringify(body) });
                const text = await res.text();
                return text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find(l => l.startsWith('data:')).slice(5));
            };
            const nested = await raw('nested_object');
            assert.equal(nested.result.resultType, 'input_required');
            const req = nested.result.inputRequests.probe_nested_object;
            assert.equal(req.method, 'elicitation/create');
            assert.deepEqual(req.params.requestedSchema.properties.nested_object.properties.city, { type: 'string', title: 'City' });
            const pattern = await raw('pattern');
            assert.equal(pattern.result.inputRequests.probe_pattern.params.requestedSchema.properties.pattern.pattern, '^[A-Z]{3}-[0-9]{3}$');
        });
    });

    describe('capability logging across many frontends', () => {
        it('logs each distinct 2026-07-28 client once and lists all of them', async () => {
            const names = ['Frontend A', 'Frontend B'];
            for (const name of names) {
                for (let i = 0; i < 2; i++) {
                    const { client } = makeClient('modern', { name, capabilities: { elicitation: {} } });
                    const c = await connectHttp(client, srv.mcpUrl);
                    await client.callTool({ name: 'inspect_client', arguments: {} });
                    await c.close();
                }
            }
            for (const name of names) {
                const seen = srv.logs.events.filter(e => e.event === 'client.seen' && e.clientInfo?.name === name);
                assert.equal(seen.length, 1, `${name} logged once`);
                assert.equal(seen[0].protocolVersion, MODERN);
            }
            const { client } = makeClient('legacy', { name: 'lister' });
            const c = await connectHttp(client, srv.mcpUrl);
            const r = await client.callTool({ name: 'list_seen_clients', arguments: {} });
            await c.close();
            for (const name of names) assert.match(textOf(r), new RegExp(`${name} 0\\.0\\.1 – ${MODERN} \\(modern, http\\) – \\[form\\]`));
        });
    });
});

describe('http configuration', () => {
    it('request bodies are capped (UPLOAD_MAX_BYTES in base64 + 1 MiB) with 413, and uploads above the limit are tool errors', async () => {
        const srv = await startHttp({ UPLOAD_MAX_BYTES: '1000' });
        try {
            const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2 * 1024 * 1024) } });
            const res = await rawRequest(srv.mcpUrl, { headers: JSON_HEADERS, body: huge });
            assert.equal(res.status, 413);
            assert.match(JSON.parse(res.body).error.message, /Request body too large \(limit 1049912 bytes/);
            await srv.logs.waitFor(e => e.event === 'http.body');

            const { client } = makeClient('modern', { name: 'upload-limit' });
            const conn = await connectHttp(client, srv.mcpUrl);
            try {
                const r = await client.callTool({ name: 'dialog_lab_upload', arguments: { name: 'b', mimeType: '', data: Buffer.alloc(1001).toString('base64') } });
                assert.equal(r.isError, true);
                assert.match(textOf(r), /above the limit of 1000 B/);
                const ok = await client.callTool({ name: 'dialog_lab_upload', arguments: { name: 'b', mimeType: '', data: Buffer.alloc(1000).toString('base64') } });
                assert.ok(!ok.isError, textOf(ok));
            } finally {
                await conn.close();
            }
        } finally {
            await srv.stop();
        }
    });

    it('ALLOWED_HOSTS replaces the localhost list', async () => {
        const srv = await startHttp({ ALLOWED_HOSTS: 'mcp.example.test' });
        try {
            assert.equal(srv.logs.find(e => e.event === 'http.listening').hostValidation, 'allow-list');
            const ok = await rawRequest(srv.mcpUrl, { headers: { ...JSON_HEADERS, host: 'mcp.example.test' }, body: legacyToolsList });
            assert.equal(ok.status, 400, 'allowed host passes validation');
            const local = await rawRequest(srv.mcpUrl, { headers: JSON_HEADERS, body: legacyToolsList });
            assert.equal(local.status, 403, '127.0.0.1 is not in the list');
            const badOrigin = await rawRequest(srv.mcpUrl, {
                headers: { ...JSON_HEADERS, host: 'mcp.example.test', origin: 'https://evil.example' },
                body: legacyToolsList
            });
            assert.equal(badOrigin.status, 403);
        } finally {
            await srv.stop();
        }
    });

    it('HOST=0.0.0.0 with a localhost PUBLIC_URL keeps localhost validation', async () => {
        const srv = await startHttp({ HOST: '0.0.0.0', PUBLIC_URL: 'http://localhost:3457' });
        try {
            assert.equal(srv.logs.find(e => e.event === 'http.listening').hostValidation, 'localhost');
            const res = await rawRequest(srv.mcpUrl, { headers: { ...JSON_HEADERS, host: 'evil.example' }, body: legacyToolsList });
            assert.equal(res.status, 403);
        } finally {
            await srv.stop();
        }
    });

    it('HOST=0.0.0.0 with a public PUBLIC_URL warns that validation is off and uses PUBLIC_URL for flows', async () => {
        const srv = await startHttp({ HOST: '0.0.0.0', PUBLIC_URL: 'https://mcp.example.test/' });
        try {
            assert.equal(srv.logs.find(e => e.event === 'http.listening').hostValidation, 'none');
            await srv.logs.waitFor(e => e.event === 'http.security' && e.level === 'warn');
            const { client, dialogs } = makeClient('modern', { name: 'public-url', answer: async () => ({ action: 'cancel' }) });
            const c = await connectHttp(client, srv.mcpUrl);
            await client.callTool({ name: 'elicit_url', arguments: {} });
            await c.close();
            assert.match(dialogs[0].url, /^https:\/\/mcp\.example\.test\/flow\/[0-9a-f-]{36}$/);
        } finally {
            await srv.stop();
        }
    });

    for (const signal of ['SIGTERM', 'SIGINT']) {
        it(`shuts down gracefully on ${signal}`, async () => {
            const srv = await startHttp();
            const { client } = makeClient('legacy', { name: 'shutdown' });
            await connectHttp(client, srv.mcpUrl); // an open legacy session must not block shutdown
            srv.child.kill(signal);
            const { code } = await srv.exited;
            assert.equal(code, 0);
            assert.match(srv.logs.raw, /"event":"http.shutdown"/);
            await client.close().catch(() => {});
        });
    }

    it('exits with an error when the port is taken', async () => {
        const first = await startHttp();
        try {
            await assert.rejects(startHttp({ PORT: String(new URL(first.base).port) }), /exited early/);
        } finally {
            await first.stop();
        }
    });
});
