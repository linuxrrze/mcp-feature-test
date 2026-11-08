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

        // ui/download-file
        await app.locator('#download').click();
        await page.waitForTimeout(1500);
        r.notes.push(`download → ${await status()}`);
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
