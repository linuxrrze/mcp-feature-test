// Generated sample files (valid bytes) and strict base64 upload decoding.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import {
    DEFAULT_UPLOAD_MAX_BYTES,
    SAMPLE_FILES,
    crc32,
    decodeBase64Strict,
    getSampleFile,
    makePdf,
    makePng,
    makeWav,
    maxRequestBodyBytes,
    sampleFileContents,
    sampleFileSize,
    sha256Base64Url,
    uploadMaxBytes
} from '../../dist/files.js';

describe('generated sample files', () => {
    it('crc32 matches the standard check value', () => {
        assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    });

    it('PNG: signature, chunk CRCs and pixel data are valid', () => {
        const png = makePng(32, 32);
        assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const chunks = [];
        for (let p = 8; p < png.length; ) {
            const len = png.readUInt32BE(p);
            const type = png.toString('ascii', p + 4, p + 8);
            const data = png.subarray(p + 8, p + 8 + len);
            assert.equal(png.readUInt32BE(p + 8 + len), crc32(png.subarray(p + 4, p + 8 + len)), `${type} CRC`);
            chunks.push({ type, data });
            p += 12 + len;
        }
        assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
        assert.equal(chunks[0].data.readUInt32BE(0), 32);
        assert.equal(chunks[0].data.readUInt32BE(4), 32);
        assert.equal(inflateSync(chunks[1].data).length, (32 * 3 + 1) * 32);
    });

    it('WAV: RIFF header fields are consistent', () => {
        const wav = makeWav(0.4, 440, 8000);
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.readUInt32LE(4), wav.length - 8);
        assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
        assert.equal(wav.readUInt16LE(20), 1, 'PCM');
        assert.equal(wav.readUInt32LE(24), 8000);
        assert.equal(wav.toString('ascii', 36, 40), 'data');
        assert.equal(wav.readUInt32LE(40), 3200);
        assert.equal(wav.length, 44 + 3200);
    });

    it('PDF: xref offsets point at their objects and startxref at the table', () => {
        const pdf = makePdf('a (tricky) \\ line').toString('latin1');
        assert.ok(pdf.startsWith('%PDF-1.4\n'));
        assert.ok(pdf.endsWith('%%EOF\n'));
        const startxref = Number(pdf.match(/startxref\n(\d+)\n/)[1]);
        assert.equal(pdf.slice(startxref, startxref + 4), 'xref');
        const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
        assert.equal(entries.length, 5);
        entries.forEach((off, i) => assert.equal(pdf.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
        const len = Number(pdf.match(/\/Length (\d+)/)[1]);
        const stream = pdf.match(/stream\n([\s\S]*?)\nendstream/)[1];
        assert.equal(stream.length, len);
        assert.match(stream, /\(a \\\(tricky\\\) \\\\ line\)/, 'parentheses and backslashes escaped');
    });

    it('the fixed set has unique names, sizes and resource contents', () => {
        const names = SAMPLE_FILES.map(f => f.name);
        assert.equal(new Set(names).size, names.length);
        for (const f of SAMPLE_FILES) {
            assert.match(f.name, /^[a-z0-9-]+\.[a-z]+$/, 'plain names only');
            const c = sampleFileContents(f);
            assert.equal(c.uri, `test://files/${f.name}`);
            const bytes = c.blob ? Buffer.from(c.blob, 'base64') : Buffer.from(c.text, 'utf8');
            assert.equal(bytes.length, sampleFileSize(f));
        }
        for (const bad of ['../etc/passwd', '', 'SAMPLE.CSV', 'sample.csv/', '%2e%2e']) assert.equal(getSampleFile(bad), undefined, bad);
    });
});

describe('upload decoding', () => {
    const b64 = s => Buffer.from(s).toString('base64');

    it('decodes valid base64 (with and without padding) and empty input', () => {
        for (const s of ['', 'a', 'ab', 'abc', 'hello world']) {
            const r = decodeBase64Strict(b64(s), 100);
            assert.ok(r.ok, s);
            assert.equal(r.bytes.toString(), s);
        }
    });

    it('rejects malformed base64', () => {
        for (const bad of ['abc', 'ab=c', 'YW Jj', 'YWJj\n', 'data:text/plain;base64,YWJj', 'YW-j', 'YW_j', 'Y===', '====']) {
            const r = decodeBase64Strict(bad, 100);
            assert.equal(r.ok, false, JSON.stringify(bad));
            assert.match(r.error, /not valid base64/);
        }
    });

    it('rejects oversized data before decoding, with the limit in the message', () => {
        assert.ok(decodeBase64Strict(b64('x'.repeat(10)), 10).ok);
        const r = decodeBase64Strict(b64('x'.repeat(11)), 10);
        assert.equal(r.ok, false);
        assert.match(r.error, /11 bytes\), above the limit of 10 B \(10 bytes, UPLOAD_MAX_BYTES\)/);
    });

    it('UPLOAD_MAX_BYTES: default, valid values and fallbacks', () => {
        assert.equal(DEFAULT_UPLOAD_MAX_BYTES, 10 * 1024 * 1024);
        assert.equal(uploadMaxBytes({}), DEFAULT_UPLOAD_MAX_BYTES);
        assert.equal(uploadMaxBytes({ UPLOAD_MAX_BYTES: '2048' }), 2048);
        for (const bad of ['', ' ', '0', '-5', '1.5', 'ten', '1e400']) assert.equal(uploadMaxBytes({ UPLOAD_MAX_BYTES: bad }), DEFAULT_UPLOAD_MAX_BYTES, bad);
    });

    it('the request body limit fits a maximum-size upload in base64', () => {
        const env = { UPLOAD_MAX_BYTES: '3000' };
        assert.ok(maxRequestBodyBytes(env) >= b64('x'.repeat(3000)).length + 1024 * 1024);
        assert.ok(maxRequestBodyBytes({}) > (DEFAULT_UPLOAD_MAX_BYTES * 4) / 3);
    });

    it('sha256Base64Url is unpadded base64url', () => {
        const d = sha256Base64Url(Buffer.from('abc'));
        assert.equal(d, createHash('sha256').update('abc').digest('base64url'));
        assert.ok(!d.includes('=') && !d.includes('+') && !d.includes('/'));
    });
});
