// The pick_color MCP App on the server side: validation, request store bounds,
// and the three tools over an in-memory transport (2025 handshake).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { APP_MIME, FULL_CAPS, textOf } from '../helpers.mjs';
import {
    COLOR_PICKER_URI,
    COLOR_REQUEST_TTL_MS,
    MAX_COLOR_REQUESTS,
    answerColorRequest,
    colorRequestCount,
    createColorRequest,
    getColorRequest,
    latestColorRequest,
    resetColorRequests
} from '../../dist/colorPicker.js';
import { createFeatureTestServer } from '../../dist/server.js';

describe('colour request store', () => {
    beforeEach(() => resetColorRequests());

    it('creates unguessable ids and normalizes the initial colour', () => {
        const a = createColorRequest('Q', '#ABCDEF');
        const b = createColorRequest('Q', '#000000');
        assert.match(a.requestId, /^[0-9a-f-]{36}$/);
        assert.notEqual(a.requestId, b.requestId);
        assert.equal(a.initial, '#abcdef');
        assert.equal(latestColorRequest().requestId, b.requestId);
    });

    it('accepts a valid colour once, then refuses a second answer', () => {
        const r = createColorRequest('Q', '#000000');
        const ok = answerColorRequest(r.requestId, 'accept', '#FF8800');
        assert.equal(ok.ok, true);
        assert.equal(getColorRequest(r.requestId).color, '#ff8800');
        const again = answerColorRequest(r.requestId, 'cancel', null);
        assert.equal(again.ok, false);
        assert.match(again.error, /already answered \(accept #ff8800\)/);
        assert.equal(getColorRequest(r.requestId).action, 'accept');
    });

    it('validates the colour', () => {
        const r = createColorRequest('Q', '#000000');
        for (const bad of ['red', '#fff', '#12345g', '#1234567', '', null, undefined]) {
            const out = answerColorRequest(r.requestId, 'accept', bad);
            assert.equal(out.ok, false, String(bad));
            assert.match(out.error, /expected #rrggbb/);
        }
        assert.equal(getColorRequest(r.requestId).answeredAt, undefined, 'still unanswered');
        assert.equal(answerColorRequest(r.requestId, 'cancel', '#ffffff').ok, false, 'cancel carries no colour');
        assert.equal(answerColorRequest(r.requestId, 'cancel', null).ok, true);
        assert.equal(getColorRequest(r.requestId).color, null);
    });

    it('rejects unknown request ids', () => {
        const out = answerColorRequest('nope', 'accept', '#ffffff');
        assert.equal(out.ok, false);
        assert.match(out.error, /Unknown or expired/);
    });

    it('expires requests after the TTL', () => {
        const t0 = Date.now();
        const r = createColorRequest('Q', '#000000', t0);
        assert.ok(getColorRequest(r.requestId, t0 + COLOR_REQUEST_TTL_MS - 1));
        const out = answerColorRequest(r.requestId, 'accept', '#ffffff', t0 + COLOR_REQUEST_TTL_MS + 1);
        assert.equal(out.ok, false);
        assert.equal(getColorRequest(r.requestId), undefined);
    });

    it(`keeps at most ${MAX_COLOR_REQUESTS} requests, dropping the oldest`, () => {
        const first = createColorRequest('first', '#000000');
        for (let i = 0; i < MAX_COLOR_REQUESTS + 5; i++) createColorRequest(`q${i}`, '#000000');
        assert.equal(colorRequestCount(), MAX_COLOR_REQUESTS);
        assert.equal(getColorRequest(first.requestId), undefined);
        assert.equal(latestColorRequest().prompt, `q${MAX_COLOR_REQUESTS + 4}`);
    });
});

describe('pick_color tools (in-memory)', () => {
    let client;
    beforeEach(async () => {
        resetColorRequests();
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await createFeatureTestServer({ transport: 'stdio' }).connect(serverSide);
        client = new Client({ name: 'color-unit', version: '1.0.0' }, { capabilities: FULL_CAPS });
        await client.connect(clientSide);
    });
    afterEach(() => client?.close());

    const call = (name, args = {}) => client.callTool({ name, arguments: args });

    it('advertises the app and hides the submit tool from the model', async () => {
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(by.pick_color._meta.ui.resourceUri, COLOR_PICKER_URI);
        assert.deepEqual(by.pick_color_submit._meta.ui.visibility, ['app']);
        assert.equal(by.pick_color_result._meta?.ui, undefined, 'result tool is a plain model tool');
        const { contents } = await client.readResource({ uri: COLOR_PICKER_URI });
        assert.equal(contents[0].mimeType, APP_MIME);
        assert.match(contents[0].text, /^<!doctype html>/i);
        assert.ok(!/<script[^>]+src=/i.test(contents[0].text), 'self-contained');
    });

    it('pick_color returns at once with a requestId; the result tool reports waiting, then the answer', async () => {
        const r = await call('pick_color', { prompt: 'Accent colour?', initial: '#00AA00' });
        assert.match(textOf(r), /A colour picker is shown to the user; wait for their choice\. If no picker appeared, this client does not render MCP Apps\./);
        const { requestId, prompt, initial } = r.structuredContent;
        assert.equal(prompt, 'Accent colour?');
        assert.equal(initial, '#00aa00');

        let res = await call('pick_color_result');
        assert.equal(res.structuredContent.status, 'waiting');
        assert.match(textOf(res), /Still waiting/);

        const sub = await call('pick_color_submit', { requestId, color: '#123ABC', action: 'accept' });
        assert.ok(!sub.isError, textOf(sub));
        res = await call('pick_color_result', { requestId });
        assert.equal(res.structuredContent.status, 'picked');
        assert.equal(res.structuredContent.color, '#123abc');
        assert.equal(textOf(res), 'The user picked #123abc for "Accent colour?".');

        const dup = await call('pick_color_submit', { requestId, color: null, action: 'cancel' });
        assert.equal(dup.isError, true);
        assert.match(textOf(dup), /already answered/);
    });

    it('defaults prompt and initial colour', async () => {
        const r = await call('pick_color');
        assert.equal(r.structuredContent.prompt, 'Pick a colour');
        assert.match(r.structuredContent.initial, /^#[0-9a-f]{6}$/);
    });

    it('rejects an invalid initial colour', async () => {
        const r = await call('pick_color', { initial: 'blue' }).catch(e => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
        assert.equal(r.isError, true);
        assert.match(textOf(r), /#rrggbb|initial/);
    });

    it('submit errors: unknown request and invalid colour', async () => {
        const unknown = await call('pick_color_submit', { requestId: 'does-not-exist', color: '#ffffff', action: 'accept' });
        assert.equal(unknown.isError, true);
        assert.match(textOf(unknown), /Unknown or expired/);
        const { requestId } = (await call('pick_color')).structuredContent;
        const bad = await call('pick_color_submit', { requestId, color: 'red', action: 'accept' });
        assert.equal(bad.isError, true);
        assert.match(textOf(bad), /expected #rrggbb/);
        const unknownResult = await call('pick_color_result', { requestId: 'does-not-exist' });
        assert.equal(unknownResult.isError, true);
    });

    it('reports a cancelled picker', async () => {
        const { requestId } = (await call('pick_color', { prompt: 'Wall?' })).structuredContent;
        await call('pick_color_submit', { requestId, color: null, action: 'cancel' });
        const res = await call('pick_color_result');
        assert.equal(res.structuredContent.status, 'cancelled');
        assert.match(textOf(res), /cancelled the colour picker \("Wall\?"\)/);
    });

    it('without any request, pick_color_result says so', async () => {
        const res = await call('pick_color_result');
        assert.ok(!res.isError);
        assert.match(textOf(res), /No colour picker request yet/);
    });
});
