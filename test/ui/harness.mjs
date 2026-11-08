// Drives the Dialog Lab MCP App in headless Chromium through a minimal
// AppBridge host, against the real server (dist/stdio.js). Shared by the UI
// test and `npm run screenshots`.
import { join } from 'node:path';
import { build } from 'esbuild';
import { connectStdio, findChromium, makeClient, ROOT } from '../helpers.mjs';

export const DEFAULT_INPUT = {
    question: 'Pick your hackathon setup',
    items: ['Pizza', 'Coffee', 'Whiteboard', 'Standing desk']
};

let hostJs;
async function hostBundle() {
    hostJs ??= (
        await build({
            entryPoints: [join(ROOT, 'test', 'ui', 'host.ts')],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            write: false,
            logLevel: 'silent'
        })
    ).outputFiles[0].text;
    return hostJs;
}

/** Launch Chromium, or return undefined (with a reason) when none is available. */
export async function launchBrowser() {
    const executablePath = await findChromium();
    if (!executablePath) {
        return { reason: 'no Chromium found: set CHROMIUM_PATH or run `npx playwright-core install chromium-headless-shell`' };
    }
    const { chromium } = await import('playwright-core');
    try {
        return { browser: await chromium.launch({ executablePath }), executablePath };
    } catch (e) {
        return { reason: `Chromium at ${executablePath} failed to launch: ${e.message.split('\n')[0]}` };
    }
}

/**
 * Open the Dialog Lab in a fresh page. Returns helpers to drive it plus the
 * MCP client (so tests can read server state) and a close() function.
 */
export async function openDialogLab(browser, { theme = 'light', toolInput = DEFAULT_INPUT, viewport = { width: 760, height: 1000 } } = {}) {
    const { client } = makeClient('modern', { name: 'ui-test-host' });
    const conn = await connectStdio(client);
    const res = await client.readResource({ uri: 'ui://feature-test/dialog-lab.html' });
    const appHtml = res.contents[0].text;

    const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('callTool', p => client.callTool(p));
    const inline = v => JSON.stringify(v).replace(/</g, '\\u003c');
    // addInitScript did not deliver the app HTML together with setContent, so it is inlined as JSON.
    await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${theme === 'dark' ? '#111214' : '#e9ebef'}}` +
            `iframe{display:block;width:100%;height:${viewport.height}px;border:0}</style></head><body>` +
            `<iframe id="app" sandbox="allow-scripts allow-forms"></iframe>` +
            `<script>window.appHtml=${inline(appHtml)};window.hostConfig=${inline({ theme, toolInput })}</script>` +
            `<script type="module">${await hostBundle()}</script></body></html>`
    );
    await page.waitForFunction(() => window.hostReady === true, null, { timeout: 10_000 });
    const app = page.frameLocator('#app');
    // Wait until the tool input has been applied inside the app.
    await app.locator('#question', { hasText: toolInput.question }).waitFor({ timeout: 10_000 });

    return {
        page,
        app,
        client,
        errors,
        hostEvents: () => page.evaluate(() => window.hostEvents),
        async waitForHostEvent(type) {
            await page.waitForFunction(t => window.hostEvents.some(e => e.type === t), type, { timeout: 5000 });
            return (await page.evaluate(t => window.hostEvents.filter(e => e.type === t), type)).at(-1);
        },
        async draw() {
            const box = await app.locator('#sketch').boundingBox();
            await page.mouse.move(box.x + 30, box.y + 40);
            await page.mouse.down();
            for (let i = 0; i <= 30; i++) await page.mouse.move(box.x + 30 + i * 20, box.y + 80 + Math.sin(i / 3) * 50);
            await page.mouse.up();
        },
        async close() {
            await context.close();
            await conn.close();
        }
    };
}

/** Fill the dialog with demo answers (used for tests and screenshots). */
export async function fillDemoAnswers(lab) {
    const { app } = lab;
    await app.locator('#stars button').nth(4).click();
    await app.locator('#color').evaluate(el => {
        el.value = '#e11d48';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await app.locator('#level').evaluate(el => {
        el.value = '85';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await app.locator('#rank li').nth(2).locator('button', { hasText: '↑' }).click(); // Whiteboard ↑
    await app.locator('#comment').fill('Works in headless Chromium');
    await lab.draw();
}

/**
 * Open the pick_color colour picker the way a host would: call pick_color
 * (model side), then render the ui:// resource with that tool input and result.
 * `unsupported` lists host methods left unhandled (→ "Method not found").
 */
export async function openColorPicker(browser, { theme = 'light', args = { prompt: 'Favourite colour?', initial: '#336699' }, unsupported = [] } = {}) {
    const { client } = makeClient('modern', { name: 'ui-test-host' });
    const conn = await connectStdio(client);
    const toolResult = await client.callTool({ name: 'pick_color', arguments: args });
    const res = await client.readResource({ uri: 'ui://feature-test/color-picker.html' });
    const appHtml = res.contents[0].text;

    const viewport = { width: 560, height: 420 };
    const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('callTool', p => client.callTool(p));
    const inline = v => JSON.stringify(v).replace(/</g, '\\u003c');
    await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${theme === 'dark' ? '#111214' : '#e9ebef'}}` +
            `iframe{display:block;width:100%;height:${viewport.height}px;border:0}</style></head><body>` +
            `<iframe id="app" sandbox="allow-scripts allow-forms"></iframe>` +
            `<script>window.appHtml=${inline(appHtml)};window.hostConfig=${inline({ theme, toolInput: args, toolResult, unsupported })}</script>` +
            `<script type="module">${await hostBundle()}</script></body></html>`
    );
    await page.waitForFunction(() => window.hostReady === true, null, { timeout: 10_000 });
    const app = page.frameLocator('#app');
    // OK is enabled once the tool result (with the requestId) has been applied.
    await app.locator('#ok:not([disabled])').waitFor({ timeout: 10_000 });

    return {
        page,
        app,
        client,
        errors,
        requestId: toolResult.structuredContent.requestId,
        hostEvents: () => page.evaluate(() => window.hostEvents),
        async waitForHostEvent(type) {
            await page.waitForFunction(t => window.hostEvents.some(e => e.type === t), type, { timeout: 5000 });
            return (await page.evaluate(t => window.hostEvents.filter(e => e.type === t), type)).at(-1);
        },
        async close() {
            await context.close();
            await conn.close();
        }
    };
}
