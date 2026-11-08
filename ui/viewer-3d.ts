/**
 * 3D viewer – browser side of the view_3d MCP App. three.js is bundled by
 * esbuild and inlined into viewer-3d.html (see scripts/build-ui.mjs), so the
 * app needs no network access, no WASM and no eval: it runs under strict host
 * CSPs such as Open WebUI's (connect-src 'none', no 'wasm-unsafe-eval').
 *
 *  - shapes knot / sphere / gear are generated here; glb-sample is read from the
 *    server with resources/read (app → host → server) and parsed with GLTFLoader.parse
 *  - orbit (drag / touch / wheel / arrow keys / + -), reset, auto-rotate, wireframe
 *  - click a part (raycast) → highlight, then view_3d_select (app-only tool) and
 *    ui/update-model-context; "Tell the assistant" sends ui/message
 *  - "Details (for testing)" probes WebGL/WebGPU/WASM/fetch/eval/fullscreen
 */
import {
    BoxHelper,
    Color,
    CylinderGeometry,
    DirectionalLight,
    ExtrudeGeometry,
    GridHelper,
    Group,
    HemisphereLight,
    IcosahedronGeometry,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Raycaster,
    Scene,
    Shape,
    SphereGeometry,
    Spherical,
    TorusGeometry,
    TorusKnotGeometry,
    Vector2,
    Vector3,
    WebGLRenderer,
    type BufferGeometry,
    type Object3D
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

type Vec3 = [number, number, number];
interface CameraState {
    position: Vec3;
    target: Vec3;
}
const SHAPES = ['knot', 'sphere', 'gear', 'glb-sample'] as const;
type ShapeName = (typeof SHAPES)[number];
const DEFAULT_CAMERA: CameraState = { position: [5, 3.5, 6], target: [0, 1.2, 0] };
const SAMPLE_GLB_URI = 'test://models/sample.glb';
/** Keep coordinates well inside the server's bounds (±100). */
const MAX_TARGET = 20;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');

// ------------------------------------------------------------------ state
let viewId: string | null = null;
let shape: ShapeName | null = null;
let highlight: string | null = null;
let initialCamera: CameraState = DEFAULT_CAMERA;
let selected: string | null = null;
let parts: Mesh[] = [];
let modelSource = '(not loaded yet)';
let loadToken = 0;
let ready = false;
const events: string[] = [];
let lastToolInput: unknown = null;
let lastToolResult: unknown = null;
const probes: Record<string, string> = {};

const app = new App({ name: 'viewer-3d', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: true });

function note(msg: string) {
    events.unshift(`${new Date().toLocaleTimeString()}  ${msg}`);
    events.length = Math.min(events.length, 20);
    $('debug').textContent = JSON.stringify(
        {
            viewId,
            shape,
            selected,
            camera: renderer ? cameraState() : null,
            hostInfo: app.getHostVersion() ?? null,
            hostCapabilities: app.getHostCapabilities() ?? null,
            displayMode: app.getHostContext()?.displayMode ?? null,
            availableDisplayModes: app.getHostContext()?.availableDisplayModes ?? null,
            lastToolInput,
            lastToolResult,
            events
        },
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
    $('report').hidden = false;
    const li = $(`r-${id}`);
    li.hidden = false;
    li.dataset.state = state;
    li.querySelector('b')!.textContent = msg;
}

function showError(msg: string | null) {
    let el = document.getElementById('error');
    if (!msg) return el?.remove();
    if (!el) {
        el = Object.assign(document.createElement('div'), { id: 'error' });
        stage.appendChild(el);
    }
    el.textContent = msg;
}

function setProbe(key: string, value: string) {
    probes[key] = value;
    const table = $('probe');
    let row = table.querySelector<HTMLTableRowElement>(`tr[data-key="${key}"]`);
    if (!row) {
        row = document.createElement('tr');
        row.dataset.key = key;
        row.append(Object.assign(document.createElement('td'), { textContent: key }), document.createElement('td'));
        table.appendChild(row);
    }
    row.cells[1].textContent = value;
}

// ------------------------------------------------------------------ scene
let renderer: WebGLRenderer | null = null;
try {
    renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    stage.prepend(renderer.domElement);
} catch (e) {
    showError(`WebGL is not available here, so nothing can be drawn: ${(e as Error).message}`);
}
const scene = new Scene();
const camera = new PerspectiveCamera(45, 1.6, 0.05, 200);
const controls = renderer ? new OrbitControls(camera, renderer.domElement) : null;
const model = new Group();
scene.add(model);
scene.add(new HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new DirectionalLight(0xffffff, 2.2);
sun.position.set(5, 9, 4);
scene.add(sun);
let grid: GridHelper | null = null;
let outline: BoxHelper | null = null;
let dirty = true;
let wireframe = false;

if (controls) {
    controls.enableDamping = false;
    controls.minDistance = 1;
    controls.maxDistance = 40;
    controls.autoRotateSpeed = 3;
    controls.addEventListener('change', () => {
        const t = controls.target;
        t.set(clamp(t.x, -MAX_TARGET, MAX_TARGET), clamp(t.y, -MAX_TARGET, MAX_TARGET), clamp(t.z, -MAX_TARGET, MAX_TARGET));
        dirty = true;
    });
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

function cameraState(): CameraState {
    const t = controls?.target ?? new Vector3();
    return { position: camera.position.toArray().map(round) as Vec3, target: t.toArray().map(round) as Vec3 };
}

function setCamera(c: CameraState) {
    camera.position.set(...c.position);
    controls?.target.set(...c.target);
    camera.lookAt(new Vector3(...c.target));
    controls?.update();
    dirty = true;
}

function cssColor(name: string, fallback: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function applyStageTheme() {
    scene.background = new Color(cssColor('--stage', '#eef1f5'));
    if (grid) {
        scene.remove(grid);
        grid.dispose();
    }
    const g = cssColor('--grid', '#b8c0cc');
    grid = new GridHelper(12, 24, g, g);
    scene.add(grid);
    if (outline) outline.material.color = new Color(cssColor('--accent', '#4f46e5'));
    for (const m of parts) if (m.name === selected) (m.material as MeshStandardMaterial).emissive.set(cssColor('--accent', '#4f46e5'));
    dirty = true;
}

function resize() {
    if (!renderer) return;
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
}
new ResizeObserver(resize).observe(stage);

// fps: measured once over a burst of forced frames, then rendering is on demand.
let benchFrames = 0;
let benchStart = 0;
renderer?.setAnimationLoop(now => {
    if (!controls || !renderer) return;
    if (controls.autoRotate) controls.update(); // emits "change" → dirty
    if (benchFrames > 0) {
        if (benchStart === 0) benchStart = now;
        if (--benchFrames === 0) setProbe('fps', `${((59 * 1000) / Math.max(1, now - benchStart)).toFixed(0)} (60 forced frames)`);
        dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    outline?.update();
    renderer.render(scene, camera);
});

// ------------------------------------------------------------------ shapes
const mat = (color: number, extra: Partial<MeshStandardMaterial> = {}) => new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...extra });

function part(name: string, geometry: BufferGeometry, material: MeshStandardMaterial, pos: Vec3 = [0, 0, 0]): Mesh {
    const m = new Mesh(geometry, material);
    m.name = name;
    m.position.set(...pos);
    return m;
}

function gearGeometry(teeth = 14, outer = 1.3, depth = 0.2, hole = 0.2, thickness = 0.35) {
    const s = new Shape();
    const steps = teeth * 4;
    for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const r = i % 4 === 1 || i % 4 === 2 ? outer : outer - depth;
        if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const h = new Shape();
    h.absarc(0, 0, hole, 0, Math.PI * 2, true);
    s.holes.push(h);
    const g = new ExtrudeGeometry(s, { depth: thickness, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1, curveSegments: 24 });
    g.translate(0, 0, -thickness / 2);
    return g;
}

function buildShape(name: Exclude<ShapeName, 'glb-sample'>): Mesh[] {
    switch (name) {
        case 'knot':
            return [
                part('knot', new TorusKnotGeometry(0.75, 0.26, 180, 24), mat(0xff8a3d), [0, 2.05, 0]),
                part('stand', new CylinderGeometry(0.1, 0.14, 1.1, 24), mat(0x9aa3b2, { metalness: 0.6 }), [0, 0.75, 0]),
                part('base', new CylinderGeometry(1.2, 1.3, 0.2, 48), mat(0x5b6474), [0, 0.1, 0])
            ];
        case 'sphere': {
            const ring = part('ring', new TorusGeometry(1.75, 0.07, 12, 120), mat(0xf5c542, { metalness: 0.5 }), [0, 1.5, 0]);
            ring.rotation.set(Math.PI / 2.3, 0, 0.25);
            return [
                part('sphere', new IcosahedronGeometry(1.1, 5), mat(0x4fb3ff), [0, 1.5, 0]),
                ring,
                part('moon', new SphereGeometry(0.3, 32, 16), mat(0xd6d3d1, { roughness: 0.9 }), [2.2, 2.6, -0.5])
            ];
        }
        case 'gear': {
            const hub = part('hub', new CylinderGeometry(0.5, 0.5, 0.7, 40), mat(0x64748b, { metalness: 0.6 }), [0, 1.5, 0]);
            const axle = part('axle', new CylinderGeometry(0.18, 0.18, 2.6, 24), mat(0xcbd5e1, { metalness: 0.8, roughness: 0.25 }), [0, 1.5, 0]);
            hub.rotation.x = axle.rotation.x = Math.PI / 2;
            return [part('gear', gearGeometry(), mat(0x22a06b, { metalness: 0.3 }), [0, 1.5, 0]), hub, axle];
        }
    }
}

async function loadGlb(): Promise<Mesh[]> {
    const res = await app.readServerResource({ uri: SAMPLE_GLB_URI });
    const c = res.contents?.[0] as { blob?: string; mimeType?: string } | undefined;
    if (!c?.blob) throw new Error('the resource came back without a blob');
    const bytes = Uint8Array.from(atob(c.blob), ch => ch.charCodeAt(0));
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
    const meshes: Mesh[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o: Object3D) => {
        if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    for (const m of meshes) {
        // Flatten into the model group (keep world transforms) and give each part its own material.
        m.applyMatrix4(m.parent!.matrixWorld);
        m.material = (m.material as MeshStandardMaterial).clone();
    }
    modelSource = `resources/read ${SAMPLE_GLB_URI} (${bytes.length} bytes, ${c.mimeType ?? 'no mimeType'}) → GLTFLoader.parse`;
    return meshes;
}

async function loadShape(name: ShapeName) {
    const token = ++loadToken;
    shape = name;
    $('shapeLabel').textContent = `Shape: ${name}`;
    showError(null);
    let meshes: Mesh[];
    try {
        if (name === 'glb-sample') {
            showError('Loading sample.glb through the host (resources/read)…');
            meshes = await loadGlb();
            showError(null);
        } else {
            meshes = buildShape(name);
            modelSource = 'generated in the app (three.js geometry)';
        }
    } catch (e) {
        if (token !== loadToken) return;
        modelSource = `FAILED: ${(e as Error).message}`;
        setProbe('model source', modelSource);
        showError(`Could not load the sample model via resources/read (${SAMPLE_GLB_URI}): ${(e as Error).message}. This host may not proxy resources/read for apps.`);
        note(`load ${name}: ${(e as Error).message}`);
        return;
    }
    if (token !== loadToken) return;
    model.clear();
    parts = meshes;
    for (const m of parts) {
        (m.material as MeshStandardMaterial).wireframe = wireframe;
        model.add(m);
    }
    setProbe('model source', modelSource);
    renderPartList();
    selectPart(highlight && parts.some(p => p.name === highlight) ? highlight : null, false);
    ready = true;
    dirty = true;
    note(`loaded ${name}: ${parts.map(p => p.name).join(', ')}`);
}

// ------------------------------------------------------------------ selection
function renderPartList() {
    const box = $('parts');
    box.innerHTML = '';
    for (const p of parts) {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: p.name });
        b.dataset.part = p.name;
        b.setAttribute('aria-pressed', String(p.name === selected));
        b.onclick = () => selectPart(p.name, true);
        box.appendChild(b);
    }
}

let selectSeq = 0;
function selectPart(name: string | null, send: boolean) {
    selected = name;
    const accent = cssColor('--accent', '#4f46e5');
    for (const m of parts) {
        const material = m.material as MeshStandardMaterial;
        material.emissive.set(m.name === name ? accent : 0x000000);
        material.emissiveIntensity = m.name === name ? 0.3 : 0;
    }
    if (outline) {
        scene.remove(outline);
        outline.dispose();
        outline = null;
    }
    const mesh = parts.find(m => m.name === name);
    if (mesh) {
        outline = new BoxHelper(mesh, new Color(accent));
        scene.add(outline);
    }
    document.querySelectorAll<HTMLButtonElement>('#parts button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.part === name)));
    ($('tell') as HTMLButtonElement).disabled = !name;
    $('overlay').textContent = name ? `Selected: ${name}` : '';
    dirty = true;
    if (name) setStatus(`Selected: ${name}`);
    if (send && name) void sendSelection(name, ++selectSeq);
}

const isMethodNotFound = (e: unknown) => (e as { code?: number })?.code === -32601 || /method not found/i.test(String((e as Error)?.message ?? e));
const describeSel = (name: string, c: CameraState) =>
    `In the 3D view of "${shape}" the user selected "${name}" (camera position [${c.position.join(', ')}], target [${c.target.join(', ')}]).`;

async function sendSelection(name: string, seq: number) {
    const cam = cameraState();
    const stale = () => seq !== selectSeq;
    // 1. Server (app-only tool)
    if (!viewId) {
        report('server', 'skip', 'no viewId (the tool result did not arrive)');
    } else {
        try {
            const res = await app.callServerTool({ name: 'view_3d_select', arguments: { viewId, part: name, camera: cam } });
            const t = res.content?.find(c => c.type === 'text');
            const msg = t && t.type === 'text' ? t.text : '';
            if (!stale()) report('server', res.isError ? 'err' : 'ok', res.isError ? msg || 'error' : `stored ${name}`);
            note(`tools/call view_3d_select: ${res.isError ? 'ERROR ' : ''}${msg}`);
        } catch (e) {
            if (!stale()) report('server', 'err', (e as Error).message);
            note(`tools/call view_3d_select: ${(e as Error).message}`);
        }
    }
    // 2. Model context
    try {
        await app.updateModelContext({ content: [{ type: 'text', text: describeSel(name, cam) }], structuredContent: { viewId, shape, selected: name, camera: cam } });
        if (!stale()) report('context', 'ok', 'updated');
        note('ui/update-model-context: ok');
    } catch (e) {
        if (!stale()) report('context', isMethodNotFound(e) ? 'skip' : 'err', isMethodNotFound(e) ? 'not supported by host' : (e as Error).message);
        note(`ui/update-model-context: ${(e as Error).message}`);
    }
}

$('tell').onclick = async () => {
    if (!selected) return;
    const sentence = `I selected ${selected} in the 3D view (${shape}).`;
    try {
        const r = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: sentence }] });
        report('message', r.isError ? 'err' : 'ok', r.isError ? 'rejected by host' : 'sent');
        note(`ui/message: ${r.isError ? 'rejected' : 'ok'}`);
    } catch (e) {
        report('message', isMethodNotFound(e) ? 'skip' : 'err', isMethodNotFound(e) ? 'not supported by host' : (e as Error).message);
        note(`ui/message: ${(e as Error).message}`);
    }
};

// Picking: a click (pointer moved < 5 px) selects the part under the pointer.
const raycaster = new Raycaster();
function hitAt(clientX: number, clientY: number): Mesh | null {
    if (!renderer) return null;
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    return (raycaster.intersectObjects(parts, false)[0]?.object as Mesh | undefined) ?? null;
}
let down: { x: number; y: number } | null = null;
renderer?.domElement.addEventListener('pointerdown', e => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
});
renderer?.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) selectPart(hit.name, true);
});

// ------------------------------------------------------------------ controls
function orbit(dTheta: number, dPhi: number) {
    if (!controls) return;
    const off = camera.position.clone().sub(controls.target);
    const s = new Spherical().setFromVector3(off);
    s.theta += dTheta;
    s.phi = clamp(s.phi + dPhi, 0.05, Math.PI - 0.05);
    off.setFromSpherical(s);
    camera.position.copy(controls.target).add(off);
    controls.update();
}
function zoom(factor: number) {
    if (!controls) return;
    const off = camera.position.clone().sub(controls.target);
    off.setLength(clamp(off.length() * factor, controls.minDistance, controls.maxDistance));
    camera.position.copy(controls.target).add(off);
    controls.update();
}
stage.addEventListener('keydown', e => {
    const k = e.key;
    if (k === 'ArrowLeft') orbit(-0.15, 0);
    else if (k === 'ArrowRight') orbit(0.15, 0);
    else if (k === 'ArrowUp') orbit(0, -0.12);
    else if (k === 'ArrowDown') orbit(0, 0.12);
    else if (k === '+' || k === '=') zoom(0.85);
    else if (k === '-' || k === '_') zoom(1 / 0.85);
    else return;
    e.preventDefault();
});
renderer?.domElement.addEventListener('pointerdown', () => stage.focus({ preventScroll: true }));

$('reset').onclick = () => {
    setCamera(initialCamera);
    note('reset view');
};
$('rotate').onclick = () => {
    if (!controls) return;
    controls.autoRotate = !controls.autoRotate;
    $('rotate').setAttribute('aria-pressed', String(controls.autoRotate));
};
$('wireframe').onclick = () => {
    wireframe = !wireframe;
    for (const m of parts) (m.material as MeshStandardMaterial).wireframe = wireframe;
    $('wireframe').setAttribute('aria-pressed', String(wireframe));
    dirty = true;
};
$('fullscreen').onclick = async () => {
    const cur = app.getHostContext()?.displayMode;
    try {
        const r = await app.requestDisplayMode({ mode: cur === 'fullscreen' ? 'inline' : 'fullscreen' });
        applyContext({ displayMode: r.mode });
        note(`ui/request-display-mode → ${r.mode}`);
    } catch (e) {
        setStatus(`Display mode change failed: ${(e as Error).message}`, 'err');
        note(`ui/request-display-mode: ${(e as Error).message}`);
    }
};

// ------------------------------------------------------------------ host
function applyContext(ctx: Partial<McpUiHostContext> | undefined) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.theme || ctx.styles) applyStageTheme();
    if (ctx.availableDisplayModes) {
        const modes = ctx.availableDisplayModes;
        const canFs = modes.includes('fullscreen');
        $('fullscreen').hidden = !canFs;
        $('fsNote').textContent = canFs ? '' : `Fullscreen is not offered by this host (display modes: ${modes.join(', ') || 'none'}).`;
    }
    if (ctx.displayMode) {
        const full = ctx.displayMode === 'fullscreen';
        document.body.classList.toggle('fullscreen', full);
        $('fullscreen').textContent = full ? 'Exit fullscreen' : 'Fullscreen';
    }
    setProbe(
        'fullscreen',
        `host display modes: ${app.getHostContext()?.availableDisplayModes?.join(', ') || 'not declared'}; document.fullscreenEnabled: ${document.fullscreenEnabled}`
    );
}

function isVec3(v: unknown): v is Vec3 {
    return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function applyArgs(a: Record<string, unknown> | undefined) {
    if (!a) return;
    const cam = a.camera as { position?: unknown; target?: unknown } | undefined;
    if (cam && isVec3(cam.position) && isVec3(cam.target)) {
        initialCamera = { position: cam.position, target: cam.target };
        setCamera(initialCamera);
    }
    if (typeof a.highlight === 'string') highlight = a.highlight;
    if (typeof a.viewId === 'string') viewId = a.viewId;
    const s = typeof a.shape === 'string' && (SHAPES as readonly string[]).includes(a.shape) ? (a.shape as ShapeName) : null;
    if (s && s !== shape) void loadShape(s);
    else if (highlight && parts.some(p => p.name === highlight) && selected !== highlight) selectPart(highlight, false);
}

app.ontoolinput = params => {
    lastToolInput = params;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    applyArgs({ shape: 'knot', ...args });
    note('ui/notifications/tool-input');
};
app.ontoolresult = params => {
    lastToolResult = params;
    applyArgs(params.structuredContent as Record<string, unknown> | undefined);
    if (!viewId) setStatus('The tool result carries no viewId; selections stay in this view only.', 'err');
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
    renderer?.setAnimationLoop(null);
    return {};
};

// ------------------------------------------------------------------ capability probes
async function runProbes() {
    const gl1 = document.createElement('canvas').getContext('webgl');
    setProbe('WebGL 1', gl1 ? 'available' : 'not available');
    setProbe('WebGL 2', document.createElement('canvas').getContext('webgl2') ? 'available' : 'not available');
    if (renderer) {
        const gl = renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        setProbe('renderer', String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
        setProbe('three.js context', renderer.capabilities.isWebGL2 ? 'WebGL 2' : 'WebGL 1');
    }
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) setProbe('WebGPU', 'not available (no navigator.gpu)');
    else {
        try {
            setProbe('WebGPU', (await gpu.requestAdapter()) ? 'adapter available' : 'API present, no adapter');
        } catch (e) {
            setProbe('WebGPU', `API present, requestAdapter failed: ${(e as Error).message}`);
        }
    }
    try {
        await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        setProbe('WASM compile', 'allowed (Draco/meshopt decoders would work)');
    } catch (e) {
        setProbe('WASM compile', `blocked: ${(e as Error).message}`);
    }
    try {
        // eslint-disable-next-line no-new-func
        setProbe('eval / new Function', new Function('return 1')() === 1 ? 'allowed' : 'blocked');
    } catch (e) {
        setProbe('eval / new Function', `blocked: ${(e as Error).message}`);
    }
    try {
        await fetch('data:text/plain,probe');
        setProbe('fetch (data: URL)', 'allowed');
    } catch (e) {
        setProbe('fetch (data: URL)', `blocked: ${(e as Error).message} (models must come through resources/read)`);
    }
    setProbe('bundle', `${(document.documentElement.outerHTML.length / 1024).toFixed(0)} KiB HTML, three.js inlined, no network access needed`);
    setProbe('host serverResources', app.getHostCapabilities()?.serverResources ? 'declared' : 'not declared');
    benchFrames = 60;
    note('probes done');
}

// ------------------------------------------------------------------ test hooks
// Used by the browser test (test/ui/viewer-3d.test.mjs); harmless in a real host.
(window as unknown as { __viewer: unknown }).__viewer = {
    get ready() {
        return ready;
    },
    get selected() {
        return selected;
    },
    get probes() {
        return { ...probes };
    },
    parts: () => parts.map(p => p.name),
    camera: cameraState,
    /** A point (iframe CSS px) where a click hits `name`: a hit cell whose neighbours hit it too. */
    pointOn(name: string) {
        if (!renderer) return null;
        const r = renderer.domElement.getBoundingClientRect();
        const cols = 32;
        const rows = 20;
        const hits = new Set<string>();
        const pt = (i: number, j: number) => ({ x: r.left + ((i + 0.5) / cols) * r.width, y: r.top + ((j + 0.5) / rows) * r.height });
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) if (hitAt(pt(i, j).x, pt(i, j).y)?.name === name) hits.add(`${i},${j}`);
        const inner = [...hits].find(k => {
            const [i, j] = k.split(',').map(Number);
            return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([di, dj]) => hits.has(`${i + di},${j + dj}`));
        });
        const k = inner ?? [...hits][0];
        if (!k) return null;
        const [i, j] = k.split(',').map(Number);
        return pt(i, j);
    },
    /** Render now and summarize the pixels: share that differs from the most common (background) colour. */
    pixelStats() {
        if (!renderer) return null;
        renderer.render(scene, camera);
        const gl = renderer.getContext();
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const counts = new Map<number, number>();
        for (let i = 0; i < buf.length; i += 4) {
            const key = ((buf[i] >> 3) << 10) | ((buf[i + 1] >> 3) << 5) | (buf[i + 2] >> 3);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const background = Math.max(...counts.values());
        return { width: w, height: h, foreground: 1 - background / (w * h), colours: counts.size };
    }
};

// ------------------------------------------------------------------ start
applyStageTheme();
resize();
setCamera(initialCamera);
app.connect()
    .then(() => {
        applyContext(app.getHostContext());
        note('connected (ui/initialize done)');
        // A host that never sends tool input still gets a picture.
        setTimeout(() => {
            if (!shape) void loadShape('knot');
        }, 1500);
    })
    .catch(e => {
        $('debug').textContent = `Not running inside an MCP Apps host?\n${String(e)}`;
        if (!shape) void loadShape('knot');
    })
    .finally(() => void runProbes());
