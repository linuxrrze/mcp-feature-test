/**
 * 3D viewer: an interactive three.js MCP App that doubles as a host-capability test.
 *
 *   view_3d          (model)  shows a 3D view (shape, optional camera and highlighted part)
 *   view_3d_select   (app)    the viewer stores the part the user clicked, with the camera
 *   view_3d_state    (model)  reads the latest selection / camera of a view
 *   resource test://models/sample.glb  a small glTF binary generated in code; the app
 *                                      reads it with resources/read (app → host → server)
 *
 * The app is fully self-contained: three.js is bundled into the HTML, models are
 * generated in the browser or read through the host, and nothing is fetched,
 * compiled to WASM or eval'd, so it also works under strict host CSPs such as
 * Open WebUI's (see docs/architecture.md).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';

const here = dirname(fileURLToPath(import.meta.url));

export const VIEWER_3D_URI = 'ui://feature-test/viewer-3d.html';
export const SAMPLE_GLB_URI = 'test://models/sample.glb';
export const GLB_MIME = 'model/gltf-binary';

/** Shapes and the named parts the app builds for each (glb-sample: the meshes inside sample.glb). */
export const SHAPE_PARTS = {
    knot: ['knot', 'stand', 'base'],
    sphere: ['sphere', 'ring', 'moon'],
    gear: ['gear', 'hub', 'axle'],
    'glb-sample': ['base', 'tower', 'roof', 'flag']
} as const;
export type Shape = keyof typeof SHAPE_PARTS;
export const SHAPES = Object.keys(SHAPE_PARTS) as Shape[];
export const DEFAULT_SHAPE: Shape = 'knot';

export interface Camera {
    position: [number, number, number];
    target: [number, number, number];
}
export const DEFAULT_CAMERA: Camera = { position: [5, 3.5, 6], target: [0, 1.2, 0] };
/** Every camera coordinate must lie in [-MAX_CAMERA_COORD, MAX_CAMERA_COORD]. */
export const MAX_CAMERA_COORD = 100;
/** Position and target must be at least this far apart (else there is no view direction). */
export const MIN_CAMERA_DISTANCE = 0.1;
export const MAX_PART_CHARS = 64;

/** Views kept (oldest dropped first) and how long they stay readable / selectable. */
export const MAX_VIEWS = 200;
export const VIEW_TTL_MS = 60 * 60_000;

export interface Selection {
    part: string | null;
    camera: Camera | null;
    at: number;
}

export interface View3d {
    viewId: string;
    shape: Shape;
    camera: Camera;
    highlight: string | null;
    createdAt: number;
    selection?: Selection;
    selections: number;
}

// ------------------------------------------------------------- validation

const vec3 = z
    .tuple([z.number(), z.number(), z.number()])
    .refine(v => v.every(n => Number.isFinite(n) && Math.abs(n) <= MAX_CAMERA_COORD), `each coordinate must be a finite number in [-${MAX_CAMERA_COORD}, ${MAX_CAMERA_COORD}]`);

export const cameraSchema = z
    .object({
        position: vec3.describe('Camera position [x, y, z]'),
        target: vec3.describe('Point the camera looks at [x, y, z]')
    })
    .refine(c => Math.hypot(...c.position.map((p, i) => p - c.target[i])) >= MIN_CAMERA_DISTANCE, {
        message: `position and target must be at least ${MIN_CAMERA_DISTANCE} apart`
    });

export type CheckResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a camera from untrusted input (tool arguments). */
export function checkCamera(input: unknown): CheckResult<Camera> {
    const r = cameraSchema.safeParse(input);
    if (!r.success) return { ok: false, error: `Invalid camera: ${r.error.issues.map(i => `${i.path.join('.') || 'camera'}: ${i.message}`).join('; ')}` };
    return { ok: true, value: { position: [...r.data.position], target: [...r.data.target] } };
}

export function partsOf(shape: Shape): readonly string[] {
    return SHAPE_PARTS[shape];
}

export function checkPart(shape: Shape, part: string): CheckResult<string> {
    if (partsOf(shape).includes(part)) return { ok: true, value: part };
    return { ok: false, error: `Unknown part "${part}" for shape ${shape}; parts: ${partsOf(shape).join(', ')}.` };
}

// ------------------------------------------------------------------ store

// Module level: HTTP mode builds a fresh McpServer per request.
const views = new Map<string, View3d>();

function prune(now = Date.now()): void {
    for (const [id, v] of views) if (now - v.createdAt > VIEW_TTL_MS) views.delete(id);
    for (const id of views.keys()) {
        if (views.size < MAX_VIEWS) break;
        views.delete(id); // insertion order: oldest first
    }
}

export function createView(shape: Shape, camera: Camera = DEFAULT_CAMERA, highlight: string | null = null, now = Date.now()): View3d {
    prune(now);
    const v: View3d = { viewId: randomUUID(), shape, camera, highlight, createdAt: now, selections: 0 };
    views.set(v.viewId, v);
    return v;
}

export function getView(viewId: string, now = Date.now()): View3d | undefined {
    const v = views.get(viewId);
    if (v && now - v.createdAt > VIEW_TTL_MS) {
        views.delete(viewId);
        return undefined;
    }
    return v;
}

export function latestView(now = Date.now()): View3d | undefined {
    prune(now);
    return [...views.values()].at(-1);
}

export function viewCount(): number {
    return views.size;
}

/** For tests. */
export function resetViews(): void {
    views.clear();
}

/** Store the latest selection of a view (part null = selection cleared). */
export function selectInView(viewId: string, part: string | null, camera: unknown, now = Date.now()): CheckResult<View3d> {
    const v = getView(viewId, now);
    if (!v) return { ok: false, error: `Unknown or expired 3D view "${viewId}". Ask the assistant to call view_3d again.` };
    if (part !== null) {
        const p = checkPart(v.shape, part);
        if (!p.ok) return p;
    }
    let cam: Camera | null = null;
    if (camera !== undefined && camera !== null) {
        const c = checkCamera(camera);
        if (!c.ok) return c;
        cam = c.value;
    }
    v.selection = { part, camera: cam, at: now };
    v.selections++;
    return { ok: true, value: v };
}

const fmt = (v: readonly number[]) => `[${v.map(n => +n.toFixed(2)).join(', ')}]`;
export const describeCamera = (c: Camera) => `position ${fmt(c.position)}, target ${fmt(c.target)}`;

export function describeView(v: View3d): string {
    const s = v.selection;
    if (!s) return `Nothing selected yet in the 3D view of "${v.shape}" (viewId ${v.viewId}; parts: ${partsOf(v.shape).join(', ')}).`;
    const cam = s.camera ? ` Camera: ${describeCamera(s.camera)}.` : '';
    if (s.part === null) return `The user cleared the selection in the 3D view of "${v.shape}".${cam}`;
    return `The user selected "${s.part}" in the 3D view of "${v.shape}".${cam}`;
}

function publicView(v: View3d) {
    return {
        viewId: v.viewId,
        shape: v.shape,
        parts: [...partsOf(v.shape)],
        camera: v.camera,
        highlight: v.highlight,
        selected: v.selection?.part ?? null,
        selectionCamera: v.selection?.camera ?? null,
        selections: v.selections,
        createdAt: new Date(v.createdAt).toISOString(),
        selectedAt: v.selection ? new Date(v.selection.at).toISOString() : null
    };
}

// ------------------------------------------------------------- sample GLB

interface MeshData {
    name: string;
    color: [number, number, number];
    translation: [number, number, number];
    positions: number[];
    normals: number[];
    indices: number[];
}

/** Flat-shaded quads/triangles: each face gets its own vertices and normal. */
function faceted(name: string, color: [number, number, number], translation: [number, number, number], faces: number[][][]): MeshData {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (const f of faces) {
        const [a, b, c] = f;
        const u = b.map((x, i) => x - a[i]);
        const w = c.map((x, i) => x - a[i]);
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(...n) || 1;
        const base = positions.length / 3;
        for (const p of f) {
            positions.push(...p);
            normals.push(...n.map(x => x / len));
        }
        for (let i = 1; i + 1 < f.length; i++) indices.push(base, base + i, base + i + 1);
    }
    return { name, color, translation, positions, normals, indices };
}

/** Axis-aligned box centred on the origin, faces wound counter-clockwise (outward normals). */
function box(name: string, color: [number, number, number], translation: [number, number, number], sx: number, sy: number, sz: number): MeshData {
    const [x, y, z] = [sx / 2, sy / 2, sz / 2];
    const faces = [
        [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]], // +x
        [[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]], // -x
        [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]], // +y
        [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]], // -y
        [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], // +z
        [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] // -z
    ];
    return faceted(name, color, translation, faces);
}

/** Square pyramid with its base centred on the origin. */
function pyramid(name: string, color: [number, number, number], translation: [number, number, number], s: number, h: number): MeshData {
    const d = s / 2;
    const top = [0, h, 0];
    const c = [[-d, 0, d], [d, 0, d], [d, 0, -d], [-d, 0, -d]];
    const faces = [[c[0], c[1], top], [c[1], c[2], top], [c[2], c[3], top], [c[3], c[0], top], [c[3], c[2], c[1], c[0]]];
    return faceted(name, color, translation, faces);
}

/** The meshes inside sample.glb, in SHAPE_PARTS['glb-sample'] order. */
export function sampleModelMeshes(): MeshData[] {
    return [
        box('base', [0.42, 0.45, 0.52], [0, 0.15, 0], 3.2, 0.3, 3.2),
        box('tower', [0.85, 0.62, 0.38], [0, 1.3, 0], 1.2, 2, 1.2),
        pyramid('roof', [0.78, 0.2, 0.22], [0, 2.3, 0], 1.6, 1.1),
        box('flag', [0.2, 0.55, 0.95], [0.9, 3.1, 0], 0.7, 0.4, 0.05)
    ];
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/**
 * A minimal, valid glTF 2.0 binary (GLB): one node + mesh per part with
 * POSITION/NORMAL/indices and a PBR material, no textures or extensions.
 */
export function makeSampleGlb(): Buffer {
    const meshes = sampleModelMeshes();
    const chunks: Buffer[] = [];
    let offset = 0;
    const bufferViews: object[] = [];
    const accessors: object[] = [];
    const push = (buf: Buffer, target: number) => {
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
        chunks.push(buf, Buffer.alloc(pad4(buf.length)));
        offset += buf.length + pad4(buf.length);
        return bufferViews.length - 1;
    };
    const gltfMeshes = meshes.map((m, i) => {
        const pos = Buffer.from(new Float32Array(m.positions).buffer);
        const nrm = Buffer.from(new Float32Array(m.normals).buffer);
        const idx = Buffer.from(new Uint16Array(m.indices).buffer);
        const count = m.positions.length / 3;
        const min = [0, 1, 2].map(k => Math.min(...m.positions.filter((_, j) => j % 3 === k)));
        const max = [0, 1, 2].map(k => Math.max(...m.positions.filter((_, j) => j % 3 === k)));
        accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count, type: 'VEC3', min, max });
        const posAcc = accessors.length - 1;
        accessors.push({ bufferView: push(nrm, 34962), componentType: 5126, count, type: 'VEC3' });
        const nrmAcc = accessors.length - 1;
        accessors.push({ bufferView: push(idx, 34963), componentType: 5123, count: m.indices.length, type: 'SCALAR' });
        const idxAcc = accessors.length - 1;
        return { name: m.name, primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc, material: i }] };
    });
    const bin = Buffer.concat(chunks);
    const json = {
        asset: { version: '2.0', generator: 'mcp-feature-test (src/viewer3d.ts)' },
        scene: 0,
        scenes: [{ name: 'sample', nodes: meshes.map((_, i) => i) }],
        nodes: meshes.map((m, i) => ({ name: m.name, mesh: i, translation: m.translation })),
        meshes: gltfMeshes,
        materials: meshes.map(m => ({ name: `${m.name}-material`, pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: 0.1, roughnessFactor: 0.6 } })),
        accessors,
        bufferViews,
        buffers: [{ byteLength: bin.length }]
    };
    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length), 0x20)]);
    const chunkHeader = (len: number, type: number) => {
        const h = Buffer.alloc(8);
        h.writeUInt32LE(len, 0);
        h.writeUInt32LE(type, 4);
        return h;
    };
    const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); // "glTF"
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    return Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a /* JSON */), jsonChunk, chunkHeader(bin.length, 0x004e4942 /* BIN */), bin]);
}

let cachedGlb: Buffer | undefined;
export function sampleGlb(): Buffer {
    return (cachedGlb ??= makeSampleGlb());
}

// ------------------------------------------------------------- registration

function loadHtml(): string {
    // Built by `npm run build:ui` (esbuild bundles ui/viewer-3d.ts with three.js and inlines it).
    const candidates = [join(here, '..', 'dist', 'ui', 'viewer-3d.html'), join(here, 'ui', 'viewer-3d.html')];
    for (const p of candidates) {
        try {
            return readFileSync(p, 'utf8');
        } catch {
            /* try next */
        }
    }
    return '<!doctype html><html><body><p>3D viewer UI not built. Run <code>npm run build</code>.</p></body></html>';
}

const text = (t: string, extra: Partial<CallToolResult> = {}): CallToolResult => ({ content: [{ type: 'text', text: t }], ...extra });

export function registerViewer3d(server: McpServer): void {
    registerAppResource(
        server,
        '3D viewer',
        VIEWER_3D_URI,
        { description: 'Interactive three.js viewer (orbit, zoom, pick parts) and host-capability probe', _meta: { ui: { prefersBorder: true } } },
        async () => ({
            contents: [{ uri: VIEWER_3D_URI, mimeType: RESOURCE_MIME_TYPE, text: loadHtml(), _meta: { ui: { prefersBorder: true } } }]
        })
    );

    server.registerResource(
        'Sample 3D model',
        SAMPLE_GLB_URI,
        {
            title: 'Sample 3D model (GLB)',
            description: `A small glTF binary generated in code with the named meshes ${SHAPE_PARTS['glb-sample'].join(', ')}; the 3D viewer reads it with resources/read`,
            mimeType: GLB_MIME
        },
        async () => ({ contents: [{ uri: SAMPLE_GLB_URI, mimeType: GLB_MIME, blob: sampleGlb().toString('base64') }] })
    );

    registerAppTool(
        server,
        'view_3d',
        {
            title: 'Show an interactive 3D view (MCP App)',
            description:
                'Show an interactive 3D viewer (MCP App, three.js) the user can rotate, zoom and click. ' +
                `Shapes: ${SHAPES.join(', ')} (glb-sample is a small glTF model read from ${SAMPLE_GLB_URI}). ` +
                'Optionally set the camera and highlight one part. When the user selects a part it reaches you as model context or a chat message; ' +
                'view_3d_state reads the latest selection.',
            inputSchema: {
                shape: z.enum(SHAPES as [Shape, ...Shape[]]).optional().describe(`What to show (default ${DEFAULT_SHAPE})`),
                camera: cameraSchema.optional().describe(`Initial camera; coordinates in [-${MAX_CAMERA_COORD}, ${MAX_CAMERA_COORD}]. Default position ${fmt(DEFAULT_CAMERA.position)}, target ${fmt(DEFAULT_CAMERA.target)}`),
                highlight: z.string().min(1).max(MAX_PART_CHARS).optional().describe('Name of a part to highlight (see parts in the result)')
            },
            annotations: { readOnlyHint: true },
            _meta: { ui: { resourceUri: VIEWER_3D_URI } }
        },
        async ({ shape, camera, highlight }) => {
            const s = shape ?? DEFAULT_SHAPE;
            if (highlight !== undefined) {
                const p = checkPart(s, highlight);
                if (!p.ok) return text(p.error, { isError: true });
            }
            const v = createView(s, camera ? { position: [...camera.position], target: [...camera.target] } : DEFAULT_CAMERA, highlight ?? null);
            return text(
                `A 3D view of "${s}" is shown to the user (parts: ${partsOf(s).join(', ')}; camera ${describeCamera(v.camera)}` +
                    `${v.highlight ? `; highlighted: ${v.highlight}` : ''}). The user can rotate, zoom and click a part; ` +
                    `view_3d_state reads the selection (viewId ${v.viewId}). If no 3D view appeared, this client does not render MCP Apps.`,
                { structuredContent: { viewId: v.viewId, shape: v.shape, camera: v.camera, parts: [...partsOf(s)], highlight: v.highlight } }
            );
        }
    );

    registerAppTool(
        server,
        'view_3d_select',
        {
            title: 'Store a 3D view selection (app-only)',
            description: 'Called by the 3D viewer when the user selects a part (or clears the selection), with the current camera. Hidden from the model.',
            inputSchema: {
                viewId: z.string().max(100),
                part: z.string().max(MAX_PART_CHARS).nullable(),
                camera: z.unknown().optional()
            },
            _meta: { ui: { resourceUri: VIEWER_3D_URI, visibility: ['app'] } }
        },
        async ({ viewId, part, camera }) => {
            const out = selectInView(viewId, part, camera);
            if (!out.ok) return text(out.error, { isError: true });
            return text(`Stored: ${describeView(out.value)}`, { structuredContent: publicView(out.value) });
        }
    );

    server.registerTool(
        'view_3d_state',
        {
            title: 'Read the 3D view selection',
            description: 'Return the part the user selected in a view_3d viewer and the camera at that moment, or "nothing selected yet". Without viewId the most recent view is used.',
            inputSchema: z.object({ viewId: z.string().max(100).optional().describe('viewId from view_3d (default: the latest)') }),
            annotations: { readOnlyHint: true }
        },
        async ({ viewId }) => {
            const v = viewId ? getView(viewId) : latestView();
            if (!v) {
                return viewId ? text(`Unknown or expired 3D view "${viewId}".`, { isError: true }) : text('No 3D view yet. Call view_3d first.');
            }
            return text(describeView(v), { structuredContent: publicView(v) });
        }
    );
}
