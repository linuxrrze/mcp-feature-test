// Browser test of the pick_color colour picker MCP App (headless Chromium via
// playwright-core). Skips with a clear message when no Chromium is available.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { launchBrowser, openColorPicker } from './harness.mjs';

const launched = await launchBrowser();
const skip = launched.browser ? false : `skipped: ${launched.reason}`;
if (skip) console.log(`# UI tests ${skip}`);

const state = (picker, id) => picker.app.locator(`#r-${id}`).getAttribute('data-state');
const reportText = (picker, id) => picker.app.locator(`#r-${id} b`).textContent();

describe('Colour picker MCP App in a browser host', { skip }, () => {
    const browser = launched.browser;
    after(() => browser?.close());

    it('shows the prompt and initial colour, picks via the colour input, OK → server, model context and chat', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app } = picker;
            assert.equal(await app.locator('#prompt').textContent(), 'Favourite colour?');
            assert.equal(await app.locator('#hex').inputValue(), '#336699');
            await app.locator('#color').evaluate(el => {
                el.value = '#e11d48';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            });
            assert.equal(await app.locator('#hex').inputValue(), '#e11d48');
            await app.locator('#ok').click();
            await app.locator('#status.ok').waitFor();
            await app.locator('#r-message[data-state=ok]').waitFor();
            assert.match(await app.locator('#status').textContent(), /You picked #e11d48/);
            assert.equal(await state(picker, 'server'), 'ok');
            assert.equal(await state(picker, 'context'), 'ok');

            const call = await picker.waitForHostEvent('tools/call');
            assert.equal(call.params.name, 'pick_color_submit');
            assert.deepEqual(call.params.arguments, { requestId: picker.requestId, color: '#e11d48', action: 'accept' });
            const ctx = await picker.waitForHostEvent('ui/update-model-context');
            assert.equal(ctx.params.structuredContent.color, '#e11d48');
            const msg = await picker.waitForHostEvent('ui/message');
            assert.equal(msg.params.content[0].text, 'I picked #e11d48 for: Favourite colour?');

            const r = await picker.client.callTool({ name: 'pick_color_result', arguments: { requestId: picker.requestId } });
            assert.equal(r.structuredContent.status, 'picked');
            assert.equal(r.structuredContent.color, '#e11d48');
            assert.equal(await app.locator('#ok').isDisabled(), true, 'answered once only');
            assert.deepEqual(picker.errors, []);
        } finally {
            await picker.close();
        }
    });

    it('validates the hex field and accepts a preset swatch', async () => {
        const picker = await openColorPicker(browser, { args: { prompt: 'Swatch?' } });
        try {
            const { app } = picker;
            await app.locator('#hex').fill('#12345');
            assert.equal(await app.locator('#hex').getAttribute('aria-invalid'), 'true');
            assert.equal(await app.locator('#ok').isDisabled(), true);
            await app.locator('#hex').fill('#22C55E');
            assert.equal(await app.locator('#ok').isDisabled(), false);
            await app.locator('#presets button[data-color="#a855f7"]').click();
            assert.equal(await app.locator('#hex').inputValue(), '#a855f7');
            await app.locator('#tell').uncheck();
            await app.locator('#ok').click();
            await app.locator('#r-message[data-state=skip]').waitFor();
            assert.match(await reportText(picker, 'message'), /skipped/);
            const r = await picker.client.callTool({ name: 'pick_color_result', arguments: { requestId: picker.requestId } });
            assert.equal(r.structuredContent.color, '#a855f7');
            assert.ok(!(await picker.hostEvents()).some(e => e.type === 'ui/message'), 'no chat message with the checkbox off');
        } finally {
            await picker.close();
        }
    });

    it('Cancel stores a cancellation; a host without ui/update-model-context is reported as such', async () => {
        const picker = await openColorPicker(browser, { args: { prompt: 'Wall colour?' }, unsupported: ['ui/update-model-context'] });
        try {
            const { app } = picker;
            await app.locator('#cancel').click();
            await app.locator('#r-message[data-state=ok]').waitFor();
            assert.equal(await state(picker, 'server'), 'ok');
            assert.equal(await state(picker, 'context'), 'skip');
            assert.equal(await reportText(picker, 'context'), 'not supported by host');
            const msg = await picker.waitForHostEvent('ui/message');
            assert.equal(msg.params.content[0].text, 'I cancelled the colour picker for: Wall colour?');
            const r = await picker.client.callTool({ name: 'pick_color_result', arguments: { requestId: picker.requestId } });
            assert.equal(r.structuredContent.status, 'cancelled');
            assert.equal(r.structuredContent.color, null);
        } finally {
            await picker.close();
        }
    });

    it('unlocks for another try when nothing was delivered (host refused the tool call, no context, no message)', async () => {
        const picker = await openColorPicker(browser, { args: { prompt: 'Door colour?' }, unsupported: ['ui/update-model-context'], refuseToolCalls: 1 });
        try {
            const { app } = picker;
            await app.locator('#tell').uncheck();
            await app.locator('#ok').click();
            await app.locator('#status.err').waitFor();
            assert.equal(await state(picker, 'server'), 'err');
            assert.match(await app.locator('#status').textContent(), /could not be delivered.*Try again/);
            assert.doesNotMatch(await app.locator('#status').textContent(), /✅/);
            assert.equal(await app.locator('#ok').isDisabled(), false, 'OK is enabled again');
            assert.equal(await app.locator('#tell').isDisabled(), false);
            let r = await picker.client.callTool({ name: 'pick_color_result', arguments: { requestId: picker.requestId } });
            assert.equal(r.structuredContent.status, 'waiting');

            await app.locator('#ok').click();
            await app.locator('#status.ok').waitFor();
            assert.equal(await state(picker, 'server'), 'ok');
            assert.equal(await app.locator('#ok').isDisabled(), true);
            r = await picker.client.callTool({ name: 'pick_color_result', arguments: { requestId: picker.requestId } });
            assert.equal(r.structuredContent.status, 'picked');
            assert.deepEqual(picker.errors, []);
        } finally {
            await picker.close();
        }
    });

    for (const theme of ['light', 'dark']) {
        it(`follows the host theme (${theme})`, async () => {
            const picker = await openColorPicker(browser, { theme });
            try {
                const { attr, bg } = await picker.page.frame({ url: /about:srcdoc/ }).evaluate(() => ({
                    attr: document.documentElement.getAttribute('data-theme'),
                    bg: getComputedStyle(document.body).backgroundColor
                }));
                assert.equal(attr, theme);
                const [r, g, b] = bg.match(/\d+/g).map(Number);
                const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                assert.ok(theme === 'dark' ? luminance < 0.3 : luminance > 0.7, `${theme} background ${bg}`);
            } finally {
                await picker.close();
            }
        });
    }
});
