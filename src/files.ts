/**
 * Sample files for the file-related tools, and validation of uploaded files.
 *
 *  - A fixed set of small, valid files (CSV, PNG, PDF, WAV, Markdown) generated
 *    in code, served by the `test://files/{name}` resource template and embedded
 *    in `return_files` results. Only these names exist: the template never maps
 *    a name to a path, so there is nothing to traverse.
 *  - Strict base64 decoding with a size cap (UPLOAD_MAX_BYTES), used by the
 *    Dialog Lab upload and the experimental `x-mcp-file` tool. File contents
 *    are never logged or stored; callers get size and SHA-256 back.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** Extension id of the experimental files extension (draft, not part of the MCP spec). */
export const FILES_EXTENSION = 'io.modelcontextprotocol/files';
export const FILES_URI_PREFIX = 'test://files/';
export const FILES_URI_TEMPLATE = `${FILES_URI_PREFIX}{name}`;

export interface SampleFile {
    name: string;
    title: string;
    description: string;
    mimeType: string;
    /** Text files carry `text`, binary files carry `bytes`. */
    text?: string;
    bytes?: Buffer;
}

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
}

/** A valid RGB PNG with a diagonal colour gradient (default 32×32, about 100 bytes). */
export function makePng(width = 32, height = 32): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    // compression, filter, interlace: 0
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 3 + 1);
        raw[row] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            const p = row + 1 + x * 3;
            raw[p] = Math.round((x / (width - 1)) * 255);
            raw[p + 1] = Math.round((y / (height - 1)) * 160);
            raw[p + 2] = 229 - Math.round(((x + y) / (width + height - 2)) * 150);
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// ------------------------------------------------------------------ WAV

/** A short mono 8-bit PCM WAV: a sine tone with a fade in/out. */
export function makeWav(seconds = 0.4, hz = 440, sampleRate = 8000): Buffer {
    const n = Math.round(seconds * sampleRate);
    const buf = Buffer.alloc(44 + n);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + n, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate, 28); // byte rate
    buf.writeUInt16LE(1, 32); // block align
    buf.writeUInt16LE(8, 34); // bits per sample
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(n, 40);
    const fade = Math.round(sampleRate * 0.05);
    for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / fade, (n - 1 - i) / fade);
        buf[44 + i] = 128 + Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 90 * env);
    }
    return buf;
}

// ------------------------------------------------------------------ PDF

/** A one-page PDF 1.4 with correct xref offsets (about 600 bytes). */
export function makePdf(line = 'Hello from mcp-feature-test'): Buffer {
    const esc = line.replace(/[\\()]/g, c => `\\${c}`);
    const stream = `BT /F1 18 Tf 36 96 Td (${esc}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

// ------------------------------------------------------------ the fixed set

const CSV = ['id,name,colour,score', '1,Ada,#4f46e5,0.95', '2,Grace,#e11d48,0.88', '3,Linus,#15803d,0.71', ''].join('\r\n');

const NOTES = [
    '# Linked notes',
    '',
    'This file was returned as a `resource_link` by the `return_files` tool.',
    'A client that shows it fetched it with `resources/read test://files/linked-notes.md`.',
    ''
].join('\n');

export const SAMPLE_FILES: readonly SampleFile[] = [
    { name: 'sample.csv', title: 'Sample CSV', description: 'Three rows of CSV (text resource)', mimeType: 'text/csv', text: CSV },
    { name: 'gradient.png', title: 'Gradient PNG', description: '32×32 PNG image (blob resource)', mimeType: 'image/png', bytes: makePng() },
    { name: 'sample.pdf', title: 'Sample PDF', description: 'One-page PDF (non-image blob resource)', mimeType: 'application/pdf', bytes: makePdf() },
    { name: 'beep.wav', title: 'Beep WAV', description: '0.4 s 440 Hz tone, 8 kHz 8-bit mono WAV', mimeType: 'audio/wav', bytes: makeWav() },
    {
        name: 'linked-notes.md',
        title: 'Linked notes',
        description: 'Markdown file that is only returned as a resource_link',
        mimeType: 'text/markdown',
        text: NOTES
    }
];

export function getSampleFile(name: string): SampleFile | undefined {
    return SAMPLE_FILES.find(f => f.name === name);
}

export function sampleFileUri(name: string): string {
    return `${FILES_URI_PREFIX}${name}`;
}

export function sampleFileSize(f: SampleFile): number {
    return f.bytes ? f.bytes.length : Buffer.byteLength(f.text ?? '', 'utf8');
}

/** `resources/read` contents for one sample file. */
export function sampleFileContents(f: SampleFile) {
    const uri = sampleFileUri(f.name);
    return f.bytes ? { uri, mimeType: f.mimeType, blob: f.bytes.toString('base64') } : { uri, mimeType: f.mimeType, text: f.text ?? '' };
}

// ------------------------------------------------------------------ uploads

export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** UPLOAD_MAX_BYTES (decoded bytes per file); invalid or missing values fall back to 10 MiB. */
export function uploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.UPLOAD_MAX_BYTES;
    if (raw === undefined || raw.trim() === '') return DEFAULT_UPLOAD_MAX_BYTES;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_UPLOAD_MAX_BYTES;
}

/**
 * Largest HTTP request body the server accepts: one maximum-size upload in
 * base64 plus 1 MiB for the JSON-RPC envelope and the other arguments.
 */
export function maxRequestBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
    return Math.ceil(uploadMaxBytes(env) / 3) * 4 + 1024 * 1024;
}

export const formatBytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1024 * 1024)).toFixed(2)} MiB`;

export type DecodeResult = { ok: true; bytes: Buffer } | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode standard (RFC 4648 §4) base64 strictly: no whitespace, no data: URL
 * prefix, correct padding. The decoded size is checked against `maxBytes`
 * before anything is allocated.
 */
export function decodeBase64Strict(data: string, maxBytes: number): DecodeResult {
    if (data.length % 4 !== 0 || !BASE64.test(data)) {
        return { ok: false, error: 'data is not valid base64 (RFC 4648, padded, no whitespace or data: prefix)' };
    }
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const size = (data.length / 4) * 3 - pad;
    if (size > maxBytes) {
        return { ok: false, error: `file is ${formatBytes(size)} (${size} bytes), above the limit of ${formatBytes(maxBytes)} (${maxBytes} bytes, UPLOAD_MAX_BYTES)` };
    }
    const bytes = Buffer.from(data, 'base64');
    // Buffer.from silently drops bad characters; the regex above makes that impossible, but double-check.
    if (bytes.length !== size) return { ok: false, error: 'data is not valid base64' };
    return { ok: true, bytes };
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const sha256Base64Url = (b: Uint8Array) => createHash('sha256').update(b).digest('base64url');
