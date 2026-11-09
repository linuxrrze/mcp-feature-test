// dist/stdio.js spawned as a child process, once per connection (as MCP hosts do).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectStdio, ERAS, makeClient, textOf } from '../helpers.mjs';
import { eraSuite } from './matrix.mjs';

for (const era of ERAS) {
    let logs;
    eraSuite({
        transport: 'stdio',
        era,
        logs: () => logs,
        connect: async client => {
            const c = await connectStdio(client);
            // The first connection of the suite owns the log collector the assertions look at.
            logs ??= c.logs;
            return c;
        }
    });
}

describe('stdio specifics', () => {
    it('never writes logs to stdout (only JSON-RPC)', async () => {
        // StdioClientTransport would fail to parse any non-JSON line on stdout; a full
        // round trip with debug logging enabled proves stdout stays clean.
        const { client } = makeClient('legacy', { name: 'stdout-check' });
        const c = await connectStdio(client, { LOG_LEVEL: 'debug', LOG_FORMAT: 'text' });
        try {
            let parseErrors = 0;
            client.onerror = () => parseErrors++;
            const r = await client.callTool({ name: 'elicit_confirm', arguments: {} });
            assert.match(textOf(r), /ACCEPTED/);
            assert.equal(parseErrors, 0);
            assert.match(c.logs.raw, /INFO {2}\[client\.connected\] client connected: stdout-check/);
        } finally {
            await c.close();
        }
    });

    it('serves URL-flow pages on FLOW_HOST and advertises FLOW_PUBLIC_URL', async () => {
        const { client, dialogs } = makeClient('modern', { name: 'flow-env', answer: async () => ({ action: 'cancel' }) });
        const c = await connectStdio(client, { FLOW_HOST: '0.0.0.0', FLOW_PUBLIC_URL: 'http://flows.example.test:9999/' });
        try {
            await client.callTool({ name: 'elicit_url', arguments: {} });
            assert.match(dialogs[0].url, /^http:\/\/flows\.example\.test:9999\/flow\/[0-9a-f-]{36}$/);
            const ev = await c.logs.waitFor(e => e.event === 'flows.listening');
            assert.equal(ev.host, '0.0.0.0');
            assert.match(ev.msg, /\(listening on 0\.0\.0\.0:\d+\)$/);
            // The page itself is reachable on the real port.
            const res = await fetch(`http://127.0.0.1:${ev.port}${new URL(dialogs[0].url).pathname}`);
            assert.equal(res.status, 200);
        } finally {
            await c.close();
        }
    });

    it('falls back to a free port when FLOW_PORT is taken', async () => {
        const { createServer } = await import('node:net');
        const blocker = createServer();
        await new Promise(r => blocker.listen(0, '127.0.0.1', r));
        const busy = blocker.address().port;
        const { client, dialogs } = makeClient('legacy', { name: 'flow-busy', answer: async () => ({ action: 'cancel' }) });
        const c = await connectStdio(client, { FLOW_PORT: String(busy) });
        try {
            await client.callTool({ name: 'elicit_url', arguments: {} });
            const port = Number(new URL(dialogs[0].url).port);
            assert.notEqual(port, busy);
            assert.ok(await c.logs.waitFor(e => e.event === 'flows' && e.level === 'warn'));
        } finally {
            await c.close();
            blocker.close();
        }
    });
});
