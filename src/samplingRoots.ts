/**
 * Sampling and roots: the two client features the server could so far only
 * *detect* (inspect_client) but never used.
 *
 *  - sample_llm  – `sampling/createMessage`: the client runs its LLM for the
 *                  server (system prompt, model hints, maxTokens, optional image
 *                  input and includeContext). With `useTools` it runs the
 *                  2025-11-25 tool loop: the model asks for `count_letters`, the
 *                  server answers with a `tool_result`, the next round finishes.
 *  - list_roots  – `roots/list`: which folders the client exposes, plus the
 *                  `notifications/roots/list_changed` it has sent.
 *
 * Both are written in the 2026-07-28 input_required style (like the
 * elicitation tools); the SDK's legacy shim sends real server→client requests
 * on 2025-era connections. Both features are deprecated as of 2026-07-28
 * (SEP-2577) but stay in the spec for at least twelve months.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    inputRequired,
    inputResponse,
    type CallToolResult,
    type CreateMessageRequestParams,
    type InputRequiredResult,
    type McpServer,
    type SamplingMessage,
    type ServerContext,
    type Tool
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { summarizeCapabilities, type ClientObservation } from './clients.js';
import { getSampleFile } from './files.js';
import { logger } from './log.js';

/** requestState of the two tools (part of the server's signed state union). */
export type SamplingRootsState =
    | { tool: 'sample'; round: number; messages: SamplingMessage[]; toolCalls: ToolCallLog[] }
    | { tool: 'roots' };

export interface ToolCallLog {
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
}

export interface SamplingRootsDeps {
    clientOf: (ctx: ServerContext) => ClientObservation;
    mintState: (s: SamplingRootsState) => Promise<string>;
}

/** Sampling rounds per sample_llm call (the first plus up to two tool-result rounds). */
export const MAX_SAMPLING_ROUNDS = 3;

export const DEFAULT_SAMPLING_PROMPT = 'Write a haiku about the Model Context Protocol.';
export const DEFAULT_IMAGE_PROMPT = 'Describe this image in one sentence.';
export const DEFAULT_TOOLS_PROMPT = 'How many times does the letter "r" appear in the word "strawberry"? Use the count_letters tool, then answer in one sentence.';

/** The one tool sample_llm offers the client's model when `useTools` is set. */
export const COUNT_LETTERS_TOOL: Tool = {
    name: 'count_letters',
    description: 'Count how often a letter occurs in a word (case-insensitive).',
    inputSchema: {
        type: 'object',
        properties: {
            word: { type: 'string', description: 'The word to search' },
            letter: { type: 'string', description: 'A single letter' }
        },
        required: ['word', 'letter']
    }
};

/** Runs a tool the client's model asked for. Unknown tools and bad input become error results. */
export function runSamplingTool(name: string, input: Record<string, unknown>): { text: string; isError: boolean } {
    if (name !== COUNT_LETTERS_TOOL.name) return { text: `Unknown tool "${name}". The only tool is count_letters.`, isError: true };
    const { word, letter } = input;
    if (typeof word !== 'string' || typeof letter !== 'string' || [...letter].length !== 1) {
        return { text: 'count_letters needs {"word": string, "letter": a single character}.', isError: true };
    }
    const needle = letter.toLowerCase();
    const count = [...word.toLowerCase()].filter(c => c === needle).length;
    return { text: String(count), isError: false };
}

type Block = { type: string; [k: string]: unknown };

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? content : content ? [content] : []) as Block[];

/** One line per content block of a sampling reply, for the text result. */
function describeBlock(b: Block): string {
    switch (b.type) {
        case 'text':
            return String(b.text ?? '');
        case 'image':
        case 'audio':
            return `[${b.type}, ${b.mimeType ?? '?'}, ${typeof b.data === 'string' ? Math.floor((b.data.length * 3) / 4) : 0} bytes]`;
        case 'tool_use':
            return `[tool_use ${b.name}(${JSON.stringify(b.input ?? {})})]`;
        default:
            return `[${b.type}]`;
    }
}

const text = (t: string, extra: Partial<CallToolResult> = {}): CallToolResult => ({ content: [{ type: 'text', text: t }], ...extra });

function whoIs(client: ClientObservation): string {
    return client.clientInfo ? `${client.clientInfo.name} ${client.clientInfo.version}` : 'This client';
}

// ---------------------------------------------------------------------------
// roots/list_changed notifications (process-wide, by client name)
// ---------------------------------------------------------------------------

interface RootsChanges {
    count: number;
    lastAt: string;
}
const rootsChanges = new Map<string, RootsChanges>();

export function rootsChangesFor(clientName: string | undefined): RootsChanges | undefined {
    return rootsChanges.get(clientName ?? '?');
}

/** For tests. */
export function resetRootsChanges(): void {
    rootsChanges.clear();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSamplingAndRoots(server: McpServer, { clientOf, mintState }: SamplingRootsDeps): void {
    // 2025-era connections deliver the notification on this server instance.
    server.server.setNotificationHandler('notifications/roots/list_changed', () => {
        const name = server.server.getClientVersion()?.name ?? '?';
        const prev = rootsChanges.get(name);
        rootsChanges.set(name, { count: (prev?.count ?? 0) + 1, lastAt: new Date().toISOString() });
        logger.info('roots.list_changed', `${name} sent notifications/roots/list_changed (#${(prev?.count ?? 0) + 1})`, { client: name });
    });

    // ------------------------------------------------------------- sampling
    server.registerTool(
        'sample_llm',
        {
            title: 'Ask the client’s LLM (sampling)',
            description:
                'Send a sampling/createMessage request: the client runs its own LLM for this server (it should let the user review the request first) and returns the reply. ' +
                'Reports the reply, the model the client chose and the stop reason. Options: system prompt, model hint, maxTokens, temperature, includeContext, an image input, and useTools (the 2025-11-25 tool loop with a count_letters tool).',
            inputSchema: z.object({
                prompt: z.string().min(1).max(2000).optional().describe('User message sent to the client’s LLM (default depends on withImage/useTools)'),
                systemPrompt: z.string().max(2000).default('You are a concise assistant. Answer in at most three lines.').describe('System prompt; empty string = none'),
                modelHint: z.string().max(100).default('claude').describe('modelPreferences.hints[0].name (substring of the model the client should prefer); empty = no hint'),
                maxTokens: z.number().int().min(1).max(4096).default(200),
                temperature: z.number().min(0).max(2).optional(),
                includeContext: z
                    .enum(['none', 'thisServer', 'allServers'])
                    .default('none')
                    .describe('Ask the client to add conversation context (needs the sampling.context capability)'),
                withImage: z.boolean().default(false).describe('Send a 32×32 gradient PNG as an image message before the prompt'),
                useTools: z.boolean().default(false).describe('Offer a count_letters tool to the model (needs the sampling.tools capability)')
            }),
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        async (args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const client = clientOf(ctx);
            const caps = summarizeCapabilities(client.capabilities).sampling;
            if (!caps.supported) {
                return text(
                    `${whoIs(client)} did not declare the sampling capability, so the server cannot ask its LLM. Run inspect_client for the full capability report.`,
                    { isError: true }
                );
            }
            if (args.useTools && !caps.tools) {
                return text(`${whoIs(client)} declared sampling but not sampling.tools, so the server must not offer tools in a sampling request. Call again without useTools.`, {
                    isError: true
                });
            }
            if (args.includeContext !== 'none' && !caps.context) {
                return text(
                    `${whoIs(client)} declared sampling but not sampling.context, so includeContext "${args.includeContext}" must not be used. Call again with includeContext "none".`,
                    { isError: true }
                );
            }

            const prompt = args.prompt ?? (args.useTools ? DEFAULT_TOOLS_PROMPT : args.withImage ? DEFAULT_IMAGE_PROMPT : DEFAULT_SAMPLING_PROMPT);
            const firstMessages = (): SamplingMessage[] => {
                const msgs: SamplingMessage[] = [];
                const png = args.withImage ? getSampleFile('gradient.png') : undefined;
                if (png?.bytes) msgs.push({ role: 'user', content: { type: 'image', data: png.bytes.toString('base64'), mimeType: png.mimeType } });
                msgs.push({ role: 'user', content: { type: 'text', text: prompt } });
                return msgs;
            };
            const requestFor = (messages: SamplingMessage[]): CreateMessageRequestParams => ({
                messages,
                maxTokens: args.maxTokens,
                ...(args.systemPrompt && { systemPrompt: args.systemPrompt }),
                ...(args.modelHint && { modelPreferences: { hints: [{ name: args.modelHint }], intelligencePriority: 0.5, speedPriority: 0.8, costPriority: 0.3 } }),
                ...(args.temperature !== undefined && { temperature: args.temperature }),
                ...(args.includeContext !== 'none' && { includeContext: args.includeContext }),
                ...(args.useTools && { tools: [COUNT_LETTERS_TOOL], toolChoice: { mode: 'auto' as const } })
            });
            const sent = {
                maxTokens: args.maxTokens,
                systemPrompt: args.systemPrompt || null,
                modelHint: args.modelHint || null,
                temperature: args.temperature ?? null,
                includeContext: args.includeContext,
                image: args.withImage,
                tools: args.useTools ? [COUNT_LETTERS_TOOL.name] : []
            };
            const ask = async (round: number, messages: SamplingMessage[], toolCalls: ToolCallLog[]) =>
                inputRequired({
                    inputRequests: { sample: inputRequired.createMessage(requestFor(messages)) },
                    requestState: await mintState({ tool: 'sample', round, messages, toolCalls })
                });

            const state = ctx.mcpReq.requestState<SamplingRootsState>();
            const view = inputResponse(ctx.mcpReq.inputResponses, 'sample');
            if (state?.tool !== 'sample') return ask(1, firstMessages(), []);
            if (view.kind !== 'sampling') {
                return text(
                    `The client answered round ${state.round} without a sampling result (got: ${view.kind}). The user may have rejected the request, or the client does not really implement sampling.`,
                    { isError: true }
                );
            }

            const reply = view.result;
            const blocks = blocksOf(reply.content);
            const toolUses = blocks.filter(b => b.type === 'tool_use') as unknown as { id: string; name: string; input: Record<string, unknown> }[];
            const toolCalls = [...state.toolCalls];

            if (args.useTools && toolUses.length > 0 && state.round < MAX_SAMPLING_ROUNDS) {
                const results = toolUses.map(u => {
                    const r = runSamplingTool(u.name, u.input ?? {});
                    toolCalls.push({ name: u.name, input: u.input ?? {}, result: r.text, isError: r.isError });
                    return { type: 'tool_result' as const, toolUseId: u.id, content: [{ type: 'text' as const, text: r.text }], ...(r.isError && { isError: true }) };
                });
                const messages: SamplingMessage[] = [
                    ...state.messages,
                    { role: 'assistant', content: blocks as SamplingMessage['content'] },
                    { role: 'user', content: results }
                ];
                return ask(state.round + 1, messages, toolCalls);
            }

            const replyText = blocks.map(describeBlock).join('\n');
            const lines = [
                `Sampling round-trip complete (${state.round} round${state.round === 1 ? '' : 's'}).`,
                `Model: ${reply.model}   stop reason: ${reply.stopReason ?? '(none)'}`,
                ...(toolCalls.length ? [`Tool calls: ${toolCalls.map(c => `${c.name}(${JSON.stringify(c.input)}) → ${c.result}`).join('; ')}`] : []),
                ...(args.useTools && toolUses.length && state.round >= MAX_SAMPLING_ROUNDS ? [`Stopped after ${MAX_SAMPLING_ROUNDS} rounds although the model still asked for a tool.`] : []),
                ...(args.useTools && !toolCalls.length ? ['The model did not use the count_letters tool.'] : []),
                'Reply (written by the client’s LLM):',
                replyText || '(empty)',
                '',
                `Sent: maxTokens ${sent.maxTokens}, system prompt ${sent.systemPrompt ? 'yes' : 'no'}, model hint ${sent.modelHint ? `"${sent.modelHint}"` : 'none'}, ` +
                    `temperature ${sent.temperature ?? 'default'}, includeContext ${sent.includeContext}, image ${sent.image ? 'yes' : 'no'}, tools ${sent.tools.join(', ') || 'none'}.`
            ];
            return text(lines.join('\n'), {
                structuredContent: {
                    model: reply.model,
                    stopReason: reply.stopReason ?? null,
                    role: reply.role,
                    reply: replyText,
                    contentTypes: blocks.map(b => b.type),
                    rounds: state.round,
                    toolCalls,
                    sent
                }
            });
        }
    );

    // ---------------------------------------------------------------- roots
    server.registerTool(
        'list_roots',
        {
            title: 'List the client’s roots',
            description:
                'Send a roots/list request and report the folders (file:// roots) the client exposes to this server, whether each path exists on the machine running the server, ' +
                'and how many notifications/roots/list_changed the client has sent. Reads nothing inside the folders.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const client = clientOf(ctx);
            const caps = summarizeCapabilities(client.capabilities).roots;
            if (!caps.supported) {
                return text(`${whoIs(client)} did not declare the roots capability, so it has no roots to list. Run inspect_client for the full capability report.`, {
                    isError: true
                });
            }
            const state = ctx.mcpReq.requestState<SamplingRootsState>();
            const view = inputResponse(ctx.mcpReq.inputResponses, 'roots');
            if (view.kind !== 'roots') {
                if (state?.tool === 'roots') {
                    return text(`The client answered without a roots/list result (got: ${view.kind}).`, { isError: true });
                }
                return inputRequired({ inputRequests: { roots: inputRequired.listRoots() }, requestState: await mintState({ tool: 'roots' }) });
            }

            const roots = view.roots.map(r => {
                let path: string | null = null;
                try {
                    path = fileURLToPath(r.uri);
                } catch {
                    /* not a file:// URI */
                }
                return { uri: r.uri, name: r.name ?? null, path, existsOnServer: path !== null && existsSync(path) };
            });
            const changes = rootsChangesFor(client.clientInfo?.name);
            // 2026-07-28 has no client→server notifications: the client sends its roots again whenever asked.
            const notificationsExist = client.era === 'legacy';
            const listChanged = {
                declared: caps.listChanged,
                notificationsExist,
                notificationsSeen: changes?.count ?? 0,
                lastAt: changes?.lastAt ?? null
            };
            const lines = [
                roots.length ? `${whoIs(client)} exposes ${roots.length} root${roots.length === 1 ? '' : 's'}:` : `${whoIs(client)} exposes no roots (empty list).`,
                ...roots.map(
                    r =>
                        `  ${r.name ? `${r.name}: ` : ''}${r.uri}` +
                        (r.path === null ? '  (not a valid file:// URI)' : r.existsOnServer ? '  (exists on the server’s machine)' : '  (not found on the server’s machine)')
                ),
                `roots.listChanged declared: ${listChanged.declared ? 'yes' : 'no'}; ` +
                    (notificationsExist
                        ? `list_changed notifications received: ${listChanged.notificationsSeen}` + (listChanged.lastAt ? ` (last at ${listChanged.lastAt})` : '')
                        : 'list_changed notifications do not exist on 2026-07-28 (the client lists its roots again on every request)')
            ];
            return text(lines.join('\n'), { structuredContent: { roots, listChanged } });
        }
    );
}
