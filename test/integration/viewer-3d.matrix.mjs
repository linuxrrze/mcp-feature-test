// view_3d in the protocol matrix (stdio/HTTP × both eras): tool metadata, the
// ui:// resource and the sample GLB resource, then the app's selection (called
// here directly, as the host would on the app's behalf) and the model-visible
// state tool. Called from matrix.mjs.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { APP_MIME, textOf } from '../helpers.mjs';

const URI = 'ui://feature-test/viewer-3d.html';
const GLB = 'test://models/sample.glb';

/** @param {{ client: import('@modelcontextprotocol/client').Client, call: (name: string, args?: object) => Promise<any> }} o */
export function viewer3dTests({ client, call }) {
    it('view_3d: tool metadata, the ui:// resource and the sample GLB', async () => {
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(by.view_3d._meta.ui.resourceUri, URI);
        assert.deepEqual(by.view_3d_select._meta.ui.visibility, ['app']);
        assert.ok(by.view_3d_state, 'model-visible state tool');
        const res = await client.readResource({ uri: URI });
        assert.equal(res.contents[0].mimeType, APP_MIME);
        assert.ok(res.contents[0].text.length > 100_000, 'three.js is inlined');
        const glb = await client.readResource({ uri: GLB });
        assert.equal(glb.contents[0].mimeType, 'model/gltf-binary');
        const bytes = Buffer.from(glb.contents[0].blob, 'base64');
        assert.equal(bytes.toString('latin1', 0, 4), 'glTF');
        assert.equal(bytes.readUInt32LE(8), bytes.length);
    });

    it('view_3d → view_3d_select (as the app) → view_3d_state', async () => {
        const opened = await call('view_3d', { shape: 'sphere', camera: { position: [6, 2, 6], target: [0, 1.5, 0] }, highlight: 'moon' });
        assert.ok(!opened.isError, textOf(opened));
        assert.match(textOf(opened), /A 3D view of "sphere" is shown to the user/);
        const { viewId, shape, parts, camera } = opened.structuredContent;
        assert.match(viewId, /^[0-9a-f-]{36}$/);
        assert.equal(shape, 'sphere');
        assert.deepEqual(parts, ['sphere', 'ring', 'moon']);
        assert.deepEqual(camera, { position: [6, 2, 6], target: [0, 1.5, 0] });

        const empty = await call('view_3d_state', { viewId });
        assert.match(textOf(empty), /^Nothing selected yet/);

        const sel = await call('view_3d_select', { viewId, part: 'ring', camera: { position: [1, 2, 3], target: [0, 1, 0] } });
        assert.ok(!sel.isError, textOf(sel));
        const wrong = await call('view_3d_select', { viewId, part: 'tower' });
        assert.equal(wrong.isError, true);
        assert.match(textOf(wrong), /Unknown part "tower"/);

        const r = await call('view_3d_state', { viewId });
        assert.equal(r.structuredContent.selected, 'ring');
        assert.equal(textOf(r), 'The user selected "ring" in the 3D view of "sphere". Camera: position [1, 2, 3], target [0, 1, 0].');
    });

    it('view_3d: invalid camera and unknown view', async () => {
        const bad = await call('view_3d', { camera: { position: [0, 0, 1000], target: [0, 0, 0] } });
        assert.equal(bad.isError, true);
        const unknown = await call('view_3d_select', { viewId: 'not-a-view', part: 'knot' });
        assert.equal(unknown.isError, true);
        assert.match(textOf(unknown), /Unknown or expired 3D view/);
    });
}
