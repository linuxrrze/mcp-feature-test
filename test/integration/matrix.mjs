// The protocol matrix shared by the stdio and HTTP suites: every interactive
// tool, accepted / declined / cancelled by a scripted user, on one transport
// and one protocol era.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { APP_MIME, defaultAnswer, makeClient, MODERN, submitFlowPage, textOf } from '../helpers.mjs';

const FORM_TOOLS = [
    { name: 'elicit_confirm', declined: /User DECLINED/, cancelled: /User CANCELLED/ },
    { name: 'elicit_all_field_types', declined: /User declined the form\./, cancelled: /User cancelled the form\./ },
    { name: 'elicit_parallel', declined: /declined or cancelled/, cancelled: /declined or cancelled/ },
    { name: 'elicit_wizard', declined: /Wizard declined at step 1\./, cancelled: /Wizard cancelled at step 1/ },
    { name: 'elicit_url', declined: /declined the browser flow/, cancelled: /cancelled the browser flow/ }
];

/**
 * @param {object} o
 * @param {'stdio'|'http'} o.transport
 * @param {'modern'|'legacy'} o.era
 * @param {(client: import('@modelcontextprotocol/client').Client) => Promise<{close(): Promise<void>}>} o.connect
 * @param {() => import('../helpers.mjs').LogCollector} o.logs server stderr (JSON lines)
 */
export function eraSuite({ transport, era, connect, logs }) {
    describe(`${transport} × ${era === 'modern' ? `modern (${MODERN})` : 'legacy (2025-11-25)'}`, () => {
        let policy = defaultAnswer;
        const clientName = `matrix-${transport}-${era}`;
        const { client, dialogs, completions } = makeClient(era, { name: clientName, answer: p => policy(p) });
        let conn;
        const call = (name, args = {}, opts) => client.callTool({ name, arguments: args }, opts);
        const withPolicy = async (p, fn) => {
            const prev = policy;
            policy = p;
            try {
                return await fn();
            } finally {
                policy = prev;
            }
        };

        before(async () => {
            conn = await connect(client);
        });
        after(async () => {
            await conn?.close();
        });

        it(`negotiates the ${era} era`, async () => {
            assert.equal(client.getProtocolEra(), era);
            const r = await call('inspect_client');
            assert.equal(r.structuredContent.era, era);
            assert.equal(r.structuredContent.transport, transport);
            assert.equal(r.structuredContent.clientInfo.name, clientName);
            assert.equal(r.structuredContent.negotiatedProtocolVersion, era === 'modern' ? MODERN : '2025-11-25');
            assert.deepEqual(r.structuredContent.summary.elicitation, { form: true, url: true });
            assert.equal(r.structuredContent.summary.ui.supported, true);
            if (era === 'modern') assert.ok(r.structuredContent.requestEnvelope, 'modern requests carry an envelope');
        });

        it('logs the client capabilities to stderr', async () => {
            const event = era === 'modern' ? 'client.seen' : 'client.connected';
            const ev = await logs().waitFor(e => e.event === event && e.clientInfo?.name === clientName);
            assert.equal(ev.era, era);
            assert.equal(ev.transport, transport);
            assert.deepEqual(ev.summary.ui.mimeTypes, [APP_MIME]);
            assert.deepEqual(ev.capabilities.elicitation, { form: {}, url: {} });
        });

        // ------------------------------------------------------------ accept
        describe('user accepts', () => {
            it('elicit_confirm', async () => {
                const r = await call('elicit_confirm', { item: 'x.txt' });
                assert.match(textOf(r), /ACCEPTED and confirmed – pretended to delete "x\.txt"/);
            });

            it('elicit_confirm with the box unchecked', async () => {
                const r = await withPolicy(async () => ({ action: 'accept', content: { confirm: false } }), () => call('elicit_confirm'));
                assert.match(textOf(r), /left the box unchecked/);
            });

            for (const variant of ['all', 'basic', 'formats', 'enums']) {
                it(`elicit_all_field_types (${variant})`, async () => {
                    const before = dialogs.length;
                    const r = await call('elicit_all_field_types', { variant });
                    assert.ok(!r.isError, textOf(r));
                    assert.equal(r.structuredContent.variant, variant);
                    const shown = dialogs[before];
                    assert.equal(shown.mode ?? 'form', 'form');
                    assert.deepEqual(Object.keys(r.structuredContent.content).sort(), Object.keys(defaultsPlusEmail(shown)).sort());
                });
            }

            it('elicit_parallel (two dialogs in one round)', async () => {
                const before = dialogs.length;
                const r = await call('elicit_parallel');
                assert.equal(textOf(r), 'Hello Tester, you are feeling 🙂 fine.');
                assert.equal(dialogs.length - before, 2);
            });

            it('elicit_wizard (3 chained steps with signed requestState)', async () => {
                const before = dialogs.length;
                const r = await call('elicit_wizard');
                assert.match(textOf(r), /Imaginary pizza ordered for Ada: large, thin, basil, olives/);
                assert.deepEqual(r.structuredContent, { name: 'Ada', size: 'large', crust: 'thin', toppings: ['basil', 'olives'], notes: 'extra crispy' });
                const steps = dialogs.slice(before).map(d => d.message.split('\n')[0]);
                assert.equal(steps.length, 3);
                assert.match(steps[0], /Step 1 of 3/);
                assert.match(steps[1], /Step 2 of 3 – toppings for a large thin pizza \(max 5\)/);
                assert.match(steps[2], /Step 3 of 3/);
                assert.match(dialogs.at(-1).message, /Toppings: 🌿 Basil, 🫒 Olives/);
            });

            it('elicit_wizard: step 2 limits depend on step 1', async () => {
                const before = dialogs.length;
                await withPolicy(
                    async p => {
                        if ('size' in (p.requestedSchema?.properties ?? {})) return { action: 'accept', content: { name: 'Bo', size: 'small', crust: 'classic' } };
                        if ('toppings' in (p.requestedSchema?.properties ?? {})) return { action: 'cancel' };
                        return defaultAnswer(p);
                    },
                    async () => {
                        const r = await call('elicit_wizard');
                        assert.equal(textOf(r), 'Wizard cancelled at step 2.');
                    }
                );
                assert.equal(dialogs[before + 1].requestedSchema.properties.toppings.maxItems, 2);
            });

            it('elicit_url (browser page submitted before accepting)', async () => {
                const before = dialogs.length;
                const r = await call('elicit_url');
                assert.match(textOf(r), /Browser flow completed\. Server received a token \(14 chars, masked: sk…56\)/);
                const d = dialogs[before];
                assert.equal(d.mode, 'url');
                assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+\/flow\/[0-9a-f-]{36}$/);
                if (transport === 'http') assert.ok(d.url.startsWith(conn.base), 'HTTP mode serves flows from the main server');
            });

            it('elicit_url: accepting and never finishing the page times out with an error', async () => {
                const r = await withPolicy(async () => ({ action: 'accept' }), () => call('elicit_url'));
                assert.equal(r.isError, true);
                assert.match(textOf(r), /browser page was not submitted within 2 s/);
            });

            // Open WebUI (and the spec) may answer "accept" as soon as the link is opened,
            // before the page is submitted: the tool must wait for the page.
            const acceptEarlyThenSubmit = async p => {
                if (p.mode !== 'url') return defaultAnswer(p);
                setTimeout(() => void submitFlowPage(p.url, 'sk-early-accept'), 300);
                return { action: 'accept' };
            };

            it('elicit_url: early accept (link opened), page submitted afterwards', async () => {
                const r = await withPolicy(acceptEarlyThenSubmit, () => call('elicit_url'));
                assert.ok(!r.isError, textOf(r));
                assert.match(textOf(r), /Browser flow completed\. Server received a token \(15 chars, masked: sk…pt\)/);
            });

            it('elicit_url: early accept, cancelling the call while waiting stops the wait', async () => {
                const ac = new AbortController();
                const pending = withPolicy(
                    async p => {
                        if (p.mode === 'url') setTimeout(() => ac.abort('user clicked stop'), 200);
                        return p.mode === 'url' ? { action: 'accept' } : defaultAnswer(p);
                    },
                    () => call('elicit_url', {}, { signal: ac.signal })
                );
                await assert.rejects(pending);
            });

            if (era === 'legacy') {
                it('elicit_url_legacy_push sends notifications/elicitation/complete', async () => {
                    const before = dialogs.length;
                    const r = await call('elicit_url_legacy_push');
                    assert.match(textOf(r), /completion notification was sent/);
                    const d = dialogs[before];
                    assert.equal(d.mode, 'url');
                    assert.ok(d.elicitationId);
                    await waitUntil(() => completions.some(c => c.elicitationId === d.elicitationId));
                });

                it('elicit_url_legacy_push: early accept, page submitted afterwards', async () => {
                    const before = dialogs.length;
                    const r = await withPolicy(acceptEarlyThenSubmit, () => call('elicit_url_legacy_push'));
                    assert.ok(!r.isError, textOf(r));
                    assert.match(textOf(r), /Browser flow completed \(token sk…pt; completion notification was sent/);
                    await waitUntil(() => completions.some(c => c.elicitationId === dialogs[before].elicitationId));
                });
            } else {
                it('elicit_url_legacy_push is refused on 2026-07-28 with a clear message', async () => {
                    const r = await call('elicit_url_legacy_push');
                    assert.equal(r.isError, true);
                    assert.match(textOf(r), /unavailable on this connection \(protocol 2026-07-28\).*Use elicit_url/s);
                });
            }
        });

        // --------------------------------------------------- decline / cancel
        for (const action of ['decline', 'cancel']) {
            describe(`user ${action}s`, () => {
                for (const t of FORM_TOOLS) {
                    it(t.name, async () => {
                        const r = await withPolicy(async () => ({ action }), () => call(t.name));
                        assert.ok(!r.isError, textOf(r));
                        assert.match(textOf(r), action === 'decline' ? t.declined : t.cancelled);
                    });
                }
                it(`elicit_wizard at the confirmation step`, async () => {
                    const r = await withPolicy(
                        async p => ('confirm' in (p.requestedSchema?.properties ?? {}) ? { action } : defaultAnswer(p)),
                        () => call('elicit_wizard')
                    );
                    assert.equal(textOf(r), `Wizard ${action === 'decline' ? 'declined' : 'cancelled'} at the confirmation step.`);
                });
                if (era === 'legacy') {
                    it('elicit_url_legacy_push', async () => {
                        const r = await withPolicy(async () => ({ action }), () => call('elicit_url_legacy_push'));
                        assert.match(textOf(r), new RegExp(`User ${action === 'decline' ? 'declined' : 'cancelled'} the browser flow`));
                    });
                }
            });
        }

        // --------------------------------------------- progress / cancellation
        it('slow_task reports progress', async () => {
            const progress = [];
            const r = await call('slow_task', { steps: 3, delayMs: 50 }, { onprogress: p => progress.push(p) });
            assert.equal(textOf(r), 'Finished 3 steps.');
            assert.deepEqual(progress.map(p => p.progress), [1, 2, 3]);
            assert.equal(progress[0].total, 3);
            assert.equal(progress[2].message, 'Step 3/3');
        });

        it('slow_task without a progress token says so', async () => {
            const r = await call('slow_task', { steps: 1, delayMs: 50 });
            assert.match(textOf(r), /Client did not request progress/);
        });

        it('slow_task stops when the client aborts (AbortSignal)', async () => {
            const ac = new AbortController();
            const started = Date.now();
            const pending = call('slow_task', { steps: 40, delayMs: 100 }, { signal: ac.signal, onprogress: p => p.progress >= 2 && ac.abort('user pressed stop') });
            await assert.rejects(pending);
            assert.ok(Date.now() - started < 3000, 'aborted promptly');
            const ev = await logs().waitFor(e => e.event === 'tool.result' && e.tool === 'slow_task' && e.outcome === 'cancelled' && e.client === clientName);
            assert.ok(ev.ms < 3500, `server stopped early (${ev.ms} ms)`);
        });

        // ---------------------------------------------------------- MCP Apps
        it('advertises the MCP App on the tool and serves the ui:// resource', async () => {
            const { tools } = await client.listTools();
            const app = tools.find(t => t.name === 'open_dialog_lab');
            assert.equal(app._meta.ui.resourceUri, 'ui://feature-test/dialog-lab.html');
            const submit = tools.find(t => t.name === 'dialog_lab_submit');
            assert.deepEqual(submit._meta.ui.visibility, ['app'], 'app-only tool must be marked for hosts to hide it from the model');
            const res = await client.readResource({ uri: 'ui://feature-test/dialog-lab.html' });
            assert.equal(res.contents[0].mimeType, APP_MIME);
            assert.equal(res.contents[0]._meta.ui.prefersBorder, true);
            assert.ok(res.contents[0].text.length > 10_000);
        });

        it('open_dialog_lab → dialog_lab_submit → dialog_lab_results round trip', async () => {
            const opened = await call('open_dialog_lab', { question: 'Q?', items: ['a', 'b'] });
            assert.deepEqual(opened.structuredContent.items, ['a', 'b']);
            const marker = `#${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
            const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            const stored = await call('dialog_lab_submit', { data: { color: marker, rating: 5, sketchPng: png } });
            assert.match(textOf(stored), /Stored submission #\d+/);
            const r = await call('dialog_lab_results', { limit: 1 });
            assert.equal(r.structuredContent.submissions[0].data.color, marker);
            assert.match(r.structuredContent.submissions[0].data.sketch, /PNG data URL/);
            const img = r.content.find(c => c.type === 'image');
            assert.equal(img?.mimeType, 'image/png');
        });

        // -------------------------------------------------------------- files
        it('return_files: one result with every file content form, all readable', async () => {
            const r = await call('return_files');
            assert.ok(!r.isError);
            assert.deepEqual(r.content.map(c => c.type), ['text', 'resource', 'resource', 'resource', 'resource_link', 'image', 'audio']);
            assert.match(r.content[0].text, /7 content blocks/);
            const [, csv, png, pdf, link, image, audio] = r.content;
            assert.equal(csv.resource.mimeType, 'text/csv');
            assert.match(csv.resource.text, /^id,name/);
            assert.equal(Buffer.from(png.resource.blob, 'base64').toString('latin1', 1, 4), 'PNG');
            assert.equal(Buffer.from(pdf.resource.blob, 'base64').toString('latin1', 0, 5), '%PDF-');
            assert.equal(image.mimeType, 'image/png');
            assert.equal(Buffer.from(audio.data, 'base64').toString('latin1', 8, 12), 'WAVE');
            // The link is resolvable through resources/read, and its declared size is right.
            assert.equal(link.uri, 'test://files/linked-notes.md');
            const read = await client.readResource({ uri: link.uri });
            assert.equal(read.contents[0].mimeType, link.mimeType);
            assert.equal(Buffer.byteLength(read.contents[0].text), link.size);
            assert.equal(r.structuredContent.items.length, 6);
            const { resourceTemplates } = await client.listResourceTemplates();
            assert.ok(resourceTemplates.some(t => t.uriTemplate === 'test://files/{name}'));
        });

        it('dialog_lab_upload accepts a 5 MiB file (above the SDK default HTTP body limit) and reports its SHA-256', async () => {
            const bytes = Buffer.alloc(5 * 1024 * 1024, 0x5a);
            const r = await call('dialog_lab_upload', { name: 'five.bin', mimeType: 'application/octet-stream', data: bytes.toString('base64') });
            assert.ok(!r.isError, textOf(r));
            assert.equal(r.structuredContent.size, bytes.length);
            assert.equal(r.structuredContent.sha256, createHash('sha256').update(bytes).digest('hex'));
        });

        it('upload_file_experimental takes an inline x-mcp-file argument', async () => {
            const bytes = Buffer.from('hello files extension');
            const r = await call('upload_file_experimental', {
                file: { id: 'f1', name: 'hello.txt', mimeType: 'text/plain', size: bytes.length, data: bytes.toString('base64') }
            });
            assert.ok(!r.isError, textOf(r));
            assert.equal(r.structuredContent.sha256, createHash('sha256').update(bytes).digest('hex'));
        });

        it('elicit_format_probe: a tolerated probe (pattern) is reported with what the client returned', async () => {
            const before = dialogs.length;
            const r = await call('elicit_format_probe', { variant: 'pattern' });
            assert.ok(!r.isError, textOf(r));
            assert.equal(dialogs.length - before, 1);
            // The SDK client parses the request with the spec schema, which drops unknown keywords like
            // `pattern` before the dialog handler sees it (the wire carries it: see http.test.mjs).
            assert.equal(dialogs[before].requestedSchema.properties.pattern.type, 'string');
            assert.match(textOf(r), /OUTSIDE the MCP elicitation spec/);
            assert.match(textOf(r), /pattern – .*accepted, returned "ABC-123" \(string\)/);
            assert.deepEqual(r.structuredContent.results, [{ probe: 'pattern', action: 'accept', content: { pattern: 'ABC-123' } }]);
        });

        it('elicit_format_probe: decline is reported per probe', async () => {
            const r = await withPolicy(async () => ({ action: 'decline' }), () => call('elicit_format_probe', { variant: 'pattern' }));
            assert.match(textOf(r), /user declined the dialog/);
        });

        // The official TypeScript client validates elicitation requests against the spec schema
        // and refuses non-spec types and formats. The server sends them unchanged; how the
        // refusal surfaces depends on the era.
        const expectRejected = async pending => {
            if (era === 'modern') {
                await assert.rejects(pending, e => e.code === -32602 && /Invalid elicitation request/.test(e.message));
            } else {
                const r = await pending;
                assert.equal(r.isError, true);
                assert.match(textOf(r), /Fulfilling input required by 'tools\/call' failed: Invalid elicitation request/);
            }
        };

        it('elicit_format_probe: a client that rejects the schema ends the call with an error (SDK client refuses format "color")', async () => {
            const before = dialogs.length;
            await expectRejected(call('elicit_format_probe', { variant: 'color' }));
            assert.equal(dialogs.length, before, 'the scripted user never saw a dialog');
        });

        it('elicit_format_probe "all": probes run one per round with signed state until the client refuses one', async () => {
            const before = dialogs.length;
            await expectRejected(call('elicit_format_probe', { variant: 'all' }));
            assert.deepEqual(dialogs.slice(before).map(d => Object.keys(d.requestedSchema.properties)[0]), ['pattern']);
            await logs().waitFor(e => e.event === 'tool.input_required' && e.client === clientName && e.inputRequests?.[0] === 'probe_color (form)');
        });

        // ------------------------------------------------ capability handling
        it('a client without elicitation gets a tool error, not a hang', async () => {
            const { client: bare } = makeClient(era, { name: `bare-${transport}-${era}`, capabilities: {} });
            const c = await connect(bare);
            try {
                for (const name of ['elicit_confirm', 'elicit_wizard', 'elicit_url']) {
                    const r = await bare.callTool({ name, arguments: {} });
                    assert.equal(r.isError, true, name);
                    assert.match(textOf(r), /did not declare (form|url)-mode elicitation support/);
                }
                const info = await bare.callTool({ name: 'inspect_client', arguments: {} });
                assert.deepEqual(info.structuredContent.summary.elicitation, { form: false, url: false });
            } finally {
                await c.close();
            }
        });

        it('list_seen_clients includes this client', async () => {
            const r = await call('list_seen_clients');
            const me = r.structuredContent.clients.find(c => c.clientInfo?.name === clientName);
            assert.ok(me, textOf(r));
            assert.equal(me.era, era);
            assert.equal(me.transport, transport);
            assert.ok(me.toolCalls > 10);
            if (era === 'legacy') assert.equal(me.connections, 1);
        });

        it('logged the client once (dedupe) and every tool call', () => {
            const event = era === 'modern' ? 'client.seen' : 'client.connected';
            const mine = logs().events.filter(e => e.event === event && e.clientInfo?.name === clientName);
            assert.equal(mine.length, 1);
            const results = logs().events.filter(e => e.event === 'tool.result' && e.client === clientName);
            assert.ok(results.some(e => e.tool === 'elicit_confirm' && e.responses === 'confirm=decline'));
            assert.ok(results.some(e => e.tool === 'elicit_confirm' && e.responses === 'confirm=cancel'));
            assert.ok(results.some(e => e.tool === 'elicit_url' && e.outcome === 'error'));
        });
    });
}

function defaultsPlusEmail(dialog) {
    const props = dialog.requestedSchema?.properties ?? {};
    const out = Object.fromEntries(Object.entries(props).filter(([, s]) => 'default' in s));
    if ('email' in props) out.email = true;
    return out;
}

export async function waitUntil(cond, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('condition not met in time');
        await new Promise(r => setTimeout(r, 20));
    }
}

export { submitFlowPage };
