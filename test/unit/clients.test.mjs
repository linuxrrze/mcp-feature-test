import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import '../helpers.mjs';
import {
    fingerprint,
    formatCapabilitySummary,
    listSeenClients,
    recordConnection,
    recordRequest,
    resetSeenClients,
    stableStringify,
    summarizeCapabilities
} from '../../dist/clients.js';
import { configureLogger } from '../../dist/log.js';

const UI = 'io.modelcontextprotocol/ui';

describe('summarizeCapabilities', () => {
    it('treats an empty elicitation object as form-only (spec back-compat)', () => {
        assert.deepEqual(summarizeCapabilities({ elicitation: {} }).elicitation, { form: true, url: false });
    });
    it('detects form and url separately', () => {
        assert.deepEqual(summarizeCapabilities({ elicitation: { url: {} } }).elicitation, { form: false, url: true });
        assert.deepEqual(summarizeCapabilities({ elicitation: { form: {}, url: {} } }).elicitation, { form: true, url: true });
    });
    it('handles missing / null capabilities', () => {
        for (const caps of [null, undefined, {}]) {
            const s = summarizeCapabilities(caps);
            assert.deepEqual(s.elicitation, { form: false, url: false });
            assert.equal(s.ui.supported, false);
            assert.equal(s.sampling.supported, false);
        }
    });
    it('reads the MCP Apps UI extension and mimeTypes', () => {
        const s = summarizeCapabilities({ extensions: { [UI]: { mimeTypes: ['text/html;profile=mcp-app'] }, 'acme/x': {} } });
        assert.deepEqual(s.ui, { supported: true, mimeTypes: ['text/html;profile=mcp-app'] });
        assert.deepEqual(s.otherExtensions, ['acme/x']);
    });
    it('reads sampling, roots, tasks, experimental and unknown keys', () => {
        const s = summarizeCapabilities({
            sampling: { tools: {} },
            roots: { listChanged: true },
            tasks: { list: {} },
            experimental: { foo: {} },
            weird: true
        });
        assert.deepEqual(s.sampling, { supported: true, tools: true, context: false });
        assert.deepEqual(s.roots, { supported: true, listChanged: true });
        assert.equal(s.tasks, true);
        assert.deepEqual(s.experimental, ['foo']);
        assert.deepEqual(s.otherCapabilities, ['weird']);
    });
    it('formats a readable table including the raw JSON', () => {
        const caps = { elicitation: { form: {} }, extensions: { [UI]: { mimeTypes: ['text/html;profile=mcp-app'] } } };
        const t = formatCapabilitySummary(summarizeCapabilities(caps), caps);
        assert.match(t, /elicitation\s+form: yes\s+url: no/);
        assert.match(t, /MCP Apps UI\s+yes\s+mimeTypes: text\/html;profile=mcp-app/);
        assert.match(t, /raw\s+\{"elicitation"/);
    });
});

describe('stableStringify / fingerprint', () => {
    it('is independent of key order', () => {
        assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }), stableStringify({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
    });
    it('changes with any identifying field', () => {
        const base = { clientInfo: { name: 'a', version: '1' }, capabilities: { elicitation: {} }, protocolVersion: '2026-07-28', era: 'modern', transport: 'http' };
        const fp = fingerprint(base);
        assert.equal(fp, fingerprint(structuredClone(base)));
        assert.notEqual(fp, fingerprint({ ...base, transport: 'stdio' }));
        assert.notEqual(fp, fingerprint({ ...base, capabilities: { elicitation: { url: {} } } }));
        assert.notEqual(fp, fingerprint({ ...base, clientInfo: { name: 'a', version: '2' } }));
    });
});

describe('seen-clients registry', () => {
    let lines;
    let restore;
    beforeEach(() => {
        resetSeenClients();
        lines = [];
        restore = configureLogger({ format: 'json', level: 'debug', write: l => lines.push(JSON.parse(l)) });
    });
    afterEach(() => configureLogger(restore));

    const modern = (name, caps = { elicitation: {} }) => ({
        clientInfo: { name, version: '1.0' },
        capabilities: caps,
        protocolVersion: '2026-07-28',
        era: 'modern',
        transport: 'http'
    });

    it('logs a 2026-07-28 client only on first sight, then just counts', () => {
        recordRequest(modern('A'), 'tools/list');
        recordRequest(modern('A'), 'tools/call');
        recordRequest(modern('A'), 'tools/call');
        const seen = lines.filter(l => l.event === 'client.seen');
        assert.equal(seen.length, 1);
        assert.equal(seen[0].clientInfo.name, 'A');
        assert.deepEqual(seen[0].summary.elicitation, { form: true, url: false });
        const [rec] = listSeenClients();
        assert.equal(rec.requests, 3);
        assert.equal(rec.toolCalls, 2);
        assert.equal(rec.connections, 0);
    });

    it('treats a changed capability set as a new client', () => {
        recordRequest(modern('A'), 'tools/list');
        recordRequest(modern('A', { elicitation: { form: {}, url: {} } }), 'tools/list');
        assert.equal(lines.filter(l => l.event === 'client.seen').length, 2);
        assert.equal(listSeenClients().length, 2);
    });

    it('logs every 2025-era connection but keeps one record', () => {
        const legacy = { ...modern('L'), protocolVersion: '2025-11-25', era: 'legacy', transport: 'stdio' };
        recordConnection(legacy);
        recordRequest(legacy, 'tools/list');
        recordConnection(legacy);
        assert.equal(lines.filter(l => l.event === 'client.connected').length, 2);
        assert.equal(lines.filter(l => l.event === 'client.seen').length, 0);
        const [rec] = listSeenClients();
        assert.equal(rec.connections, 2);
        assert.equal(rec.requests, 1);
    });

    it('lists most recently active first and returns copies', async () => {
        recordRequest(modern('first'), 'tools/list');
        await new Promise(r => setTimeout(r, 5));
        recordRequest(modern('second'), 'tools/list');
        const list = listSeenClients();
        assert.deepEqual(list.map(c => c.clientInfo.name), ['second', 'first']);
        list[0].requests = 999;
        assert.equal(listSeenClients()[0].requests, 1);
    });
});
