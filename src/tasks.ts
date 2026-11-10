/**
 * Tasks: a tools/call that returns a handle at once and is polled for its
 * result. Two generations, implemented here by hand because SDK v2.4 ships the
 * wire schemas but no task runtime:
 *
 *  - 2025-11-25 (core, experimental): the client asks for a task with
 *    `params.task: {ttl}` on tools/call; the tool must allow it via
 *    `execution.taskSupport` ("optional" / "required") in tools/list, and the
 *    server declares `capabilities.tasks`. The server answers
 *    `CreateTaskResult` = `{task: Task}`. Methods: tasks/get (status),
 *    tasks/result (blocks until done, returns the CallToolResult or the
 *    JSON-RPC error), tasks/list, tasks/cancel. Field names: `ttl`,
 *    `pollInterval`. Input mid-task: the server sends a normal
 *    elicitation/create request tagged with `_meta["io.modelcontextprotocol/related-task"]`.
 *  - 2026-07-28 (extension `io.modelcontextprotocol/tasks`, SEP-2663): the
 *    client declares the extension in its per-request capabilities; the server
 *    decides alone whether to answer with a task (`resultType: "task"` plus the
 *    Task fields inline). Methods: tasks/get (status, and the result or error
 *    once terminal), tasks/update (answers to `inputRequests`), tasks/cancel.
 *    tasks/result and tasks/list are gone; field names are `ttlMs`, `pollIntervalMs`.
 *
 * Tools:
 *  - run_task           – execution.taskSupport "optional": runs as a task when
 *                         the client asks (2025) or supports the extension (2026),
 *                         otherwise synchronously.
 *  - run_task_required  – execution.taskSupport "required": refuses to run
 *                         without a task (-32601 on 2025-era, -32021 Missing
 *                         Required Client Capability on 2026-07-28).
 *
 * Task-augmented calls are answered from a per-instance `_wrapHandler` hook,
 * in front of the SDK's tools/call result validation (which rejects a 2025
 * CreateTaskResult and would add `content: []` to a 2026 one). Tasks live in
 * a module-level store so that tasks/get reaches them from any server
 * instance (2026-07-28 over HTTP builds a new instance per request). 2025-era
 * tasks are visible only to the connection that created them, 2026-07-28
 * tasks to anyone holding the (unguessable) task ID. Status is polled; this
 * server does not push task status notifications.
 */
import { randomUUID } from 'node:crypto';
import type { CallToolResult, InputRequest, McpServer, ServerContext } from '@modelcontextprotocol/server';
import {
    acceptedContent,
    inputRequired,
    inputResponse,
    MissingRequiredClientCapabilityError,
    ProtocolError,
    ProtocolErrorCode,
    RELATED_TASK_META_KEY
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ClientObservation, Era } from './clients.js';
import { summarizeCapabilities } from './clients.js';
import { logger } from './log.js';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const TASK_TOOLS = { run_task: 'optional', run_task_required: 'required' } as const;
export type TaskToolName = keyof typeof TASK_TOOLS;

export const TASK_LIMITS = {
    /** Tasks kept at most; the oldest finished (else oldest) task is dropped first. */
    maxTasks: 50,
    defaultTtlMs: 10 * 60_000,
    minTtlMs: 1_000,
    maxTtlMs: 60 * 60_000,
    pollIntervalMs: 1_000,
    listPageSize: 20
};

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

export const runTaskArgs = z.object({
    seconds: z.number().min(0).max(120).default(10).describe('How long the fake job runs'),
    steps: z.number().int().min(1).max(20).default(5).describe('Number of steps; each one updates statusMessage'),
    outcome: z
        .enum(['success', 'tool_error', 'failure'])
        .default('success')
        .describe('success = normal result; tool_error = result with isError (task still "completed"); failure = JSON-RPC error (task "failed")'),
    askConfirmation: z.boolean().default(false).describe('Halfway through, ask the user to continue (task status input_required)')
});
export type RunTaskArgs = z.infer<typeof runTaskArgs>;

const continueSchema = z.object({ proceed: z.boolean().default(true).describe('Continue the job?') });

interface TaskRecord {
    taskId: string;
    tool: TaskToolName;
    era: Era;
    /** The server instance (connection) that created a 2025-era task; it sends that task's elicitations. */
    owner: McpServer;
    client: ClientObservation;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: number;
    lastUpdatedAt: number;
    ttlMs: number;
    pollIntervalMs: number;
    result?: CallToolResult;
    error?: { code: number; message: string; data?: unknown };
    /** 2026-07-28: outstanding input requests, answered via tasks/update. */
    inputRequests: Record<string, InputRequest>;
    inputWaiters: Map<string, (responses: Record<string, unknown>) => void>;
    inputSeq: number;
    abort: AbortController;
    doneWaiters: Array<() => void>;
}

const tasks = new Map<string, TaskRecord>();

/** For tests: drop every task (running ones are aborted). */
export function resetTasks(): void {
    for (const t of tasks.values()) t.abort.abort();
    tasks.clear();
}

/** For tests and inspection: a copy of the task's current state. */
export function taskSnapshot(taskId: string): Omit<TaskRecord, 'owner' | 'abort' | 'inputWaiters' | 'doneWaiters'> | undefined {
    const t = tasks.get(taskId);
    if (!t) return undefined;
    const { owner: _o, abort: _a, inputWaiters: _w, doneWaiters: _d, ...rest } = t;
    return structuredClone(rest);
}

export function taskCount(): number {
    purgeExpired();
    return tasks.size;
}

const iso = (ms: number) => new Date(ms).toISOString();

function touch(t: TaskRecord, status: TaskStatus, statusMessage?: string): void {
    t.status = status;
    if (statusMessage !== undefined) t.statusMessage = statusMessage;
    t.lastUpdatedAt = Date.now();
    if (TERMINAL.has(status)) {
        for (const w of t.doneWaiters.splice(0)) w();
        logger.info('task.finished', `${t.tool} task ${t.taskId} ${status} [${t.era}]`, { taskId: t.taskId, tool: t.tool, era: t.era, status });
    }
}

function purgeExpired(now = Date.now()): void {
    for (const [id, t] of tasks) {
        if (t.createdAt + t.ttlMs < now) {
            t.abort.abort();
            tasks.delete(id);
        }
    }
}

function makeRoom(): void {
    purgeExpired();
    while (tasks.size >= TASK_LIMITS.maxTasks) {
        const all = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
        const victim = all.find(t => TERMINAL.has(t.status)) ?? all[0]!;
        victim.abort.abort();
        tasks.delete(victim.taskId);
    }
}

/** The Task object as each generation spells it. */
export function taskView(t: TaskRecord, era: Era, detailed: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
        taskId: t.taskId,
        status: t.status,
        ...(t.statusMessage !== undefined && { statusMessage: t.statusMessage }),
        createdAt: iso(t.createdAt),
        lastUpdatedAt: iso(t.lastUpdatedAt)
    };
    if (era === 'legacy') return { ...base, ttl: t.ttlMs, pollInterval: t.pollIntervalMs };
    const view: Record<string, unknown> = { ...base, ttlMs: t.ttlMs, pollIntervalMs: t.pollIntervalMs };
    if (!detailed) return view;
    if (t.status === 'input_required') view.inputRequests = { ...t.inputRequests };
    if (t.status === 'completed') view.result = t.result;
    if (t.status === 'failed') view.error = t.error;
    return view;
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });

type Ask = () => Promise<'accepted' | 'declined' | 'cancelled' | 'not_asked'>;

/** The fake job behind both tools. Throws a ProtocolError for outcome "failure". */
export async function runJob(
    args: RunTaskArgs,
    { signal, onStep, ask }: { signal: AbortSignal; onStep?: (step: number, of: number) => void; ask?: Ask }
): Promise<CallToolResult> {
    const stepMs = (args.seconds * 1000) / args.steps;
    const askAt = args.askConfirmation ? Math.ceil(args.steps / 2) : -1;
    let asked = 'not requested';
    for (let i = 1; i <= args.steps; i++) {
        await sleep(stepMs, signal);
        onStep?.(i, args.steps);
        if (i === askAt) {
            const answer = ask ? await ask() : 'not_asked';
            asked = answer === 'not_asked' ? 'not asked (no way to ask in this mode or client)' : answer;
            if (answer === 'declined' || answer === 'cancelled') {
                return { content: [{ type: 'text', text: `Job stopped after step ${i}/${args.steps}: the user ${answer} to continue.` }] };
            }
        }
    }
    const summary = `Job finished ${args.steps} steps in ${args.seconds} s. Confirmation: ${asked}.`;
    if (args.outcome === 'failure') {
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'Job failed (deliberate JSON-RPC error, outcome "failure")', { steps: args.steps });
    }
    if (args.outcome === 'tool_error') return { content: [{ type: 'text', text: `${summary} Result: deliberate tool error (isError).` }], isError: true };
    return { content: [{ type: 'text', text: `${summary} Result: success.` }], structuredContent: { steps: args.steps, seconds: args.seconds, confirmation: asked } };
}

function askFor(t: TaskRecord): Ask {
    return async () => {
        if (!summarizeCapabilities(t.client.capabilities).elicitation.form) return 'not_asked';
        const request = inputRequired.elicit({
            message: `Task ${t.taskId.slice(0, 8)} is halfway through. Continue?`,
            requestedSchema: continueSchema
        });
        touch(t, 'input_required', 'Waiting for the user to confirm');
        try {
            if (t.era === 'legacy') {
                // 2025-11-25: an ordinary elicitation/create, tagged with the task it belongs to.
                const params = { ...(request.params as Record<string, unknown>), _meta: { [RELATED_TASK_META_KEY]: { taskId: t.taskId } } };
                const r = await t.owner.server.elicitInput(params as Parameters<typeof t.owner.server.elicitInput>[0], { signal: t.abort.signal, timeout: t.ttlMs });
                if (r.action !== 'accept') return r.action === 'decline' ? 'declined' : 'cancelled';
                return r.content?.proceed === false ? 'declined' : 'accepted';
            }
            // 2026-07-28: surface the request in tasks/get and wait for tasks/update.
            const key = `confirm-${++t.inputSeq}`;
            t.inputRequests[key] = request;
            const responses = await new Promise<Record<string, unknown>>((resolve, reject) => {
                t.inputWaiters.set(key, resolve);
                t.abort.signal.addEventListener('abort', () => reject(t.abort.signal.reason), { once: true });
            });
            delete t.inputRequests[key];
            t.inputWaiters.delete(key);
            const view = inputResponse(responses, key);
            if (view.kind !== 'elicit') return 'cancelled';
            if (view.action !== 'accept') return view.action === 'decline' ? 'declined' : 'cancelled';
            return acceptedContent(responses, key, continueSchema)?.proceed === false ? 'declined' : 'accepted';
        } finally {
            if (!TERMINAL.has(t.status)) touch(t, 'working', 'Continuing');
        }
    };
}

function createTask(server: McpServer, tool: TaskToolName, args: RunTaskArgs, client: ClientObservation, requestedTtl: unknown): TaskRecord {
    makeRoom();
    const now = Date.now();
    const ttl = typeof requestedTtl === 'number' && Number.isFinite(requestedTtl) ? requestedTtl : TASK_LIMITS.defaultTtlMs;
    const t: TaskRecord = {
        taskId: randomUUID(),
        tool,
        era: client.era,
        owner: server,
        client,
        status: 'working',
        statusMessage: `Step 0/${args.steps}`,
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: Math.min(TASK_LIMITS.maxTtlMs, Math.max(TASK_LIMITS.minTtlMs, Math.round(ttl))),
        pollIntervalMs: TASK_LIMITS.pollIntervalMs,
        inputRequests: {},
        inputWaiters: new Map(),
        inputSeq: 0,
        abort: new AbortController(),
        doneWaiters: []
    };
    tasks.set(t.taskId, t);
    logger.info('task.created', `${tool} task ${t.taskId} [${t.era}] (${args.seconds} s, ${args.steps} steps)`, {
        taskId: t.taskId,
        tool,
        era: t.era,
        client: client.clientInfo?.name ?? null
    });
    runJob(args, {
        signal: t.abort.signal,
        onStep: (i, n) => {
            if (!TERMINAL.has(t.status)) touch(t, t.status, `Step ${i}/${n}`);
        },
        ask: askFor(t)
    }).then(
        result => {
            if (TERMINAL.has(t.status)) return;
            t.result = result;
            touch(t, 'completed', result.isError ? 'Finished with a tool error' : 'Finished');
        },
        (e: unknown) => {
            if (TERMINAL.has(t.status)) return; // cancelled (or expired) first
            const err = e instanceof ProtocolError ? e : new ProtocolError(ProtocolErrorCode.InternalError, e instanceof Error ? e.message : String(e));
            t.error = { code: err.code, message: err.message, ...(err.data !== undefined && { data: err.data }) };
            touch(t, 'failed', err.message);
        }
    );
    return t;
}

/** Whether (and how) this tools/call is to run as a task. */
function taskRequest(req: { params?: Record<string, unknown> }, client: ClientObservation): { ttl?: unknown } | undefined {
    if (client.era === 'legacy') {
        const task = req.params?.task;
        return task && typeof task === 'object' ? { ttl: (task as { ttl?: unknown }).ttl } : undefined;
    }
    const ext = (client.capabilities?.extensions ?? {}) as Record<string, unknown>;
    return TASKS_EXTENSION in ext ? {} : undefined;
}

function lookup(server: McpServer, client: ClientObservation, taskId: unknown): TaskRecord {
    purgeExpired();
    const t = typeof taskId === 'string' ? tasks.get(taskId) : undefined;
    // 2025-era tasks belong to their connection; 2026-07-28 has no connections, the task ID is the handle.
    if (!t || t.era !== client.era || (t.era === 'legacy' && t.owner !== server)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task: ${String(taskId)}`);
    }
    return t;
}

const waitForTerminal = (t: TaskRecord, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (TERMINAL.has(t.status)) return resolve();
        const onAbort = () => reject(signal.reason);
        t.doneWaiters.push(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        });
        signal.addEventListener('abort', onAbort, { once: true });
    });

type LowLevelServer = {
    _wrapHandler: (method: string, handler: (req: any, ctx: ServerContext) => Promise<unknown>) => (req: any, ctx: ServerContext) => Promise<unknown>;
    setRequestHandler: (method: string, schemas: unknown, handler: (params: any, ctx: ServerContext) => unknown) => void;
};

/**
 * Must run before the first registerTool: installs the tools/call hook that
 * answers task-augmented calls before the SDK validates them as CallToolResult.
 */
export function installTaskSupport(server: McpServer, { clientOf }: { clientOf: (ctx: ServerContext) => ClientObservation }): void {
    server.server.registerCapabilities({
        // 2025-11-25 core capability (the 2026-07-28 codec strips it) …
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        // … and the 2026-07-28 extension (2025-era clients ignore unknown extensions).
        extensions: { [TASKS_EXTENSION]: {} }
    } as Parameters<typeof server.server.registerCapabilities>[0]);

    const low = server.server as unknown as LowLevelServer;
    const wrap = low._wrapHandler.bind(server.server);
    low._wrapHandler = (method, handler) => {
        const validated = wrap(method, handler);
        if (method !== 'tools/call') return validated;
        return async (req: { params?: Record<string, unknown> }, ctx: ServerContext) => {
            const name = String(req.params?.name ?? '');
            if (!(name in TASK_TOOLS)) return validated(req, ctx);
            const tool = name as TaskToolName;
            const client = clientOf(ctx);
            const asTask = taskRequest(req, client);
            if (!asTask) {
                if (TASK_TOOLS[tool] !== 'required') return validated(req, ctx); // runs synchronously
                if (client.era === 'legacy') {
                    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Tool ${tool} requires task augmentation (params.task); execution.taskSupport is "required"`);
                }
                throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } }, `Tool ${tool} only runs as a task: declare the ${TASKS_EXTENSION} extension`);
            }
            const parsed = runTaskArgs.safeParse(req.params?.arguments ?? {});
            if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for tool ${tool}: ${parsed.error.message}`);
            const t = createTask(server, tool, parsed.data, client, asTask.ttl);
            return client.era === 'legacy' ? { task: taskView(t, 'legacy', false) } : { resultType: 'task', ...taskView(t, 'modern', false) };
        };
    };
}

const taskIdParams = z.object({ taskId: z.string() }).passthrough();

/** Registers the task tools and the tasks/* methods. */
export function registerTasks(server: McpServer, { clientOf }: { clientOf: (ctx: ServerContext) => ClientObservation }): void {
    for (const tool of Object.keys(TASK_TOOLS) as TaskToolName[]) {
        const required = TASK_TOOLS[tool] === 'required';
        const registered = server.registerTool(
            tool,
            {
                title: required ? 'Task-only job (taskSupport: required)' : 'Long job as a task (tasks)',
                description: required
                    ? 'Same fake job as run_task, but declared execution.taskSupport "required": the client must call it as a task. Without task support it fails (-32601 on 2025-era, -32021 on 2026-07-28).'
                    : 'Run a fake long job. Clients with task support get a task handle at once and poll it (tasks/get); others wait for the result. Options: seconds, steps, outcome (success, tool_error, failure) and askConfirmation (pauses halfway for a yes/no: task status input_required).',
                inputSchema: runTaskArgs,
                annotations: { readOnlyHint: true, idempotentHint: false }
            },
            async (args, ctx): Promise<CallToolResult> => {
                // Synchronous fallback (run_task without a task). A JSON-RPC failure becomes a tool error here.
                const result = await runJob(args, { signal: ctx.mcpReq.signal });
                const note = args.askConfirmation ? ' (askConfirmation only applies when running as a task.)' : '';
                return { ...result, content: [...result.content, { type: 'text', text: `Ran synchronously: the client did not request a task.${note}` }] };
            }
        );
        // registerTool has no `execution` option; tools/list reads the field from the registered tool.
        (registered as unknown as { execution: unknown }).execution = { taskSupport: TASK_TOOLS[tool] };
    }

    const low = server.server as unknown as LowLevelServer;

    low.setRequestHandler('tasks/get', { params: taskIdParams }, (params, ctx) => {
        const client = clientOf(ctx);
        return taskView(lookup(server, client, params.taskId), client.era, true);
    });

    low.setRequestHandler('tasks/cancel', { params: taskIdParams }, (params, ctx) => {
        const client = clientOf(ctx);
        const t = lookup(server, client, params.taskId);
        if (TERMINAL.has(t.status)) {
            if (client.era === 'legacy') throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task ${t.taskId} is already ${t.status}`);
            return {}; // 2026-07-28: an ack, whatever the state
        }
        touch(t, 'cancelled', 'Cancelled by the client');
        t.abort.abort(new Error('cancelled'));
        return client.era === 'legacy' ? taskView(t, 'legacy', false) : {};
    });

    // 2026-07-28 only (an extension method the SDK passes through on both eras).
    low.setRequestHandler(
        'tasks/update',
        { params: taskIdParams },
        (params, ctx) => {
            const client = clientOf(ctx);
            if (client.era === 'legacy') throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'tasks/update exists only in the 2026-07-28 tasks extension');
            const t = lookup(server, client, params.taskId);
            // The SDK lifts `inputResponses` (MRTR vocabulary) out of params into the request context.
            const responses = (ctx.mcpReq.inputResponses ?? params.inputResponses) as Record<string, unknown> | undefined;
            if (!responses || typeof responses !== 'object') throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'tasks/update needs inputResponses');
            for (const key of Object.keys(responses)) t.inputWaiters.get(key)?.(responses); // unknown or answered keys are ignored
            return {};
        }
    );

    // 2025-11-25 only: the SDK answers "Method not found" on 2026-07-28 connections.
    low.setRequestHandler('tasks/result', { params: taskIdParams }, async (params, ctx) => {
        const client = clientOf(ctx);
        const t = lookup(server, client, params.taskId);
        await waitForTerminal(t, ctx.mcpReq.signal);
        const meta = { [RELATED_TASK_META_KEY]: { taskId: t.taskId } };
        if (t.status === 'completed') return { ...t.result, _meta: { ...t.result?._meta, ...meta } };
        if (t.status === 'failed') throw new ProtocolError(t.error!.code, t.error!.message, t.error!.data);
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Task ${t.taskId} was cancelled; it has no result`);
    });

    low.setRequestHandler('tasks/list', { params: z.object({ cursor: z.string().optional() }).passthrough() }, (params, ctx) => {
        const client = clientOf(ctx);
        purgeExpired();
        const mine = [...tasks.values()].filter(t => t.era === 'legacy' && t.owner === server).sort((a, b) => b.createdAt - a.createdAt);
        const start = params.cursor ? Number.parseInt(Buffer.from(params.cursor, 'base64url').toString(), 10) || 0 : 0;
        const page = mine.slice(start, start + TASK_LIMITS.listPageSize);
        const next = start + page.length < mine.length ? Buffer.from(String(start + page.length)).toString('base64url') : undefined;
        return { tasks: page.map(t => taskView(t, client.era, false)), ...(next && { nextCursor: next }) };
    });
}
