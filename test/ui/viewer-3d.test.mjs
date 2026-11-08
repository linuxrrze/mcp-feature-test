// Browser test of the view_3d 3D viewer MCP App (headless Chromium, software
// WebGL via SwiftShader). Rendering is not pixel-exact across GL backends, so
// the checks look at structure (share of non-background pixels, colour count,
// camera numbers, which part a raycast hits), never at reference images.
// Skips with a clear message when no Chromium is available.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { launchBrowser, OPEN_WEBUI_CSP, openViewer3d } from './harness.mjs';

const launched = await launchBrowser();
const skip = launched.browser ? false : `skipped: ${launched.reason}`;
if (skip) console.log(`# UI tests ${skip}`);

const dist = (c, t = c.target) => Math.hypot(...c.position.map((p, i) => p - t[i]));

describe('3D viewer MCP App in a browser host', { skip }, () => {
    const browser = launched.browser;
    after(() => browser?.close());

    it('renders the knot: non-blank canvas, part list, capability probes', async () => {
        const v = await openViewer3d(browser);
        try {
            assert.deepEqual(await v.viewer(() => window.__viewer.parts()), ['knot', 'stand', 'base']);
            assert.deepEqual(await v.app.locator('#parts button').allTextContents(), ['knot', 'stand', 'base']);
            const px = await v.viewer(() => window.__viewer.pixelStats());
            assert.ok(px.width > 300 && px.height > 200, JSON.stringify(px));
            assert.ok(px.foreground > 0.05 && px.foreground < 0.8, `foreground share ${px.foreground}`);
            assert.ok(px.colours > 20, `shaded, not flat: ${px.colours} colours`);
            const probes = await v.viewer(() => window.__viewer.probes);
            assert.match(probes['WebGL 1'] + probes['WebGL 2'], /available/);
            assert.ok(probes.renderer?.length > 3, 'renderer string');
            assert.equal(probes['model source'], 'generated in the app (three.js geometry)');
            assert.match(probes.bundle, /KiB HTML/);
            await v.app.locator('#probe tr[data-key="WASM compile"]').waitFor({ state: 'attached' });
            assert.match(await v.app.locator('#shapeLabel').textContent(), /knot/);
            assert.deepEqual(v.errors, []);
        } finally {
            await v.close();
        }
    });

    it('drag, wheel and keys move the camera; Reset view restores it; wireframe changes the picture', async () => {
        const v = await openViewer3d(browser, { args: { shape: 'gear' } });
        try {
            const cam = () => v.viewer(() => window.__viewer.camera());
            const start = await cam();
            assert.deepEqual(start, { position: [5, 3.5, 6], target: [0, 1.2, 0] });
            const box = await v.app.locator('#stage').boundingBox();
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            await v.page.mouse.move(cx, cy);
            await v.page.mouse.down();
            await v.page.mouse.move(cx + 120, cy + 30, { steps: 8 });
            await v.page.mouse.up();
            const dragged = await cam();
            assert.notDeepEqual(dragged.position, start.position, 'drag orbits');
            assert.ok(Math.abs(dist(dragged) - dist(start)) < 0.05, 'orbit keeps the distance');

            await v.page.mouse.move(cx, cy);
            await v.page.mouse.wheel(0, -400);
            await v.frame.waitForFunction(d => {
                const c = window.__viewer.camera();
                return Math.hypot(...c.position.map((p, i) => p - c.target[i])) < d - 0.2;
            }, dist(dragged));

            await v.app.locator('#stage').focus();
            const beforeKey = await cam();
            await v.page.keyboard.press('ArrowLeft');
            await v.page.keyboard.press('-');
            const afterKey = await cam();
            assert.notDeepEqual(afterKey.position, beforeKey.position, 'arrow key orbits');
            assert.ok(dist(afterKey) > dist(beforeKey) + 0.1, '"-" zooms out');

            await v.app.locator('#reset').click();
            assert.deepEqual(await cam(), start);

            const solid = (await v.viewer(() => window.__viewer.pixelStats())).foreground;
            await v.app.locator('#wireframe').click();
            assert.equal(await v.app.locator('#wireframe').getAttribute('aria-pressed'), 'true');
            const wire = (await v.viewer(() => window.__viewer.pixelStats())).foreground;
            assert.ok(wire < solid, `wireframe covers fewer pixels (${wire} < ${solid})`);
            assert.deepEqual(v.errors, []);
        } finally {
            await v.close();
        }
    });

    it('clicking a part selects it → view_3d_select, model context, and "Tell the assistant" → ui/message', async () => {
        const v = await openViewer3d(browser, { args: { shape: 'sphere' } });
        try {
            const p = await v.pointOn('sphere');
            assert.ok(p, 'the sphere is visible');
            await v.page.mouse.click(p.x, p.y);
            await v.app.locator('#r-server[data-state=ok]').waitFor();
            await v.app.locator('#r-context[data-state=ok]').waitFor();
            assert.equal(await v.viewer(() => window.__viewer.selected), 'sphere');
            assert.equal(await v.app.locator('#parts button[data-part=sphere]').getAttribute('aria-pressed'), 'true');

            const call = await v.waitForHostEvent('tools/call');
            assert.equal(call.params.name, 'view_3d_select');
            assert.equal(call.params.arguments.viewId, v.viewId);
            assert.equal(call.params.arguments.part, 'sphere');
            assert.equal(call.params.arguments.camera.position.length, 3);
            const ctx = await v.waitForHostEvent('ui/update-model-context');
            assert.equal(ctx.params.structuredContent.selected, 'sphere');

            const state = await v.client.callTool({ name: 'view_3d_state', arguments: { viewId: v.viewId } });
            assert.equal(state.structuredContent.selected, 'sphere');
            assert.match(state.content[0].text, /^The user selected "sphere" in the 3D view of "sphere"\. Camera: position \[5, 3\.5, 6\]/);

            // The part list selects too.
            await v.app.locator('#parts button[data-part=moon]').click();
            await v.page.waitForFunction(() => window.hostEvents.filter(e => e.type === 'tools/call').length >= 2);
            await v.app.locator('#r-server b', { hasText: 'stored moon' }).waitFor();

            await v.app.locator('#tell').click();
            await v.app.locator('#r-message[data-state=ok]').waitFor();
            const msg = await v.waitForHostEvent('ui/message');
            assert.equal(msg.params.content[0].text, 'I selected moon in the 3D view (sphere).');
            assert.deepEqual(v.errors, []);
        } finally {
            await v.close();
        }
    });

    it('glb-sample loads through resources/read under Open WebUI’s CSP (no fetch, no WASM, no eval)', async () => {
        const v = await openViewer3d(browser, { args: { shape: 'glb-sample', highlight: 'roof' }, csp: OPEN_WEBUI_CSP, theme: 'dark' });
        try {
            const read = await v.waitForHostEvent('resources/read');
            assert.equal(read.params.uri, 'test://models/sample.glb');
            assert.deepEqual(await v.viewer(() => window.__viewer.parts()), ['base', 'tower', 'roof', 'flag']);
            assert.equal(await v.viewer(() => window.__viewer.selected), 'roof', 'highlight argument preselects the part');
            assert.ok(!(await v.hostEvents()).some(e => e.type === 'tools/call'), 'a highlight from the model is not echoed back to the server');
            const px = await v.viewer(() => window.__viewer.pixelStats());
            assert.ok(px.foreground > 0.05, `foreground share ${px.foreground}`);

            await v.app.locator('#probe tr[data-key="fetch (data: URL)"]').waitFor({ state: 'attached' });
            const probes = await v.viewer(() => window.__viewer.probes);
            assert.match(probes['model source'], /^resources\/read test:\/\/models\/sample\.glb \(\d+ bytes, model\/gltf-binary\)/);
            assert.match(probes['WASM compile'], /^blocked/);
            assert.match(probes['eval / new Function'], /^blocked/);
            assert.match(probes['fetch (data: URL)'], /^blocked/);

            const p = await v.pointOn('tower');
            await v.page.mouse.click(p.x, p.y);
            await v.app.locator('#r-server[data-state=ok]').waitFor();
            const state = await v.client.callTool({ name: 'view_3d_state', arguments: { viewId: v.viewId } });
            assert.equal(state.structuredContent.selected, 'tower');
            assert.equal(await v.frame.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
            assert.deepEqual(v.errors, []);
        } finally {
            await v.close();
        }
    });

    it('fullscreen: hidden with a note when the host offers only inline; otherwise requests the display mode', async () => {
        const inline = await openViewer3d(browser, { displayModes: ['inline'] });
        try {
            assert.equal(await inline.app.locator('#fullscreen').isHidden(), true);
            assert.match(await inline.app.locator('#fsNote').textContent(), /not offered by this host \(display modes: inline\)/);
        } finally {
            await inline.close();
        }
        const full = await openViewer3d(browser, { unsupported: ['ui/update-model-context'] });
        try {
            assert.equal(await full.app.locator('#fsNote').textContent(), '');
            await full.app.locator('#fullscreen').click();
            const req = await full.waitForHostEvent('ui/request-display-mode');
            assert.equal(req.params.mode, 'fullscreen');
            await full.app.locator('#fullscreen', { hasText: 'Exit fullscreen' }).waitFor();
            assert.equal(await full.frame.evaluate(() => document.body.classList.contains('fullscreen')), true);

            await full.app.locator('#parts button[data-part=base]').click();
            await full.app.locator('#r-context[data-state=skip]').waitFor();
            assert.equal(await full.app.locator('#r-context b').textContent(), 'not supported by host');
            assert.equal(await full.app.locator('#r-server').getAttribute('data-state'), 'ok');
        } finally {
            await full.close();
        }
    });
});
