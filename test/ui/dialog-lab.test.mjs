// Browser test of the Dialog Lab MCP App (headless Chromium via playwright-core).
// Skips with a clear message when no Chromium is available.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_INPUT, fillDemoAnswers, launchBrowser, openDialogLab } from './harness.mjs';

const launched = await launchBrowser();
const skip = launched.browser ? false : `skipped: ${launched.reason}`;
if (skip) console.log(`# UI tests ${skip}`);

describe('Dialog Lab MCP App in a browser host', { skip }, () => {
    const browser = launched.browser;
    after(() => browser?.close());

    describe('interaction (light theme)', () => {
        let lab;
        before(async () => {
            lab = await openDialogLab(browser, { theme: 'light' });
        });
        after(() => lab?.close());

        it('connects via ui/initialize and applies the tool input', async () => {
            assert.equal(await lab.app.locator('#question').textContent(), DEFAULT_INPUT.question);
            assert.deepEqual(await lab.app.locator('#rank li span').allTextContents(), DEFAULT_INPUT.items);
            await lab.app.locator('#debug', { hasText: 'connected (ui/initialize done)' }).waitFor({ state: 'attached' }); // inside a closed <details>
            const debug = JSON.parse(await lab.app.locator('#debug').textContent());
            assert.equal(debug.hostInfo.name, 'TestHost');
            assert.equal(debug.hostContext.theme, 'light');
        });

        it('submits to the server through the app-only tool', async () => {
            await fillDemoAnswers(lab);
            await lab.app.locator('#submit').click();
            await lab.app.locator('#status.ok').waitFor();
            assert.match(await lab.app.locator('#status').textContent(), /Stored submission #\d+/);
            const call = await lab.waitForHostEvent('tools/call');
            assert.equal(call.params.name, 'dialog_lab_submit');

            const r = await lab.client.callTool({ name: 'dialog_lab_results', arguments: { limit: 1 } });
            const data = r.structuredContent.submissions[0].data;
            assert.equal(data.question, DEFAULT_INPUT.question);
            assert.equal(data.rating, 5);
            assert.equal(data.color, '#e11d48');
            assert.equal(data.focusLevel, 85);
            assert.deepEqual(data.ranking, ['Pizza', 'Whiteboard', 'Coffee', 'Standing desk']);
            assert.equal(data.comment, 'Works in headless Chromium');
            assert.match(data.sketch, /PNG data URL/);
            assert.ok(r.content.some(c => c.type === 'image' && c.mimeType === 'image/png'), 'sketch returned as image');
        });

        it('sends a chat message (ui/message)', async () => {
            await lab.app.locator('#chat').click();
            const ev = await lab.waitForHostEvent('ui/message');
            assert.equal(ev.params.role, 'user');
            assert.match(ev.params.content[0].text, /Rating: ★★★★★/);
            assert.match(ev.params.content[0].text, /Ranking: 1\. Pizza, 2\. Whiteboard/);
        });

        it('updates the model context (ui/update-model-context)', async () => {
            await lab.app.locator('#context').click();
            const ev = await lab.waitForHostEvent('ui/update-model-context');
            assert.equal(ev.params.structuredContent.rating, 5);
            assert.equal(ev.params.structuredContent.sketchPng, undefined, 'sketch is not pushed into the model context');
        });

        it('requests fullscreen (ui/request-display-mode)', async () => {
            await lab.app.locator('#fullscreen').click();
            const ev = await lab.waitForHostEvent('ui/request-display-mode');
            assert.equal(ev.params.mode, 'fullscreen');
            await lab.app.locator('#fullscreen', { hasText: 'Exit fullscreen' }).waitFor();
        });

        it('offers a download (ui/download-file)', async () => {
            await lab.app.locator('#download').click();
            const ev = await lab.waitForHostEvent('ui/download-file');
            const resource = ev.params.contents[0].resource;
            assert.equal(resource.mimeType, 'application/json');
            assert.equal(JSON.parse(resource.text).rating, 5);
            assert.match(await lab.app.locator('#downloadNote').textContent(), /host advertises downloadFile/);
        });

        it('offers a blob download (sketch PNG) and a resource_link download', async () => {
            await lab.app.locator('#downloadBlob').click();
            await lab.app.locator('#status', { hasText: 'PNG blob' }).waitFor();
            const blob = (await lab.hostEvents()).filter(e => e.type === 'ui/download-file').at(-1).params.contents[0];
            assert.equal(blob.type, 'resource');
            assert.equal(blob.resource.mimeType, 'image/png');
            assert.ok(Buffer.from(blob.resource.blob, 'base64').subarray(1, 4).toString() === 'PNG', 'valid PNG bytes');

            await lab.app.locator('#downloadLink').click();
            await lab.app.locator('#status', { hasText: 'resource_link' }).waitFor();
            const link = (await lab.hostEvents()).filter(e => e.type === 'ui/download-file').at(-1).params.contents[0];
            assert.equal(link.type, 'resource_link');
            assert.equal(link.uri, 'test://files/sample.pdf');
            // The link must be readable from the server, as a host would do.
            const read = await lab.client.readResource({ uri: link.uri });
            assert.equal(read.contents[0].mimeType, 'application/pdf');
        });

        it('uploads a file through the app-only tool and shows size and SHA-256', async () => {
            const buffer = Buffer.from(Array.from({ length: 150_000 }, (_, i) => i % 251));
            const sha256 = createHash('sha256').update(buffer).digest('hex');
            assert.equal(await lab.app.locator('#upload').isDisabled(), true, 'disabled until a file is chosen');
            await lab.app.locator('#file').setInputFiles({ name: 'probe.bin', mimeType: 'application/octet-stream', buffer });
            await lab.app.locator('#upload').click();
            await lab.app.locator('#uploadStatus.ok').waitFor();
            const shown = await lab.app.locator('#uploadStatus').textContent();
            assert.match(shown, /Received "probe\.bin" \(application\/octet-stream\): 146\.5 KiB \(150000 bytes\)/);
            assert.ok(shown.includes(sha256), shown);
            const call = (await lab.hostEvents()).filter(e => e.type === 'tools/call').at(-1);
            assert.equal(call.params.name, 'dialog_lab_upload');
            assert.equal(Buffer.from(call.params.arguments.data, 'base64').length, 150_000);
        });

        it('raised no page errors', () => {
            assert.deepEqual(lab.errors, []);
        });
    });

    it('host without downloadFile and a small UPLOAD_MAX_BYTES: downloads disabled, oversized upload rejected', async () => {
        const lab = await openDialogLab(browser, {
            hostCapabilities: { serverTools: {}, message: { text: {} } },
            env: { UPLOAD_MAX_BYTES: '1000' }
        });
        try {
            await lab.app.locator('#downloadNote', { hasText: 'Downloads disabled' }).waitFor();
            for (const id of ['#download', '#downloadBlob', '#downloadLink']) assert.equal(await lab.app.locator(id).isDisabled(), true, id);
            // Another action re-enables the action buttons; the download buttons must stay disabled.
            await lab.app.locator('#submit').click();
            await lab.app.locator('#status.ok').waitFor();
            assert.equal(await lab.app.locator('#downloadBlob').isDisabled(), true);

            await lab.app.locator('#file').setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2000, 'x') });
            await lab.app.locator('#upload').click();
            await lab.app.locator('#uploadStatus.err').waitFor();
            assert.match(await lab.app.locator('#uploadStatus').textContent(), /failed: .*above the limit of 1000 B \(1000 bytes, UPLOAD_MAX_BYTES\)/);
            assert.deepEqual(lab.errors, []);
        } finally {
            await lab.close();
        }
    });

    for (const theme of ['light', 'dark']) {
        it(`follows the host theme (${theme})`, async () => {
            const lab = await openDialogLab(browser, { theme });
            try {
                const { attr, bg } = await lab.page.frame({ url: /about:srcdoc/ }).evaluate(() => ({
                    attr: document.documentElement.getAttribute('data-theme'),
                    bg: getComputedStyle(document.body).backgroundColor
                }));
                assert.equal(attr, theme);
                const [r, g, b] = bg.match(/\d+/g).map(Number);
                const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                assert.ok(theme === 'dark' ? luminance < 0.3 : luminance > 0.7, `${theme} background ${bg}`);
            } finally {
                await lab.close();
            }
        });
    }
});
