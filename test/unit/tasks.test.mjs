// Task internals, in-process: the job itself, the task store (TTL, cap,
// visibility per connection), the per-era Task shape, and the tools/call hook
// that answers task-augmented calls before the SDK validates them.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, ProtocolError } from '@modelcontextprotocol/server';
import { configureLogger } from '../../dist/log.js';
import { createFeatureTestServer } from '../../dist/server.js';
import { TASK_LIMITS, TASK_TOOLS, TASKS_EXTENSION, resetTasks, runJob, runTaskArgs, taskCount, taskSnapshot } from '../../dist/tasks.js';

configureLogger({ level: 'silent' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = [];
afterEach(async () => {
    for (const c of open.splice(0)) await c.close();
    resetTasks();
});

/** A 2025-era in-process client plus a raw request function (the SDK client has no task methods). */
async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createFeatureTestServer({ transport: 'stdio' }).connect(serverSide);
    const client = new Client({ name: 'tasks-unit', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientSide);
    open.push(client);
    const pending = new Map();
    let n = 0;
    const deliver = clientSide.onmessage;
    clientSide.onmessage = (msg, extra) => {
        const p = pending.get(msg.id);
        if (p && !('method' in msg)) {
            pending.delete(msg.id);
            return msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result);
        }
        deliver(msg, extra);
    };
    const raw = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = `u-${++n}`;
            pending.set(id, { resolve, reject });
            clientSide.send({ jsonrpc: '2.0', id, method, params });
        });
    return { client, raw };
}

const startTask = (raw, args = {}, ttl) => raw('tools/call', { name: 'run_task', arguments: { seconds: 0.05, steps: 1, ...args }, task: ttl === undefined ? {} : { ttl } }).then(r => r.task);

describe('runJob', () => {
    const args = over => runTaskArgs.parse(over);

    it('reports every step and succeeds with structured content', async () => {
        const steps = [];
        const r = await runJob(args({ seconds: 0.03, steps: 3 }), { signal: new AbortController().signal, onStep: (i, n) => steps.push(`${i}/${n}`) });
        assert.deepEqual(steps, ['1/3', '2/3', '3/3']);
        assert.deepEqual(r.structuredContent, { steps: 3, seconds: 0.03, confirmation: 'not requested' });
    });

    it('outcome failure throws a ProtocolError (the task becomes "failed")', async () => {
        await assert.rejects(runJob(args({ seconds: 0, steps: 1, outcome: 'failure' }), { signal: new AbortController().signal }), e => e instanceof ProtocolError && e.code === -32603);
    });

    it('stops at once when aborted', async () => {
        const ac = new AbortController();
        const started = Date.now();
        const job = runJob(args({ seconds: 30, steps: 2 }), { signal: ac.signal });
        ac.abort(new Error('stop'));
        await assert.rejects(job, /stop/);
        assert.ok(Date.now() - started < 1000);
    });

    it('asks halfway; without a way to ask it says so', async () => {
        const asked = [];
        const r = await runJob(args({ seconds: 0, steps: 4, askConfirmation: true }), {
            signal: new AbortController().signal,
            onStep: i => asked.push(`step ${i}`),
            ask: async () => {
                asked.push('ask');
                return 'not_asked';
            }
        });
        assert.deepEqual(asked, ['step 1', 'step 2', 'ask', 'step 3', 'step 4']);
        assert.match(r.content[0].text, /Confirmation: not asked/);
    });
});

describe('task store (2025-era connection)', () => {
    it('clamps the requested ttl and reports it as ttl/pollInterval', async () => {
        const { raw } = await connect();
        assert.equal((await startTask(raw, {}, 5)).ttl, TASK_LIMITS.minTtlMs);
        assert.equal((await startTask(raw, {}, 10 * TASK_LIMITS.maxTtlMs)).ttl, TASK_LIMITS.maxTtlMs);
        const t = await startTask(raw);
        assert.equal(t.ttl, TASK_LIMITS.defaultTtlMs);
        assert.equal(t.pollInterval, TASK_LIMITS.pollIntervalMs);
        assert.equal('ttlMs' in t, false, '2025-11-25 spells it ttl');
    });

    it('drops tasks after their ttl', async () => {
        const { raw } = await connect();
        const t = await startTask(raw, { seconds: 30 }, 1);
        assert.equal(taskSnapshot(t.taskId).status, 'working');
        await sleep(1100);
        assert.equal(taskCount(), 0);
        await assert.rejects(raw('tasks/get', { taskId: t.taskId }), e => e.code === -32602);
    });

    it(`keeps at most ${TASK_LIMITS.maxTasks} tasks, dropping finished ones first`, async () => {
        const { raw } = await connect();
        const first = await startTask(raw, { seconds: 0 });
        await sleep(50);
        const running = [];
        for (let i = 1; i < TASK_LIMITS.maxTasks; i++) running.push(await startTask(raw, { seconds: 30 }));
        assert.equal(taskCount(), TASK_LIMITS.maxTasks);
        await startTask(raw, { seconds: 30 });
        assert.equal(taskCount(), TASK_LIMITS.maxTasks);
        assert.equal(taskSnapshot(first.taskId), undefined, 'the finished task went first');
        assert.equal(taskSnapshot(running[0].taskId).status, 'working');
    });

    it('a 2025-era task is invisible to another connection', async () => {
        const a = await connect();
        const b = await connect();
        const t = await startTask(a.raw);
        await assert.rejects(b.raw('tasks/get', { taskId: t.taskId }), e => e.code === -32602);
        await assert.rejects(b.raw('tasks/cancel', { taskId: t.taskId }), e => e.code === -32602);
        assert.equal((await b.raw('tasks/list')).tasks.length, 0);
        assert.equal((await a.raw('tasks/list')).tasks.length, 1);
    });

    it('tasks/list pages with an opaque cursor', async () => {
        const { raw } = await connect();
        for (let i = 0; i < TASK_LIMITS.listPageSize + 3; i++) await startTask(raw, { seconds: 30 });
        const page1 = await raw('tasks/list');
        assert.equal(page1.tasks.length, TASK_LIMITS.listPageSize);
        const page2 = await raw('tasks/list', { cursor: page1.nextCursor });
        assert.equal(page2.tasks.length, 3);
        assert.equal(page2.nextCursor, undefined);
    });

    it('invalid arguments in a task-augmented call are invalid params, not a task', async () => {
        const { raw } = await connect();
        await assert.rejects(raw('tools/call', { name: 'run_task', arguments: { seconds: -1 }, task: {} }), e => e.code === -32602);
        assert.equal(taskCount(), 0);
    });

    it('other tools ignore params.task and keep the SDK validation path', async () => {
        const { raw } = await connect();
        const r = await raw('tools/call', { name: 'structured_output', arguments: {}, task: {} });
        assert.equal(r.task, undefined);
        assert.equal(r.structuredContent.passed, 42);
    });
});

it('exports the extension id and the per-tool taskSupport', () => {
    assert.equal(TASKS_EXTENSION, 'io.modelcontextprotocol/tasks');
    assert.deepEqual(TASK_TOOLS, { run_task: 'optional', run_task_required: 'required' });
});
