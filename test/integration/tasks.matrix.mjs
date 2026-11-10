// run_task / run_task_required in the protocol matrix (stdio/HTTP × both eras).
// The official TypeScript client has no task runtime (it rejects
// `resultType: "task"`), so these tests send the task messages raw over the
// client's own transport and check exactly what the server puts on the wire.
// 2025-11-25: params.task, {task}, tasks/get|result|list|cancel, elicitation
// tagged with related-task. 2026-07-28: the io.modelcontextprotocol/tasks
// extension, resultType "task", tasks/get|update|cancel.
// Called from matrix.mjs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeClient, MODERN, textOf } from '../helpers.mjs';

export const TASKS_EXT = 'io.modelcontextprotocol/tasks';
const RELATED = 'io.modelcontextprotocol/related-task';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const QUICK = { seconds: 0.2, steps: 2 };

/**
 * Send raw JSON-RPC requests over a connected SDK client's transport. On
 * 2026-07-28 every request carries its own envelope (version, capabilities,
 * client info), so the channel adds it like the SDK would.
 */
export function rawChannel(client, { era, capabilities, name }) {
    const transport = client.transport;
    const pending = new Map();
    let n = 0;
    const deliver = transport.onmessage;
    transport.onmessage = (msg, extra) => {
        if (msg && 'id' in msg && !('method' in msg) && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }));
            else p.resolve(msg.result);
            return;
        }
        deliver?.call(transport, msg, extra);
    };
    const envelope = {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': capabilities,
        'io.modelcontextprotocol/clientInfo': { name, version: '0.0.1' }
    };
    return (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = `raw-${++n}`;
            pending.set(id, { resolve, reject });
            const body = era === 'modern' ? { ...params, _meta: { ...envelope, ...params._meta } } : params;
            transport.send({ jsonrpc: '2.0', id, method, params: body }).catch(e => {
                pending.delete(id);
                reject(e);
            });
        });
}

/** Poll tasks/get until `pred(task)` holds. */
async function pollUntil(raw, taskId, pred, ms = 5000) {
    let task;
    for (let t = 0; t < ms; t += 25) {
        task = await raw('tasks/get', { taskId });
        if (pred(task)) return task;
        await sleep(25);
    }
    assert.fail(`task ${taskId} never matched; last state ${JSON.stringify(task)}`);
}
/** A JSON-RPC error with this code; over HTTP the SDK transport may surface it as an HTTP error carrying the body. */
const rpcError = code => e => e.code === code || new RegExp(`"code":${code}\\b`).test(e.message);
const terminal = t => ['completed', 'failed', 'cancelled'].includes(t.status);

/**
 * @param {object} o
 * @param {'stdio'|'http'} o.transport
 * @param {'modern'|'legacy'} o.era
 * @param {(client: import('@modelcontextprotocol/client').Client) => Promise<{close(): Promise<void>}>} o.connect
 */
export function tasksTests({ transport, era, connect }) {
    describe('tasks', () => {
        const modern = era === 'modern';
        const name = `tasks-${transport}-${era}`;
        const capabilities = modern ? { elicitation: { form: {} }, extensions: { [TASKS_EXT]: {} } } : { elicitation: { form: {} } };
        let answer = async () => ({ action: 'accept', content: { proceed: true } });
        const { client, dialogs } = makeClient(era, { name, capabilities, answer: p => answer(p) });
        let raw;
        let conn;
        /** Start a task: 2025 asks with params.task, 2026 gets one because the client declares the extension. */
        const start = async (args, tool = 'run_task') => {
            const r = await raw('tools/call', { name: tool, arguments: args, ...(modern ? {} : { task: { ttl: 30_000 } }) });
            return modern ? r : r.task;
        };
        before(async () => {
            conn = await connect(client);
            raw = rawChannel(client, { era, capabilities, name });
        });
        after(async () => {
            await conn?.close();
        });

        it('advertises task support in the era’s own way', async () => {
            const caps = client.getServerCapabilities();
            const tools = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t]));
            if (modern) {
                assert.deepEqual(caps.extensions[TASKS_EXT], {});
                assert.equal(caps.tasks, undefined, '2026-07-28 has no core tasks capability');
                assert.equal(tools.run_task.execution, undefined, 'execution.taskSupport was removed from 2026-07-28');
            } else {
                assert.deepEqual(caps.tasks, { list: {}, cancel: {}, requests: { tools: { call: {} } } });
                assert.deepEqual(tools.run_task.execution, { taskSupport: 'optional' });
                assert.deepEqual(tools.run_task_required.execution, { taskSupport: 'required' });
            }
        });

        it('tools/call returns a task handle at once, polling reaches completed', async () => {
            const created = await start({ ...QUICK });
            assert.equal(created.status, 'working');
            assert.match(created.taskId, /^[0-9a-f-]{36}$/);
            assert.ok(Date.parse(created.createdAt) && Date.parse(created.lastUpdatedAt));
            if (modern) {
                assert.equal(created.resultType, 'task');
                assert.equal(created.ttlMs, 600_000);
                assert.equal(created.pollIntervalMs, 1000);
                assert.equal(created.content, undefined, 'a CreateTaskResult is not a CallToolResult');
            } else {
                assert.equal(created.ttl, 30_000, 'the requested ttl is honoured');
                assert.equal(created.pollInterval, 1000);
            }
            const done = await pollUntil(raw, created.taskId, terminal);
            assert.equal(done.status, 'completed');
            if (modern) {
                assert.match(textOf(done.result), /Job finished 2 steps .* Result: success\./);
                assert.equal(done.result.structuredContent.steps, 2);
            } else {
                assert.equal(done.result, undefined, '2025-11-25 tasks/get carries no result');
                const r = await raw('tasks/result', { taskId: created.taskId });
                assert.match(textOf(r), /Result: success\./);
                assert.deepEqual(r._meta[RELATED], { taskId: created.taskId });
            }
        });

        it('statusMessage reports the steps while working', async () => {
            const created = await start({ seconds: 0.6, steps: 3 });
            const mid = await pollUntil(raw, created.taskId, t => /^Step [12]\/3$/.test(t.statusMessage ?? ''));
            assert.equal(mid.status, 'working');
            await pollUntil(raw, created.taskId, terminal);
        });

        it('a tool error is still a completed task; a JSON-RPC error makes it failed', async () => {
            const toolError = await start({ ...QUICK, outcome: 'tool_error' });
            const failure = await start({ ...QUICK, outcome: 'failure' });
            const te = await pollUntil(raw, toolError.taskId, terminal);
            const fe = await pollUntil(raw, failure.taskId, terminal);
            assert.equal(te.status, 'completed');
            assert.equal(fe.status, 'failed');
            if (modern) {
                assert.equal(te.result.isError, true);
                assert.equal(fe.error.code, -32603);
                assert.match(fe.error.message, /deliberate JSON-RPC error/);
            } else {
                assert.equal((await raw('tasks/result', { taskId: toolError.taskId })).isError, true);
                await assert.rejects(raw('tasks/result', { taskId: failure.taskId }), e => e.code === -32603 && /deliberate/.test(e.message));
            }
        });

        it('tasks/cancel stops a running task', async () => {
            const created = await start({ seconds: 30, steps: 3 });
            const ack = await raw('tasks/cancel', { taskId: created.taskId });
            if (modern) assert.equal(ack.status, undefined, '2026-07-28 answers with an empty ack');
            else assert.equal(ack.status, 'cancelled', '2025-11-25 returns the cancelled task');
            assert.equal((await raw('tasks/get', { taskId: created.taskId })).status, 'cancelled');
            if (modern) {
                await raw('tasks/cancel', { taskId: created.taskId }); // still just an ack
            } else {
                await assert.rejects(raw('tasks/cancel', { taskId: created.taskId }), e => e.code === -32602);
                await assert.rejects(raw('tasks/result', { taskId: created.taskId }), /was cancelled/);
            }
        });

        it('unknown task IDs are invalid params', async () => {
            await assert.rejects(raw('tasks/get', { taskId: 'no-such-task' }), e => e.code === -32602);
        });

        it('askConfirmation: the task pauses in input_required until the user answers', async () => {
            const before = dialogs.length;
            const created = await start({ seconds: 0.4, steps: 2, askConfirmation: true });
            if (modern) {
                const waiting = await pollUntil(raw, created.taskId, t => t.status === 'input_required');
                assert.deepEqual(Object.keys(waiting.inputRequests), ['confirm-1']);
                assert.equal(waiting.inputRequests['confirm-1'].method, 'elicitation/create');
                assert.match(waiting.inputRequests['confirm-1'].params.message, /halfway through/);
                await raw('tasks/update', { taskId: created.taskId, inputResponses: { 'unknown-key': { action: 'accept' } } }); // ignored
                assert.equal((await raw('tasks/get', { taskId: created.taskId })).status, 'input_required');
                await raw('tasks/update', { taskId: created.taskId, inputResponses: { 'confirm-1': { action: 'accept', content: { proceed: true } } } });
                const done = await pollUntil(raw, created.taskId, terminal);
                assert.match(textOf(done.result), /Confirmation: accepted/);
                assert.equal(dialogs.length, before, 'no elicitation/create request on 2026-07-28');
            } else {
                const r = await raw('tasks/result', { taskId: created.taskId });
                assert.match(textOf(r), /Confirmation: accepted/);
                assert.equal(dialogs.length - before, 1);
                assert.deepEqual(dialogs.at(-1)._meta?.[RELATED], { taskId: created.taskId }, 'the elicitation names its task');
            }
        });

        it('askConfirmation: declining stops the job', async () => {
            const prev = answer;
            answer = async () => ({ action: 'decline' });
            try {
                const created = await start({ seconds: 0.4, steps: 2, askConfirmation: true });
                if (modern) {
                    await pollUntil(raw, created.taskId, t => t.status === 'input_required');
                    await raw('tasks/update', { taskId: created.taskId, inputResponses: { 'confirm-1': { action: 'decline' } } });
                }
                const text = modern ? textOf((await pollUntil(raw, created.taskId, terminal)).result) : textOf(await raw('tasks/result', { taskId: created.taskId }));
                assert.match(text, /Job stopped after step 1\/2: the user declined/);
            } finally {
                answer = prev;
            }
        });

        it('each era only knows its own task methods', async () => {
            if (modern) {
                for (const method of ['tasks/result', 'tasks/list']) await assert.rejects(raw(method, { taskId: 'x' }), rpcError(-32601), method);
            } else {
                await assert.rejects(raw('tasks/update', { taskId: 'x', inputResponses: {} }), rpcError(-32601));
                const created = await start({ ...QUICK });
                const list = await raw('tasks/list', {});
                assert.ok(list.tasks.some(t => t.taskId === created.taskId));
                await pollUntil(raw, created.taskId, terminal);
            }
        });

        if (modern) {
            it('the official client SDK cannot consume a task result', async () => {
                await assert.rejects(client.callTool({ name: 'run_task', arguments: QUICK }), /Unsupported result type 'task'/);
            });
        }

        it('without task support: run_task runs synchronously, run_task_required is refused', async () => {
            const { client: bare } = makeClient(era, { name: `no-tasks-${transport}-${era}`, capabilities: {} });
            const c = await connect(bare);
            try {
                const r = await bare.callTool({ name: 'run_task', arguments: { ...QUICK, askConfirmation: true } });
                assert.match(textOf(r), /Result: success\.\nRan synchronously: the client did not request a task\. \(askConfirmation only applies/);
                await assert.rejects(
                    bare.callTool({ name: 'run_task_required', arguments: QUICK }),
                    modern ? e => e.code === -32021 && e.data?.requiredCapabilities?.extensions?.[TASKS_EXT] !== undefined : e => e.code === -32601
                );
            } finally {
                await c.close();
            }
        });

        if (transport === 'http') {
            it(modern ? 'a 2026-07-28 task can be polled from another connection' : 'a 2025-era task is private to its session', async () => {
                const created = await start({ seconds: 0.4, steps: 2 });
                const other = makeClient(era, { name: `other-${era}`, capabilities }).client;
                const c = await connect(other);
                try {
                    const otherRaw = rawChannel(other, { era, capabilities, name: `other-${era}` });
                    if (modern) assert.equal((await pollUntil(otherRaw, created.taskId, terminal)).status, 'completed');
                    else await assert.rejects(otherRaw('tasks/get', { taskId: created.taskId }), e => e.code === -32602);
                } finally {
                    await c.close();
                }
                await pollUntil(raw, created.taskId, terminal);
            });
        }
    });
}
