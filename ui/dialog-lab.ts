/**
 * Dialog Lab – browser side of the MCP App. Bundled by esbuild and inlined
 * into dialog-lab.html, which the server serves as the ui:// resource.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const log: string[] = [];
let lastToolInput: unknown = null;
let lastToolResult: unknown = null;
let rating = 4;
let items: string[] = ['Coffee', 'Music', 'Plants', 'Natural light', 'Second monitor'];

const app = new App({ name: 'dialog-lab', version: '1.0.0' }, {}, { autoResize: true });

function note(msg: string) {
    log.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
    log.length = Math.min(log.length, 30);
    renderDebug();
}

function setStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
    const el = $('status');
    el.textContent = msg;
    el.className = kind;
}

function renderDebug() {
    $('debug').textContent = JSON.stringify(
        {
            hostInfo: app.getHostVersion() ?? null,
            hostCapabilities: app.getHostCapabilities() ?? null,
            hostContext: app.getHostContext() ?? null,
            lastToolInput,
            lastToolResult,
            events: log
        },
        null,
        2
    );
}

function applyContext(ctx: Partial<McpUiHostContext> | undefined) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    const full = ctx.displayMode === 'fullscreen';
    $('fullscreen').textContent = full ? 'Exit fullscreen' : 'Fullscreen';
}

// ---------------------------------------------------------------- widgets
function renderStars() {
    const box = $('stars');
    box.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = '★';
        b.className = i <= rating ? 'on' : '';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(i === rating));
        b.setAttribute('aria-label', `${i} star${i > 1 ? 's' : ''}`);
        b.onclick = () => {
            rating = i;
            renderStars();
        };
        box.appendChild(b);
    }
}

function renderRank() {
    const ol = $('rank');
    ol.innerHTML = '';
    items.forEach((label, idx) => {
        const li = document.createElement('li');
        li.draggable = true;
        li.dataset.idx = String(idx);
        const span = document.createElement('span');
        span.textContent = label;
        const up = Object.assign(document.createElement('button'), { type: 'button', textContent: '↑', title: 'Move up' });
        const down = Object.assign(document.createElement('button'), { type: 'button', textContent: '↓', title: 'Move down' });
        up.onclick = () => move(idx, idx - 1);
        down.onclick = () => move(idx, idx + 1);
        li.append(span, up, down);
        li.addEventListener('dragstart', e => {
            li.classList.add('dragging');
            e.dataTransfer?.setData('text/plain', String(idx));
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', e => e.preventDefault());
        li.addEventListener('drop', e => {
            e.preventDefault();
            const from = Number(e.dataTransfer?.getData('text/plain'));
            move(from, idx);
        });
        ol.appendChild(li);
    });
}

function move(from: number, to: number) {
    if (Number.isNaN(from) || to < 0 || to >= items.length || from === to) return;
    const [x] = items.splice(from, 1);
    items.splice(to, 0, x);
    renderRank();
}

const canvas = $<HTMLCanvasElement>('sketch');
const g = canvas.getContext('2d')!;
let drawing = false;
let dirty = false;
function clearCanvas() {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    dirty = false;
}
function pos(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}
canvas.addEventListener('pointerdown', e => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    g.beginPath();
    g.moveTo(p.x, p.y);
});
canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    g.strokeStyle = ($('color') as HTMLInputElement).value;
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineTo(p.x, p.y);
    g.stroke();
    dirty = true;
});
canvas.addEventListener('pointerup', () => (drawing = false));
$('clear').onclick = clearCanvas;

const colorEl = $<HTMLInputElement>('color');
const levelEl = $<HTMLInputElement>('level');
colorEl.oninput = () => ($('swatch').style.background = colorEl.value);
levelEl.oninput = () => ($('levelOut').textContent = levelEl.value);
$<HTMLInputElement>('date').value = new Date().toISOString().slice(0, 10);

function collect(includeSketch = true) {
    return {
        question: $('question').textContent,
        color: colorEl.value,
        focusLevel: Number(levelEl.value),
        rating,
        startDate: $<HTMLInputElement>('date').value,
        ranking: [...items],
        comment: $<HTMLInputElement>('comment').value || null,
        ...(includeSketch && dirty ? { sketchPng: canvas.toDataURL('image/png') } : {})
    };
}

function describe(d: ReturnType<typeof collect>) {
    return (
        `My Dialog Lab answers for “${d.question}”:\n` +
        `• Colour: ${d.color}\n• Focus level: ${d.focusLevel}%\n• Rating: ${'★'.repeat(d.rating)}${'☆'.repeat(5 - d.rating)}\n` +
        `• Start date: ${d.startDate}\n• Ranking: ${d.ranking.map((x, i) => `${i + 1}. ${x}`).join(', ')}` +
        (d.comment ? `\n• Comment: ${d.comment}` : '') +
        (d.sketchPng ? '\n• (Sketch attached)' : '')
    );
}

async function guarded(label: string, fn: () => Promise<unknown>) {
    const buttons = document.querySelectorAll<HTMLButtonElement>('.actions button');
    buttons.forEach(b => (b.disabled = true));
    try {
        const r = await fn();
        note(`${label}: ok ${r ? JSON.stringify(r).slice(0, 200) : ''}`);
    } catch (e) {
        setStatus(`${label} failed: ${(e as Error).message}`, 'err');
        note(`${label}: ERROR ${(e as Error).message}`);
    } finally {
        buttons.forEach(b => (b.disabled = false));
        refreshDownloads();
    }
}

// ------------------------------------------------------------ downloads
let connected = false;

/** Download buttons only work when the host advertises hostCapabilities.downloadFile. */
function refreshDownloads() {
    const supported = !!app.getHostCapabilities()?.downloadFile;
    document.querySelectorAll<HTMLButtonElement>('.actions button.dl').forEach(b => (b.disabled = !supported));
    $('downloadNote').textContent = !connected
        ? 'Downloads: waiting for the host…'
        : supported
          ? 'Downloads: the host advertises downloadFile, so the three download buttons use ui/download-file (text resource, blob resource, resource_link).'
          : 'Downloads disabled: the host did not advertise hostCapabilities.downloadFile, so ui/download-file would fail (Open WebUI 0.13.2, for example, answers "Method not found").';
}

async function offerDownload(contents: Parameters<typeof app.downloadFile>[0]['contents'], what: string) {
    const r = await app.downloadFile({ contents });
    if (r.isError) throw new Error('host refused the download');
    setStatus(`✅ Download offered by the host (${what}).`, 'ok');
    return r;
}

// --------------------------------------------------------------- upload
const fileEl = $<HTMLInputElement>('file');
const uploadBtn = $<HTMLButtonElement>('upload');
fileEl.onchange = () => (uploadBtn.disabled = !fileEl.files?.length);

function setUploadStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
    const el = $('uploadStatus');
    el.textContent = msg;
    el.className = kind;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1024 * 1024)).toFixed(2)} MiB`);

function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const url = String(reader.result ?? '');
            resolve(url.slice(url.indexOf(',') + 1)); // strip "data:<type>;base64,"
        };
        reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
        reader.readAsDataURL(file);
    });
}

/** Local SHA-256 for comparison; crypto.subtle needs a secure context, so this may be unavailable. */
async function localSha256(file: File): Promise<string | undefined> {
    try {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return undefined;
    }
}

uploadBtn.onclick = async () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    const started = performance.now();
    try {
        setUploadStatus(`Reading ${file.name} (${fmtBytes(file.size)})…`);
        const data = await readAsBase64(file);
        setUploadStatus(`Uploading ${file.name}: ${fmtBytes(file.size)} as ${fmtBytes(data.length)} of base64…`);
        const res = await app.callServerTool({ name: 'dialog_lab_upload', arguments: { name: file.name, mimeType: file.type, data } });
        const first = res.content?.[0];
        const msg = first && first.type === 'text' ? first.text : JSON.stringify(res.content);
        if (res.isError) throw new Error(msg);
        const sc = (res.structuredContent ?? {}) as { size?: number; sha256?: string };
        const local = await localSha256(file);
        const check =
            sc.size !== file.size
                ? ` ⚠ size differs from the local file (${file.size} bytes).`
                : local === undefined
                  ? ' Size matches (local SHA-256 unavailable in this frame).'
                  : local === sc.sha256
                    ? ' Size and SHA-256 match the local file.'
                    : ` ⚠ SHA-256 differs from the local file (${local}).`;
        setUploadStatus(`✅ ${msg}${check} (${Math.round(performance.now() - started)} ms)`, sc.size === file.size && (!local || local === sc.sha256) ? 'ok' : 'err');
        note(`tools/call dialog_lab_upload: ok ${sc.size} bytes`);
    } catch (e) {
        setUploadStatus(`Upload of ${file.name} (${fmtBytes(file.size)}) failed: ${(e as Error).message}`, 'err');
        note(`tools/call dialog_lab_upload: ERROR ${(e as Error).message.slice(0, 200)}`);
    } finally {
        uploadBtn.disabled = !fileEl.files?.length;
    }
};

// ------------------------------------------------------------- actions
$('submit').onclick = () =>
    guarded('tools/call dialog_lab_submit', async () => {
        const res = await app.callServerTool({ name: 'dialog_lab_submit', arguments: { data: collect() } });
        if (res.isError) throw new Error(JSON.stringify(res.content));
        const first = res.content?.[0];
        setStatus(`✅ ${first && first.type === 'text' ? first.text : 'Stored.'} Ask the assistant to read it (dialog_lab_results).`, 'ok');
        return res.structuredContent;
    });

$('chat').onclick = () =>
    guarded('ui/message', async () => {
        const d = collect();
        const content: { type: 'text'; text: string }[] = [{ type: 'text', text: describe(d) }];
        const r = await app.sendMessage({ role: 'user', content });
        if (r.isError) throw new Error('host rejected the message');
        setStatus('✅ Sent to the chat as a user message.', 'ok');
        return r;
    });

$('context').onclick = () =>
    guarded('ui/update-model-context', async () => {
        const d = collect(false);
        const r = await app.updateModelContext({ content: [{ type: 'text', text: describe(d) }], structuredContent: d });
        setStatus('✅ Model context updated (the assistant sees it with your next message).', 'ok');
        return r;
    });

$('fullscreen').onclick = () =>
    guarded('ui/request-display-mode', async () => {
        const cur = app.getHostContext()?.displayMode;
        const r = await app.requestDisplayMode({ mode: cur === 'fullscreen' ? 'inline' : 'fullscreen' });
        setStatus(`Display mode is now: ${r.mode}`, 'ok');
        applyContext({ displayMode: r.mode });
        return r;
    });

$('download').onclick = () =>
    guarded('ui/download-file', async () => {
        const json = JSON.stringify(collect(), null, 2);
        return offerDownload([{ type: 'resource', resource: { uri: 'file:///dialog-lab-answers.json', mimeType: 'application/json', text: json } }], 'JSON text');
    });

$('downloadBlob').onclick = () =>
    guarded('ui/download-file (blob)', async () => {
        const blob = canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
        return offerDownload([{ type: 'resource', resource: { uri: 'file:///dialog-lab-sketch.png', mimeType: 'image/png', blob } }], 'PNG blob');
    });

$('downloadLink').onclick = () =>
    guarded('ui/download-file (resource_link)', async () =>
        offerDownload(
            [{ type: 'resource_link', uri: 'test://files/sample.pdf', name: 'sample.pdf', title: 'Sample PDF', mimeType: 'application/pdf' }],
            'resource_link to test://files/sample.pdf, which the host must read from the server'
        )
    );

// ------------------------------------------------- host → app events
// Register handlers BEFORE connect() so one-shot notifications aren't missed.
app.ontoolinput = params => {
    lastToolInput = params;
    const args = (params.arguments ?? {}) as { question?: string; items?: string[] };
    if (args.question) $('question').textContent = args.question;
    if (Array.isArray(args.items) && args.items.length) {
        items = args.items.map(String);
        renderRank();
    }
    note('ui/notifications/tool-input');
};
app.ontoolinputpartial = () => note('ui/notifications/tool-input-partial');
app.ontoolresult = params => {
    lastToolResult = params;
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
app.onteardown = async () => {
    note('ui/resource-teardown');
    return {};
};

renderStars();
renderRank();
clearCanvas();
refreshDownloads();
$('swatch').style.background = colorEl.value;

app
    .connect()
    .then(() => {
        connected = true;
        refreshDownloads();
        applyContext(app.getHostContext());
        note('connected (ui/initialize done)');
    })
    .catch(e => {
        setStatus(`Could not connect to the host: ${(e as Error).message}`, 'err');
        $('debug').textContent = `Not running inside an MCP Apps host?\n${String(e)}`;
    });
