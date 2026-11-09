// sample_llm / list_roots pieces that need no client: the server-side tool the
// sampled model may call, and the capability checks (in-process, 2025 handshake).
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { textOf } from '../helpers.mjs';
import { configureLogger } from '../../dist/log.js';
import { createFeatureTestServer } from '../../dist/server.js';
import { COUNT_LETTERS_TOOL, MAX_SAMPLING_ROUNDS, runSamplingTool } from '../../dist/samplingRoots.js';

configureLogger({ level: 'silent' });

describe('runSamplingTool (count_letters)', () => {
    it('counts case-insensitively', () => {
        assert.deepEqual(runSamplingTool('count_letters', { word: 'Strawberry', letter: 'R' }), { text: '3', isError: false });
        assert.deepEqual(runSamplingTool('count_letters', { word: 'MCP', letter: 'x' }), { text: '0', isError: false });
    });
    it('counts a non-BMP character as one letter', () => {
        assert.deepEqual(runSamplingTool('count_letters', { word: '🍕a🍕', letter: '🍕' }), { text: '2', isError: false });
    });
    it('rejects bad input and unknown tools as error results', () => {
        assert.equal(runSamplingTool('count_letters', { word: 'abc', letter: 'ab' }).isError, true);
        assert.equal(runSamplingTool('count_letters', { word: 3, letter: 'a' }).isError, true);
        assert.equal(runSamplingTool('count_letters', {}).isError, true);
        assert.match(runSamplingTool('delete_everything', {}).text, /Unknown tool "delete_everything"/);
    });
    it('describes the tool with a valid object schema', () => {
        assert.equal(COUNT_LETTERS_TOOL.inputSchema.type, 'object');
        assert.deepEqual(COUNT_LETTERS_TOOL.inputSchema.required, ['word', 'letter']);
        assert.equal(MAX_SAMPLING_ROUNDS, 3);
    });
});

describe('capability checks', () => {
    let client;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });
    async function connect(capabilities) {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await createFeatureTestServer({ transport: 'stdio' }).connect(serverSide);
        client = new Client({ name: 'caps-client', version: '1.0.0' }, { capabilities });
        if (capabilities.sampling) client.setRequestHandler('sampling/createMessage', async () => assert.fail('must not be called'));
        await client.connect(clientSide);
        return client;
    }

    it('without sampling: sample_llm explains instead of failing', async () => {
        await connect({});
        const r = await client.callTool({ name: 'sample_llm', arguments: {} });
        assert.equal(r.isError, true);
        assert.match(textOf(r), /caps-client 1\.0\.0 did not declare the sampling capability/);
    });

    it('without roots: list_roots explains instead of failing', async () => {
        await connect({ sampling: {} });
        const r = await client.callTool({ name: 'list_roots', arguments: {} });
        assert.equal(r.isError, true);
        assert.match(textOf(r), /did not declare the roots capability/);
    });

    it('never sends tools or includeContext the client did not declare', async () => {
        await connect({ sampling: {} });
        for (const args of [{ useTools: true }, { includeContext: 'thisServer' }, { includeContext: 'allServers' }]) {
            const r = await client.callTool({ name: 'sample_llm', arguments: args });
            assert.equal(r.isError, true, JSON.stringify(args));
        }
    });

    it('annotates sample_llm as open-world and both tools as read-only', async () => {
        await connect({});
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(by.sample_llm.annotations.openWorldHint, true);
        assert.equal(by.sample_llm.annotations.readOnlyHint, true);
        assert.equal(by.list_roots.annotations.readOnlyHint, true);
        assert.deepEqual(by.sample_llm.inputSchema.properties.includeContext.enum, ['none', 'thisServer', 'allServers']);
    });
});
