#!/usr/bin/env node
/**
 * Playwright driver: runs the MCP feature-test scenarios in a running Open WebUI and
 * writes screenshots + a JSON report.
 *
 *   node openwebui/drive.mjs [scenario ...]        (default: all scenarios)
 *
 * Env:
 *   OWUI_URL      Open WebUI base URL            (default http://127.0.0.1:3602)
 *   OWUI_MODEL    model id to chat with          (default mcp-tester, created by setup.mjs)
 *   OWUI_SERVER_ID MCP tool server connection id (default featuretest; the elicitation modal is labelled with it)
 *   SHOT_DIR      screenshot directory           (default docs/images)
 *   SHOT_PREFIX   screenshot file prefix         (default openwebui-)
 *   REPORT        JSON report path               (default openwebui/out/report.json)
 *   PROBES        elicit_format_probe variants, comma-separated (default: all six)
 *   UPLOAD_SIZES  dialog_lab_files upload sizes in bytes (default 102400,1048576,10485760)
 *   X_FILE_SIZES  upload_file_experimental generated file sizes in bytes (default 102400,1048576)
 *   CHROME        browser binary (default: Playwright's chromium headless shell 1248 in ~/.cache/ms-playwright)
 *   HEADED=1      use the full chromium build with a window (needs a display)
 *
 * Requires: the stack from openwebui/start.sh (Open WebUI with WEBUI_AUTH=False, fake LLM,
 * MCP server registered as tool server id "featuretest", model "mcp-tester").
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASE = process.env.OWUI_URL ?? 'http://127.0.0.1:3602';
const MODEL = process.env.OWUI_MODEL ?? 'mcp-tester';
const SERVER_ID = process.env.OWUI_SERVER_ID ?? 'featuretest';
const SHOT_DIR = resolve(process.env.SHOT_DIR ?? join(root, 'docs/images'));
const PREFIX = process.env.SHOT_PREFIX ?? 'openwebui-';
const REPORT = resolve(process.env.REPORT ?? join(here, 'out/report.json'));
const pw = join(process.env.HOME ?? '', '.cache/ms-playwright');
const CHROME =
    process.env.CHROME ??
    (process.env.HEADED
        ? join(pw, 'chromium-1248/chrome-linux64/chrome')
        : join(pw, 'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'));

mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync(dirname(REPORT), { recursive: true });

const report = { startedAt: new Date().toISOString(), base: BASE, model: MODEL, scenarios: {} };

const browser = await chromium.launch({ executablePath: existsSync(CHROME) ? CHROME : undefined, headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
// Keep the "What's new" changelog modal from showing up (it only shows when the stored version differs).
const page = await context.newPage();
page.setDefaultTimeout(30000);

async function shot(name, opts = {}) {
    const p = join(SHOT_DIR, `${PREFIX}${name}.png`);
    await page.screenshot({ path: p, ...opts });
    return p;
}

async function dismissPopups() {
    for (let i = 0; i < 3; i++) {
        const modal = page.locator('[role=dialog][aria-modal=true]');
        if (!(await modal.count())) return;
        const label = (await modal.first().getAttribute('aria-label')) ?? '';
        if (!/what.?s new|changelog|update/i.test(label)) return;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
    }
}

async function newChat(prompt) {
    await page.goto(`${BASE}/?models=${encodeURIComponent(MODEL)}`);
    await page.waitForSelector('#chat-input', { timeout: 60000 });
    await page.waitForTimeout(1200); // tool selection is applied asynchronously after load
    await dismissPopups();
    await page.click('#chat-input');
    await page.keyboard.type(prompt);
    await page.keyboard.press('Enter');
}

/** The Open WebUI elicitation modal is a Modal whose aria-label is the MCP server id. */
const elicitDialog = () => page.locator(`[role=dialog][aria-label="${SERVER_ID}"]`);

async function waitForText(text, timeout = 30000) {
    await page.getByText(text, { exact: false }).last().waitFor({ timeout });
}

async function lastAssistantText() {
    return page.evaluate(() => {
        const els = document.querySelectorAll('#messages-container .chat-assistant, #messages-container [class*="assistant"]');
        const el = els[els.length - 1];
        return (el ?? document.querySelector('#messages-container'))?.innerText ?? '';
    });
}

async function run(name, fn) {
    const r = { ok: false, notes: [], shots: [] };
    report.scenarios[name] = r;
    const t0 = Date.now();
    try {
        await fn(r);
        r.ok = true;
    } catch (e) {
        r.error = String(e?.message ?? e).split('\n')[0];
        try {
            r.shots.push(await shot(`${name}-error`));
        } catch {
            /* ignore */
        }
    }
    r.ms = Date.now() - t0;
    console.error(`${r.ok ? 'PASS' : 'FAIL'} ${name} (${r.ms} ms)${r.error ? ` – ${r.error}` : ''}`);
}

/** URL-mode elicitation: click the link in Open WebUI's dialog, complete the page in the popup. */
async function urlFlow(r, tool, shotName) {
    await newChat(`call ${tool}`);
    const outcome = await Promise.race([
        elicitDialog().waitFor().then(() => 'dialog'),
        waitForText('Tool result:').then(() => 'result')
    ]);
    if (outcome === 'result') {
        r.notes.push(`no dialog: ${(await lastAssistantText()).slice(0, 400)}`);
        return;
    }
    const popupPromise = context.waitForEvent('page', { timeout: 10000 });
    await elicitDialog().locator('a').first().click(); // Open WebUI answers "accept" on click
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await popup.setViewportSize({ width: 800, height: 600 });
    r.shots.push(join(SHOT_DIR, `${PREFIX}${shotName}-page.png`));
    await popup.screenshot({ path: r.shots.at(-1) });
    r.notes.push(`dialog open after click: ${(await elicitDialog().count()) > 0}`);
    await popup.locator('input[name=token]').fill('sk-test-123');
    await popup.locator('button[type=submit]').click();
    await popup.waitForLoadState();
    await popup.close();
    await waitForText('Tool result:', 60000);
    await page.waitForTimeout(500);
    r.shots.push(await shot(`${shotName}-result`));
    r.notes.push((await lastAssistantText()).slice(0, 400));
}


/** The inline MCP App iframe Open WebUI renders under a tool call (titled with the tool name). */
async function appFrame(tool) {
    const iframe = page.locator(`iframe[title="${tool}"]`).last();
    await iframe.waitFor({ timeout: 30000 });
    return { iframe, app: page.frameLocator(`iframe[title="${tool}"]`).last() };
}

/** Open WebUI asks before every app → server tools/call; answer it (optionally screenshot it first). */
async function confirmToolCall(r, shotName, button = 'Confirm') {
    const confirm = page.locator('[role=dialog][aria-label="Tool call"]');
    await confirm.waitFor({ timeout: 15000 });
    if (shotName) r.shots.push(await shot(shotName));
    r.notes.push(`tool-call confirm: ${(await confirm.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
    await confirm.getByRole('button', { name: button }).click();
}

/** Open WebUI asks before an app's ui/message is sent; answer it. */
async function confirmPrompt(r, shotName) {
    const cp = page.locator('[role=dialog][aria-label="Confirm Prompt from Embed"]');
    await cp.waitFor({ timeout: 15000 });
    if (shotName) r.shots.push(await shot(shotName));
    r.notes.push(`prompt confirm: ${(await cp.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
    await cp.getByRole('button', { name: 'Confirm' }).click();
}

/** What the last assistant message shows besides text: images, audio, file chips, links. */
async function describeLastMessage() {
    return page.evaluate(() => {
        const all = document.querySelectorAll('#messages-container .chat-assistant, #messages-container [class*="assistant"]');
        const el = all[all.length - 1] ?? document.querySelector('#messages-container');
        if (!el) return {};
        return {
            images: [...el.querySelectorAll('img')].map(i => `${(i.getAttribute('src') ?? '').slice(0, 40)}… ${i.naturalWidth}x${i.naturalHeight}`),
            audio: [...el.querySelectorAll('audio, video')].map(a => `${a.tagName} ${(a.getAttribute('src') ?? a.querySelector('source')?.getAttribute('src') ?? '').slice(0, 40)}`),
            links: [...el.querySelectorAll('a')].map(a => `${a.innerText.trim().slice(0, 40)} → ${(a.getAttribute('href') ?? '').slice(0, 60)}`),
            buttons: [...el.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).slice(0, 20)
        };
    });
}

/** Expand the collapsed "View Result from …" tool-call block(s) so the raw result is visible. */
async function expandToolCalls() {
    for (const t of await page.getByText('View Result from', { exact: false }).all()) await t.click().catch(() => {});
    await page.waitForTimeout(800);
}

/** One elicit_format_probe variant in a fresh chat: what is rendered, what comes back. */
async function formatProbe(r, variant, { fill, shotName } = {}) {
    await newChat(`call elicit_format_probe {"variant":"${variant}"}`);
    const outcome = await Promise.race([elicitDialog().waitFor().then(() => 'dialog'), waitForText('Tool result:').then(() => 'result')]);
    if (outcome === 'result') {
        r.notes.push(`${variant}: no dialog → ${(await lastAssistantText()).slice(0, 300)}`);
        return;
    }
    await page.waitForTimeout(300);
    const d = elicitDialog();
    const fields = await d.locator('input, select, textarea').evaluateAll(els =>
        els.map(e => `${e.tagName.toLowerCase()}[type=${e.getAttribute('type') ?? ''}${e.getAttribute('pattern') ? ` pattern=${e.getAttribute('pattern')}` : ''}${e.getAttribute('placeholder') ? ` placeholder="${e.getAttribute('placeholder')}"` : ''}] value="${e.value}"`)
    );
    const buttons = (await d.getByRole('button').allInnerTexts()).map(b => b.trim()).filter(Boolean);
    const unsupported = (await d.getByText('Unsupported input format').count()) > 0;
    r.notes.push(`${variant}: fields ${JSON.stringify(fields)}; buttons ${JSON.stringify(buttons)}${unsupported ? '; "Unsupported input format"' : ''}`);
    if (shotName) r.shots.push(await shot(shotName));
    if (fill) await fill(d);
    const submit = d.getByRole('button', { name: 'Submit' });
    if (await submit.count()) {
        await submit.click();
        await page.waitForTimeout(1200);
        if (await d.count()) {
            const invalid = await d.locator(':invalid').evaluateAll(els => els.map(e => e.validationMessage).filter(Boolean));
            r.notes.push(`${variant}: dialog still open after Submit (browser validation: ${JSON.stringify(invalid)}); cancelling`);
            await d.getByRole('button', { name: 'Cancel' }).click();
        }
    } else {
        await d.getByRole('button', { name: 'Decline' }).click();
    }
    await waitForText('Tool result:', 30000);
    const t = await lastAssistantText();
    r.notes.push(`${variant}: ${t.slice(t.indexOf('Tool result:'), t.indexOf('Tool result:') + 600).replace(/\s+/g, ' ')}`);
}

/** Pick a file of `bytes` random bytes in the Dialog Lab and upload it; returns the upload status line. */
async function labUpload(r, app, bytes, { shotName, timeout = 120000 } = {}) {
    const name = `probe-${bytes}.bin`;
    await app.locator('#file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(bytes, 0x5a) });
    const t0 = Date.now();
    await app.locator('#upload').click();
    const confirm = page.locator('[role=dialog][aria-label="Tool call"]');
    const first = await Promise.race([
        confirm.waitFor({ timeout: 20000 }).then(() => 'confirm'),
        app.locator('#uploadStatus.err, #uploadStatus.ok').waitFor({ timeout: 20000 }).then(() => 'status')
    ]).catch(() => 'nothing');
    if (first === 'confirm') await confirmToolCall(r, shotName);
    await app.locator('#uploadStatus.err, #uploadStatus.ok').waitFor({ timeout }).catch(() => {});
    const status = (await app.locator('#uploadStatus').innerText()).trim();
    r.notes.push(`upload ${bytes} B (${first}, ${Date.now() - t0} ms): ${status.slice(0, 400)}`);
    return status;
}

const scenarios = {
    async inspect_client(r) {
        await newChat('call inspect_client');
        await waitForText('Tool result:');
        r.shots.push(await shot('inspect-client'));
        r.notes.push((await lastAssistantText()).slice(0, 800));
    },

    async elicit_confirm(r) {
        await newChat('call elicit_confirm {"item":"report-2026.pdf"}');
        await elicitDialog().waitFor();
        r.shots.push(await shot('elicit-confirm-dialog'));
        await elicitDialog().locator('select').first().selectOption({ label: 'Yes' });
        await elicitDialog().getByRole('button', { name: 'Submit' }).click();
        await waitForText('Tool result:');
        await page.waitForTimeout(500);
        r.shots.push(await shot('elicit-confirm-result'));
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async elicit_confirm_decline(r) {
        await newChat('call elicit_confirm');
        await elicitDialog().waitFor();
        await elicitDialog().getByRole('button', { name: 'Decline' }).click();
        await waitForText('Tool result:');
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async elicit_all_field_types(r) {
        await newChat('call elicit_all_field_types {"variant":"all"}');
        await elicitDialog().waitFor();
        await page.waitForTimeout(300);
        r.shots.push(await shot('elicit-all-fields-dialog'));
        // The modal scrolls; capture the full form element too.
        const form = elicitDialog().locator('form');
        r.shots.push(await form.screenshot({ path: join(SHOT_DIR, `${PREFIX}elicit-all-fields-form.png`) }).then(() => join(SHOT_DIR, `${PREFIX}elicit-all-fields-form.png`)));
        // Fill every empty text-like input (some are required, e.g. the e-mail field).
        const samples = { email: 'ada@example.org', url: 'https://example.org/ada', date: '2026-11-08', number: '7', text: 'Ada Lovelace' };
        for (const input of await elicitDialog().locator('input').all()) {
            const type = (await input.getAttribute('type')) ?? 'text';
            const placeholder = (await input.getAttribute('placeholder')) ?? '';
            if ((await input.inputValue()) !== '') continue;
            const value = placeholder.startsWith('YYYY-MM-DDT') ? '2026-11-09T10:00:00Z' : samples[type];
            if (value) await input.fill(value);
        }
        r.shots.push(await shot('elicit-all-fields-filled'));
        await elicitDialog().getByRole('button', { name: 'Submit' }).click();
        // Browser-side validation (required/format) may block submit; record what happens.
        await page.waitForTimeout(1500);
        if (await elicitDialog().count()) {
            r.notes.push('dialog still open after Submit (client-side validation?)');
            r.shots.push(await shot('elicit-all-fields-after-submit'));
            await elicitDialog().getByRole('button', { name: 'Cancel' }).click();
        }
        await waitForText('Tool result:');
        r.notes.push((await lastAssistantText()).slice(0, 1200));
    },

    async elicit_parallel(r) {
        await newChat('call elicit_parallel');
        await elicitDialog().first().waitFor();
        await page.waitForTimeout(800);
        r.notes.push(`dialogs visible at once: ${await elicitDialog().count()}`);
        r.shots.push(await shot('elicit-parallel-dialog'));
        for (let i = 0; i < 4 && (await elicitDialog().count()); i++) {
            const d = elicitDialog().first();
            const input = d.locator('input[type=text]');
            if (await input.count()) await input.first().fill('Tester');
            const sel = d.locator('select');
            if (await sel.count()) await sel.first().selectOption({ index: 1 });
            await d.getByRole('button', { name: 'Submit' }).click();
            await page.waitForTimeout(800);
        }
        await waitForText('Tool result:');
        r.notes.push((await lastAssistantText()).slice(0, 600));
    },

    async elicit_wizard(r) {
        await newChat('call elicit_wizard');
        for (let step = 1; step <= 4; step++) {
            const d = elicitDialog();
            try {
                await d.waitFor({ timeout: 15000 });
            } catch {
                break;
            }
            await page.waitForTimeout(300);
            r.shots.push(await shot(`elicit-wizard-step${step}`));
            const text = d.locator('input[type=text]');
            if (await text.count()) await text.first().fill('Ada');
            const multi = d.locator('select[multiple]');
            if (await multi.count()) await multi.first().selectOption([{ index: 0 }, { index: 1 }]);
            for (const s of await d.locator('select:not([multiple])').all()) {
                const v = await s.inputValue().catch(() => '');
                if (!v || v === 'undefined') await s.selectOption({ index: 1 });
            }
            await d.getByRole('button', { name: 'Submit' }).click();
            await page.waitForTimeout(1000);
        }
        await waitForText('Tool result:');
        r.shots.push(await shot('elicit-wizard-result'));
        r.notes.push((await lastAssistantText()).slice(0, 600));
    },

    async elicit_url(r) {
        await newChat('call elicit_url');
        await elicitDialog().waitFor();
        r.shots.push(await shot('elicit-url-dialog'));
        r.notes.push(`link: ${await elicitDialog().locator('a').first().getAttribute('href')}`);
        // Do not open the link; cancel so the tool finishes.
        await elicitDialog().getByRole('button', { name: 'Cancel' }).click();
        await waitForText('Tool result:', 60000);
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async elicit_url_accept(r) {
        await urlFlow(r, 'elicit_url', 'elicit-url');
    },

    async elicit_url_legacy_push(r) {
        await urlFlow(r, 'elicit_url_legacy_push', 'elicit-url-legacy-push');
    },

    async slow_task(r) {
        await newChat('call slow_task');
        await page.waitForTimeout(2500);
        r.shots.push(await shot('slow-task-running'));
        await waitForText('Tool result:', 90000);
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async open_dialog_lab(r) {
        await newChat('call open_dialog_lab');
        const iframe = page.locator('iframe[title="open_dialog_lab"]');
        await iframe.waitFor({ timeout: 30000 });
        const app = page.frameLocator('iframe[title="open_dialog_lab"]');
        await app.locator('#submit').waitFor({ timeout: 30000 });
        await page.waitForTimeout(1500);
        await iframe.scrollIntoViewIfNeeded();
        r.shots.push(await shot('mcp-app-dialog-lab'));
        r.shots.push(
            await iframe.screenshot({ path: join(SHOT_DIR, `${PREFIX}mcp-app-dialog-lab-frame.png`) }).then(() => join(SHOT_DIR, `${PREFIX}mcp-app-dialog-lab-frame.png`))
        );
        const status = async () => ((await app.locator('#status').innerText().catch(() => '')) || '').trim();
        const debug = async () => ((await app.locator('#debug').innerText().catch(() => '')) || '').trim();

        // tools/call from the app → Open WebUI asks the user to confirm first.
        await app.locator('#submit').click();
        const confirm = page.locator('[role=dialog][aria-label="Tool call"]');
        await confirm.waitFor({ timeout: 10000 });
        r.shots.push(await shot('mcp-app-toolcall-confirm'));
        await confirm.getByRole('button', { name: 'Confirm' }).click();
        await page.waitForTimeout(2500);
        r.notes.push(`submit → ${await status()}`);

        // ui/update-model-context
        await app.locator('#context').click();
        await page.waitForTimeout(1500);
        r.notes.push(`context → ${await status()}`);

        // ui/request-display-mode
        await app.locator('#fullscreen').click();
        await page.waitForTimeout(1500);
        r.notes.push(`fullscreen → ${await status()}`);

        // ui/download-file: the buttons are disabled unless the host advertises downloadFile.
        r.notes.push(`download buttons disabled: ${await app.locator('#download').isDisabled()}`);
        r.shots.push(await shot('mcp-app-after-actions'));

        // ui/message → confirmation, then the text is submitted as a new user prompt.
        await app.locator('#chat').click();
        const cp = page.locator('[role=dialog][aria-label="Confirm Prompt from Embed"]');
        await cp.waitFor({ timeout: 10000 });
        r.shots.push(await shot('mcp-app-message-confirm'));
        await cp.getByRole('button', { name: 'Confirm' }).click();
        await page.waitForTimeout(3000);
        r.notes.push(`chat → ${await status()}`);
        r.notes.push(`app debug log:\n${(await debug()).slice(-1500)}`);
        r.shots.push(await shot('mcp-app-after-message'));
    },
    async pick_color(r) {
        await newChat('call pick_color {"prompt":"Accent colour for the new logo?","initial":"#22c55e"}');
        const { iframe, app } = await appFrame('pick_color');
        await app.locator('#ok:not([disabled])').waitFor({ timeout: 30000 });
        await page.waitForTimeout(800);
        await iframe.scrollIntoViewIfNeeded();
        r.shots.push(await shot('pick-color'));
        await app.locator('#presets button[data-color="#e11d48"], #presets button[data-color="#ec4899"]').first().click();
        await app.locator('#ok').click();
        await confirmToolCall(r, 'pick-color-toolcall-confirm'); // pick_color_submit
        await confirmPrompt(r, 'pick-color-message-confirm'); // ui/message after ui/update-model-context
        // The fake LLM answers the "I picked …" message with a pick_color_result call.
        await waitForText('The user picked #', 30000);
        await page.waitForTimeout(800);
        const report = async () => (await app.locator('#report').innerText().catch(() => '')).replace(/\s+/g, ' ');
        r.notes.push(`picker report: ${await report()}`);
        r.notes.push(`picker status: ${(await app.locator('#status').innerText().catch(() => '')).trim()}`);
        r.notes.push(`picker debug:\n${(await app.locator('#debug').textContent().catch(() => '')).slice(0, 1500)}`);
        r.shots.push(await shot('pick-color-result'));
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async pick_color_cancel(r) {
        // Cancel in the picker with "Also tell the assistant" unchecked: only pick_color_submit
        // reaches the server; the model learns about it with pick_color_result on the next turn.
        await newChat('call pick_color {"prompt":"Background colour?"}');
        const { app } = await appFrame('pick_color');
        await app.locator('#cancel:not([disabled])').waitFor({ timeout: 30000 });
        await app.locator('#tell').uncheck();
        await app.locator('#cancel').click();
        await confirmToolCall(r);
        await app.locator('#r-context[data-state="skip"], #r-context[data-state="err"], #r-context[data-state="ok"]').waitFor({ timeout: 15000 });
        await page.waitForTimeout(500);
        r.notes.push(`picker report: ${(await app.locator('#report').innerText()).replace(/\s+/g, ' ')}`);
        r.notes.push(`prompt dialog shown: ${(await page.locator('[role=dialog][aria-label="Confirm Prompt from Embed"]').count()) > 0}`);
        await page.click('#chat-input');
        await page.keyboard.type('call pick_color_result');
        await page.keyboard.press('Enter');
        await waitForText('The user cancelled', 30000);
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async pick_color_deny(r) {
        // The user refuses Open WebUI's "Tool call" confirmation: what does the app get?
        await newChat('call pick_color {"prompt":"Deny test"}');
        const { app } = await appFrame('pick_color');
        await app.locator('#ok:not([disabled])').waitFor({ timeout: 30000 });
        await app.locator('#tell').uncheck();
        await app.locator('#ok').click();
        await confirmToolCall(r, undefined, 'Cancel');
        await app.locator('#r-context[data-state="skip"], #r-context[data-state="err"], #r-context[data-state="ok"]').waitFor({ timeout: 15000 });
        await page.waitForTimeout(500);
        r.notes.push(`picker report: ${(await app.locator('#report').innerText()).replace(/\s+/g, ' ')}`);
        r.notes.push(`picker status: ${(await app.locator('#status').innerText()).trim()}`);
        // Nothing was delivered, so the picker unlocks: try again and confirm this time.
        await app.locator('#ok:not([disabled])').waitFor({ timeout: 5000 });
        await app.locator('#ok').click();
        await confirmToolCall(r);
        await app.locator('#status.ok').waitFor({ timeout: 15000 });
        r.notes.push(`retry: ${(await app.locator('#report').innerText()).replace(/\s+/g, ' ')}`);
    },

    async pick_color_features(r) {
        // The richer picker inside Open WebUI's sandbox: size, Recent from earlier answers, wheel drag,
        // EyeDropper availability, the file chooser + image sampling, opacity → #rrggbbaa.
        await newChat('call pick_color {"prompt":"Overlay colour (with opacity)?","initial":"#336699"}');
        const { iframe, app } = await appFrame('pick_color');
        await app.locator('#ok:not([disabled])').waitFor({ timeout: 30000 });
        await page.waitForTimeout(800);
        const box = await iframe.boundingBox();
        r.notes.push(`iframe size: ${Math.round(box.width)}×${Math.round(box.height)}`);
        const env = await app.locator('body').evaluate(() => {
            let storage;
            try {
                localStorage.setItem('x', '1');
                storage = 'localStorage works';
            } catch (e) {
                storage = `localStorage throws: ${e.name}`;
            }
            return {
                eyeDropper: typeof window.EyeDropper,
                storage,
                dpr: window.devicePixelRatio,
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
                bodyHeight: document.body.scrollHeight
            };
        });
        r.notes.push(`app environment: ${JSON.stringify(env)}`);
        r.notes.push(`recent from server: ${JSON.stringify(await app.locator('#recent button').evaluateAll(bs => bs.map(b => b.dataset.color)))}`);

        // Drag on the hue ring (from hue 210° to 120°): pointer events inside the iframe.
        const wheel = await app.locator('#wheel').boundingBox();
        const g = { cx: wheel.x + wheel.width / 2, cy: wheel.y + wheel.width / 2, r: wheel.width / 2 - 1 - Math.max(16, wheel.width * 0.09) / 2 };
        const at = h => [g.cx + g.r * Math.cos((h * Math.PI) / 180), g.cy - g.r * Math.sin((h * Math.PI) / 180)];
        await page.mouse.move(...at(210));
        await page.mouse.down();
        await page.mouse.move(...at(160), { steps: 5 });
        await page.mouse.move(...at(120), { steps: 5 });
        await page.mouse.up();
        r.notes.push(`after ring drag: hue ${await app.locator('#hue-handle').getAttribute('aria-valuenow')}, ${await app.locator('#hex').inputValue()}`);

        // Pick tab: EyeDropper message, then the real file chooser (does the sandbox allow it?).
        await app.locator('#tab-pick').click();
        await page.waitForTimeout(300);
        r.notes.push(`eyedropper: available=${await app.locator('#eyedropper-msg').getAttribute('data-available')} "${await app.locator('#eyedropper-msg').textContent()}"`);
        if (await app.locator('#eyedropper').isVisible()) {
            // Headless Chromium has no screen to pick from; this shows whether the sandbox lets the call through.
            await app.locator('#eyedropper').click();
            await page.waitForTimeout(1500);
            r.notes.push(`eyedropper click → "${await app.locator('#eyedropper-msg').textContent()}"`);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            r.notes.push(`after Escape → "${await app.locator('#eyedropper-msg').textContent()}"`);
        }
        const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        await app.locator('label[for=image-file]').click();
        const fc = await chooser;
        r.notes.push(`file chooser opened from the sandboxed iframe: ${!!fc}`);
        if (fc) {
            await fc.setFiles(join(root, 'docs/images/color-picker-palettes.png'));
            await app.locator('#image-canvas:not([hidden])').waitFor({ timeout: 10000 });
            const ib = await app.locator('#image-canvas').boundingBox();
            await page.mouse.click(ib.x + ib.width * 0.2, ib.y + ib.height * 0.25);
            r.notes.push(`sampled from the image: ${await app.locator('#hex').inputValue()} (image ${Math.round(ib.width)}×${Math.round(ib.height)})`);
        }
        await iframe.scrollIntoViewIfNeeded();
        r.shots.push(await shot('pick-color-pick-tab'));

        // Opacity 50 % → #rrggbbaa; message off, so only the server gets it (one confirmation).
        await app.locator('#tab-wheel').click();
        await app.locator('#alpha').fill('50');
        const hex = await app.locator('#hex').inputValue();
        r.notes.push(`with opacity: ${hex}`);
        await app.locator('#tell').uncheck();
        await app.locator('#ok').click();
        await confirmToolCall(r);
        await app.locator('#status.ok').waitFor({ timeout: 15000 });
        await page.click('#chat-input');
        await page.keyboard.type('call pick_color_result');
        await page.keyboard.press('Enter');
        await waitForText('The user picked #', 30000);
        r.notes.push((await lastAssistantText()).slice(0, 400));
    },

    async return_files(r) {
        await newChat('call return_files');
        await waitForText('Tool result:');
        await page.waitForTimeout(1500);
        r.shots.push(await shot('return-files'));
        r.notes.push(`message: ${JSON.stringify(await describeLastMessage())}`);
        await expandToolCalls();
        r.notes.push(`expanded: ${JSON.stringify(await describeLastMessage())}`);
        await page.getByText('View Result from', { exact: false }).last().scrollIntoViewIfNeeded();
        r.shots.push(await shot('return-files-expanded'));
        r.notes.push((await lastAssistantText()).slice(0, 1500));
    },

    async elicit_format_probe(r) {
        const variants = (process.env.PROBES ?? 'pattern,color,time,nested_object,free_array,file').split(',');
        // The data-url field starts empty; give it a value so the answer shows whether it is passed through.
        const fill = { file: d => d.locator('input').first().fill('data:text/plain;base64,aGVsbG8=') };
        for (const v of variants) {
            await formatProbe(r, v, { fill: fill[v], shotName: ['color', 'nested_object'].includes(v) ? `format-probe-${v.replace('_', '-')}` : undefined });
        }
    },

    async elicit_format_probe_all(r) {
        // All probes in one tool call (one input_required round each): Submit where possible, else Decline.
        await newChat('call elicit_format_probe {"variant":"all"}');
        for (let i = 0; i < 8; i++) {
            const shown = await Promise.race([elicitDialog().waitFor({ timeout: 20000 }).then(() => true), waitForText('Tool result:', 20000).then(() => false)]);
            if (!shown) break;
            await page.waitForTimeout(300);
            const d = elicitDialog();
            const submit = d.getByRole('button', { name: 'Submit' });
            await ((await submit.count()) ? submit : d.getByRole('button', { name: 'Decline' })).click();
            await page.waitForTimeout(800);
        }
        await waitForText('Tool result:', 30000);
        const t = await lastAssistantText();
        r.notes.push(t.slice(t.indexOf('Tool result:'), t.indexOf('Tool result:') + 1500).replace(/\s+/g, ' '));
    },

    async elicit_format_probe_pattern_invalid(r) {
        // A value that violates "pattern": blocked by the browser, by Open WebUI's validator, or sent?
        await formatProbe(r, 'pattern', {
            fill: async d => {
                const input = d.locator('input[type=text], input:not([type])').first();
                await input.fill('not-a-code');
            }
        });
    },

    async dialog_lab_files(r) {
        await newChat('call open_dialog_lab');
        const { iframe, app } = await appFrame('open_dialog_lab');
        await app.locator('#submit').waitFor({ timeout: 30000 });
        await page.waitForTimeout(1500);
        // Downloads: disabled unless the host advertises hostCapabilities.downloadFile.
        for (const id of ['download', 'downloadBlob', 'downloadLink']) r.notes.push(`#${id} disabled: ${await app.locator(`#${id}`).isDisabled()}`);
        r.notes.push(`download note: ${(await app.locator('#downloadNote').innerText()).trim()}`);
        const sizes = (process.env.UPLOAD_SIZES ?? '102400,1048576,10485760').split(',').map(Number);
        for (const [i, bytes] of sizes.entries()) await labUpload(r, app, bytes, { shotName: i === 0 ? 'dialog-lab-upload-confirm' : undefined });
        // Upload card (last result) plus the action row with the disabled download buttons.
        const card = app.locator('section:has(#file)');
        await card.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const a = await card.boundingBox();
        const b = await app.locator('#downloadNote').boundingBox();
        if (a && b) {
            const clip = { x: a.x - 8, y: a.y - 8, width: a.width + 16, height: b.y + b.height - a.y + 16 };
            r.shots.push(await shot('dialog-lab-files', { clip }));
        }
    },

    async upload_file_experimental(r) {
        // Small file typed inline by the "model", then generated ones (fake LLM expands $generateFile).
        const prompts = [
            'call upload_file_experimental {"file":{"id":"f1","name":"hello.txt","mimeType":"text/plain","size":5,"data":"aGVsbG8="}}',
            ...(process.env.X_FILE_SIZES ?? '102400,1048576').split(',').map(n => `call upload_file_experimental {"file":{"$generateFile":${Number(n)}}}`)
        ];
        for (const prompt of prompts) {
            await newChat(prompt);
            await waitForText('Tool result:', 120000);
            await page.waitForTimeout(500);
            const t = await lastAssistantText();
            r.notes.push(`${prompt.slice(0, 80)} → ${t.slice(t.indexOf('Tool result:'), t.indexOf('Tool result:') + 400).replace(/\s+/g, ' ')}`);
        }
    }
};

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(scenarios)) {
    if (wanted.length && !wanted.includes(name)) continue;
    await run(name, fn);
}

report.finishedAt = new Date().toISOString();
writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.error(`report: ${REPORT}`);
await browser.close();
process.exit(Object.values(report.scenarios).every(s => s.ok) ? 0 : 1);
