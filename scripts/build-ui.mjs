// Bundles ui/dialog-lab.ts and inlines it into a single self-contained HTML file
// (MCP App iframes are sandboxed; a single file avoids CSP/resource-domain setup).
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// zod (used by @modelcontextprotocol/ext-apps) re-exports all ~50 locales through its `z`
// namespace, which esbuild cannot tree-shake: ~258 KB per app. Only English is used
// (zod calls config(en()) itself), so the locale index is reduced to `en`. This keeps the
// 3D viewer below 1 MiB, the largest single SSE event the Python MCP SDK accepts.
const zodEnglishOnly = {
    name: 'zod-english-only',
    setup(b) {
        b.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, args => ({
            contents: 'export { default as en } from "./en.js";',
            loader: 'js',
            resolveDir: dirname(args.path)
        }));
    }
};
const common = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none', plugins: [zodEnglishOnly] };

const result = await build({ ...common, entryPoints: ['ui/dialog-lab.ts'] });
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('ui/dialog-lab.html', 'utf8').replace('<!--APP_SCRIPT-->', () => `<script type="module">${js}</script>`);
mkdirSync('dist/ui', { recursive: true });
writeFileSync('dist/ui/dialog-lab.html', html);
console.log(`dist/ui/dialog-lab.html (${(html.length / 1024).toFixed(1)} KiB)`);

// The colour picker app (pick_color), built the same way.
for (const name of ['color-picker']) {
    const r = await build({ ...common, entryPoints: [`ui/${name}.ts`] });
    const appJs = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    const page = readFileSync(`ui/${name}.html`, 'utf8').replace('<!--APP_SCRIPT-->', () => `<script type="module">${appJs}</script>`);
    writeFileSync(`dist/ui/${name}.html`, page);
    console.log(`dist/ui/${name}.html (${(page.length / 1024).toFixed(1)} KiB)`);
}

// The 3D viewer (view_3d): three.js is bundled (tree-shaken) into the page, so it needs no network, WASM or eval.
{
    const r = await build({ ...common, entryPoints: ['ui/viewer-3d.ts'] });
    const appJs = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    const page = readFileSync('ui/viewer-3d.html', 'utf8').replace('<!--APP_SCRIPT-->', () => `<script type="module">${appJs}</script>`);
    writeFileSync('dist/ui/viewer-3d.html', page);
    console.log(`dist/ui/viewer-3d.html (${(page.length / 1024).toFixed(1)} KiB)`);
}
