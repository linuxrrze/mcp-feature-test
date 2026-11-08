// The view_3d MCP App on the server side: argument validation, the sample GLB
// (a valid glTF binary with the named meshes), view store bounds, and the
// three tools plus the GLB resource over an in-memory transport (2025 handshake).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { APP_MIME, FULL_CAPS, textOf } from '../helpers.mjs';
import {
    DEFAULT_CAMERA,
    GLB_MIME,
    MAX_CAMERA_COORD,
    MAX_VIEWS,
    SAMPLE_GLB_URI,
    SHAPE_PARTS,
    VIEW_TTL_MS,
    VIEWER_3D_URI,
    checkCamera,
    createView,
    getView,
    latestView,
    makeSampleGlb,
    resetViews,
    selectInView,
    viewCount
} from '../../dist/viewer3d.js';
import { createFeatureTestServer } from '../../dist/server.js';

/** Parse a GLB: header, JSON chunk and BIN chunk. */
function parseGlb(buf) {
    assert.equal(buf.readUInt32LE(0), 0x46546c67, 'magic "glTF"');
    assert.equal(buf.readUInt32LE(4), 2, 'version 2');
    assert.equal(buf.readUInt32LE(8), buf.length, 'total length');
    const jsonLen = buf.readUInt32LE(12);
    assert.equal(buf.readUInt32LE(16), 0x4e4f534a, 'first chunk is JSON');
    assert.equal(jsonLen % 4, 0, 'JSON chunk 4-byte aligned');
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const binHeader = 20 + jsonLen;
    const binLen = buf.readUInt32LE(binHeader);
    assert.equal(buf.readUInt32LE(binHeader + 4), 0x004e4942, 'second chunk is BIN');
    assert.equal(binLen % 4, 0);
    assert.equal(binHeader + 8 + binLen, buf.length, 'no trailing bytes');
    return { json, bin: buf.subarray(binHeader + 8, binHeader + 8 + binLen) };
}

describe('camera validation', () => {
    it('accepts finite, bounded coordinates', () => {
        const r = checkCamera({ position: [1, 2, 3], target: [0, 0, 0] });
        assert.deepEqual(r, { ok: true, value: { position: [1, 2, 3], target: [0, 0, 0] } });
        assert.equal(checkCamera({ position: [MAX_CAMERA_COORD, -MAX_CAMERA_COORD, 0], target: [0, 0, 0] }).ok, true);
    });

    for (const [label, cam] of [
        ['NaN', { position: [NaN, 0, 0], target: [0, 0, 0] }],
        ['Infinity', { position: [Infinity, 0, 0], target: [0, 0, 0] }],
        ['out of bounds', { position: [MAX_CAMERA_COORD + 1, 0, 0], target: [0, 0, 0] }],
        ['two components', { position: [1, 2], target: [0, 0, 0] }],
        ['four components', { position: [1, 2, 3, 4], target: [0, 0, 0] }],
        ['strings', { position: ['1', 2, 3], target: [0, 0, 0] }],
        ['missing target', { position: [1, 2, 3] }],
        ['position = target', { position: [1, 1, 1], target: [1, 1, 1] }],
        ['not an object', 'front']
    ]) {
        it(`rejects ${label}`, () => {
            const r = checkCamera(cam);
            assert.equal(r.ok, false);
            assert.match(r.error, /^Invalid camera: /);
        });
    }
});

describe('sample GLB', () => {
    const glb = makeSampleGlb();
    const { json, bin } = parseGlb(glb);

    it('is a small glTF 2.0 binary', () => {
        assert.ok(glb.length > 1000 && glb.length < 20_000, `${glb.length} bytes`);
        assert.equal(json.asset.version, '2.0');
        assert.equal(json.buffers[0].byteLength, bin.length);
        assert.equal(json.extensionsUsed, undefined, 'no extensions (no Draco/meshopt)');
        assert.equal(json.images, undefined, 'no textures to fetch');
        assert.equal(json.buffers[0].uri, undefined, 'everything is in the BIN chunk');
    });

    it('lists the named meshes and nodes', () => {
        const names = [...SHAPE_PARTS['glb-sample']];
        assert.deepEqual(json.meshes.map(m => m.name), names);
        assert.deepEqual(json.nodes.map(n => n.name), names);
        assert.deepEqual(json.scenes[json.scene].nodes, names.map((_, i) => i));
    });

    it('has consistent accessors and buffer views inside the BIN chunk', () => {
        for (const v of json.bufferViews) {
            assert.equal(v.byteOffset % 4, 0);
            assert.ok(v.byteOffset + v.byteLength <= bin.length);
        }
        for (const mesh of json.meshes) {
            const prim = mesh.primitives[0];
            const pos = json.accessors[prim.attributes.POSITION];
            const nrm = json.accessors[prim.attributes.NORMAL];
            const idx = json.accessors[prim.indices];
            assert.equal(pos.type, 'VEC3');
            assert.equal(pos.componentType, 5126);
            assert.equal(pos.min.length, 3);
            assert.equal(nrm.count, pos.count);
            assert.equal(idx.componentType, 5123);
            assert.equal(idx.count % 3, 0);
            assert.equal(json.bufferViews[pos.bufferView].byteLength, pos.count * 12);
            const view = json.bufferViews[idx.bufferView];
            const indices = new Uint16Array(bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + view.byteLength));
            assert.ok(Math.max(...indices) < pos.count, `${mesh.name}: indices in range`);
            assert.ok(json.materials[prim.material].pbrMetallicRoughness.baseColorFactor.length === 4);
        }
    });

    it('is deterministic', () => {
        assert.ok(makeSampleGlb().equals(glb));
    });
});

describe('3D view store', () => {
    beforeEach(() => resetViews());

    it('creates views with unguessable ids and the default camera', () => {
        const a = createView('knot');
        const b = createView('gear');
        assert.match(a.viewId, /^[0-9a-f-]{36}$/);
        assert.notEqual(a.viewId, b.viewId);
        assert.deepEqual(a.camera, DEFAULT_CAMERA);
        assert.equal(latestView().viewId, b.viewId);
    });

    it('stores the latest selection; validates part names and the camera', () => {
        const v = createView('sphere');
        assert.equal(selectInView(v.viewId, 'ring', { position: [3, 2, 1], target: [0, 1, 0] }).ok, true);
        assert.equal(selectInView(v.viewId, 'moon', undefined).ok, true);
        const got = getView(v.viewId);
        assert.equal(got.selection.part, 'moon');
        assert.equal(got.selection.camera, null);
        assert.equal(got.selections, 2);
        const bad = selectInView(v.viewId, 'knot', null);
        assert.equal(bad.ok, false);
        assert.match(bad.error, /Unknown part "knot" for shape sphere; parts: sphere, ring, moon/);
        assert.equal(selectInView(v.viewId, 'ring', { position: [1e9, 0, 0], target: [0, 0, 0] }).ok, false);
        assert.equal(selectInView('nope', 'ring', null).ok, false);
        assert.equal(getView(v.viewId).selection.part, 'moon', 'failed selections change nothing');
    });

    it(`keeps at most ${MAX_VIEWS} views, oldest dropped first`, () => {
        const first = createView('knot');
        for (let i = 0; i < MAX_VIEWS + 20; i++) createView('knot');
        assert.equal(viewCount(), MAX_VIEWS);
        assert.equal(getView(first.viewId), undefined);
    });

    it('expires views after the TTL', () => {
        const t0 = Date.now();
        const v = createView('gear', undefined, null, t0);
        assert.ok(getView(v.viewId, t0 + VIEW_TTL_MS - 1));
        assert.equal(getView(v.viewId, t0 + VIEW_TTL_MS + 1), undefined);
        assert.equal(selectInView(v.viewId, 'gear', null, t0 + VIEW_TTL_MS + 2).ok, false);
    });
});

describe('view_3d tools (in-memory)', () => {
    let client;
    beforeEach(async () => {
        resetViews();
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await createFeatureTestServer({ transport: 'stdio' }).connect(serverSide);
        client = new Client({ name: 'viewer-unit', version: '1.0.0' }, { capabilities: FULL_CAPS });
        await client.connect(clientSide);
    });
    afterEach(() => client?.close());

    const call = (name, args = {}) => client.callTool({ name, arguments: args });

    it('advertises the app, hides the select tool and serves the HTML and the GLB', async () => {
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(by.view_3d._meta.ui.resourceUri, VIEWER_3D_URI);
        assert.deepEqual(by.view_3d.inputSchema.properties.shape.enum, Object.keys(SHAPE_PARTS));
        assert.deepEqual(by.view_3d_select._meta.ui.visibility, ['app']);
        assert.equal(by.view_3d_state._meta?.ui, undefined);
        const html = await client.readResource({ uri: VIEWER_3D_URI });
        assert.equal(html.contents[0].mimeType, APP_MIME);
        assert.ok(html.contents[0].text.length < 5 * 1024 * 1024, 'below Open WebUI’s 5 MB per app resource');
        const { resources } = await client.listResources();
        assert.equal(resources.find(r => r.uri === SAMPLE_GLB_URI)?.mimeType, GLB_MIME);
        const glb = await client.readResource({ uri: SAMPLE_GLB_URI });
        assert.equal(glb.contents[0].mimeType, GLB_MIME);
        assert.ok(Buffer.from(glb.contents[0].blob, 'base64').equals(makeSampleGlb()));
    });

    it('view_3d validates its arguments', async () => {
        const ok = await call('view_3d', { shape: 'gear', camera: { position: [4, 2, 4], target: [0, 1, 0] }, highlight: 'hub' });
        assert.ok(!ok.isError, textOf(ok));
        assert.deepEqual(ok.structuredContent.parts, ['gear', 'hub', 'axle']);
        assert.equal(ok.structuredContent.highlight, 'hub');
        assert.match(textOf(ok), /If no 3D view appeared, this client does not render MCP Apps\./);
        const def = await call('view_3d');
        assert.equal(def.structuredContent.shape, 'knot');
        assert.deepEqual(def.structuredContent.camera, DEFAULT_CAMERA);

        const unknownPart = await call('view_3d', { shape: 'knot', highlight: 'roof' });
        assert.equal(unknownPart.isError, true);
        assert.match(textOf(unknownPart), /Unknown part "roof" for shape knot/);
        for (const args of [{ shape: 'cube' }, { camera: { position: [0, 0, 1e6], target: [0, 0, 0] } }, { camera: { position: [0, 0, 0], target: [0, 0, 0] } }, { highlight: 'x'.repeat(65) }]) {
            const r = await call('view_3d', args);
            assert.equal(r.isError, true, JSON.stringify(args));
        }
    });

    it('select → state round trip', async () => {
        const { viewId } = (await call('view_3d', { shape: 'glb-sample' })).structuredContent;
        let s = await call('view_3d_state', { viewId });
        assert.match(textOf(s), /^Nothing selected yet/);
        const sel = await call('view_3d_select', { viewId, part: 'roof', camera: { position: [2, 3, 4], target: [0, 1, 0] } });
        assert.ok(!sel.isError, textOf(sel));
        s = await call('view_3d_state');
        assert.equal(s.structuredContent.selected, 'roof');
        assert.deepEqual(s.structuredContent.selectionCamera, { position: [2, 3, 4], target: [0, 1, 0] });
        assert.equal(textOf(s), 'The user selected "roof" in the 3D view of "glb-sample". Camera: position [2, 3, 4], target [0, 1, 0].');
        const bad = await call('view_3d_select', { viewId, part: 'roof', camera: { position: [NaN, 0, 0], target: [0, 0, 0] } });
        assert.equal(bad.isError, true);
        const unknown = await call('view_3d_state', { viewId: 'nope' });
        assert.equal(unknown.isError, true);
    });
});
