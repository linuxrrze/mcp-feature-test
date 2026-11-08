// Regenerates the README screenshots in docs/images/ (needs `npm run build` and Chromium).
//   npm run screenshots
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ROOT } from '../test/helpers.mjs';
import { fillDemoAnswers, launchBrowser, openDialogLab } from '../test/ui/harness.mjs';
import { createFlow, handleFlowRequest, setFlowBaseUrl } from '../dist/flows.js';

const outDir = join(ROOT, 'docs', 'images');
mkdirSync(outDir, { recursive: true });

const { browser, reason } = await launchBrowser();
if (!browser) {
    console.error(`Cannot take screenshots: ${reason}`);
    process.exit(1);
}

try {
    // ---- MCP App (Dialog Lab) in a minimal host, both themes
    for (const theme of ['light', 'dark']) {
        const lab = await openDialogLab(browser, { theme, viewport: { width: 760, height: 1400 } });
        try {
            await fillDemoAnswers(lab);
            await lab.app.locator('#submit').click();
            await lab.app.locator('#status.ok').waitFor();
            const height = await lab.page.frame({ url: /about:srcdoc/ }).evaluate(() => document.querySelector('main').getBoundingClientRect().bottom + 8);
            const file = join(outDir, `dialog-lab-${theme}.png`);
            await lab.page.screenshot({ path: file, clip: { x: 0, y: 0, width: 760, height: Math.ceil(height) } });
            console.log(file);
        } finally {
            await lab.close();
        }
    }

    // ---- URL-mode elicitation page (what the browser shows for elicit_url)
    const srv = createServer((req, res) => handleFlowRequest(req, res) || res.writeHead(404).end());
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    setFlowBaseUrl(`http://127.0.0.1:${srv.address().port}`);
    try {
        for (const theme of ['light', 'dark']) {
            const { url } = await createFlow('The MCP tool “elicit_url” asked you to connect a (fake) account.');
            const ctx = await browser.newContext({ viewport: { width: 640, height: 560 }, colorScheme: theme, deviceScaleFactor: 2 });
            const page = await ctx.newPage();
            await page.goto(url);
            await page.locator('#t').fill('sk-test-123');
            const file = join(outDir, `url-flow-${theme}.png`);
            await page.screenshot({ path: file });
            console.log(file);
            await ctx.close();
        }
    } finally {
        srv.close();
    }
} finally {
    await browser.close();
}
