// change_lists / update_live_resource internals, in-process over the 2025-era
// handshake: the shared lists, per-instance re-registration, resources/subscribe,
// the per-request mode used for 2026-07-28 HTTP, and the HTTP notifier bridge.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configureLogger } from '../../dist/log.js';
import { createFeatureTestServer } from '../../dist/server.js';
import {
    LIVE_RESOURCE_URI,
    MAX_DYNAMIC_PER_KIND,
    MAX_SUBSCRIPTIONS_PER_CONNECTION,
    dynamicSnapshot,
    forwardToNotifier,
    listEventListenerCount,
    resetLists
} from '../../dist/listChanged.js';

configureLogger({ level: 'silent' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = [];

async function connect(options = {}) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createFeatureTestServer({ transport: 'stdio', ...options });
    await server.connect(serverSide);
    const client = new Client({ name: 'lists-unit', version: '1.0.0' }, { capabilities: {} });
    const got = [];
    for (const m of ['tools/list_changed', 'prompts/list_changed', 'resources/list_changed', 'resources/updated']) {
        client.setNotificationHandler(`notifications/${m}`, n => got.push(n.params?.uri ? `${m} ${n.params.uri}` : m));
    }
    await client.connect(clientSide);
    open.push(client);
    return { client, server, got };
}
const change = (client, args = {}) => client.callTool({ name: 'change_lists', arguments: args });
const dyn = list => list.filter(n => n.includes('dynamic'));

afterEach(async () => {
    for (const c of open.splice(0)) await c.close().catch(() => {});
    resetLists();
});

describe('shared dynamic lists', () => {
    it('one client’s change re-registers the items on every live instance', async () => {
        const a = await connect();
        const b = await connect();
        await change(a.client);
        await sleep(20);
        assert.deepEqual(b.got.sort(), ['prompts/list_changed', 'resources/list_changed', 'tools/list_changed']);
        assert.deepEqual(dyn((await b.client.listTools()).tools.map(t => t.name)), ['dynamic_tool_1']);
        assert.match((await b.client.getPrompt({ name: 'dynamic_prompt_1' })).messages[0].content.text, /dynamic_prompt_1/);
    });

    it('a new instance starts with the current items', async () => {
        const a = await connect();
        await change(a.client, { kind: 'resource' });
        const late = await connect();
        assert.deepEqual(dyn((await late.client.listResources()).resources.map(r => r.uri)), ['test://dynamic/1']);
    });

    it(`caps each list at ${MAX_DYNAMIC_PER_KIND} and numbers items without reuse until reset`, async () => {
        const { client } = await connect();
        for (let i = 0; i < MAX_DYNAMIC_PER_KIND + 2; i++) await change(client, { kind: 'tool' });
        assert.equal(dynamicSnapshot().tools.length, MAX_DYNAMIC_PER_KIND);
        await change(client, { action: 'remove', kind: 'tool' });
        await change(client, { kind: 'tool' });
        assert.deepEqual(dynamicSnapshot().tools, ['dynamic_tool_1', 'dynamic_tool_2', 'dynamic_tool_4']);
        assert.deepEqual(resetLists(), ['tool']);
        assert.deepEqual(dynamicSnapshot(), { tools: [], prompts: [], resources: [] });
    });

    it('remove on an empty list changes nothing and sends nothing', async () => {
        const { client, got } = await connect();
        const r = await change(client, { action: 'remove' });
        assert.deepEqual(r.structuredContent.changed, []);
        await sleep(20);
        assert.deepEqual(got, []);
    });

    it('a closed instance stops following the lists', async () => {
        const before = listEventListenerCount();
        const { client } = await connect();
        assert.equal(listEventListenerCount(), before + 1);
        await client.close();
        await sleep(10);
        assert.equal(listEventListenerCount(), before);
    });

    it('a per-request instance (2026-07-28 HTTP) shows the current items but does not follow changes', async () => {
        const writer = await connect();
        await change(writer.client, { kind: 'tool' });
        const before = listEventListenerCount();
        const pr = await connect({ perRequest: true });
        assert.equal(listEventListenerCount(), before, 'no listener');
        assert.deepEqual(dyn((await pr.client.listTools()).tools.map(t => t.name)), ['dynamic_tool_1']);
        await change(writer.client, { kind: 'tool' });
        await sleep(20);
        assert.deepEqual(pr.got, []);
    });
});

describe('resources/subscribe (2025-era)', () => {
    it('resources/updated only reaches subscribed connections, and only for that URI', async () => {
        const sub = await connect();
        const quiet = await connect();
        await sub.client.subscribeResource({ uri: LIVE_RESOURCE_URI });
        const r = await sub.client.callTool({ name: 'update_live_resource', arguments: {} });
        assert.equal(r.structuredContent.legacySubscribers, 1);
        await sleep(20);
        assert.deepEqual(sub.got, [`resources/updated ${LIVE_RESOURCE_URI}`]);
        assert.deepEqual(quiet.got, []);
        assert.equal(JSON.parse((await quiet.client.readResource({ uri: LIVE_RESOURCE_URI })).contents[0].text).counter, 1);
    });

    it(`refuses more than ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions per connection`, async () => {
        const { client } = await connect();
        for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) await client.subscribeResource({ uri: `test://x/${i}` });
        await client.subscribeResource({ uri: 'test://x/0' }); // already subscribed: fine
        await assert.rejects(client.subscribeResource({ uri: 'test://x/overflow' }), /At most 32 resource subscriptions/);
    });
});

describe('forwardToNotifier (2026-07-28 HTTP)', () => {
    it('maps each change onto the handler’s notifier and reports open streams', async () => {
        const calls = [];
        const notify = {
            toolsChanged: () => calls.push('tools'),
            promptsChanged: () => calls.push('prompts'),
            resourcesChanged: () => calls.push('resources'),
            resourceUpdated: uri => calls.push(`updated ${uri}`)
        };
        const stop = forwardToNotifier(notify, () => 7);
        try {
            const pr = await connect({ perRequest: true });
            const r = await change(pr.client);
            assert.match(textOf(r), /open listen streams on this HTTP server: 7/);
            await pr.client.callTool({ name: 'update_live_resource', arguments: {} });
            assert.deepEqual(calls, ['tools', 'prompts', 'resources', `updated ${LIVE_RESOURCE_URI}`]);
        } finally {
            stop();
        }
        calls.length = 0;
        resetLists();
        assert.deepEqual(calls, [], 'stopped forwarding');
    });
});

const textOf = r => r.content.map(c => c.text).join('\n');
