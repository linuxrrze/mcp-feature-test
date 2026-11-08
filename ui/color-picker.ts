/**
 * Colour picker – browser side of the pick_color MCP App. Bundled by esbuild
 * and inlined into color-picker.html (see scripts/build-ui.mjs).
 *
 * The pick_color tool call has already returned when this UI is shown, so the
 * answer goes back in later steps, each attempted and reported separately:
 *   1. tools/call pick_color_submit (app-only)  → server stores it (pick_color_result)
 *   2. ui/update-model-context                  → model sees it on the next turn
 *   3. ui/message (optional, checkbox)          → a user message starts the next turn
 * Model context is sent before the message so that the turn the message starts
 * already sees it.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

const HEX = /^#[0-9a-fA-F]{6}$/;
const PRESETS = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#4f46e5', '#a855f7', '#ec4899', '#111827', '#9ca3af', '#ffffff'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const colorEl = $<HTMLInputElement>('color');
const hexEl = $<HTMLInputElement>('hex');
const okBtn = $<HTMLButtonElement>('ok');
const cancelBtn = $<HTMLButtonElement>('cancel');
const tellEl = $<HTMLInputElement>('tell');

let requestId: string | null = null;
let prompt = 'Pick a colour';
let answered = false;
const events: string[] = [];
let lastToolInput: unknown = null;
let lastToolResult: unknown = null;

const app = new App({ name: 'color-picker', version: '1.0.0' }, {}, { autoResize: true });

function note(msg: string) {
    events.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
    events.length = Math.min(events.length, 20);
    $('debug').textContent = JSON.stringify(
        { requestId, prompt, hostInfo: app.getHostVersion() ?? null, hostCapabilities: app.getHostCapabilities() ?? null, lastToolInput, lastToolResult, events },
        null,
        2
    );
}

function setStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
    const el = $('status');
    el.textContent = msg;
    el.className = kind;
}

function report(id: 'server' | 'context' | 'message', state: 'ok' | 'err' | 'skip', msg: string) {
    const li = $(`r-${id}`);
    li.dataset.state = state;
    li.querySelector('b')!.textContent = msg;
}

function applyContext(ctx: Partial<McpUiHostContext> | undefined) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function current(): string | null {
    const v = hexEl.value.trim();
    return HEX.test(v) ? v.toLowerCase() : null;
}

function refresh() {
    const c = current();
    hexEl.setAttribute('aria-invalid', String(c === null));
    if (c) $('preview').style.background = c;
    document.querySelectorAll<HTMLButtonElement>('#presets button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === c)));
    okBtn.disabled = answered || !requestId || !c;
    cancelBtn.disabled = answered || !requestId;
}

function setColor(c: string) {
    colorEl.value = c.toLowerCase();
    hexEl.value = c.toLowerCase();
    refresh();
}

colorEl.addEventListener('input', () => setColor(colorEl.value));
hexEl.addEventListener('input', () => {
    const c = current();
    if (c) colorEl.value = c;
    refresh();
});
for (const c of PRESETS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', title: c });
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute('aria-label', c);
    b.onclick = () => setColor(c);
    $('presets').appendChild(b);
}

const isMethodNotFound = (e: unknown) => (e as { code?: number })?.code === -32601 || /method not found/i.test(String((e as Error)?.message ?? e));

async function answer(action: 'accept' | 'cancel') {
    if (!requestId || answered) return;
    const color = action === 'accept' ? current() : null;
    if (action === 'accept' && !color) return;
    answered = true;
    for (const el of [colorEl, hexEl, tellEl]) el.disabled = true;
    document.querySelectorAll<HTMLButtonElement>('#presets button').forEach(b => (b.disabled = true));
    refresh();
    $('report').hidden = false;
    const sentence = action === 'accept' ? `I picked ${color} for: ${prompt}` : `I cancelled the colour picker for: ${prompt}`;
    setStatus(action === 'accept' ? `You picked ${color}. Sending…` : 'Cancelled. Sending…');

    // 1. Server (app-only tool)
    try {
        const res = await app.callServerTool({ name: 'pick_color_submit', arguments: { requestId, color, action } });
        const t = res.content?.find(c => c.type === 'text');
        const msg = t && t.type === 'text' ? t.text : '';
        if (res.isError) report('server', 'err', msg || 'error');
        else report('server', 'ok', 'stored');
        note(`tools/call pick_color_submit: ${res.isError ? 'ERROR ' : ''}${msg}`);
    } catch (e) {
        report('server', 'err', (e as Error).message);
        note(`tools/call pick_color_submit: ${(e as Error).message}`);
    }

    // 2. Model context
    try {
        await app.updateModelContext({
            content: [{ type: 'text', text: sentence }],
            structuredContent: { requestId, prompt, action, color }
        });
        report('context', 'ok', 'updated');
        note('ui/update-model-context: ok');
    } catch (e) {
        if (isMethodNotFound(e)) report('context', 'skip', 'not supported by host');
        else report('context', 'err', (e as Error).message);
        note(`ui/update-model-context: ${(e as Error).message}`);
    }

    // 3. Chat message
    if (!tellEl.checked) {
        report('message', 'skip', 'skipped (checkbox off)');
    } else {
        try {
            const r = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: sentence }] });
            if (r.isError) report('message', 'err', 'rejected by host');
            else report('message', 'ok', 'sent');
            note(`ui/message: ${r.isError ? 'rejected' : 'ok'}`);
        } catch (e) {
            if (isMethodNotFound(e)) report('message', 'skip', 'not supported by host');
            else report('message', 'err', (e as Error).message);
            note(`ui/message: ${(e as Error).message}`);
        }
    }

    const delivered = ['server', 'context', 'message'].some(id => $(`r-${id}`).dataset.state === 'ok');
    setStatus(
        (action === 'accept' ? `✅ You picked ${color}.` : 'Cancelled.') + (delivered ? '' : ' The answer could not be delivered (see below).'),
        delivered ? 'ok' : 'err'
    );
}

okBtn.onclick = () => void answer('accept');
cancelBtn.onclick = () => void answer('cancel');

// ------------------------------------------------- host → app events
// Registered before connect() so one-shot notifications aren't missed.
function applyArgs(a: { prompt?: unknown; initial?: unknown; requestId?: unknown } | undefined) {
    if (!a) return;
    if (typeof a.prompt === 'string' && a.prompt) {
        prompt = a.prompt;
        $('prompt').textContent = prompt;
    }
    if (typeof a.initial === 'string' && HEX.test(a.initial) && !answered) setColor(a.initial);
    if (typeof a.requestId === 'string' && a.requestId) requestId = a.requestId;
}

app.ontoolinput = params => {
    lastToolInput = params;
    applyArgs(params.arguments as Record<string, unknown> | undefined);
    refresh();
    note('ui/notifications/tool-input');
};
app.ontoolresult = params => {
    lastToolResult = params;
    applyArgs(params.structuredContent as Record<string, unknown> | undefined);
    if (requestId) setStatus(answered ? $('status').textContent ?? '' : '');
    else setStatus('The tool result carries no requestId; the answer cannot be sent.', 'err');
    refresh();
    note('ui/notifications/tool-result');
};
app.ontoolcancelled = () => {
    setStatus('The host cancelled the tool call.', 'err');
    note('ui/notifications/tool-cancelled');
};
app.onhostcontextchanged = ctx => {
    applyContext(ctx);
    note(`host-context-changed ${Object.keys(ctx).join(',')}`);
};
app.onteardown = async () => ({});

refresh();
app.connect()
    .then(() => {
        applyContext(app.getHostContext());
        note('connected (ui/initialize done)');
    })
    .catch(e => {
        setStatus(`Could not connect to the host: ${(e as Error).message}`, 'err');
        $('debug').textContent = `Not running inside an MCP Apps host?\n${String(e)}`;
    });
