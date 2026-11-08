// In-process tests of the server factory over an in-memory transport
// (2025-era handshake). Protocol-era matrices live in test/integration.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { APP_MIME, FULL_CAPS, UI_EXT, textOf } from '../helpers.mjs';
import { resetSeenClients } from '../../dist/clients.js';
import { configureLogger } from '../../dist/log.js';
import { DIALOG_APP_URI, allFieldsSchema, createFeatureTestServer } from '../../dist/server.js';

async function connect(capabilities, name = 'unit-client') {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createFeatureTestServer({ transport: 'stdio' });
    await server.connect(serverSide);
    const client = new Client({ name, version: '9.9.9' }, { capabilities });
    if (capabilities.elicitation) client.setRequestHandler('elicitation/create', async () => ({ action: 'cancel' }));
    await client.connect(clientSide);
    return client;
}

describe('elicitation form schemas', () => {
    const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean', 'array']);
    for (const variant of ['all', 'basic', 'formats', 'enums']) {
        it(`"${variant}" is a flat object of spec-allowed primitives`, () => {
            const s = allFieldsSchema(variant);
            assert.equal(s.type, 'object');
            const props = Object.entries(s.properties);
            assert.ok(props.length > 0);
            for (const k of s.required) assert.ok(k in s.properties, `required "${k}" must exist`);
            for (const [k, p] of props) {
                assert.ok(PRIMITIVES.has(p.type), `${k}: type ${p.type}`);
                assert.ok(p.title, `${k} has a title`);
                if (p.type === 'array') {
                    assert.ok(p.items.enum || p.items.anyOf, `${k}: multi-select needs items.enum or items.anyOf`);
                    const allowed = p.items.enum ?? p.items.anyOf.map(o => o.const);
                    for (const d of p.default ?? []) assert.ok(allowed.includes(d), `${k}: default ${d} allowed`);
                }
                if (p.enum && 'default' in p) assert.ok(p.enum.includes(p.default), `${k}: default in enum`);
                if (p.oneOf && 'default' in p) assert.ok(p.oneOf.some(o => o.const === p.default), `${k}: default in oneOf`);
                if (p.enumNames) assert.equal(p.enumNames.length, p.enum.length);
                if (p.type === 'integer' || p.type === 'number') assert.ok(p.default >= p.minimum && p.default <= p.maximum);
                if (p.type === 'string' && typeof p.default === 'string' && p.minLength) assert.ok(p.default.length >= p.minLength);
            }
        });
    }
    it('"all" is the union of the three subsets', () => {
        const keys = v => Object.keys(allFieldsSchema(v).properties);
        assert.deepEqual(keys('all').sort(), [...keys('basic'), ...keys('formats'), ...keys('enums')].sort());
    });
    it('covers every string format the spec allows', () => {
        const formats = Object.values(allFieldsSchema('formats').properties).map(p => p.format);
        assert.deepEqual(formats.sort(), ['date', 'date-time', 'email', 'uri']);
    });
});

describe('server tools (in-memory, 2025-11-25 handshake)', () => {
    let client;
    let restore;
    let logs;
    beforeEach(() => {
        resetSeenClients();
        logs = [];
        restore = configureLogger({ format: 'json', level: 'debug', write: l => logs.push(JSON.parse(l)) });
    });
    afterEach(async () => {
        await client?.close();
        configureLogger(restore);
    });

    it('logs the client capabilities after initialize', async () => {
        client = await connect(FULL_CAPS, 'Cap Logger');
        const ev = logs.find(l => l.event === 'client.connected');
        assert.ok(ev, 'client.connected logged');
        assert.equal(ev.clientInfo.name, 'Cap Logger');
        assert.equal(ev.era, 'legacy');
        assert.equal(ev.protocolVersion, '2025-11-25');
        assert.deepEqual(ev.summary.elicitation, { form: true, url: true });
        assert.deepEqual(ev.summary.ui.mimeTypes, [APP_MIME]);
        assert.deepEqual(ev.capabilities, FULL_CAPS);
    });

    it('lists the expected tools with sane metadata', async () => {
        client = await connect(FULL_CAPS);
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name).sort();
        assert.deepEqual(names, [
            'dialog_lab_results',
            'dialog_lab_submit',
            'elicit_all_field_types',
            'elicit_confirm',
            'elicit_parallel',
            'elicit_url',
            'elicit_url_legacy_push',
            'elicit_wizard',
            'inspect_client',
            'list_seen_clients',
            'open_dialog_lab',
            'slow_task'
        ]);
        for (const t of tools) {
            assert.ok(t.title, `${t.name} has a title`);
            assert.ok(t.description?.length > 20, `${t.name} has a description`);
            assert.equal(t.inputSchema.type, 'object');
        }
        const byName = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(byName.open_dialog_lab._meta.ui.resourceUri, DIALOG_APP_URI);
        assert.equal(byName.open_dialog_lab._meta['ui/resourceUri'], DIALOG_APP_URI, 'deprecated flat key for older hosts');
        assert.deepEqual(byName.dialog_lab_submit._meta.ui.visibility, ['app']);
        assert.equal(byName.list_seen_clients.annotations.readOnlyHint, true);
    });

    it('returns a friendly tool error when the client has no elicitation capability', async () => {
        client = await connect({}, 'no-dialogs');
        for (const name of ['elicit_confirm', 'elicit_all_field_types', 'elicit_parallel', 'elicit_wizard', 'elicit_url', 'elicit_url_legacy_push']) {
            const r = await client.callTool({ name, arguments: {} });
            assert.equal(r.isError, true, name);
            assert.match(textOf(r), /did not declare (form|url)-mode elicitation/, name);
        }
    });

    it('needs elicitation.url (not just form) for the URL tools', async () => {
        client = await connect({ elicitation: {} }, 'form-only');
        const r = await client.callTool({ name: 'elicit_url', arguments: {} });
        assert.equal(r.isError, true);
        assert.match(textOf(r), /url-mode/);
    });

    it('inspect_client reports the declared capabilities', async () => {
        client = await connect({ elicitation: { form: {} }, roots: { listChanged: true } }, 'Inspector Gadget');
        const r = await client.callTool({ name: 'inspect_client', arguments: {} });
        const sc = r.structuredContent;
        assert.equal(sc.clientInfo.name, 'Inspector Gadget');
        assert.equal(sc.era, 'legacy');
        assert.equal(sc.transport, 'stdio');
        assert.deepEqual(sc.summary.elicitation, { form: true, url: false });
        assert.equal(sc.summary.roots.listChanged, true);
        assert.match(textOf(r), /roots\s+yes/);
    });

    it('list_seen_clients reports every distinct client', async () => {
        const other = await connect({ elicitation: {} }, 'Other Frontend');
        await other.callTool({ name: 'inspect_client', arguments: {} });
        await other.close();
        client = await connect(FULL_CAPS, 'Main Frontend');
        const r = await client.callTool({ name: 'list_seen_clients', arguments: {} });
        const names = r.structuredContent.clients.map(c => c.clientInfo.name);
        assert.deepEqual(names, ['Main Frontend', 'Other Frontend']);
        const main = r.structuredContent.clients[0];
        assert.equal(main.connections, 1);
        assert.ok(main.toolCalls >= 1);
        assert.match(textOf(r), /Main Frontend 9\.9\.9 – 2025-11-25 \(legacy, stdio\) – \[form, url, apps-ui\]/);
        assert.match(textOf(r), /Other Frontend 9\.9\.9 .*\[form\]/);
    });

    it('logs each tool call with its outcome', async () => {
        client = await connect(FULL_CAPS);
        await client.callTool({ name: 'elicit_confirm', arguments: {} }); // scripted user cancels
        const asked = logs.find(l => l.event === 'tool.input_required' && l.tool === 'elicit_confirm');
        assert.deepEqual(asked.inputRequests, ['confirm (form)']);
        const done = logs.find(l => l.event === 'tool.result' && l.tool === 'elicit_confirm');
        assert.equal(done.responses, 'confirm=cancel');
        assert.equal(done.outcome, 'ok');
        assert.equal(done.era, 'legacy');
    });

    it('serves the MCP App resource as a single self-contained HTML file', async () => {
        client = await connect(FULL_CAPS);
        const { resources } = await client.listResources();
        const res = resources.find(r => r.uri === DIALOG_APP_URI);
        assert.ok(res, 'listed');
        assert.equal(res.mimeType, APP_MIME);
        const { contents } = await client.readResource({ uri: DIALOG_APP_URI });
        assert.equal(contents[0].mimeType, APP_MIME);
        assert.equal(contents[0]._meta.ui.prefersBorder, true);
        assert.match(contents[0].text, /^<!doctype html>/i);
        assert.match(contents[0].text, /<script type="module">/);
        assert.ok(!/<script[^>]+src=/i.test(contents[0].text), 'no external scripts');
        assert.ok(UI_EXT);
    });
});
