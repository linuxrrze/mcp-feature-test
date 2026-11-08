/**
 * Colour picker: a standalone MCP App used like a question to the user.
 *
 *   pick_color          (model)  shows the picker, returns at once with a requestId
 *   pick_color_submit   (app)    the picker stores the user's answer (OK / Cancel)
 *   pick_color_result   (model)  reads the answer, or "still waiting"
 *
 * Unlike elicitation, the pick_color tool call has already returned when the
 * user answers: MCP Apps have no way to complete a pending tool call. The answer
 * reaches the model in a later step instead (ui/update-model-context,
 * ui/message, or pick_color_result), see docs/server-vs-app.md.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';

const here = dirname(fileURLToPath(import.meta.url));

export const COLOR_PICKER_URI = 'ui://feature-test/color-picker.html';
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_PICK_PROMPT = 'Pick a colour';
export const DEFAULT_PICK_COLOR = '#4f46e5';
/** Requests kept (oldest dropped first) and how long they stay answerable / readable. */
export const MAX_COLOR_REQUESTS = 200;
export const COLOR_REQUEST_TTL_MS = 60 * 60_000;
export const MAX_PICK_PROMPT_CHARS = 500;

export interface ColorRequest {
    requestId: string;
    prompt: string;
    initial: string;
    createdAt: number;
    answeredAt?: number;
    action?: 'accept' | 'cancel';
    color?: string | null;
}

// Module level: HTTP mode builds a fresh McpServer per request.
const requests = new Map<string, ColorRequest>();

function prune(now = Date.now()): void {
    for (const [id, r] of requests) if (now - r.createdAt > COLOR_REQUEST_TTL_MS) requests.delete(id);
    // Map iteration is insertion order, so the oldest go first.
    for (const id of requests.keys()) {
        if (requests.size < MAX_COLOR_REQUESTS) break;
        requests.delete(id);
    }
}

export function createColorRequest(prompt: string, initial: string, now = Date.now()): ColorRequest {
    prune(now);
    const r: ColorRequest = { requestId: randomUUID(), prompt, initial: initial.toLowerCase(), createdAt: now };
    requests.set(r.requestId, r);
    return r;
}

export function getColorRequest(requestId: string, now = Date.now()): ColorRequest | undefined {
    const r = requests.get(requestId);
    if (r && now - r.createdAt > COLOR_REQUEST_TTL_MS) {
        requests.delete(requestId);
        return undefined;
    }
    return r;
}

/** Most recently created request that has not expired. */
export function latestColorRequest(now = Date.now()): ColorRequest | undefined {
    prune(now);
    return [...requests.values()].at(-1);
}

export function colorRequestCount(): number {
    return requests.size;
}

/** For tests. */
export function resetColorRequests(): void {
    requests.clear();
}

export type SubmitOutcome = { ok: true; request: ColorRequest } | { ok: false; error: string };

/** Validate and store an answer. Each request can be answered exactly once. */
export function answerColorRequest(requestId: string, action: 'accept' | 'cancel', color: string | null | undefined, now = Date.now()): SubmitOutcome {
    const r = getColorRequest(requestId, now);
    if (!r) return { ok: false, error: `Unknown or expired colour request "${requestId}". Ask the assistant to call pick_color again.` };
    if (r.answeredAt) return { ok: false, error: `Colour request ${requestId} was already answered (${r.action}${r.color ? ` ${r.color}` : ''}).` };
    if (action === 'accept') {
        if (typeof color !== 'string' || !HEX_COLOR.test(color)) return { ok: false, error: `Invalid colour ${JSON.stringify(color ?? null)}: expected #rrggbb.` };
        r.color = color.toLowerCase();
    } else {
        if (color != null) return { ok: false, error: 'A cancelled request carries no colour (color must be null).' };
        r.color = null;
    }
    r.action = action;
    r.answeredAt = now;
    return { ok: true, request: r };
}

export function describeColorRequest(r: ColorRequest): string {
    if (!r.answeredAt) return `Still waiting: the user has not answered the colour picker yet ("${r.prompt}", requestId ${r.requestId}).`;
    if (r.action === 'cancel') return `The user cancelled the colour picker ("${r.prompt}") without choosing a colour.`;
    return `The user picked ${r.color} for "${r.prompt}".`;
}

function publicView(r: ColorRequest) {
    return {
        requestId: r.requestId,
        prompt: r.prompt,
        initial: r.initial,
        status: r.answeredAt ? (r.action === 'accept' ? 'picked' : 'cancelled') : 'waiting',
        color: r.color ?? null,
        createdAt: new Date(r.createdAt).toISOString(),
        answeredAt: r.answeredAt ? new Date(r.answeredAt).toISOString() : null
    };
}

function loadHtml(): string {
    // Built by `npm run build:ui` (esbuild bundles ui/color-picker.ts and inlines it).
    const candidates = [join(here, '..', 'dist', 'ui', 'color-picker.html'), join(here, 'ui', 'color-picker.html')];
    for (const p of candidates) {
        try {
            return readFileSync(p, 'utf8');
        } catch {
            /* try next */
        }
    }
    return '<!doctype html><html><body><p>Colour picker UI not built. Run <code>npm run build</code>.</p></body></html>';
}

const text = (t: string, extra: Partial<CallToolResult> = {}): CallToolResult => ({ content: [{ type: 'text', text: t }], ...extra });

export function registerColorPicker(server: McpServer): void {
    registerAppResource(
        server,
        'Colour picker',
        COLOR_PICKER_URI,
        { description: 'A small colour picker that asks the user one question', _meta: { ui: { prefersBorder: true } } },
        async () => ({
            contents: [{ uri: COLOR_PICKER_URI, mimeType: RESOURCE_MIME_TYPE, text: loadHtml(), _meta: { ui: { prefersBorder: true } } }]
        })
    );

    registerAppTool(
        server,
        'pick_color',
        {
            title: 'Ask the user for a colour (MCP App)',
            description:
                'Show a small colour picker (MCP App) that asks the user a question. The call returns immediately; the user answers afterwards. ' +
                'The answer reaches you as a chat message or model context, or call pick_color_result to read it.',
            inputSchema: {
                prompt: z.string().min(1).max(MAX_PICK_PROMPT_CHARS).optional().describe('Question shown above the picker'),
                initial: z.string().regex(HEX_COLOR, 'expected #rrggbb').optional().describe('Pre-selected colour, #rrggbb')
            },
            annotations: { readOnlyHint: true },
            _meta: { ui: { resourceUri: COLOR_PICKER_URI } }
        },
        async ({ prompt, initial }) => {
            const r = createColorRequest(prompt ?? DEFAULT_PICK_PROMPT, initial ?? DEFAULT_PICK_COLOR);
            return text(
                'A colour picker is shown to the user; wait for their choice. If no picker appeared, this client does not render MCP Apps. ' +
                    `(requestId ${r.requestId}; pick_color_result reads the answer.)`,
                { structuredContent: { requestId: r.requestId, prompt: r.prompt, initial: r.initial } }
            );
        }
    );

    registerAppTool(
        server,
        'pick_color_submit',
        {
            title: 'Submit colour picker answer (app-only)',
            description: "Called by the colour picker UI to store the user's answer (OK or Cancel). Hidden from the model.",
            inputSchema: {
                requestId: z.string().max(100),
                color: z.string().max(20).nullable().optional(),
                action: z.enum(['accept', 'cancel'])
            },
            _meta: { ui: { resourceUri: COLOR_PICKER_URI, visibility: ['app'] } }
        },
        async ({ requestId, color, action }) => {
            const out = answerColorRequest(requestId, action, color);
            if (!out.ok) return text(out.error, { isError: true });
            return text(`Stored: ${describeColorRequest(out.request)}`, { structuredContent: publicView(out.request) });
        }
    );

    server.registerTool(
        'pick_color_result',
        {
            title: 'Read the colour picker answer',
            description:
                'Return the answer to a pick_color question: the colour, "cancelled", or "still waiting". Without requestId the most recent pick_color request is used.',
            inputSchema: z.object({ requestId: z.string().max(100).optional().describe('requestId from pick_color (default: the latest)') }),
            annotations: { readOnlyHint: true }
        },
        async ({ requestId }) => {
            const r = requestId ? getColorRequest(requestId) : latestColorRequest();
            if (!r) {
                return requestId
                    ? text(`Unknown or expired colour request "${requestId}".`, { isError: true })
                    : text('No colour picker request yet. Call pick_color first.');
            }
            return text(describeColorRequest(r), { structuredContent: publicView(r) });
        }
    );
}
