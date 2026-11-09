/**
 * List-changed notifications and resource subscriptions: the server changes
 * its own tools, prompts and resources at runtime so you can watch a client
 * react.
 *
 *  - change_lists          – adds or removes dynamic_tool_N, dynamic_prompt_N
 *                            and test://dynamic/N (at most MAX_DYNAMIC_PER_KIND
 *                            of each), then announces the change with
 *                            notifications/{tools,prompts,resources}/list_changed.
 *  - update_live_resource  – changes the content of test://live/counter and
 *                            sends notifications/resources/updated for it.
 *
 * The dynamic items are process-wide, not per client: HTTP mode builds a fresh
 * McpServer for every 2026-07-28 request, so there is no session to hang them
 * on, and a shared list is what lets one client's change reach every other
 * client of the same HTTP server. Tests reset it with change_lists action=reset.
 *
 * Delivery differs per protocol era:
 *  - 2025-era (initialize): list_changed notifications are sent unsolicited to
 *    every connection; resources/updated only after resources/subscribe for
 *    that URI. Each long-lived McpServer re-registers the dynamic items when
 *    the shared list changes; the SDK then sends the notification itself.
 *  - 2026-07-28: nothing arrives unless the client holds a subscriptions/listen
 *    stream whose filter asks for it (toolsListChanged, promptsListChanged,
 *    resourcesListChanged, resourceSubscriptions: [uri]); resources/subscribe
 *    no longer exists. On stdio the SDK routes the instance's notifications
 *    onto the open streams; in HTTP mode the per-request instances are gone
 *    by then, so httpServer.ts forwards changes to createMcpHandler's notifier.
 */
import type { McpServer, RegisteredPrompt, RegisteredResource, RegisteredTool, ServerNotifier } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { logger } from './log.js';

export const MAX_DYNAMIC_PER_KIND = 3;
export const LIVE_RESOURCE_URI = 'test://live/counter';
/** resources/subscribe calls one 2025-era connection may hold. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;

export const LIST_KINDS = ['tool', 'prompt', 'resource'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const dynamicToolName = (n: number) => `dynamic_tool_${n}`;
export const dynamicPromptName = (n: number) => `dynamic_prompt_${n}`;
export const dynamicResourceUri = (n: number) => `test://dynamic/${n}`;

/** A change the instances (and the HTTP notifier) must hear about. */
export type ListEvent = { kind: 'list'; list: ListKind } | { kind: 'updated'; uri: string };

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

interface DynamicItem {
    n: number;
    addedAt: string;
}
const dynamic: Record<ListKind, DynamicItem[]> = { tool: [], prompt: [], resource: [] };
let nextNumber: Record<ListKind, number> = { tool: 1, prompt: 1, resource: 1 };
const live = { counter: 0, updatedAt: new Date().toISOString() };
const listeners = new Set<(e: ListEvent) => void>();
/** resources/subscribe sets of the live 2025-era connections (for the subscriber count). */
const legacySubscriptions = new Set<Set<string>>();
let modernStreams: (() => number) | undefined;

function publish(e: ListEvent): void {
    for (const l of [...listeners]) {
        try {
            l(e);
        } catch (err) {
            logger.warn('lists.listener', `a list-change listener threw: ${(err as Error)?.message ?? err}`);
        }
    }
}

/** Listen to every change (returns the unsubscribe function). */
export function onListEvent(listener: (e: ListEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Instances (and notifiers) currently following the shared lists (tests check that closed ones let go). */
export const listEventListenerCount = () => listeners.size;

/**
 * HTTP mode: forward changes to createMcpHandler's notifier, which writes them
 * to the open 2026-07-28 subscriptions/listen streams. `openStreams` reports how
 * many are open (shown in the tool results).
 */
export function forwardToNotifier(notify: ServerNotifier, openStreams?: () => number): () => void {
    modernStreams = openStreams;
    const off = onListEvent(e => {
        if (e.kind === 'updated') notify.resourceUpdated(e.uri);
        else if (e.list === 'tool') notify.toolsChanged();
        else if (e.list === 'prompt') notify.promptsChanged();
        else notify.resourcesChanged();
    });
    return () => {
        off();
        modernStreams = undefined;
    };
}

/** The dynamic items as names/URIs (for results and tests). */
export function dynamicSnapshot() {
    return {
        tools: dynamic.tool.map(i => dynamicToolName(i.n)),
        prompts: dynamic.prompt.map(i => dynamicPromptName(i.n)),
        resources: dynamic.resource.map(i => dynamicResourceUri(i.n))
    };
}

/** Back to no dynamic items and counter 0 (announces only lists that change). */
export function resetLists(): ListKind[] {
    const changed = LIST_KINDS.filter(k => dynamic[k].length > 0);
    for (const k of LIST_KINDS) dynamic[k] = [];
    nextNumber = { tool: 1, prompt: 1, resource: 1 };
    live.counter = 0;
    live.updatedAt = new Date().toISOString();
    for (const list of changed) publish({ kind: 'list', list });
    return changed;
}

function liveContent() {
    return JSON.stringify({ counter: live.counter, updatedAt: live.updatedAt });
}

// ---------------------------------------------------------------------------
// Per-instance registration
// ---------------------------------------------------------------------------

export interface ListChangedOptions {
    /**
     * The instance lives for a single 2026-07-28 HTTP request: it registers the
     * current items but does not follow later changes (httpServer.ts forwards
     * those to the listen streams instead).
     */
    perRequest?: boolean;
}

export function registerListChanged(server: McpServer, options: ListChangedOptions = {}): void {
    // listChanged is set by the SDK as soon as a tool/prompt/resource exists; subscribe must be declared.
    server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

    const tools = new Map<number, RegisteredTool>();
    const prompts = new Map<number, RegisteredPrompt>();
    const resources = new Map<number, RegisteredResource>();

    const addTool = (item: DynamicItem) =>
        tools.set(
            item.n,
            server.registerTool(
                dynamicToolName(item.n),
                {
                    title: `Dynamic tool ${item.n}`,
                    description: `Added at runtime by change_lists (${item.addedAt}). Calling it just confirms that the client picked up the new tool list.`,
                    inputSchema: z.object({}),
                    annotations: { readOnlyHint: true }
                },
                async () => ({ content: [{ type: 'text', text: `Hello from ${dynamicToolName(item.n)}, added at ${item.addedAt}.` }] })
            )
        );
    const addPrompt = (item: DynamicItem) =>
        prompts.set(
            item.n,
            server.registerPrompt(
                dynamicPromptName(item.n),
                { title: `Dynamic prompt ${item.n}`, description: `Added at runtime by change_lists (${item.addedAt}).` },
                async () => ({
                    messages: [{ role: 'user', content: { type: 'text', text: `This is ${dynamicPromptName(item.n)}, added at ${item.addedAt}. Reply with "got it".` } }]
                })
            )
        );
    const addResource = (item: DynamicItem) =>
        resources.set(
            item.n,
            server.registerResource(
                `dynamic-resource-${item.n}`,
                dynamicResourceUri(item.n),
                { title: `Dynamic resource ${item.n}`, description: `Added at runtime by change_lists (${item.addedAt}).`, mimeType: 'text/plain' },
                async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Dynamic resource ${item.n}, added at ${item.addedAt}.` }] })
            )
        );

    /** Make this instance's registrations match the shared list; each add/remove makes the SDK send list_changed. */
    const sync = (list: ListKind) => {
        const [mine, add] =
            list === 'tool' ? ([tools, addTool] as const) : list === 'prompt' ? ([prompts, addPrompt] as const) : ([resources, addResource] as const);
        const wanted = new Set(dynamic[list].map(i => i.n));
        for (const [n, handle] of mine) {
            if (!wanted.has(n)) {
                handle.remove();
                mine.delete(n);
            }
        }
        for (const item of dynamic[list]) if (!mine.has(item.n)) add(item);
    };
    for (const k of LIST_KINDS) sync(k);

    // 2025-era resources/subscribe (gone in 2026-07-28, where subscriptions/listen carries the URIs).
    const subscribed = new Set<string>();
    server.server.setRequestHandler('resources/subscribe', async req => {
        if (!subscribed.has(req.params.uri) && subscribed.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
            throw new Error(`At most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} resource subscriptions per connection`);
        }
        subscribed.add(req.params.uri);
        return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', async req => {
        subscribed.delete(req.params.uri);
        return {};
    });

    const isModern = () => (server.server.getNegotiatedProtocolVersion() ?? '') >= '2026-07-28';

    if (!options.perRequest) {
        legacySubscriptions.add(subscribed);
        const off = onListEvent(e => {
            if (e.kind === 'list') return sync(e.list);
            if (!server.isConnected()) return;
            // 2026-07-28 stdio: send always, the SDK keeps it only for listen streams that asked for this URI.
            if (isModern() || subscribed.has(e.uri)) void server.server.sendResourceUpdated({ uri: e.uri }).catch(() => {});
        });
        const previous = server.server.onclose;
        server.server.onclose = () => {
            off();
            legacySubscriptions.delete(subscribed);
            previous?.();
        };
    }

    server.registerResource(
        'live-counter',
        LIVE_RESOURCE_URI,
        {
            title: 'Live counter (subscribable)',
            description: 'Changes every time update_live_resource runs. Subscribe to it to get notifications/resources/updated.',
            mimeType: 'application/json'
        },
        async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: liveContent() }] })
    );

    const delivery = (legacy: string) =>
        `Delivery: 2025-era clients get ${legacy}; 2026-07-28 clients only while a subscriptions/listen stream asks for it` +
        (modernStreams ? ` (open listen streams on this HTTP server: ${modernStreams()})` : '') +
        '. A client that understood the notification shows the new list without being reconnected.';

    server.registerTool(
        'change_lists',
        {
            title: 'Change the server’s lists (list_changed)',
            description:
                `Add or remove a dynamic tool (dynamic_tool_N), prompt (dynamic_prompt_N) and resource (test://dynamic/N), at most ${MAX_DYNAMIC_PER_KIND} each, ` +
                'and send the matching notifications/*/list_changed. Then check whether the client’s tool, prompt and resource lists update by themselves. ' +
                'The lists are shared by all clients of this server; action=reset removes every dynamic item.',
            inputSchema: z.object({
                action: z.enum(['add', 'remove', 'reset']).default('add').meta({ description: 'add the next item, remove the newest one, or reset everything' }),
                kind: z.enum(['all', ...LIST_KINDS]).default('all').meta({ description: 'Which list to change' })
            }),
            outputSchema: z.object({
                action: z.string(),
                changed: z.array(z.enum(LIST_KINDS)),
                atLimit: z.array(z.enum(LIST_KINDS)),
                dynamic: z.object({ tools: z.array(z.string()), prompts: z.array(z.string()), resources: z.array(z.string()) })
            }),
            annotations: { readOnlyHint: false, idempotentHint: false }
        },
        async ({ action, kind }) => {
            const kinds = kind === 'all' ? [...LIST_KINDS] : [kind];
            const changed: ListKind[] = [];
            const atLimit: ListKind[] = [];
            if (action === 'reset') {
                changed.push(...resetLists().filter(k => kinds.includes(k)));
            } else {
                for (const k of kinds) {
                    if (action === 'add') {
                        if (dynamic[k].length >= MAX_DYNAMIC_PER_KIND) {
                            atLimit.push(k);
                            continue;
                        }
                        dynamic[k].push({ n: nextNumber[k]++, addedAt: new Date().toISOString() });
                    } else if (!dynamic[k].pop()) {
                        continue;
                    }
                    changed.push(k);
                    publish({ kind: 'list', list: k });
                }
            }
            const snapshot = dynamicSnapshot();
            logger.info('lists.changed', `change_lists ${action} ${kind}: changed ${changed.join(', ') || 'nothing'}`, { action, kind, changed, ...snapshot });
            const methods = changed.map(k => `notifications/${k}s/list_changed`);
            const lines = [
                changed.length ? `Sent ${methods.join(', ')}.` : 'Nothing changed, so no notification was sent.',
                ...(atLimit.length ? [`Already at the limit of ${MAX_DYNAMIC_PER_KIND} for: ${atLimit.join(', ')} (remove or reset first).`] : []),
                `Dynamic tools: ${snapshot.tools.join(', ') || 'none'}`,
                `Dynamic prompts: ${snapshot.prompts.join(', ') || 'none'}`,
                `Dynamic resources: ${snapshot.resources.join(', ') || 'none'}`,
                delivery('list_changed right away')
            ];
            return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { action, changed, atLimit, dynamic: snapshot } };
        }
    );

    server.registerTool(
        'update_live_resource',
        {
            title: 'Update a subscribed resource',
            description: `Increase the counter in ${LIVE_RESOURCE_URI} and send notifications/resources/updated for it. Subscribe first (resources/subscribe on 2025-era connections, a subscriptions/listen stream with resourceSubscriptions on 2026-07-28), then check whether the client re-reads it.`,
            inputSchema: z.object({}),
            outputSchema: z.object({ uri: z.string(), counter: z.number().int(), updatedAt: z.string(), legacySubscribers: z.number().int() }),
            annotations: { readOnlyHint: false, idempotentHint: false }
        },
        async () => {
            live.counter++;
            live.updatedAt = new Date().toISOString();
            publish({ kind: 'updated', uri: LIVE_RESOURCE_URI });
            const legacySubscribers = [...legacySubscriptions].filter(s => s.has(LIVE_RESOURCE_URI)).length;
            logger.info('lists.updated', `${LIVE_RESOURCE_URI} counter → ${live.counter}`, { uri: LIVE_RESOURCE_URI, counter: live.counter, legacySubscribers });
            return {
                content: [
                    {
                        type: 'text',
                        text:
                            `${LIVE_RESOURCE_URI} now has counter ${live.counter}. Sent notifications/resources/updated.\n` +
                            `2025-era connections subscribed to it: ${legacySubscribers}.\n` +
                            delivery('it only after resources/subscribe')
                    }
                ],
                structuredContent: { uri: LIVE_RESOURCE_URI, counter: live.counter, updatedAt: live.updatedAt, legacySubscribers }
            };
        }
    );
}
