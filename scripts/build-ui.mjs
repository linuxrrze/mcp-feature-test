// Bundles ui/dialog-lab.ts and inlines it into a single self-contained HTML file
// (MCP App iframes are sandboxed; a single file avoids CSP/resource-domain setup).
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const result = await build({
    entryPoints: ['ui/dialog-lab.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none'
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('ui/dialog-lab.html', 'utf8').replace('<!--APP_SCRIPT-->', () => `<script type="module">${js}</script>`);
mkdirSync('dist/ui', { recursive: true });
writeFileSync('dist/ui/dialog-lab.html', html);
console.log(`dist/ui/dialog-lab.html (${(html.length / 1024).toFixed(1)} KiB)`);
