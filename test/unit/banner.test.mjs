import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { baseEnv, ROOT } from '../helpers.mjs';
import { printImageBanner } from '../../dist/banner.js';

const dir = mkdtempSync(join(tmpdir(), 'banner-'));
const file = join(dir, 'image-banner.txt');
writeFileSync(file, 'MCP-FEATURE-TEST\n1.2.3');

describe('container startup banner (builtin mode)', () => {
    it('prints the banner file, adding a final newline', () => {
        const out = [];
        assert.equal(printImageBanner(file, s => out.push(s)), true);
        assert.deepEqual(out, ['MCP-FEATURE-TEST\n1.2.3\n']);
    });

    it('is silent when the file is missing (outside the image)', () => {
        const out = [];
        assert.equal(printImageBanner(join(dir, 'missing.txt'), s => out.push(s)), false);
        assert.deepEqual(out, []);
    });

    it('stdio mode writes it to stderr, never to stdout (the protocol channel)', async () => {
        const child = spawn(process.execPath, [join(ROOT, 'dist', 'stdio.js')], {
            env: baseEnv({ IMAGE_BANNER_FILE: file }),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => (stdout += d));
        child.stderr.on('data', d => (stderr += d));
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`no ready log; stderr: ${stderr}`)), 10_000);
            child.stderr.on('data', () => {
                if (stderr.includes('stdio.ready')) {
                    clearTimeout(t);
                    resolve();
                }
            });
        });
        child.kill();
        assert.ok(stderr.startsWith('MCP-FEATURE-TEST\n1.2.3\n'), `stderr starts with the banner: ${stderr.slice(0, 80)}`);
        assert.equal(stdout, '');
    });
});
