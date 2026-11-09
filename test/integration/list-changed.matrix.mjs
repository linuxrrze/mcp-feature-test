// change_lists and update_live_resource in the protocol matrix (stdio/HTTP ×
// both eras): do list_changed and resources/updated notifications reach the
// client, and do the lists really change? On 2026-07-28 a client only gets
// them over a subscriptions/listen stream; on 2025-era connections list_changed
// is unsolicited and resources/updated needs resources/subscribe.
// Called from matrix.mjs.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { makeClient, textOf } from '../helpers.mjs';

const LIVE = 'test://live/counter';
const METHODS = {
    tools: 'notifications/tools/list_changed',
    prompts: 'notifications/prompts/list_changed',
    resources: 'notifications/resources/list_changed',
    updated: 'notifications/resources/updated'
};
const ALL = { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: [LIVE] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** How long "nothing arrives" is given to prove itself. */
const QUIET_MS = 300;

/** A client that records every change notification as 'tools' | 'prompts' | 'resources' | 'updated <uri>'. */
function recordingClient(era, name) {
    const { client } = makeClient(era, { name, capabilities: {} });
    const got = [];
    for (const [key, method] of Object.entries(METHODS)) {
        client.setNotificationHandler(method, n => got.push(key === 'updated' ? `updated ${n.params.uri}` : key));
    }
    return { client, got };
}

async function waitFor(got, entry, ms = 5000) {
    for (let t = 0; t < ms && !got.includes(entry); t += 20) await sleep(20);
    assert.ok(got.includes(entry), `expected ${entry}, got [${got.join(', ')}]`);
}

const dynamicNames = (list, key = 'name') => list.map(x => x[key]).filter(n => n.includes('dynamic'));

/**
 * @param {object} o
 * @param {'stdio'|'http'} o.transport
 * @param {'modern'|'legacy'} o.era
 * @param {(client: import('@modelcontextprotocol/client').Client) => Promise<{close(): Promise<void>}>} o.connect
 */
export function listChangedTests({ transport, era, connect }) {
    describe('list-changed notifications and resource subscriptions', () => {
        const { client, got } = recordingClient(era, `lists-${transport}-${era}`);
        const call = (action = 'add', kind = 'all') => client.callTool({ name: 'change_lists', arguments: { action, kind } });
        let conn;
        let subscription;
        before(async () => {
            conn = await connect(client);
            await call('reset');
            if (era === 'modern') subscription = await client.listen(ALL);
            else await client.subscribeResource({ uri: LIVE });
        });
        after(async () => {
            await call('reset').catch(() => {});
            await subscription?.close();
            await conn?.close();
        });
        beforeEach(() => {
            got.length = 0;
        });

        it('declares listChanged for tools, prompts and resources, and resources.subscribe', () => {
            const caps = client.getServerCapabilities();
            assert.equal(caps.tools.listChanged, true);
            assert.equal(caps.prompts.listChanged, true);
            assert.deepEqual(caps.resources, { subscribe: true, listChanged: true });
            if (era === 'modern') assert.deepEqual(subscription.honoredFilter, ALL, 'the listen stream honors every requested type');
        });

        it('add: one notification per list, and the new items are listed and usable', async () => {
            const r = await call('add');
            assert.ok(!r.isError, textOf(r));
            assert.deepEqual(r.structuredContent.changed, ['tool', 'prompt', 'resource']);
            assert.match(textOf(r), /Sent notifications\/tools\/list_changed, notifications\/prompts\/list_changed, notifications\/resources\/list_changed/);
            for (const k of ['tools', 'prompts', 'resources']) await waitFor(got, k);

            assert.deepEqual(dynamicNames((await client.listTools()).tools), ['dynamic_tool_1']);
            assert.deepEqual(dynamicNames((await client.listPrompts()).prompts), ['dynamic_prompt_1']);
            assert.deepEqual(dynamicNames((await client.listResources()).resources, 'uri'), ['test://dynamic/1']);
            assert.match(textOf(await client.callTool({ name: 'dynamic_tool_1', arguments: {} })), /Hello from dynamic_tool_1/);
            assert.match((await client.getPrompt({ name: 'dynamic_prompt_1' })).messages[0].content.text, /This is dynamic_prompt_1/);
            assert.match((await client.readResource({ uri: 'test://dynamic/1' })).contents[0].text, /Dynamic resource 1/);
        });

        it('kind=tool changes only the tool list', async () => {
            await call('add', 'tool');
            await waitFor(got, 'tools');
            await sleep(QUIET_MS);
            assert.deepEqual(got, ['tools']);
            assert.deepEqual(dynamicNames((await client.listTools()).tools), ['dynamic_tool_1', 'dynamic_tool_2']);
        });

        it(`stops at the limit and sends nothing when nothing changed`, async () => {
            await call('add', 'tool');
            const full = await call('add', 'tool');
            assert.deepEqual(full.structuredContent.changed, []);
            assert.deepEqual(full.structuredContent.atLimit, ['tool']);
            assert.match(textOf(full), /Nothing changed[\s\S]*Already at the limit of 3 for: tool/);
            assert.deepEqual(full.structuredContent.dynamic.tools, ['dynamic_tool_1', 'dynamic_tool_2', 'dynamic_tool_3']);
        });

        it('remove: the newest item disappears and calling it fails', async () => {
            await call('remove', 'tool');
            await waitFor(got, 'tools');
            assert.deepEqual(dynamicNames((await client.listTools()).tools), ['dynamic_tool_1', 'dynamic_tool_2']);
            const gone = await client.callTool({ name: 'dynamic_tool_3', arguments: {} }).catch(e => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
            assert.equal(gone.isError, true);
            assert.match(textOf(gone), /dynamic_tool_3/);
        });

        it('reset: every dynamic item is gone', async () => {
            const r = await call('reset');
            assert.deepEqual(r.structuredContent.dynamic, { tools: [], prompts: [], resources: [] });
            for (const k of ['tools', 'prompts', 'resources']) await waitFor(got, k);
            assert.deepEqual(dynamicNames((await client.listTools()).tools), []);
            assert.deepEqual(dynamicNames((await client.listResources()).resources, 'uri'), []);
        });

        it('update_live_resource: resources/updated for the subscribed URI, and the content changed', async () => {
            const before = JSON.parse((await client.readResource({ uri: LIVE })).contents[0].text).counter;
            const r = await client.callTool({ name: 'update_live_resource', arguments: {} });
            assert.ok(!r.isError, textOf(r));
            assert.equal(r.structuredContent.counter, before + 1);
            await waitFor(got, `updated ${LIVE}`);
            assert.equal(JSON.parse((await client.readResource({ uri: LIVE })).contents[0].text).counter, before + 1);
            assert.equal(r.structuredContent.legacySubscribers, era === 'legacy' ? 1 : 0);
        });

        if (era === 'legacy') {
            it('2025-era: after resources/unsubscribe no resources/updated arrives (list_changed still does)', async () => {
                await client.unsubscribeResource({ uri: LIVE });
                try {
                    await client.callTool({ name: 'update_live_resource', arguments: {} });
                    await call('add', 'prompt');
                    await waitFor(got, 'prompts');
                    await sleep(QUIET_MS);
                    assert.deepEqual(got, ['prompts']);
                } finally {
                    await client.subscribeResource({ uri: LIVE });
                    await call('reset');
                }
            });

            it('2025-era: a client that never subscribed still gets list_changed, but no resources/updated', async () => {
                const other = recordingClient(era, `lists-quiet-${transport}`);
                const c = await connect(other.client);
                try {
                    await other.client.callTool({ name: 'change_lists', arguments: { kind: 'resource' } });
                    await other.client.callTool({ name: 'update_live_resource', arguments: {} });
                    await waitFor(other.got, 'resources');
                    await sleep(QUIET_MS);
                    assert.deepEqual(other.got, ['resources']);
                } finally {
                    await other.client.callTool({ name: 'change_lists', arguments: { action: 'reset' } });
                    await c.close();
                }
            });
        } else {
            it('2026-07-28: resources/subscribe does not exist; listen() is the only way', async () => {
                await assert.rejects(client.subscribeResource({ uri: LIVE }), /not supported by the negotiated protocol version/);
            });

            it('2026-07-28: a client without a listen stream gets no notifications at all', async () => {
                const other = recordingClient(era, `lists-quiet-${transport}`);
                const c = await connect(other.client);
                try {
                    await other.client.callTool({ name: 'change_lists', arguments: {} });
                    await other.client.callTool({ name: 'update_live_resource', arguments: {} });
                    // On HTTP the listening client (same server process) sees them, which proves they were sent.
                    if (transport === 'http') for (const k of ['tools', 'prompts', 'resources', `updated ${LIVE}`]) await waitFor(got, k);
                    await sleep(QUIET_MS);
                    assert.deepEqual(other.got, []);
                    assert.deepEqual(dynamicNames((await other.client.listTools()).tools), ['dynamic_tool_1'], 'the list itself did change');
                } finally {
                    await other.client.callTool({ name: 'change_lists', arguments: { action: 'reset' } });
                    await c.close();
                }
            });

            it('2026-07-28: a filter narrows what arrives; after close() nothing arrives', async () => {
                const other = recordingClient(era, `lists-narrow-${transport}`);
                const c = await connect(other.client);
                try {
                    const sub = await other.client.listen({ promptsListChanged: true });
                    assert.deepEqual(sub.honoredFilter, { promptsListChanged: true });
                    await other.client.callTool({ name: 'change_lists', arguments: {} });
                    await other.client.callTool({ name: 'update_live_resource', arguments: {} });
                    await waitFor(other.got, 'prompts');
                    await sleep(QUIET_MS);
                    assert.deepEqual(other.got, ['prompts']);

                    await sub.close();
                    assert.equal(await sub.closed, 'local');
                    other.got.length = 0;
                    await other.client.callTool({ name: 'change_lists', arguments: { action: 'reset' } });
                    await sleep(QUIET_MS);
                    assert.deepEqual(other.got, []);
                } finally {
                    await other.client.callTool({ name: 'change_lists', arguments: { action: 'reset' } });
                    await c.close();
                }
            });
        }

        if (transport === 'http') {
            it('HTTP: the lists are shared, so another client’s change reaches this one', async () => {
                const other = recordingClient(era, `lists-other-${transport}-${era}`);
                const c = await connect(other.client);
                try {
                    await other.client.callTool({ name: 'change_lists', arguments: { kind: 'tool' } });
                    await waitFor(got, 'tools');
                    assert.deepEqual(dynamicNames((await client.listTools()).tools), ['dynamic_tool_1']);
                    await other.client.callTool({ name: 'update_live_resource', arguments: {} });
                    await waitFor(got, `updated ${LIVE}`);
                } finally {
                    await other.client.callTool({ name: 'change_lists', arguments: { action: 'reset' } });
                    await c.close();
                }
            });
        }
    });
}
