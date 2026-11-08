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

// The colour picker app (pick_color), built the same way.
for (const name of ['color-picker']) {
    const r = await build({ entryPoints: [`ui/${name}.ts`], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none' });
    const appJs = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    const page = readFileSync(`ui/${name}.html`, 'utf8').replace('<!--APP_SCRIPT-->', () => `<script type="module">${appJs}</script>`);
    writeFileSync(`dist/ui/${name}.html`, page);
    console.log(`dist/ui/${name}.html (${(page.length / 1024).toFixed(1)} KiB)`);
}

// The 3D viewer (view_3d): three.js is bundled (tree-shaken) into the page, so it needs no network, WASM or eval.
{
    const r = await build({ entryPoints: ['ui/viewer-3d.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none' });
    const appJs = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    const page = readFileSync('ui/viewer-3d.html', 'utf8').replace('<!--APP_SCRIPT-->', () => `<script type="module">${appJs}</script>`);
    writeFileSync('dist/ui/viewer-3d.html', page);
    console.log(`dist/ui/viewer-3d.html (${(page.length / 1024).toFixed(1)} KiB)`);
}
