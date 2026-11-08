// pick_color in the protocol matrix (stdio/HTTP × both eras): tool metadata and
// resource, then the app's submit (called here directly, as the host would on the
// app's behalf) and the model-visible result tool. Called from matrix.mjs.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { APP_MIME, textOf } from '../helpers.mjs';

const URI = 'ui://feature-test/color-picker.html';

/** @param {{ client: import('@modelcontextprotocol/client').Client, call: (name: string, args?: object) => Promise<any> }} o */
export function colorPickerTests({ client, call }) {
    it('pick_color: tool metadata and the ui:// resource', async () => {
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(by.pick_color._meta.ui.resourceUri, URI);
        assert.deepEqual(by.pick_color_submit._meta.ui.visibility, ['app']);
        assert.ok(by.pick_color_result, 'model-visible result tool');
        const res = await client.readResource({ uri: URI });
        assert.equal(res.contents[0].mimeType, APP_MIME);
        assert.ok(res.contents[0].text.length > 10_000);
    });

    it('pick_color → pick_color_submit (as the app) → pick_color_result', async () => {
        const opened = await call('pick_color', { prompt: 'Brand colour?', initial: '#336699' });
        assert.ok(!opened.isError, textOf(opened));
        assert.match(textOf(opened), /A colour picker is shown to the user; wait for their choice/);
        const { requestId, prompt, initial } = opened.structuredContent;
        assert.match(requestId, /^[0-9a-f-]{36}$/);
        assert.equal(prompt, 'Brand colour?');
        assert.equal(initial, '#336699');

        const waiting = await call('pick_color_result', { requestId });
        assert.equal(waiting.structuredContent.status, 'waiting');

        const stored = await call('pick_color_submit', { requestId, color: '#FFCC00', action: 'accept' });
        assert.ok(!stored.isError, textOf(stored));
        const again = await call('pick_color_submit', { requestId, color: '#000000', action: 'accept' });
        assert.equal(again.isError, true);
        assert.match(textOf(again), /already answered/);

        const r = await call('pick_color_result', { requestId });
        assert.equal(r.structuredContent.status, 'picked');
        assert.equal(r.structuredContent.color, '#ffcc00');
        assert.equal(textOf(r), 'The user picked #ffcc00 for "Brand colour?".');
    });

    it('pick_color: cancel path and an unknown requestId', async () => {
        const { requestId } = (await call('pick_color')).structuredContent;
        const cancelled = await call('pick_color_submit', { requestId, color: null, action: 'cancel' });
        assert.ok(!cancelled.isError, textOf(cancelled));
        const r = await call('pick_color_result', { requestId });
        assert.equal(r.structuredContent.status, 'cancelled');
        const unknown = await call('pick_color_submit', { requestId: 'not-a-request', color: '#ffffff', action: 'accept' });
        assert.equal(unknown.isError, true);
        assert.match(textOf(unknown), /Unknown or expired/);
    });
}
