import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import '../helpers.mjs';
import { configureLogger } from '../../dist/log.js';
import { chooseValidation, MAX_LEGACY_SESSIONS, parseAllowedHosts, startHttpServer } from '../../dist/httpServer.js';

describe('HTTP Host/Origin validation choice', () => {
    it('parses ALLOWED_HOSTS', () => {
        assert.equal(parseAllowedHosts(undefined), undefined);
        assert.equal(parseAllowedHosts(' , '), undefined);
        assert.deepEqual(parseAllowedHosts('mcp.example.com, localhost ,127.0.0.1'), ['mcp.example.com', 'localhost', '127.0.0.1']);
    });
    it('uses the allow-list when given', () => {
        const v = chooseValidation({ host: '0.0.0.0', publicUrl: 'http://x:1', allowedHosts: ['x'] });
        assert.equal(v.mode, 'allow-list');
        assert.equal(v.validators.length, 2);
    });
    it('enforces localhost names on a localhost bind', () => {
        assert.equal(chooseValidation({ host: '127.0.0.1', publicUrl: 'http://127.0.0.1:3457' }).mode, 'localhost');
        assert.equal(chooseValidation({ host: 'localhost', publicUrl: 'http://localhost:3457' }).mode, 'localhost');
    });
    it('enforces localhost names when PUBLIC_URL is local even on 0.0.0.0 (docker -p 127.0.0.1:…)', () => {
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'http://127.0.0.1:3457' }).mode, 'localhost');
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'http://localhost:3457' }).mode, 'localhost');
    });
    it('turns validation off only for non-local bind + non-local PUBLIC_URL without allow-list', () => {
        const pub = chooseValidation({ host: '0.0.0.0', publicUrl: 'https://mcp.example.com' });
        assert.equal(pub.mode, 'public-url');
        assert.deepEqual(pub.allowed, ['mcp.example.com', 'localhost', '127.0.0.1', '[::1]']);
        assert.equal(pub.validators.length, 2);
        assert.deepEqual(chooseValidation({ host: '0.0.0.0', publicUrl: 'http://[2001:db8::1]:3457' }).allowed[0], '[2001:db8::1]');
        assert.equal(chooseValidation({ host: '0.0.0.0', publicUrl: 'not a url' }).mode, 'none');
    });
});

describe('2025-era session cap', () => {
    it(`keeps at most MAX_LEGACY_SESSIONS (${MAX_LEGACY_SESSIONS}) sessions, closing the least recently used`, async () => {
        const prev = configureLogger({ level: 'silent' });
        const running = await startHttpServer({ port: 0 });
        const url = `${running.url}/mcp`;
        const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
        const init = () =>
            fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cap', version: '1' } }
                })
            }).then(async r => {
                await r.text();
                return r.headers.get('mcp-session-id');
            });
        const ping = sid =>
            fetch(url, {
                method: 'POST',
                headers: { ...headers, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
            }).then(async r => (await r.text(), r.status));
        try {
            const first = await init();
            const second = await init();
            for (let i = 2; i < MAX_LEGACY_SESSIONS; i++) await init();
            assert.equal(await ping(first), 200, 'touching the first session makes it recently used');
            await init(); // one over the cap: evicts `second`, the least recently used
            assert.equal(await ping(second), 404);
            assert.equal(await ping(first), 200);
        } finally {
            await running.close();
            configureLogger(prev);
        }
    });
});
