// Shared helpers for the node:test suites. Everything runs against the built
// output in dist/ (`npm test` builds first).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = join(ROOT, 'dist');

if (!existsSync(join(DIST, 'stdio.js')) || !existsSync(join(DIST, 'ui', 'dialog-lab.html'))) {
    throw new Error('dist/ is missing – run `npm run build` first (npm test does this automatically).');
}

export const MODERN = '2026-07-28';
export const UI_EXT = 'io.modelcontextprotocol/ui';
export const APP_MIME = 'text/html;profile=mcp-app';
export const ERAS = ['modern', 'legacy'];

/** Capabilities of a fully featured client (form + URL elicitation + MCP Apps). */
export const FULL_CAPS = {
    elicitation: { form: {}, url: {} },
    extensions: { [UI_EXT]: { mimeTypes: [APP_MIME] } }
};

export const textOf = r => (r?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

export function versionNegotiation(era) {
    return era === 'legacy' ? { mode: 'legacy' } : { mode: { pin: MODERN } };
}

/**
 * A test client with a scripted "user". `answer(params)` decides how each
 * elicitation dialog is answered; the default accepts with sensible values.
 */
export function makeClient(era, { name = 'node-test', capabilities = FULL_CAPS, answer = defaultAnswer } = {}) {
    const client = new Client({ name, version: '0.0.1' }, { capabilities, versionNegotiation: versionNegotiation(era) });
    const dialogs = [];
    const completions = [];
    if (capabilities?.elicitation) {
        client.setRequestHandler('elicitation/create', async req => {
            dialogs.push(req.params);
            return answer(req.params);
        });
    }
    client.setNotificationHandler('notifications/elicitation/complete', n => {
        completions.push(n.params);
    });
    return { client, dialogs, completions };
}

/** Accept every dialog with plausible content; URL-mode dialogs "submit" the browser page first. */
export async function defaultAnswer(p) {
    if (p.mode === 'url') {
        await submitFlowPage(p.url, 'sk-test-123456');
        return { action: 'accept' };
    }
    const props = p.requestedSchema?.properties ?? {};
    if ('confirm' in props) return { action: 'accept', content: { confirm: true } };
    if ('nickname' in props) return { action: 'accept', content: { nickname: 'Tester' } };
    if ('mood' in props) return { action: 'accept', content: { mood: '🙂 fine' } };
    if ('size' in props) return { action: 'accept', content: { name: 'Ada', size: 'large', crust: 'thin' } };
    if ('toppings' in props) return { action: 'accept', content: { toppings: ['basil', 'olives'], notes: 'extra crispy' } };
    // all-field-types form: accept the defaults, add the required e-mail
    const content = Object.fromEntries(Object.entries(props).filter(([, s]) => 'default' in s).map(([k, s]) => [k, s.default]));
    if ('email' in props) content.email = 'ada@example.org';
    return { action: 'accept', content };
}

export async function submitFlowPage(url, token) {
    const res = await fetch(url, {
        method: 'POST',
        body: `token=${encodeURIComponent(token)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    if (!res.ok) throw new Error(`flow page answered ${res.status}`);
    return res.text();
}

// ------------------------------------------------------------------ logs

/** Collects stderr of a child; with LOG_FORMAT=json each line is a JSON event. */
export class LogCollector {
    constructor() {
        this.raw = '';
        this.waiters = [];
    }
    attach(stream) {
        stream.setEncoding('utf8');
        stream.on('data', d => {
            this.raw += d;
            for (const w of [...this.waiters]) w();
        });
    }
    get events() {
        return this.raw
            .split('\n')
            .filter(l => l.startsWith('{'))
            .map(l => {
                try {
                    return JSON.parse(l);
                } catch {
                    return undefined;
                }
            })
            .filter(Boolean);
    }
    find(pred) {
        return this.events.find(pred);
    }
    /** Resolve with the first event matching `pred` (rejects after `ms`). */
    waitFor(pred, ms = 5000) {
        return new Promise((resolve, reject) => {
            const check = () => {
                const e = this.find(pred);
                if (!e) return false;
                clearTimeout(timer);
                this.waiters = this.waiters.filter(w => w !== check);
                resolve(e);
                return true;
            };
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter(w => w !== check);
                reject(new Error(`timed out waiting for log event; stderr so far:\n${this.raw.slice(-2000)}`));
            }, ms);
            if (!check()) this.waiters.push(check);
        });
    }
}

// --------------------------------------------------------------- servers

// FLOW_WAIT_MS: keep the "accepted but page never submitted" tests short.
export const baseEnv = extra => ({ ...process.env, LOG_FORMAT: 'json', LOG_LEVEL: 'debug', FLOW_PORT: '0', FLOW_WAIT_MS: '1500', ...extra });

/** Spawn dist/stdio.js and connect `client` to it. */
export async function connectStdio(client, env = {}) {
    const logs = new LogCollector();
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(DIST, 'stdio.js')], env: baseEnv(env), stderr: 'pipe', cwd: ROOT });
    logs.attach(transport.stderr);
    await client.connect(transport);
    return { logs, close: () => client.close() };
}

/** Spawn dist/http.js on a free port. Resolves once it is listening. */
export async function startHttp(env = {}) {
    const child = spawn(process.execPath, [join(DIST, 'http.js')], {
        cwd: ROOT,
        env: baseEnv({ PORT: '0', ...env }),
        stdio: ['ignore', 'ignore', 'pipe']
    });
    const logs = new LogCollector();
    logs.attach(child.stderr);
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const listening = await Promise.race([
        logs.waitFor(e => e.event === 'http.listening', 10_000),
        exited.then(x => {
            throw new Error(`http server exited early (${JSON.stringify(x)}):\n${logs.raw}`);
        })
    ]);
    const base = `http://127.0.0.1:${listening.port}`;
    return {
        child,
        logs,
        exited,
        base,
        mcpUrl: `${base}/mcp`,
        async stop() {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            const t = setTimeout(() => child.kill('SIGKILL'), 5000);
            await exited;
            clearTimeout(t);
        }
    };
}

export async function connectHttp(client, mcpUrl, transportOptions = {}) {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), transportOptions));
    return { close: () => client.close() };
}

// --------------------------------------------------------------- browser

/**
 * Locate a Chromium binary for playwright-core. Order: $CHROMIUM_PATH,
 * Playwright's own download (~/.cache/ms-playwright or $PLAYWRIGHT_BROWSERS_PATH),
 * then common system locations. Returns undefined when nothing is found.
 */
export async function findChromium() {
    const fromEnv = process.env.CHROMIUM_PATH;
    if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
    try {
        const { chromium } = await import('playwright-core');
        const p = chromium.executablePath();
        if (p && existsSync(p)) return p;
    } catch {
        /* playwright-core missing or no matching revision */
    }
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
    const candidates = [];
    if (existsSync(cache)) {
        const dirs = readdirSync(cache)
            .filter(d => /^chromium(_headless_shell)?-\d+$/.test(d))
            .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
        for (const d of dirs) {
            for (const sub of safeReaddir(join(cache, d))) {
                candidates.push(
                    join(cache, d, sub, 'chrome-headless-shell'),
                    join(cache, d, sub, 'chrome'),
                    join(cache, d, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
                );
            }
        }
    }
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    return candidates.find(p => existsSync(p));
}

function safeReaddir(d) {
    try {
        return readdirSync(d);
    } catch {
        return [];
    }
}
