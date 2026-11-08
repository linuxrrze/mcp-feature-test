// Browser test of the pick_color colour picker MCP App (headless Chromium via
// playwright-core). Skips with a clear message when no Chromium is available.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { launchBrowser, openColorPicker } from './harness.mjs';

const launched = await launchBrowser();
const skip = launched.browser ? false : `skipped: ${launched.reason}`;
if (skip) console.log(`# UI tests ${skip}`);

const state = (picker, id) => picker.app.locator(`#r-${id}`).getAttribute('data-state');
const reportText = (picker, id) => picker.app.locator(`#r-${id} b`).textContent();
const hex = picker => picker.app.locator('#hex').inputValue();

/** Same geometry as wheelGeometry() in ui/color-picker.ts, in page coordinates. */
async function wheelGeometry(picker) {
    const box = await picker.app.locator('#wheel').boundingBox();
    const size = box.width;
    const outer = size / 2 - 1;
    const thickness = Math.max(16, size * 0.09);
    const inner = outer - thickness;
    return { cx: box.x + size / 2, cy: box.y + size / 2, mid: (outer + inner) / 2, inner };
}
const at = (g, hue, r) => ({ x: g.cx + r * Math.cos((hue * Math.PI) / 180), y: g.cy - r * Math.sin((hue * Math.PI) / 180) });

async function drag(page, from, ...path) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const p of path) await page.mouse.move(p.x, p.y, { steps: 6 });
    await page.mouse.up();
}

/** A tiny PNG: left half red, right half blue (no image library needed). */
function twoColourPng(w = 40, h = 20) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = buf => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    const rows = [];
    for (let y = 0; y < h; y++) {
        rows.push(0);
        for (let x = 0; x < w; x++) rows.push(...(x < w / 2 ? [255, 0, 0] : [0, 0, 255]));
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

describe('Colour picker MCP App in a browser host', { skip }, () => {
    const browser = launched.browser;
    after(() => browser?.close());

    it('shows the prompt and initial colour, picks via the colour input, OK → server, model context and chat', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app } = picker;
            assert.equal(await app.locator('#prompt').textContent(), 'Favourite colour?');
            assert.equal(await hex(picker), '#336699');
            assert.equal(await app.locator('#tab-wheel').getAttribute('aria-selected'), 'true', 'Wheel is the default tab');
            await app.locator('#color').evaluate(el => {
                el.value = '#e11d48';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            });
            assert.equal(await hex(picker), '#e11d48');
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
            assert.equal(await app.locator('#picker').evaluate(el => el.disabled), true, 'the picker is locked after answering');
            assert.deepEqual(picker.errors, []);
        } finally {
            await picker.close();
        }
    });

    it('validates the hex field (with alpha) and accepts a preset swatch', async () => {
        const picker = await openColorPicker(browser, { args: { prompt: 'Swatch?' } });
        try {
            const { app } = picker;
            await app.locator('#hex').fill('#12345');
            assert.equal(await app.locator('#hex').getAttribute('aria-invalid'), 'true');
            assert.equal(await app.locator('#ok').isDisabled(), true);
            await app.locator('#hex').fill('#22C55E');
            assert.equal(await app.locator('#ok').isDisabled(), false);
            await app.locator('#hex').fill('#22C55E40');
            assert.equal(await app.locator('#alpha').inputValue(), '25', '0x40 → 25 % opacity');
            await app.locator('#hex').fill('#22C55E');
            await app.locator('#presets button[data-color="#a855f7"]').click();
            assert.equal(await hex(picker), '#a855f7');
            assert.equal(await app.locator('#presets button[data-color="#a855f7"]').getAttribute('aria-pressed'), 'true');
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
            assert.equal(await app.locator('#picker').evaluate(el => el.disabled), false, 'the picker is usable again');
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

    it('Wheel: dragging on the ring changes the hue, dragging in the triangle changes saturation/value (clamped)', async () => {
        const picker = await openColorPicker(browser); // #336699 = hsv(210°, 67 %, 60 %)
        try {
            const { app, page } = picker;
            assert.equal(await app.locator('#hue-handle').getAttribute('aria-valuenow'), '210');
            const g = await wheelGeometry(picker);
            await drag(page, at(g, 200, g.mid), at(g, 160, g.mid), at(g, 120, g.mid));
            assert.equal(await app.locator('#hue-handle').getAttribute('aria-valuenow'), '120');
            assert.equal(await hex(picker), '#339933', 'hsv(120°, 67 %, 60 %)');

            // Start in the triangle, then drag far beyond the white corner (h + 120°): clamped to white.
            await drag(page, { x: g.cx, y: g.cy }, at(g, 240, g.inner * 0.5), at(g, 240, g.inner * 3));
            assert.equal(await hex(picker), '#ffffff');
            assert.equal(await app.locator('#hue-handle').getAttribute('aria-valuenow'), '120', 'hue kept on white');
            // ... and beyond the tip: the pure hue.
            await drag(page, { x: g.cx, y: g.cy }, at(g, 120, g.inner * 3));
            assert.equal(await hex(picker), '#00ff00');
            // ... and beyond the black corner.
            await drag(page, { x: g.cx, y: g.cy }, at(g, 0, g.inner * 3));
            assert.equal(await hex(picker), '#000000');
            assert.match(await app.locator('#tri-handle').getAttribute('aria-valuetext'), /brightness 0%/);
            // Each finished drag lands in Recent, newest first.
            const recent = await app.locator('#recent button').evaluateAll(bs => bs.map(b => b.dataset.color));
            assert.deepEqual(recent.slice(0, 4), ['#000000', '#00ff00', '#ffffff', '#339933']);
            assert.deepEqual(picker.errors, []);
        } finally {
            await picker.close();
        }
    });

    it('keyboard: arrows on the ring and triangle handles, tab list arrows', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app, page } = picker;
            await app.locator('#hue-handle').focus();
            for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
            assert.equal(await app.locator('#hue-handle').getAttribute('aria-valuenow'), '213');
            await page.keyboard.press('Shift+ArrowLeft');
            assert.equal(await app.locator('#hue-handle').getAttribute('aria-valuenow'), '203');
            await app.locator('#tri-handle').focus();
            await page.keyboard.press('Shift+ArrowUp'); // value 60 → 70 %
            await page.keyboard.press('ArrowLeft'); // saturation 67 → 66 %
            assert.equal(await app.locator('#tri-handle').getAttribute('aria-valuetext'), 'saturation 66%, brightness 70%');
            assert.equal(await app.locator('#tri-handle').evaluate(el => el.matches(':focus-visible')), true, 'visible focus');

            await app.locator('#tab-wheel').focus();
            await page.keyboard.press('ArrowRight');
            assert.equal(await app.locator('#tab-values').getAttribute('aria-selected'), 'true');
            assert.equal(await app.locator('#tab-values').evaluate(el => el === document.activeElement), true);
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
            assert.equal(await app.locator('#tab-classic').getAttribute('aria-selected'), 'true');
            await app.locator('#sq-handle').focus();
            await page.keyboard.press('Shift+ArrowDown');
            assert.match(await app.locator('#sq-handle').getAttribute('aria-valuetext'), /brightness 60%/);
        } finally {
            await picker.close();
        }
    });

    it('tabs switch panels; Classic square and hue slider work', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app, page } = picker;
            for (const t of ['classic', 'values', 'pick', 'palettes', 'wheel']) {
                await app.locator(`#tab-${t}`).click();
                assert.equal(await app.locator(`#tab-${t}`).getAttribute('aria-selected'), 'true');
                const visible = await app.locator('[role=tabpanel]').evaluateAll(ps => ps.filter(p => !p.hidden).map(p => p.id));
                assert.deepEqual(visible, [`panel-${t}`]);
            }
            await app.locator('#tab-classic').click();
            const box = await app.locator('#square').boundingBox();
            await drag(page, { x: box.x + 5, y: box.y + 5 }, { x: box.x + box.width + 30, y: box.y - 30 }); // top right, clamped
            assert.equal(await app.locator('#sq-handle').getAttribute('aria-valuetext'), 'saturation 100%, brightness 100%');
            assert.equal(await hex(picker), '#0080ff', 'hsv(210°, 100 %, 100 %)');
            await app.locator('#hue-range').fill('0');
            assert.equal(await hex(picker), '#ff0000');
        } finally {
            await picker.close();
        }
    });

    it('Values: RGB, HSL and HSV inputs stay in sync', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app } = picker;
            await app.locator('#tab-values').click();
            const v = id => app.locator(`#ch-${id}`).inputValue();
            assert.deepEqual([await v('r'), await v('g'), await v('b')], ['51', '102', '153']);
            assert.deepEqual([await v('hsl-h'), await v('hsl-s'), await v('hsl-l')], ['210', '50', '40']);
            assert.deepEqual([await v('hsv-h'), await v('hsv-s'), await v('hsv-v')], ['210', '67', '60']);

            await app.locator('#ch-r').fill('255');
            assert.equal(await hex(picker), '#ff6699');
            assert.equal(await v('hsl-h'), '340');
            await app.locator('#ch-hsl-l').fill('50');
            assert.deepEqual([await v('r'), await v('g'), await v('b')], ['255', '0', '85']);
            await app.locator('#ch-hsv-v').fill('20');
            assert.equal(await hex(picker), '#330011');
            await app.locator('#ch-hsv-h-range').fill('120');
            assert.equal(await hex(picker), '#003300');
            assert.equal(await v('hsv-h'), '120');
            await app.locator('#ch-a').fill('50');
            assert.equal(await hex(picker), '#00330080');
            assert.equal(await app.locator('#alpha').inputValue(), '50');
            assert.equal(await app.locator('#out-rgb').textContent(), 'rgba(0, 51, 0, 0.502)');
        } finally {
            await picker.close();
        }
    });

    it('opacity slider → #rrggbbaa is submitted and stored', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app } = picker;
            await app.locator('#alpha').fill('50');
            assert.equal(await hex(picker), '#33669980');
            assert.equal(await app.locator('#alpha-out').textContent(), '50%');
            await app.locator('#ok').click();
            await app.locator('#status.ok').waitFor();
            const call = await picker.waitForHostEvent('tools/call');
            assert.equal(call.params.arguments.color, '#33669980');
            const msg = await picker.waitForHostEvent('ui/message');
            assert.equal(msg.params.content[0].text, 'I picked #33669980 for: Favourite colour?');
            const r = await picker.client.callTool({ name: 'pick_color_result', arguments: { requestId: picker.requestId } });
            assert.equal(r.structuredContent.color, '#33669980');
            assert.equal(r.structuredContent.rgb, 'rgba(51, 102, 153, 0.502)');
        } finally {
            await picker.close();
        }
    });

    it('palettes and the previous colour: click a swatch (keeps opacity), click the previous colour to swap back', async () => {
        const picker = await openColorPicker(browser);
        try {
            const { app } = picker;
            await app.locator('#alpha').fill('80');
            await app.locator('#tab-palettes').click();
            const sw = app.locator('#palettes .palette').nth(2).locator('button').nth(14); // Spectrum, row 2
            const color = await sw.getAttribute('data-color');
            assert.match(color, /^#[0-9a-f]{6}$/);
            await sw.click();
            assert.equal(await hex(picker), `${color}cc`, 'palette colour with the chosen 80 % opacity');
            assert.equal(await sw.getAttribute('aria-pressed'), 'true');
            assert.equal(await app.locator('#side-palette-box').isHidden(), true, 'no duplicate palette beside the Palettes tab');
            assert.equal(await app.locator('#recent button').first().getAttribute('data-color'), `${color}cc`);

            await app.locator('#previous').click();
            assert.equal(await hex(picker), '#336699', 'back to the previous (initial) colour');
            await app.locator('#previous').click();
            assert.equal(await hex(picker), `${color}cc`, 'and swapped again');
        } finally {
            await picker.close();
        }
    });

    it('Recent is seeded from earlier answers on the server (structuredContent.recent)', async () => {
        const setup = async client => {
            for (const c of ['#abcdef', '#12345680']) {
                const { requestId } = (await client.callTool({ name: 'pick_color', arguments: {} })).structuredContent;
                await client.callTool({ name: 'pick_color_submit', arguments: { requestId, color: c, action: 'accept' } });
            }
        };
        const picker = await openColorPicker(browser, { setup });
        try {
            const { app } = picker;
            assert.deepEqual(picker.toolResult.structuredContent.recent, ['#12345680', '#abcdef']);
            await app.locator('#recent button[data-color="#abcdef"]').waitFor();
            await app.locator('#recent button[data-color="#12345680"]').click();
            assert.equal(await hex(picker), '#12345680', 'a recent colour carries its own opacity');
        } finally {
            await picker.close();
        }
    });

    it('Pick: explains when the EyeDropper API is missing; samples a colour from a loaded image', async () => {
        const picker = await openColorPicker(browser, { beforeConnect: 'delete window.EyeDropper; window.EyeDropper = undefined;' });
        try {
            const { app, page } = picker;
            await app.locator('#tab-pick').click();
            assert.equal(await app.locator('#eyedropper').isHidden(), true);
            assert.match(await app.locator('#eyedropper-msg').textContent(), /not available here.*EyeDropper API/);

            await app.locator('#image-file').setInputFiles({ name: 'two.png', mimeType: 'image/png', buffer: twoColourPng() });
            await app.locator('#image-canvas:not([hidden])').waitFor();
            const box = await app.locator('#image-canvas').boundingBox();
            await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
            assert.equal(await hex(picker), '#ff0000');
            await drag(page, { x: box.x + 2, y: box.y + 2 }, { x: box.x + box.width * 0.9, y: box.y + box.height / 2 });
            assert.equal(await hex(picker), '#0000ff');
            assert.equal(await app.locator('#image-marker').isVisible(), true);
            assert.deepEqual(picker.errors, []);
        } finally {
            await picker.close();
        }
    });

    it('Pick: uses the EyeDropper API when the browser has it', async () => {
        const fake = 'window.EyeDropper = class { async open() { return { sRGBHex: "#13579b" }; } };';
        const picker = await openColorPicker(browser, { beforeConnect: fake });
        try {
            const { app } = picker;
            await app.locator('#alpha').fill('50');
            await app.locator('#tab-pick').click();
            await app.locator('#eyedropper').click();
            assert.equal(await hex(picker), '#13579b80', 'screen colour, opacity kept');
            assert.match(await app.locator('#eyedropper-msg').textContent(), /Picked #13579b/);
        } finally {
            await picker.close();
        }
    });

    it('fits a narrow (360 px) host without horizontal scrolling', async () => {
        const picker = await openColorPicker(browser, { viewport: { width: 360, height: 1400 } });
        try {
            for (const t of ['wheel', 'classic', 'values', 'pick', 'palettes']) {
                await picker.app.locator(`#tab-${t}`).click();
                const { sw, cw } = await picker.frame().evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
                assert.ok(sw <= cw, `${t}: scrollWidth ${sw} > ${cw}`);
            }
        } finally {
            await picker.close();
        }
    });

    for (const theme of ['light', 'dark']) {
        it(`follows the host theme (${theme})`, async () => {
            const picker = await openColorPicker(browser, { theme });
            try {
                const { attr, bg } = await picker.frame().evaluate(() => ({
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
