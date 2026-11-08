/**
 * Colour picker – browser side of the pick_color MCP App. Bundled by esbuild
 * and inlined into color-picker.html (see scripts/build-ui.mjs).
 *
 * Modes (tab bar): Wheel (hue ring + rotating S/V triangle, the default),
 * Classic (S/V square + hue slider), Values (RGB/HSL/HSV/alpha numbers and
 * sliders), Pick (EyeDropper API when the browser has it, the system colour
 * dialog, sampling from a local image), Palettes. Shared: current/previous
 * pair, hex field, presets, opacity, Recent (seeded from the server, because
 * the sandboxed iframe usually has no usable storage).
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
import {
    clamp,
    cssHsl,
    cssRgb,
    formatHex,
    HEX_COLOR,
    hslToHsv,
    hsvToHsl,
    hsvToRgb,
    hueAt,
    parseHex,
    pointAtHue,
    rgbToHsv,
    svToTrianglePoint,
    triangleVertices,
    trianglePointToSv,
    type Hsv,
    type Rgb
} from '../src/colorMath.js';

const PRESETS = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#111827', '#ffffff'];
const MAX_RECENT = 10;

/** Original palettes: 3 rows × 10, each row a ramp between two HSL colours (hue may wrap past 360). */
type Ramp = [h1: number, s1: number, l1: number, h2: number, s2: number, l2: number];
const PALETTE_DEFS: [name: string, rows: Ramp[]][] = [
    ['Harvest', [[350, 0.75, 0.12, 410, 0.9, 0.72], [205, 0.45, 0.14, 95, 0.45, 0.78], [330, 0.6, 0.22, 450, 0.55, 0.92]]],
    ['Tidepool', [[215, 0.6, 0.12, 185, 0.65, 0.8], [170, 0.45, 0.18, 120, 0.4, 0.85], [30, 0.35, 0.25, 45, 0.6, 0.9]]],
    ['Spectrum', [[0, 0.85, 0.35, 324, 0.85, 0.35], [0, 0.9, 0.55, 324, 0.9, 0.55], [0, 0.95, 0.78, 324, 0.95, 0.78]]],
    ['Neutrals', [[0, 0, 0, 0, 0, 1], [30, 0.12, 0.1, 40, 0.18, 0.92], [215, 0.14, 0.1, 210, 0.2, 0.92]]]
];
const PALETTES: { name: string; colors: string[] }[] = PALETTE_DEFS.map(([name, rows]) => ({
    name,
    colors: rows.flatMap(([h1, s1, l1, h2, s2, l2]) =>
        Array.from({ length: 10 }, (_, i) => {
            const t = i / 9;
            const hsv = hslToHsv({ h: (h1 + (h2 - h1) * t) % 360, s: s1 + (s2 - s1) * t, l: l1 + (l2 - l1) * t });
            return formatHex(hsvToRgb(hsv));
        })
    )
}));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const okBtn = $<HTMLButtonElement>('ok');
const cancelBtn = $<HTMLButtonElement>('cancel');
const tellEl = $<HTMLInputElement>('tell');
const hexEl = $<HTMLInputElement>('hex');
const colorEl = $<HTMLInputElement>('color');
const alphaEl = $<HTMLInputElement>('alpha');
const pickerEl = $<HTMLFieldSetElement>('picker');

// ------------------------------------------------------------- state
/** The colour: HSV keeps the hue while saturation or value is 0 (the wheel needs that); alpha 0..1. */
const state: Hsv & { a: number } = { h: 245, s: 0.7, v: 0.9, a: 1 };
let previous = '#4f46e5';
let recent: string[] = [];
let tab = 'wheel';
let hexInvalid = false;
let touched = false; // the user changed the colour; a late tool result must not reset it

let requestId: string | null = null;
let prompt = 'Pick a colour';
let answered = false;
const events: string[] = [];
let lastToolInput: unknown = null;
let lastToolResult: unknown = null;

const rgb = (): Rgb => hsvToRgb(state);
const currentHex = () => formatHex({ ...rgb(), a: state.a });
const opaqueCss = () => formatHex(rgb());

const app = new App({ name: 'color-picker', version: '2.0.0' }, {}, { autoResize: true });

function note(msg: string) {
    events.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
    events.length = Math.min(events.length, 20);
    $('debug').textContent = JSON.stringify(
        { requestId, prompt, color: currentHex(), recent, hostInfo: app.getHostVersion() ?? null, hostCapabilities: app.getHostCapabilities() ?? null, lastToolInput, lastToolResult, events },
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

// ------------------------------------------------------- set colour
interface SetOpts {
    /** Element that caused the change: not rewritten while the user types in it. */
    from?: Element | null;
    /** A finished choice (drag end, swatch click, typed value): goes into Recent. */
    commit?: boolean;
}

function setHsv(c: Partial<Hsv & { a: number }>, o: SetOpts = {}) {
    if (answered) return;
    if (c.h !== undefined) state.h = ((c.h % 360) + 360) % 360;
    if (c.s !== undefined) state.s = clamp(c.s);
    if (c.v !== undefined) state.v = clamp(c.v);
    if (c.a !== undefined) state.a = clamp(c.a);
    touched = true;
    if (o.from !== hexEl) hexInvalid = false;
    render(o.from);
    if (o.commit) addRecent(currentHex());
}

/** Set from RGB(A); the hue (and saturation) survive when the colour has none (grey, black). */
function setRgb(c: Rgb & { a?: number }, o: SetOpts = {}) {
    const hsv = rgbToHsv(c);
    const keepHue = hsv.s === 0 || hsv.v === 0;
    setHsv({ h: keepHue ? state.h : hsv.h, s: hsv.v === 0 ? state.s : hsv.s, v: hsv.v, a: c.a }, o);
}

/** Set from #rrggbb[aa]; `keepAlpha` keeps the current opacity (swatches, eyedropper). */
function setHex(hex: string, o: SetOpts & { keepAlpha?: boolean } = {}) {
    const c = parseHex(hex);
    if (!c) return false;
    setRgb({ r: c.r, g: c.g, b: c.b, a: o.keepAlpha ? undefined : c.a }, o);
    return true;
}

function addRecent(hex: string) {
    recent = [hex, ...recent.filter(c => c !== hex)].slice(0, MAX_RECENT);
    renderRecent();
}

// ------------------------------------------------------------ render
let drawQueued = false;
let drawnHue = NaN;

function render(from?: Element | null) {
    const hex = currentHex();
    const c = { ...rgb(), a: Math.round(state.a * 255) / 255 }; // what the hex (and the server) will say
    const solid = opaqueCss();
    $('current').querySelector('span')!.style.background = cssRgb(c);
    $('current').setAttribute('aria-label', `Current colour ${hex}`);
    $('previous').querySelector('span')!.style.background = previous;
    $('previous').setAttribute('aria-label', `Previous colour ${previous}: click to swap`);
    if (from !== hexEl) {
        hexEl.value = hex;
        hexInvalid = false;
    }
    hexEl.setAttribute('aria-invalid', String(hexInvalid));
    $('css-rgb').textContent = cssRgb(c);
    $('out-rgb').textContent = cssRgb(c);
    $('out-hsl').textContent = cssHsl(c);
    if (from !== colorEl) colorEl.value = solid;

    // opacity
    const pct = Math.round(state.a * 100);
    if (from !== alphaEl) alphaEl.value = String(pct);
    $('alpha-out').textContent = `${pct}%`;
    alphaEl.style.background = `linear-gradient(to right, ${solid}00, ${solid}), var(--checker)`;
    alphaEl.style.setProperty('--thumb', cssRgb(c));
    alphaEl.setAttribute('aria-valuetext', `${pct}%`);

    // wheel + square handles
    positionWheelHandles();
    positionSquareHandle();
    const hueRange = $<HTMLInputElement>('hue-range');
    if (from !== hueRange) hueRange.value = String(Math.round(state.h) % 360);
    hueRange.style.setProperty('--thumb', `hsl(${state.h} 100% 50%)`);
    if (state.h !== drawnHue) queueDraw();

    renderChannels(from);
    for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-color]')) {
        const dc = b.dataset.color!;
        b.setAttribute('aria-pressed', String(dc === hex || (b.dataset.keepAlpha === '1' && dc === solid)));
    }
    refreshButtons();
}

function refreshButtons() {
    okBtn.disabled = answered || !requestId || hexInvalid;
    cancelBtn.disabled = answered || !requestId;
}

function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
        drawQueued = false;
        drawWheel();
        drawSquare();
    });
}

// ------------------------------------------------- wheel (ring + triangle)
const wheelEl = $('wheel');
const wheelCanvas = $<HTMLCanvasElement>('wheel-canvas');
const hueHandle = $('hue-handle');
const triHandle = $('tri-handle');
let ringCache: { px: number; data: Uint8ClampedArray } | null = null;

/** Geometry in CSS pixels for a wheel of `size` px. */
function wheelGeometry(size: number) {
    const outer = size / 2 - 1;
    const thickness = Math.max(16, size * 0.09);
    const inner = outer - thickness;
    return { c: size / 2, outer, inner, mid: (outer + inner) / 2, tri: inner - Math.max(6, size * 0.025) };
}

function buildRing(px: number, dpr: number): Uint8ClampedArray {
    const g = wheelGeometry(px / dpr);
    const data = new Uint8ClampedArray(px * px * 4);
    const c = g.c * dpr;
    const ro = g.outer * dpr;
    const ri = g.inner * dpr;
    for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
            const dx = x + 0.5 - c;
            const dy = y + 0.5 - c;
            const d = Math.sqrt(dx * dx + dy * dy);
            const cover = Math.min(d - ri + 0.5, ro - d + 0.5);
            if (cover <= 0) continue;
            const { r, g: gg, b } = hsvToRgb({ h: hueAt(dx, dy, 0, 0), s: 1, v: 1 });
            const i = (y * px + x) * 4;
            data[i] = r;
            data[i + 1] = gg;
            data[i + 2] = b;
            data[i + 3] = Math.min(1, cover) * 255;
        }
    }
    return data;
}

function drawWheel() {
    const size = wheelEl.clientWidth;
    if (!size) return; // hidden tab
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    if (wheelCanvas.width !== px || wheelCanvas.height !== px) {
        wheelCanvas.width = wheelCanvas.height = px;
    }
    if (ringCache?.px !== px) ringCache = { px, data: buildRing(px, dpr) };
    const img = new ImageData(new Uint8ClampedArray(ringCache.data), px, px);
    const d = img.data;
    const g = wheelGeometry(size);
    const t = triangleVertices(g.c * dpr, g.c * dpr, g.tri * dpr, state.h);
    // Barycentric weights per pixel, with signed distances to the edges for anti-aliasing.
    const { hue: A, white: B, black: C } = t;
    const det = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    const altitude = 1.5 * g.tri * dpr; // equilateral: distance from a vertex to the opposite edge
    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)) - 1);
    const x1 = Math.min(px - 1, Math.ceil(Math.max(A.x, B.x, C.x)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)) - 1);
    const y1 = Math.min(px - 1, Math.ceil(Math.max(A.y, B.y, C.y)) + 1);
    const pure = hsvToRgb({ h: state.h, s: 1, v: 1 });
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const fx = x + 0.5;
            const fy = y + 0.5;
            const wa = ((B.y - C.y) * (fx - C.x) + (C.x - B.x) * (fy - C.y)) / det;
            const wb = ((C.y - A.y) * (fx - C.x) + (A.x - C.x) * (fy - C.y)) / det;
            const wc = 1 - wa - wb;
            const cover = Math.min(wa, wb, wc) * altitude + 0.5;
            if (cover <= 0) continue;
            const h = clamp(wa);
            const v = clamp(h + clamp(wb));
            // hsv(h, s=h/v, v) = v·white + h·(pure − white) in linear 8-bit terms
            const i = (y * px + x) * 4;
            d[i] = (v - h) * 255 + h * pure.r;
            d[i + 1] = (v - h) * 255 + h * pure.g;
            d[i + 2] = (v - h) * 255 + h * pure.b;
            d[i + 3] = Math.min(1, cover) * 255;
        }
    }
    wheelCanvas.getContext('2d')!.putImageData(img, 0, 0);
    drawnHue = state.h;
    positionWheelHandles();
}

function positionWheelHandles() {
    const size = wheelEl.clientWidth;
    const hue = Math.round(state.h) % 360;
    hueHandle.setAttribute('aria-valuenow', String(hue));
    hueHandle.setAttribute('aria-valuetext', `${hue}°`);
    const sv = `saturation ${Math.round(state.s * 100)}%, brightness ${Math.round(state.v * 100)}%`;
    triHandle.setAttribute('aria-valuenow', String(Math.round(state.s * 100)));
    triHandle.setAttribute('aria-valuetext', sv);
    hueHandle.style.background = `hsl(${state.h} 100% 50%)`;
    triHandle.style.background = opaqueCss();
    if (!size) return;
    const g = wheelGeometry(size);
    const p = pointAtHue(state.h, g.c, g.c, g.mid);
    hueHandle.style.transform = `translate(${p.x}px, ${p.y}px)`;
    const q = svToTrianglePoint(state.s, state.v, triangleVertices(g.c, g.c, g.tri, state.h));
    triHandle.style.transform = `translate(${q.x}px, ${q.y}px)`;
}

/** Shared drag plumbing: pointer capture, a fixed target per drag, commit on release. */
function draggable(el: HTMLElement, start: (x: number, y: number) => ((x: number, y: number) => void) | null) {
    el.addEventListener('pointerdown', e => {
        if (answered || e.button > 0) return;
        const r = el.getBoundingClientRect();
        const move = start(e.clientX - r.left, e.clientY - r.top);
        if (!move) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        move(e.clientX - r.left, e.clientY - r.top);
        const onMove = (ev: PointerEvent) => {
            const rr = el.getBoundingClientRect();
            move(ev.clientX - rr.left, ev.clientY - rr.top);
        };
        const onUp = () => {
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            if (!answered) addRecent(currentHex());
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    });
}

draggable(wheelEl, (x, y) => {
    const g = wheelGeometry(wheelEl.clientWidth);
    const d = Math.hypot(x - g.c, y - g.c);
    if (d > g.outer + 6) return null;
    if (d >= g.inner - 4) {
        hueHandle.focus({ preventScroll: true });
        return (mx, my) => setHsv({ h: hueAt(mx, my, g.c, g.c) });
    }
    triHandle.focus({ preventScroll: true });
    return (mx, my) => {
        const t = triangleVertices(g.c, g.c, g.tri, state.h);
        setHsv(trianglePointToSv({ x: mx, y: my }, t));
    };
});

/** Arrow keys on a 2-D handle: left/right saturation, up/down brightness (Shift: ×10). */
function svKeys(e: KeyboardEvent) {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const k: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (e.key === 'Home') return setHsv({ s: 0 }, { commit: true }), e.preventDefault();
    if (e.key === 'End') return setHsv({ s: 1 }, { commit: true }), e.preventDefault();
    if (!k[e.key]) return;
    e.preventDefault();
    setHsv({ s: state.s + k[e.key][0], v: state.v + k[e.key][1] }, { commit: !e.repeat });
}

hueHandle.addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 30, PageDown: -30 };
    if (e.key === 'Home') return setHsv({ h: 0 }, { commit: true }), e.preventDefault();
    if (delta[e.key] === undefined) return;
    e.preventDefault();
    setHsv({ h: Math.round(state.h) + delta[e.key] }, { commit: !e.repeat });
});
triHandle.addEventListener('keydown', svKeys);

// --------------------------------------------- classic (S/V square + hue)
const squareEl = $('square');
const squareCanvas = $<HTMLCanvasElement>('square-canvas');
const sqHandle = $('sq-handle');

function drawSquare() {
    const w = squareEl.clientWidth;
    const h = squareEl.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    squareCanvas.width = Math.round(w * dpr);
    squareCanvas.height = Math.round(h * dpr);
    const ctx = squareCanvas.getContext('2d')!;
    const W = squareCanvas.width;
    const H = squareCanvas.height;
    ctx.fillStyle = formatHex(hsvToRgb({ h: state.h, s: 1, v: 1 }));
    ctx.fillRect(0, 0, W, H);
    const white = ctx.createLinearGradient(0, 0, W, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, W, H);
    const black = ctx.createLinearGradient(0, 0, 0, H);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, W, H);
    positionSquareHandle();
}

function positionSquareHandle() {
    sqHandle.style.background = opaqueCss();
    sqHandle.setAttribute('aria-valuenow', String(Math.round(state.s * 100)));
    sqHandle.setAttribute('aria-valuetext', `saturation ${Math.round(state.s * 100)}%, brightness ${Math.round(state.v * 100)}%`);
    const w = squareEl.clientWidth;
    const h = squareEl.clientHeight;
    if (w) sqHandle.style.transform = `translate(${state.s * w}px, ${(1 - state.v) * h}px)`;
}

draggable(squareEl, () => {
    sqHandle.focus({ preventScroll: true });
    return (x, y) => setHsv({ s: x / squareEl.clientWidth, v: 1 - y / squareEl.clientHeight });
});
sqHandle.addEventListener('keydown', svKeys);
$<HTMLInputElement>('hue-range').addEventListener('input', e => setHsv({ h: Number((e.target as HTMLInputElement).value) }, { from: e.target as Element }));
$<HTMLInputElement>('hue-range').addEventListener('change', () => addRecent(currentHex()));

// ---------------------------------------------------- values (numbers)
interface Channel {
    id: string;
    label: string;
    max: number;
    get(): number;
    set(n: number): void;
    track(): string;
}
const hsl = () => hsvToHsl(state);
const rgbStops = (f: (t: number) => Rgb, n = 2) => Array.from({ length: n }, (_, i) => formatHex(f(i / (n - 1)))).join(', ');
const hueStops = (f: (h: number) => Rgb) => rgbStops(t => f(t * 360), 7);
const setRgbChannel = (k: 'r' | 'g' | 'b', n: number) => setRgb({ ...rgb(), [k]: n });
const rgbTrack = (k: 'r' | 'g' | 'b') => `linear-gradient(to right, ${rgbStops(t => ({ ...rgb(), [k]: t * 255 }))})`;
const GROUPS: [string, Channel[]][] = [
    [
        'RGB',
        (['r', 'g', 'b'] as const).map(k => ({
            id: k,
            label: k.toUpperCase(),
            max: 255,
            get: () => Math.round(rgb()[k]),
            set: n => setRgbChannel(k, n),
            track: () => rgbTrack(k)
        }))
    ],
    [
        'HSL',
        [
            { id: 'hsl-h', label: 'H', max: 359, get: () => Math.round(state.h) % 360, set: n => setHsv({ h: n }), track: () => `linear-gradient(to right, ${hueStops(h => hsvToRgb(hslToHsv({ ...hsl(), h })))})` },
            { id: 'hsl-s', label: 'S', max: 100, get: () => Math.round(hsl().s * 100), set: n => setHsv(hslToHsv({ ...hsl(), s: n / 100 })), track: () => `linear-gradient(to right, ${rgbStops(t => hsvToRgb(hslToHsv({ ...hsl(), s: t })))})` },
            { id: 'hsl-l', label: 'L', max: 100, get: () => Math.round(hsl().l * 100), set: n => setHsv(hslToHsv({ ...hsl(), l: n / 100 })), track: () => `linear-gradient(to right, ${rgbStops(t => hsvToRgb(hslToHsv({ ...hsl(), l: t })), 3)})` }
        ]
    ],
    [
        'HSV',
        [
            { id: 'hsv-h', label: 'H', max: 359, get: () => Math.round(state.h) % 360, set: n => setHsv({ h: n }), track: () => `linear-gradient(to right, ${hueStops(h => hsvToRgb({ ...state, h }))})` },
            { id: 'hsv-s', label: 'S', max: 100, get: () => Math.round(state.s * 100), set: n => setHsv({ s: n / 100 }), track: () => `linear-gradient(to right, ${rgbStops(t => hsvToRgb({ ...state, s: t }))})` },
            { id: 'hsv-v', label: 'V', max: 100, get: () => Math.round(state.v * 100), set: n => setHsv({ v: n / 100 }), track: () => `linear-gradient(to right, ${rgbStops(t => hsvToRgb({ ...state, v: t }))})` }
        ]
    ],
    ['Alpha', [{ id: 'a', label: 'A', max: 100, get: () => Math.round(state.a * 100), set: n => setHsv({ a: n / 100 }), track: () => `linear-gradient(to right, ${opaqueCss()}00, ${opaqueCss()}), var(--checker)` }]]
];
const channelEls: { ch: Channel; range: HTMLInputElement; num: HTMLInputElement }[] = [];

function buildChannels() {
    const box = $('channels');
    for (const [name, chans] of GROUPS) {
        const fs = document.createElement('fieldset');
        fs.className = 'group';
        fs.innerHTML = `<legend>${name}${name === 'Alpha' ? ' %' : ''}</legend>`;
        for (const ch of chans) {
            const label = Object.assign(document.createElement('label'), { textContent: ch.label, htmlFor: `ch-${ch.id}` });
            const range = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: String(ch.max), step: '1', className: 'track thin', id: `ch-${ch.id}-range`, tabIndex: -1 });
            range.setAttribute('aria-hidden', 'true');
            const num = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: String(ch.max), step: '1', id: `ch-${ch.id}`, inputMode: 'numeric' });
            num.setAttribute('aria-label', `${name} ${ch.label}`);
            const apply = (el: HTMLInputElement, commit: boolean) => {
                const n = Number(el.value);
                if (el.value === '' || !Number.isFinite(n)) return;
                ch.set(clamp(Math.round(n), 0, ch.max));
                render(el);
                if (commit) addRecent(currentHex());
            };
            range.addEventListener('input', () => apply(range, false));
            range.addEventListener('change', () => apply(range, true));
            num.addEventListener('input', () => apply(num, false));
            num.addEventListener('change', () => {
                apply(num, true);
                num.value = String(ch.get());
            });
            fs.append(label, range, num);
            channelEls.push({ ch, range, num });
        }
        box.appendChild(fs);
    }
}

function renderChannels(from?: Element | null) {
    if (tab !== 'values') return;
    for (const { ch, range, num } of channelEls) {
        const v = String(ch.get());
        if (from !== range) range.value = v;
        if (from !== num && document.activeElement !== num) num.value = v;
        range.style.background = ch.track();
    }
}

// ------------------------------------------------------- pick (sampling)
const eyeBtn = $<HTMLButtonElement>('eyedropper');
const eyeMsg = $('eyedropper-msg');
type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

function updateEyeDropper() {
    const ED = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    const ok = typeof ED === 'function';
    eyeBtn.hidden = !ok;
    eyeMsg.textContent = ok
        ? 'Click, then click anywhere on your screen to take its colour (EyeDropper API).'
        : 'Picking from the screen is not available here: this browser does not offer the EyeDropper API (only desktop Chrome, Edge and other Chromium browsers do). Load an image below or use the system colour dialog instead.';
    eyeMsg.dataset.available = String(ok);
}

eyeBtn.addEventListener('click', async () => {
    const ED = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!ED) return updateEyeDropper();
    try {
        const r = await new ED().open();
        const hex = HEX_COLOR.test(r.sRGBHex) ? r.sRGBHex : rgbStringToHex(r.sRGBHex);
        if (hex && setHex(hex, { keepAlpha: true, commit: true })) eyeMsg.textContent = `Picked ${hex.toLowerCase()} from the screen.`;
        note(`EyeDropper: ${r.sRGBHex}`);
    } catch (e) {
        const err = e as Error;
        eyeMsg.textContent = err.name === 'AbortError' ? 'Screen picking cancelled.' : `The host blocked screen picking: ${err.message}`;
        note(`EyeDropper: ${err.name} ${err.message}`);
    }
});

function rgbStringToHex(s: string): string | null {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
    return m ? formatHex({ r: +m[1], g: +m[2], b: +m[3] }) : null;
}

colorEl.addEventListener('input', () => setHex(colorEl.value, { keepAlpha: true, from: colorEl }));
colorEl.addEventListener('change', () => addRecent(currentHex()));

const imgCanvas = $<HTMLCanvasElement>('image-canvas');
const marker = $('image-marker');
const drop = $('drop');

async function loadImage(file: Blob | undefined | null) {
    if (!file) return;
    try {
        // createImageBitmap(Blob) never taints the canvas, even in an opaque-origin sandbox.
        const bmp = await createImageBitmap(file);
        const maxW = Math.max(120, drop.clientWidth - 24);
        const scale = Math.min(1, maxW / bmp.width, 280 / bmp.height);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const dpr = window.devicePixelRatio || 1;
        imgCanvas.width = Math.round(w * dpr);
        imgCanvas.height = Math.round(h * dpr);
        imgCanvas.style.width = `${w}px`;
        imgCanvas.style.height = `${h}px`;
        imgCanvas.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0, imgCanvas.width, imgCanvas.height);
        imgCanvas.hidden = false;
        marker.hidden = true;
        $('drop-hint').textContent = 'Click or drag on the image to sample a colour.';
        note(`image loaded ${bmp.width}×${bmp.height}`);
    } catch (e) {
        $('drop-hint').textContent = `Could not read that file as an image (${(e as Error).message}).`;
    }
}

$<HTMLInputElement>('image-file').addEventListener('change', e => void loadImage((e.target as HTMLInputElement).files?.[0]));
drop.addEventListener('dragover', e => {
    e.preventDefault();
    drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    if (!answered) void loadImage(e.dataTransfer?.files?.[0]);
});
draggable(imgCanvas, () => (x, y) => {
    const w = imgCanvas.clientWidth;
    const h = imgCanvas.clientHeight;
    x = clamp(x, 0, w - 0.01);
    y = clamp(y, 0, h - 0.01);
    const k = imgCanvas.width / w;
    const [r, g, b, a] = imgCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data;
    marker.hidden = false;
    marker.style.left = `${imgCanvas.offsetLeft + x}px`;
    marker.style.top = `${imgCanvas.offsetTop + y}px`;
    marker.style.background = `rgb(${r},${g},${b})`;
    if (a > 0) setRgb({ r, g, b }, { from: imgCanvas });
});

// ----------------------------------------------- swatches (presets, recent, palettes)
function swatch(color: string, label: string, keepAlpha: boolean, cls = 'sw'): HTMLButtonElement {
    const b = Object.assign(document.createElement('button'), { type: 'button', title: label, className: cls });
    b.dataset.color = color;
    if (keepAlpha) b.dataset.keepAlpha = '1';
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    const s = document.createElement('span');
    s.style.background = color;
    if (cls === 'sw') b.appendChild(s);
    else b.style.background = color;
    return b;
}

// One delegated handler: presets and palette colours keep the opacity, recent colours carry their own.
document.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-color]');
    if (!b || answered) return;
    setHex(b.dataset.color!, { keepAlpha: b.dataset.keepAlpha === '1', commit: !b.closest('#recent') });
});

function renderRecent() {
    const box = $('recent');
    box.replaceChildren(
        ...(recent.length
            ? [
                  ...recent.map(c => swatch(c, `Recent ${c}`, false)),
                  ...Array.from({ length: MAX_RECENT - recent.length }, () => Object.assign(document.createElement('div'), { className: 'slot' }))
              ]
            : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Colours you settle on (and earlier answers) show up here.' })])
    );
    render();
}

function buildPalettes() {
    const box = $('palettes');
    const select = $<HTMLSelectElement>('palette-select');
    for (const [i, p] of PALETTES.entries()) {
        const sec = document.createElement('div');
        sec.className = 'palette';
        const id = `pal-${i}`;
        sec.innerHTML = `<div class="label" id="${id}">${p.name}</div>`;
        const grid = document.createElement('div');
        grid.className = 'grid';
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-labelledby', id);
        grid.append(...p.colors.map(c => swatch(c, `${p.name} ${c}`, true)));
        sec.appendChild(grid);
        box.appendChild(sec);
        select.add(new Option(p.name, String(i)));
    }
    const showSide = () => $('side-palette').replaceChildren(...PALETTES[Number(select.value)].colors.map(c => swatch(c, `${PALETTES[Number(select.value)].name} ${c}`, true)));
    select.addEventListener('change', () => {
        showSide();
        render();
    });
    showSide();
    $('presets').append(...PRESETS.map(c => swatch(c, c, true, 'preset')));
}

$('previous').addEventListener('click', () => {
    if (answered) return;
    const was = currentHex();
    const to = previous;
    previous = was;
    setHex(to, { commit: true });
});

// ------------------------------------------------- hex + opacity fields
hexEl.addEventListener('input', () => {
    const v = hexEl.value.trim();
    hexInvalid = !HEX_COLOR.test(v);
    if (!hexInvalid) setHex(v, { from: hexEl });
    else render(hexEl);
});
hexEl.addEventListener('change', () => {
    if (!hexInvalid) {
        hexEl.value = currentHex();
        addRecent(currentHex());
    }
});
alphaEl.addEventListener('input', () => setHsv({ a: Number(alphaEl.value) / 100 }, { from: alphaEl }));
alphaEl.addEventListener('change', () => addRecent(currentHex()));

// --------------------------------------------------------------- tabs
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
function showTab(name: string, focus = false) {
    tab = name;
    for (const t of tabs) {
        const on = t.dataset.tab === name;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $(t.getAttribute('aria-controls')!).hidden = !on;
        if (on && focus) t.focus();
    }
    $('side-palette-box').hidden = name === 'palettes';
    if (name === 'pick') updateEyeDropper();
    drawnHue = NaN;
    drawWheel();
    drawSquare();
    render();
}
for (const t of tabs) {
    t.addEventListener('click', () => showTab(t.dataset.tab!));
    t.addEventListener('keydown', e => {
        const i = tabs.indexOf(t);
        const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (j === -1 && !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
        e.preventDefault();
        showTab(tabs[(j + tabs.length) % tabs.length].dataset.tab!, true);
    });
}

new ResizeObserver(() => {
    drawnHue = NaN;
    queueDraw();
    positionWheelHandles();
    positionSquareHandle();
}).observe(document.body);

// -------------------------------------------------------------- answer
const isMethodNotFound = (e: unknown) => (e as { code?: number })?.code === -32601 || /method not found/i.test(String((e as Error)?.message ?? e));

function lock(on: boolean) {
    pickerEl.disabled = on;
    tellEl.disabled = on;
    for (const h of [hueHandle, triHandle, sqHandle]) h.tabIndex = on ? -1 : 0;
}

async function answer(action: 'accept' | 'cancel') {
    if (!requestId || answered) return;
    if (action === 'accept' && hexInvalid) return;
    const color = action === 'accept' ? currentHex() : null;
    answered = true;
    lock(true);
    refreshButtons();
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
    if (delivered) {
        if (color) recent = [color, ...recent.filter(c => c !== color)].slice(0, MAX_RECENT);
        setStatus(action === 'accept' ? `✅ You picked ${color}.` : 'Cancelled.', 'ok');
        return;
    }
    // Nothing got through (e.g. the user refused the host's tool-call confirmation): unlock so they can try again.
    answered = false;
    lock(false);
    refreshButtons();
    setStatus(`${action === 'accept' ? `You picked ${color}, but` : 'Cancelled, but'} the answer could not be delivered (see below). Try again.`, 'err');
}

okBtn.onclick = () => void answer('accept');
cancelBtn.onclick = () => void answer('cancel');

// ------------------------------------------------- host → app events
// Registered before connect() so one-shot notifications aren't missed.
function applyArgs(a: { prompt?: unknown; initial?: unknown; requestId?: unknown; recent?: unknown } | undefined) {
    if (!a) return;
    if (typeof a.prompt === 'string' && a.prompt) {
        prompt = a.prompt;
        $('prompt').textContent = prompt;
    }
    if (typeof a.initial === 'string' && HEX_COLOR.test(a.initial) && !answered && !touched) {
        previous = formatHex(parseHex(a.initial)!);
        setHex(a.initial);
        touched = false;
    }
    if (typeof a.requestId === 'string' && a.requestId) requestId = a.requestId;
    if (Array.isArray(a.recent)) {
        const fromServer = a.recent.filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c)).map(c => formatHex(parseHex(c)!));
        recent = [...new Set([...recent, ...fromServer])].slice(0, MAX_RECENT);
        renderRecent();
    }
}

app.ontoolinput = params => {
    lastToolInput = params;
    applyArgs(params.arguments as Record<string, unknown> | undefined);
    refreshButtons();
    note('ui/notifications/tool-input');
};
app.ontoolresult = params => {
    lastToolResult = params;
    applyArgs(params.structuredContent as Record<string, unknown> | undefined);
    if (requestId) setStatus(answered ? $('status').textContent ?? '' : '');
    else setStatus('The tool result carries no requestId; the answer cannot be sent.', 'err');
    refreshButtons();
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

buildChannels();
buildPalettes();
renderRecent();
setHex(previous);
touched = false;
showTab('wheel');
app.connect()
    .then(() => {
        applyContext(app.getHostContext());
        note('connected (ui/initialize done)');
    })
    .catch(e => {
        setStatus(`Could not connect to the host: ${(e as Error).message}`, 'err');
        $('debug').textContent = `Not running inside an MCP Apps host?\n${String(e)}`;
    });
