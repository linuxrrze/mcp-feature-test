// sample_llm and list_roots in the protocol matrix (stdio/HTTP × both eras).
// A second client declares sampling (with tools and context) and roots; its
// scripted "LLM" echoes what it was sent, so the assertions can check the
// request the server built. Called from matrix.mjs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ProtocolError } from '@modelcontextprotocol/client';
import { makeClient, textOf } from '../helpers.mjs';

const CAPS = { sampling: { tools: {}, context: {} }, roots: { listChanged: true } };
const ROOTS = [
    { uri: 'file:///tmp', name: 'Temp' },
    { uri: 'file:///definitely/not/here', name: 'Missing' }
];

const blocksOf = content => (Array.isArray(content) ? content : [content]);

/** Echoes the request; with tools offered, first asks for count_letters (or `toolName`). */
export function fakeLlm(requests, { toolName = 'count_letters', alwaysTool = false } = {}) {
    return async req => {
        const p = req.params;
        requests.push(p);
        const last = blocksOf(p.messages.at(-1).content);
        if (p.tools && (alwaysTool || !last.some(b => b.type === 'tool_result'))) {
            return {
                role: 'assistant',
                model: 'fake-llm-1',
                stopReason: 'toolUse',
                content: [{ type: 'tool_use', id: `call-${requests.length}`, name: toolName, input: { word: 'strawberry', letter: 'r' } }]
            };
        }
        const answer = last.find(b => b.type === 'tool_result')?.content?.[0]?.text;
        return {
            role: 'assistant',
            model: 'fake-llm-1',
            stopReason: 'endTurn',
            content: { type: 'text', text: answer ? `The tool said ${answer}.` : `I saw ${p.messages.length} message(s).` }
        };
    };
}

/**
 * @param {object} o
 * @param {'stdio'|'http'} o.transport
 * @param {'modern'|'legacy'} o.era
 * @param {(client: import('@modelcontextprotocol/client').Client) => Promise<{close(): Promise<void>}>} o.connect
 */
export function samplingRootsTests({ transport, era, connect }) {
    describe('sampling and roots', () => {
        const name = `sampler-${transport}-${era}`;
        const { client } = makeClient(era, { name, capabilities: CAPS });
        const requests = [];
        let llm = fakeLlm(requests);
        let rootsAnswer = async () => ({ roots: ROOTS });
        client.setRequestHandler('sampling/createMessage', req => llm(req));
        client.setRequestHandler('roots/list', () => rootsAnswer());
        const call = (tool, args = {}) => client.callTool({ name: tool, arguments: args });
        let conn;
        before(async () => {
            conn = await connect(client);
        });
        after(async () => {
            await conn?.close();
        });

        it('sample_llm: one round with system prompt, model hint and maxTokens', async () => {
            const n = requests.length;
            const r = await call('sample_llm', { prompt: 'Say hi', maxTokens: 50, temperature: 0.2 });
            assert.ok(!r.isError, textOf(r));
            assert.equal(requests.length - n, 1);
            const p = requests.at(-1);
            assert.deepEqual(p.messages, [{ role: 'user', content: { type: 'text', text: 'Say hi' } }]);
            assert.equal(p.maxTokens, 50);
            assert.equal(p.temperature, 0.2);
            assert.match(p.systemPrompt, /concise assistant/);
            assert.equal(p.modelPreferences.hints[0].name, 'claude');
            assert.equal(p.includeContext, undefined, 'includeContext "none" is not sent');
            assert.equal(p.tools, undefined);
            assert.deepEqual(
                { model: r.structuredContent.model, stopReason: r.structuredContent.stopReason, rounds: r.structuredContent.rounds, reply: r.structuredContent.reply },
                { model: 'fake-llm-1', stopReason: 'endTurn', rounds: 1, reply: 'I saw 1 message(s).' }
            );
            assert.match(textOf(r), /Model: fake-llm-1 {3}stop reason: endTurn/);
        });

        it('sample_llm: empty systemPrompt and modelHint are left out', async () => {
            await call('sample_llm', { systemPrompt: '', modelHint: '' });
            const p = requests.at(-1);
            assert.equal(p.systemPrompt, undefined);
            assert.equal(p.modelPreferences, undefined);
        });

        it('sample_llm withImage: a PNG image message before the prompt', async () => {
            const r = await call('sample_llm', { withImage: true });
            const p = requests.at(-1);
            assert.equal(p.messages.length, 2);
            assert.equal(p.messages[0].content.type, 'image');
            assert.equal(p.messages[0].content.mimeType, 'image/png');
            assert.equal(Buffer.from(p.messages[0].content.data, 'base64').subarray(1, 4).toString(), 'PNG');
            assert.equal(p.messages[1].content.text, 'Describe this image in one sentence.');
            assert.equal(r.structuredContent.sent.image, true);
        });

        it('sample_llm includeContext is passed through when the client declares sampling.context', async () => {
            await call('sample_llm', { includeContext: 'thisServer' });
            assert.equal(requests.at(-1).includeContext, 'thisServer');
        });

        it('sample_llm useTools: tool_use → server runs count_letters → tool_result round', async () => {
            const n = requests.length;
            const r = await call('sample_llm', { useTools: true });
            assert.ok(!r.isError, textOf(r));
            const [first, second] = requests.slice(n);
            assert.equal(requests.length - n, 2);
            assert.deepEqual(first.tools.map(t => t.name), ['count_letters']);
            assert.deepEqual(first.toolChoice, { mode: 'auto' });
            // Round 2 carries the whole conversation: prompt, the model's tool_use, the server's tool_result.
            assert.deepEqual(second.messages.map(m => m.role), ['user', 'assistant', 'user']);
            assert.equal(second.messages[1].content[0].type, 'tool_use');
            assert.deepEqual(second.messages[2].content, [{ type: 'tool_result', toolUseId: 'call-' + (n + 1), content: [{ type: 'text', text: '3' }] }]);
            assert.equal(r.structuredContent.rounds, 2);
            assert.deepEqual(r.structuredContent.toolCalls, [{ name: 'count_letters', input: { word: 'strawberry', letter: 'r' }, result: '3', isError: false }]);
            assert.equal(r.structuredContent.reply, 'The tool said 3.');
        });

        it('sample_llm useTools: unknown tools get an error result; the loop stops after 3 rounds', async () => {
            const prev = llm;
            llm = fakeLlm(requests, { toolName: 'rm_rf', alwaysTool: true });
            try {
                const n = requests.length;
                const r = await call('sample_llm', { useTools: true });
                assert.equal(requests.length - n, 3);
                assert.equal(r.structuredContent.rounds, 3);
                assert.equal(r.structuredContent.toolCalls.length, 2);
                assert.ok(r.structuredContent.toolCalls.every(c => c.isError));
                assert.equal(requests.at(-1).messages.at(-1).content[0].isError, true);
                assert.match(textOf(r), /Stopped after 3 rounds although the model still asked for a tool/);
            } finally {
                llm = prev;
            }
        });

        it('sample_llm: a user who rejects the request ends the call with an error', async () => {
            const prev = llm;
            llm = async () => {
                throw new ProtocolError(-1, 'User rejected sampling request');
            };
            try {
                const pending = call('sample_llm');
                if (era === 'modern') {
                    // 2026-07-28: the client fulfils the input request itself, so its own error ends the call client-side.
                    await assert.rejects(pending, /User rejected sampling request/);
                } else {
                    const r = await pending;
                    assert.equal(r.isError, true);
                    assert.match(textOf(r), /failed: User rejected sampling request/);
                }
            } finally {
                llm = prev;
            }
        });

        it('list_roots: reports each root and whether it exists on the server machine', async () => {
            const r = await call('list_roots');
            assert.ok(!r.isError, textOf(r));
            assert.deepEqual(
                r.structuredContent.roots.map(x => [x.name, x.uri, x.path, x.existsOnServer]),
                [
                    ['Temp', 'file:///tmp', '/tmp', true],
                    ['Missing', 'file:///definitely/not/here', '/definitely/not/here', false]
                ]
            );
            assert.match(textOf(r), /exposes 2 roots:\n {2}Temp: file:\/\/\/tmp {2}\(exists on the server’s machine\)/);
            assert.equal(r.structuredContent.listChanged.declared, true);
        });

        it('list_roots: an empty list', async () => {
            const prev = rootsAnswer;
            rootsAnswer = async () => ({ roots: [] });
            try {
                const r = await call('list_roots');
                assert.deepEqual(r.structuredContent.roots, []);
                assert.match(textOf(r), /exposes no roots \(empty list\)/);
            } finally {
                rootsAnswer = prev;
            }
        });

        if (era === 'legacy') {
            it('list_roots counts notifications/roots/list_changed (2025-era only)', async () => {
                const before = (await call('list_roots')).structuredContent.listChanged.notificationsSeen;
                await client.sendRootsListChanged();
                await client.sendRootsListChanged();
                let seen = before;
                for (let i = 0; i < 50 && seen < before + 2; i++) {
                    await new Promise(r => setTimeout(r, 20));
                    seen = (await call('list_roots')).structuredContent.listChanged.notificationsSeen;
                }
                assert.equal(seen, before + 2);
                assert.match(textOf(await call('list_roots')), /list_changed notifications received: \d+ \(last at /);
            });
        } else {
            it('list_roots explains that list_changed does not exist on 2026-07-28', async () => {
                await assert.rejects(client.sendRootsListChanged(), /not supported by the negotiated protocol version/);
                const r = await call('list_roots');
                assert.equal(r.structuredContent.listChanged.notificationsExist, false);
                assert.match(textOf(r), /do not exist on 2026-07-28/);
            });
        }

        it('a client without sampling or roots gets tool errors, not a hang', async () => {
            const { client: bare } = makeClient(era, { name: `no-sampling-${transport}-${era}`, capabilities: { sampling: {}, elicitation: {} } });
            const c = await connect(bare);
            try {
                const roots = await bare.callTool({ name: 'list_roots', arguments: {} });
                assert.equal(roots.isError, true);
                assert.match(textOf(roots), /did not declare the roots capability/);
                const tools = await bare.callTool({ name: 'sample_llm', arguments: { useTools: true } });
                assert.match(textOf(tools), /not sampling\.tools/);
                const ctx = await bare.callTool({ name: 'sample_llm', arguments: { includeContext: 'allServers' } });
                assert.match(textOf(ctx), /not sampling\.context/);
            } finally {
                await c.close();
            }
        });
    });
}
