/**
 * MCP feature-test server: user-interaction features of current MCP.
 *
 *  1. Elicitation, form mode   – the client renders a native dialog from a JSON schema
 *  2. Elicitation, URL mode    – the client opens a browser page (OAuth/secret-style flows)
 *  3. Multi-round elicitation  – wizard over several dialogs (input_required + requestState)
 *  4. MCP Apps (ext-apps)      – a full interactive HTML UI rendered by the host in an iframe
 *  5. Progress / logging / cancellation, and a client-capability inspector
 *  6. Files: returning files (embedded resources, resource_link, image, audio),
 *     uploads from the MCP App, and non-spec form-schema probes
 *
 * Elicitation is written with the 2026-07-28 "input_required" (multi-round-trip)
 * pattern. The SDK's legacy shim turns the same code into classic
 * `elicitation/create` requests for 2025-era clients, so one implementation
 * serves both protocol generations.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    McpServer,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    ResourceTemplate,
    acceptedContent,
    createRequestStateCodec,
    inputRequired,
    inputResponse,
    isInputRequiredResult,
    type CallToolResult,
    type InputRequiredResult,
    type ServerContext
} from '@modelcontextprotocol/server';
import { serverVersion } from './version.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';
import {
    formatCapabilitySummary,
    listSeenClients,
    recordConnection,
    recordRequest,
    summarizeCapabilities,
    type ClientInfo,
    type ClientObservation,
    type Era,
    type TransportKind
} from './clients.js';
import {
    FILES_EXTENSION,
    FILES_URI_TEMPLATE,
    SAMPLE_FILES,
    decodeBase64Strict,
    formatBytes,
    getSampleFile,
    sampleFileContents,
    sampleFileSize,
    sampleFileUri,
    sha256Base64Url,
    sha256Hex,
    uploadMaxBytes
} from './files.js';
import { registerColorPicker } from './colorPicker.js';
import { registerViewer3d } from './viewer3d.js';
import { createFlow, flowWaitMs, getFlow, waitForFlow } from './flows.js';
import { errorData, logger } from './log.js';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Shared, process-wide state (HTTP mode builds a fresh McpServer per request,
// so everything that must survive between calls lives at module level).
// ---------------------------------------------------------------------------

type WizardState =
    | { tool: 'wizard'; step: 'toppings'; size: string; crust: string; name: string }
    | { tool: 'wizard'; step: 'confirm'; size: string; crust: string; name: string; toppings: string[]; notes?: string }
    | { tool: 'url'; flowId: string }
    | { tool: 'probe'; queue: FormatProbeName[]; results: FormatProbeResult[] };

/** Signed (HMAC) requestState so the client cannot tamper with wizard progress. */
const stateCodec = createRequestStateCodec<WizardState>({
    key: crypto.getRandomValues(new Uint8Array(32)),
    ttlSeconds: 15 * 60
});

interface DialogSubmission {
    id: number;
    receivedAt: string;
    data: unknown;
}
const dialogSubmissions: DialogSubmission[] = [];
let lastSubmissionId = 0;
/** Kept submissions (oldest dropped first) and the largest accepted one (JSON-serialized). */
export const MAX_DIALOG_SUBMISSIONS = 50;
export const MAX_DIALOG_SUBMISSION_BYTES = 1024 * 1024;

export const DIALOG_APP_URI = 'ui://feature-test/dialog-lab.html';

function loadDialogAppHtml(): string {
    // Built by `npm run build:ui` (esbuild bundles ui/dialog-lab.ts and inlines it).
    const candidates = [join(here, '..', 'dist', 'ui', 'dialog-lab.html'), join(here, 'ui', 'dialog-lab.html')];
    for (const p of candidates) {
        try {
            return readFileSync(p, 'utf8');
        } catch {
            /* try next */
        }
    }
    return '<!doctype html><html><body><p>Dialog Lab UI not built. Run <code>npm run build</code>.</p></body></html>';
}

/** 'decline' → 'declined', 'cancel' → 'cancelled', 'accept' → 'accepted'. */
const pastTense = (action: string) => ({ accept: 'accepted', decline: 'declined', cancel: 'cancelled' })[action] ?? `${action}ed`;

/** Masked form of a URL-flow token for tool results. Short tokens are not revealed at all (4 shown characters would nearly disclose them). */
export const maskToken = (t: string) => (t.length < 12 ? '****' : `${t.slice(0, 2)}…${t.slice(-2)}`);

const text = (t: string, extra: Partial<CallToolResult> = {}): CallToolResult => ({ content: [{ type: 'text', text: t }], ...extra });

// ---------------------------------------------------------------------------
// Who is calling? (works for both protocol eras)
// ---------------------------------------------------------------------------

export interface FeatureTestServerOptions {
    /** Which entry point built this instance (used for logs and inspect_client). */
    transport?: TransportKind;
}

/**
 * Client identity for one request. 2026-07-28 requests carry it in the `_meta`
 * envelope; 2025-era connections declared it once during `initialize`.
 */
function observeClient(server: McpServer, ctx: ServerContext, transport: TransportKind | undefined): ClientObservation {
    const env = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
    const modern = env[PROTOCOL_VERSION_META_KEY] !== undefined;
    return {
        clientInfo: ((modern ? env[CLIENT_INFO_META_KEY] : server.server.getClientVersion()) ?? null) as ClientInfo | null,
        capabilities: ((modern ? env[CLIENT_CAPABILITIES_META_KEY] : server.server.getClientCapabilities()) ?? null) as Record<string, any> | null,
        protocolVersion: ((modern ? env[PROTOCOL_VERSION_META_KEY] : server.server.getNegotiatedProtocolVersion()) ?? null) as string | null,
        era: modern ? 'modern' : 'legacy',
        transport: transport ?? (ctx.http ? 'http' : 'stdio')
    };
}

/** A friendly tool error (instead of a protocol error) when the client cannot show the dialog. */
function missingElicitation(client: ClientObservation, mode: 'form' | 'url'): CallToolResult | undefined {
    if (summarizeCapabilities(client.capabilities).elicitation[mode]) return undefined;
    const who = client.clientInfo ? `${client.clientInfo.name} ${client.clientInfo.version}` : 'This client';
    return text(
        `${who} did not declare ${mode}-mode elicitation support (capabilities.elicitation${mode === 'url' ? '.url' : ''}), ` +
            `so the server cannot show this dialog. Declared elicitation capability: ${JSON.stringify(client.capabilities?.elicitation ?? null)}. ` +
            'Run inspect_client for the full capability report.',
        { isError: true }
    );
}

function describeInputResponses(responses: Record<string, unknown> | undefined): string {
    if (!responses) return '';
    return Object.keys(responses)
        .map(k => {
            const v = inputResponse(responses, k);
            return `${k}=${v.kind === 'elicit' ? v.action : v.kind}`;
        })
        .join(', ');
}

/**
 * Wrap every request handler registered on this instance so that each request
 * updates the seen-clients registry (first sighting of a 2026-07-28 client is
 * logged) and every tools/call round is logged with its outcome.
 *
 * Hooking `setRequestHandler` before any tool is registered is the narrowest
 * public seam the SDK offers for this; the SDK's own wrapping (validation, the
 * input_required / legacy shim loop) still sits outside ours, so on 2025-era
 * connections each shim round passes through here as well.
 */
function instrumentRequests(server: McpServer, transport: TransportKind | undefined): void {
    const low = server.server as unknown as { setRequestHandler: (method: string, ...rest: unknown[]) => void };
    const original = low.setRequestHandler.bind(low);
    low.setRequestHandler = (method: string, ...rest: unknown[]) => {
        const handler = rest[rest.length - 1];
        if (typeof handler !== 'function') return original(method, ...rest);
        const wrapped = async (req: { params?: { name?: unknown } }, ctx: ServerContext) => {
            const client = observeClient(server, ctx, transport);
            recordRequest(client, method);
            if (method !== 'tools/call') return handler(req, ctx);
            return observeToolCall(String(req?.params?.name ?? '?'), client, ctx, () => handler(req, ctx));
        };
        return original(method, ...rest.slice(0, -1), wrapped);
    };
}

async function observeToolCall(name: string, client: ClientObservation, ctx: ServerContext, run: () => Promise<unknown>): Promise<unknown> {
    const started = Date.now();
    const answers = describeInputResponses(ctx.mcpReq.inputResponses as Record<string, unknown> | undefined);
    const base = { tool: name, era: client.era, transport: client.transport, client: client.clientInfo?.name ?? null };
    try {
        const result = await run();
        const ms = Date.now() - started;
        if (isInputRequiredResult(result)) {
            const asks = Object.entries(result.inputRequests ?? {}).map(([k, r]) => {
                const params = (r as { params?: { mode?: string } }).params;
                return `${k} (${params?.mode ?? 'form'})`;
            });
            logger.info('tool.input_required', `${name} [${client.era}]${answers ? ` user: ${answers};` : ''} asks for input: ${asks.join(', ') || '(state only)'}`, {
                ...base,
                responses: answers || null,
                inputRequests: asks
            });
        } else {
            const r = result as CallToolResult;
            const outcome = ctx.mcpReq.signal.aborted ? 'cancelled' : r?.isError ? 'error' : 'ok';
            logger.info('tool.result', `${name} [${client.era}]${answers ? ` user: ${answers};` : ''} → ${outcome} (${ms} ms)`, {
                ...base,
                responses: answers || null,
                outcome,
                ms
            });
        }
        return result;
    } catch (e) {
        logger.warn('tool.error', `${name} [${client.era}] threw: ${(e as Error)?.message ?? e}`, { ...base, ...errorData(e) });
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Elicitation form schemas
// ---------------------------------------------------------------------------

/** Every primitive the 2025-11-25+ elicitation spec allows in a form. */
export function allFieldsSchema(variant: 'all' | 'basic' | 'formats' | 'enums') {
    const basic = {
        name: {
            type: 'string',
            title: 'Full name',
            description: 'Plain string with min/max length and a default',
            minLength: 2,
            maxLength: 50,
            default: 'Ada Lovelace'
        },
        age: { type: 'integer', title: 'Age', description: 'Integer 0–150', minimum: 0, maximum: 150, default: 36 },
        confidence: { type: 'number', title: 'Confidence', description: 'Number 0.0–1.0', minimum: 0, maximum: 1, default: 0.75 },
        subscribe: { type: 'boolean', title: 'Subscribe to newsletter', description: 'Boolean checkbox', default: true }
    };
    const formats = {
        email: { type: 'string', format: 'email', title: 'E-mail', description: 'format: email' },
        website: { type: 'string', format: 'uri', title: 'Website', description: 'format: uri', default: 'https://example.org' },
        birthday: { type: 'string', format: 'date', title: 'Birthday', description: 'format: date (YYYY-MM-DD)' },
        meeting: { type: 'string', format: 'date-time', title: 'Next meeting', description: 'format: date-time (ISO 8601)' }
    };
    const enums = {
        color: {
            type: 'string',
            title: 'Favourite colour',
            description: 'Single-select, untitled enum',
            enum: ['red', 'green', 'blue'],
            default: 'green'
        },
        tshirt: {
            type: 'string',
            title: 'T-shirt size',
            description: 'Single-select, titled options (oneOf const/title)',
            oneOf: [
                { const: 's', title: 'Small' },
                { const: 'm', title: 'Medium' },
                { const: 'l', title: 'Large' },
                { const: 'xl', title: 'Extra large' }
            ],
            default: 'm'
        },
        languages: {
            type: 'array',
            title: 'Languages you speak',
            description: 'Multi-select, untitled (1–3 items)',
            minItems: 1,
            maxItems: 3,
            items: { type: 'string', enum: ['English', 'German', 'French', 'Spanish', 'Japanese'] },
            default: ['English']
        },
        features: {
            type: 'array',
            title: 'Features to enable',
            description: 'Multi-select, titled options (items.anyOf)',
            items: {
                anyOf: [
                    { const: 'dark', title: '🌙 Dark mode' },
                    { const: 'beta', title: '🧪 Beta features' },
                    { const: 'sync', title: '🔄 Cloud sync' }
                ]
            },
            default: ['dark']
        },
        priority: {
            type: 'string',
            title: 'Priority',
            description: 'Legacy titled enum (enum + enumNames, deprecated but still common)',
            enum: ['p1', 'p2', 'p3'],
            enumNames: ['High', 'Normal', 'Low'],
            default: 'p2'
        }
    };
    const properties =
        variant === 'basic' ? basic : variant === 'formats' ? formats : variant === 'enums' ? enums : { ...basic, ...formats, ...enums };
    const required = variant === 'formats' ? ['email'] : variant === 'enums' ? ['color'] : variant === 'basic' ? ['name'] : ['name', 'email'];
    // Cast: the SDK's static type is narrower than the spec for a few legacy shapes (enumNames).
    return { type: 'object', properties, required } as never;
}

/**
 * Schema features that are NOT part of the elicitation spec (which allows only
 * a flat object of string / number / integer / boolean / enum / multi-select
 * properties, and the string formats email, uri, date and date-time). Each
 * probe is shown as its own one-field dialog. Ordered from "extra keyword on
 * an allowed type" (most likely to be tolerated) to "type the spec lacks".
 */
export const FORMAT_PROBES = {
    pattern: {
        what: 'string with a "pattern" regex constraint (not an allowed keyword)',
        field: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{3}$', title: 'Ticket code', description: 'pattern: ^[A-Z]{3}-[0-9]{3}$, e.g. ABC-123', default: 'ABC-123' }
    },
    color: {
        what: 'string with format "color" (not an allowed format)',
        field: { type: 'string', format: 'color', title: 'Pick a colour', description: 'format: "color" – a colour picker, if the client has one', default: '#4f46e5' }
    },
    time: {
        what: 'string with format "time" (not an allowed format)',
        field: { type: 'string', format: 'time', title: 'Pick a time', description: 'format: "time" (HH:MM:SS)', default: '12:30:00' }
    },
    nested_object: {
        what: 'property of type "object" with its own properties (forms must be flat)',
        field: {
            type: 'object',
            title: 'Address',
            description: 'Nested object with street and city',
            properties: { street: { type: 'string', title: 'Street' }, city: { type: 'string', title: 'City' } },
            required: ['city']
        }
    },
    free_array: {
        what: 'array of free-text strings (arrays are only allowed as multi-selects with enum/anyOf items)',
        field: { type: 'array', title: 'Tags', description: 'Array of free-text strings (items without enum)', items: { type: 'string' }, minItems: 1 }
    },
    file: {
        what: 'string with format "data-url" and contentMediaType (how generic JSON Schema form libraries ask for a file; the spec has no file field)',
        field: { type: 'string', format: 'data-url', contentMediaType: 'image/*', title: 'Pick a file', description: 'format: "data-url" – a file picker, if the client has one' }
    }
} as const;

export type FormatProbeName = keyof typeof FORMAT_PROBES;
export const FORMAT_PROBE_NAMES = Object.keys(FORMAT_PROBES) as FormatProbeName[];

export interface FormatProbeResult {
    probe: FormatProbeName;
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
}

/** The (intentionally non-spec) requestedSchema for one probe: a single field named after the probe. */
export function formatProbeSchema(name: FormatProbeName) {
    // Cast: these shapes are outside the SDK's (spec-conforming) static type on purpose.
    return { type: 'object', properties: { [name]: FORMAT_PROBES[name].field } } as never;
}

const PIZZA_TOPPINGS = [
    { const: 'mozzarella', title: '🧀 Mozzarella' },
    { const: 'basil', title: '🌿 Basil' },
    { const: 'mushrooms', title: '🍄 Mushrooms' },
    { const: 'salami', title: '🍕 Salami' },
    { const: 'pineapple', title: '🍍 Pineapple (controversial)' },
    { const: 'olives', title: '🫒 Olives' },
    { const: 'chili', title: '🌶️ Chili' }
];

/**
 * `test://files/{name}`: a resource template over the fixed sample files. The
 * name is only ever looked up in SAMPLE_FILES (never used as a path), so
 * unknown names, `..` and the like simply don't exist.
 */
function registerSampleFiles(server: McpServer): void {
    const listed = SAMPLE_FILES.map(f => ({
        uri: sampleFileUri(f.name),
        name: f.name,
        title: f.title,
        description: f.description,
        mimeType: f.mimeType,
        size: sampleFileSize(f)
    }));
    server.registerResource(
        'Sample files',
        new ResourceTemplate(FILES_URI_TEMPLATE, {
            list: async () => ({ resources: listed }),
            complete: { name: value => SAMPLE_FILES.map(f => f.name).filter(n => n.startsWith(value)) }
        }),
        {
            title: 'Sample files',
            description: `Small generated test files returned by return_files: ${SAMPLE_FILES.map(f => f.name).join(', ')}`
        },
        async (uri, variables) => {
            const name = typeof variables.name === 'string' ? variables.name : '';
            const file = getSampleFile(name);
            if (!file) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown sample file: ${uri.href}`);
            return { contents: [sampleFileContents(file)] };
        }
    );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createFeatureTestServer(options: FeatureTestServerOptions = {}): McpServer {
    const server = new McpServer(
        {
            name: 'mcp-feature-test',
            title: 'MCP Feature Test (dialogs & UI)',
            version: serverVersion()
        },
        {
            // The files extension draft has servers advertise how much inline file data they accept per request.
            capabilities: { logging: {}, extensions: { [FILES_EXTENSION]: { maxInlineBytes: uploadMaxBytes() } } },
            requestState: { verify: stateCodec.verify },
            instructions:
                'Test server for MCP user-interaction features. Call the tools when the user wants to try dialogs: ' +
                'elicit_* tools show native client dialogs (elicitation), open_dialog_lab shows an interactive HTML UI (MCP Apps), pick_color asks the user for a colour in a small app (fetch the answer with pick_color_result), return_files returns files in every content form. ' +
                'Call inspect_client first to see what the current client supports.'
        }
    );
    const transport = options.transport;
    const clientOf = (ctx: ServerContext) => observeClient(server, ctx, transport);

    // Must run before the first registerTool (the SDK installs tools/* handlers lazily).
    instrumentRequests(server, transport);

    // 2025-era: capabilities are known once the handshake completes.
    server.server.oninitialized = () => {
        recordConnection({
            clientInfo: (server.server.getClientVersion() ?? null) as ClientInfo | null,
            capabilities: (server.server.getClientCapabilities() ?? null) as Record<string, any> | null,
            protocolVersion: server.server.getNegotiatedProtocolVersion() ?? null,
            era: 'legacy',
            transport: transport ?? 'stdio'
        });
    };

    // ---------------------------------------------------------------- inspect
    server.registerTool(
        'inspect_client',
        {
            title: 'Inspect client capabilities',
            description:
                'Report the protocol version, client info and declared client capabilities (elicitation form/url, MCP Apps UI extension, sampling, roots). Use it to check what the current frontend supports.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async (_args, ctx) => {
            const client = clientOf(ctx);
            const summary = summarizeCapabilities(client.capabilities);
            const info = {
                negotiatedProtocolVersion: client.protocolVersion ?? '(unknown)',
                era: client.era,
                clientInfo: client.clientInfo,
                clientCapabilities: client.capabilities,
                summary,
                requestEnvelope: ctx.mcpReq.envelope ?? null,
                transport: client.transport,
                sessionId: ctx.sessionId ?? null
            };
            const head = [
                `Protocol: ${info.negotiatedProtocolVersion} (${client.era} era, ${client.transport})`,
                `Client:   ${client.clientInfo ? `${client.clientInfo.name} ${client.clientInfo.version}` : 'unknown'}`
            ].join('\n');
            return text(`${head}\n${formatCapabilitySummary(summary)}\n\nFull details:\n${JSON.stringify(info, null, 2)}`, {
                structuredContent: info
            });
        }
    );

    server.registerTool(
        'list_seen_clients',
        {
            title: 'List clients seen by this server',
            description:
                'List every distinct client (name, version, protocol version, transport, capabilities) that has talked to this server process since it started, most recent first. Useful when testing several frontends against one HTTP server.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async () => {
            const clients = listSeenClients();
            const lines = clients.map((c, i) => {
                const s = c.summary;
                const flags = [
                    s.elicitation.form && 'form',
                    s.elicitation.url && 'url',
                    s.ui.supported && 'apps-ui',
                    s.sampling.supported && 'sampling',
                    s.roots.supported && 'roots',
                    s.tasks && 'tasks'
                ].filter(Boolean);
                return (
                    `${i + 1}. ${c.clientInfo ? `${c.clientInfo.name} ${c.clientInfo.version}` : 'unknown client'} – ` +
                    `${c.protocolVersion ?? '?'} (${c.era}, ${c.transport}) – [${flags.join(', ') || 'no interactive capabilities'}] – ` +
                    `${c.requests} requests, ${c.toolCalls} tool calls${c.era === 'legacy' ? `, ${c.connections} connections` : ''}, last seen ${c.lastSeen}`
                );
            });
            return text(clients.length ? `Clients seen since server start (most recent first):\n${lines.join('\n')}` : 'No clients seen yet.', {
                structuredContent: { clients }
            });
        }
    );

    // --------------------------------------------------------- simple confirm
    const confirmSchema = z.object({
        confirm: z.boolean().default(false).meta({ title: 'Yes, delete it', description: 'Tick to confirm the (fake) deletion' })
    });
    server.registerTool(
        'elicit_confirm',
        {
            title: 'Confirm dialog (elicitation)',
            description:
                'Ask the user to confirm a (fake, harmless) destructive action via a native yes/no elicitation dialog. Demonstrates accept / decline / cancel handling.',
            inputSchema: z.object({ item: z.string().default('important-file.txt').describe('Name of the fake item to "delete"') }),
            annotations: { destructiveHint: false, readOnlyHint: true }
        },
        async ({ item }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const unsupported = missingElicitation(clientOf(ctx), 'form');
            if (unsupported) return unsupported;
            const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
            if (view.kind === 'elicit') {
                if (view.action === 'decline') return text(`User DECLINED – "${item}" was not deleted.`);
                if (view.action === 'cancel') return text(`User CANCELLED (dismissed the dialog) – "${item}" was not deleted.`);
                const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmSchema);
                return answer?.confirm
                    ? text(`User ACCEPTED and confirmed – pretended to delete "${item}". (Nothing was actually deleted.)`)
                    : text(`User ACCEPTED but left the box unchecked – "${item}" was not deleted.`);
            }
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Really delete "${item}"? (Demo – nothing is actually deleted.)`,
                        requestedSchema: confirmSchema
                    })
                }
            });
        }
    );

    // -------------------------------------------------- all form field types
    server.registerTool(
        'elicit_all_field_types',
        {
            title: 'Form with every field type (elicitation)',
            description:
                'Show one elicitation form containing every field type allowed by the spec: string (min/max length), formats (email, uri, date, date-time), integer, number, boolean, single-select enums (untitled, titled, legacy enumNames) and multi-select enums, with defaults. Use variant to test subsets.',
            inputSchema: z.object({
                variant: z
                    .enum(['all', 'basic', 'formats', 'enums'])
                    .default('all')
                    .describe('all = everything; basic = string/integer/number/boolean; formats = email/uri/date/date-time; enums = selects')
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ variant }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const unsupported = missingElicitation(clientOf(ctx), 'form');
            if (unsupported) return unsupported;
            const view = inputResponse(ctx.mcpReq.inputResponses, 'form');
            if (view.kind === 'elicit') {
                if (view.action !== 'accept') return text(`User ${pastTense(view.action)} the form.`);
                const r = ctx.mcpReq.inputResponses?.form as { content?: Record<string, unknown> } | undefined;
                const content = r?.content ?? {};
                const lines = Object.entries(content).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}  (${Array.isArray(v) ? 'array' : typeof v})`);
                return text(`User submitted the "${variant}" form:\n${lines.join('\n') || '  (no fields)'}`, { structuredContent: { variant, content } });
            }
            return inputRequired({
                inputRequests: {
                    form: inputRequired.elicit({
                        message: `Feature test: “${variant}” field types. Fill in whatever you like – nothing is stored.`,
                        requestedSchema: allFieldsSchema(variant)
                    })
                }
            });
        }
    );

    // ------------------------------------------------- parallel requests
    const nameSchema = z.object({ nickname: z.string().min(1).meta({ title: 'Nickname' }) });
    const moodSchema = z.object({
        mood: z.enum(['😀 great', '🙂 fine', '😐 meh', '😩 tired']).meta({ title: 'How are you today?' })
    });
    server.registerTool(
        'elicit_parallel',
        {
            title: 'Two dialogs in one round (elicitation)',
            description:
                'Request two independent elicitations in a single input_required round. Tests how a client handles several pending input requests (modern clients may show them together; legacy clients one after the other).',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const unsupported = missingElicitation(clientOf(ctx), 'form');
            if (unsupported) return unsupported;
            const nick = acceptedContent(ctx.mcpReq.inputResponses, 'nickname', nameSchema);
            const mood = acceptedContent(ctx.mcpReq.inputResponses, 'mood', moodSchema);
            const nv = inputResponse(ctx.mcpReq.inputResponses, 'nickname');
            const mv = inputResponse(ctx.mcpReq.inputResponses, 'mood');
            if ((nv.kind === 'elicit' && nv.action !== 'accept') || (mv.kind === 'elicit' && mv.action !== 'accept')) {
                return text('At least one of the two dialogs was declined or cancelled.');
            }
            if (nick && mood) return text(`Hello ${nick.nickname}, you are feeling ${mood.mood}.`);
            return inputRequired({
                inputRequests: {
                    ...(!nick && { nickname: inputRequired.elicit({ message: 'Dialog A: what should I call you?', requestedSchema: nameSchema }) }),
                    ...(!mood && { mood: inputRequired.elicit({ message: 'Dialog B: how are you?', requestedSchema: moodSchema }) })
                }
            });
        }
    );

    // ----------------------------------------------- multi-step wizard
    const step1Schema = z.object({
        name: z.string().min(1).meta({ title: 'Name for the order' }),
        size: z.enum(['small', 'medium', 'large']).default('medium').meta({ title: 'Size', description: 'Large allows up to 5 toppings' }),
        crust: z.enum(['classic', 'thin', 'gluten-free']).default('classic').meta({ title: 'Crust' })
    });
    const step3Schema = z.object({ confirm: z.boolean().default(true).meta({ title: 'Place this (imaginary) order' }) });

    server.registerTool(
        'elicit_wizard',
        {
            title: 'Multi-step wizard (elicitation)',
            description:
                'Order an imaginary pizza through a 3-step dialog wizard. Step 2 depends on step 1 (number of toppings depends on size), step 3 shows a summary for confirmation. Demonstrates chained elicitations with signed requestState.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const unsupported = missingElicitation(clientOf(ctx), 'form');
            if (unsupported) return unsupported;
            const state = ctx.mcpReq.requestState<WizardState>();
            const responses = ctx.mcpReq.inputResponses;

            const cancelledIn = (key: string) => {
                const v = inputResponse(responses, key);
                return v.kind === 'elicit' && v.action !== 'accept' ? v.action : undefined;
            };

            const askStep1 = () =>
                inputRequired({
                    inputRequests: {
                        step1: inputRequired.elicit({ message: '🍕 Step 1 of 3 – the basics', requestedSchema: step1Schema })
                    }
                });

            const askStep2 = async (s: { size: string; crust: string; name: string }) => {
                const max = s.size === 'large' ? 5 : s.size === 'medium' ? 3 : 2;
                return inputRequired({
                    inputRequests: {
                        step2: inputRequired.elicit({
                            message: `🍕 Step 2 of 3 – toppings for a ${s.size} ${s.crust} pizza (max ${max})`,
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    toppings: {
                                        type: 'array',
                                        title: `Toppings (up to ${max})`,
                                        minItems: 1,
                                        maxItems: max,
                                        items: { anyOf: PIZZA_TOPPINGS },
                                        default: ['mozzarella']
                                    },
                                    notes: { type: 'string', title: 'Notes for the kitchen', maxLength: 200 }
                                },
                                required: ['toppings']
                            }
                        })
                    },
                    requestState: await stateCodec.mint({ tool: 'wizard', step: 'toppings', ...s })
                });
            };

            // Round 1 (no state yet)
            if (!state || state.tool !== 'wizard') {
                const c = cancelledIn('step1');
                if (c) return text(`Wizard ${pastTense(c)} at step 1.`);
                const s1 = acceptedContent(responses, 'step1', step1Schema);
                if (!s1) return askStep1();
                return askStep2(s1);
            }

            if (state.step === 'toppings') {
                const c = cancelledIn('step2');
                if (c) return text(`Wizard ${pastTense(c)} at step 2.`);
                const raw = (responses?.step2 as { content?: { toppings?: unknown; notes?: unknown } } | undefined)?.content;
                const toppings = Array.isArray(raw?.toppings) ? raw.toppings.filter((t): t is string => typeof t === 'string') : undefined;
                if (!toppings?.length) return askStep2(state);
                const notes = typeof raw?.notes === 'string' && raw.notes ? raw.notes : undefined;
                const titles = toppings.map(t => PIZZA_TOPPINGS.find(p => p.const === t)?.title ?? t).join(', ');
                return inputRequired({
                    inputRequests: {
                        step3: inputRequired.elicit({
                            message:
                                `🍕 Step 3 of 3 – please confirm\n\n` +
                                `Name: ${state.name}\nSize: ${state.size}\nCrust: ${state.crust}\nToppings: ${titles}` +
                                (notes ? `\nNotes: ${notes}` : ''),
                            requestedSchema: step3Schema
                        })
                    },
                    requestState: await stateCodec.mint({ ...state, step: 'confirm', toppings, notes })
                });
            }

            // state.step === 'confirm'
            const c = cancelledIn('step3');
            if (c) return text(`Wizard ${pastTense(c)} at the confirmation step.`);
            const s3 = acceptedContent(responses, 'step3', step3Schema);
            if (!s3?.confirm) return text('Order not confirmed – nothing ordered.');
            const order = { name: state.name, size: state.size, crust: state.crust, toppings: state.toppings, notes: state.notes ?? null };
            return text(`✅ Imaginary pizza ordered for ${state.name}: ${state.size}, ${state.crust}, ${state.toppings.join(', ')}.`, {
                structuredContent: order
            });
        }
    );

    // ------------------------------------------------------ URL mode (MRTR)
    /**
     * After the client answered "accept", make sure the browser page was really
     * submitted. Clients may accept as soon as the link is opened (Open WebUI
     * does), so wait for the page, sending progress heartbeats if the client
     * asked for progress, and give up after FLOW_WAIT_MS or on cancellation.
     */
    async function finishBrowserFlow(flowId: string, ctx: ServerContext, doneText: (token: string) => string): Promise<CallToolResult> {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        let beats = 0;
        const heartbeat =
            progressToken === undefined || getFlow(flowId)?.completedAt
                ? undefined
                : setInterval(() => {
                      beats++;
                      void ctx.mcpReq
                          .notify({
                              method: 'notifications/progress',
                              params: { progressToken, progress: beats, message: 'Waiting for the browser page to be submitted…' }
                          })
                          .catch(() => {});
                  }, 5_000);
        try {
            const done = await waitForFlow(flowId, flowWaitMs(), ctx.mcpReq.signal);
            const token = getFlow(flowId)?.token;
            if (done && token) return text(doneText(token));
            if (ctx.mcpReq.signal.aborted) return text('Cancelled while waiting for the browser page.', { isError: true });
            return text(
                `The client reported "accept", but the browser page was not submitted within ${Math.round(flowWaitMs() / 1000)} s. Run the tool again and submit the page.`,
                { isError: true }
            );
        } finally {
            if (heartbeat) clearInterval(heartbeat);
        }
    }

    server.registerTool(
        'elicit_url',
        {
            title: 'Browser flow (URL-mode elicitation)',
            description:
                'Ask the client to open a local web page where the user enters a fake API token (simulates OAuth / secret entry that must not pass through the client or model). The tool then confirms the server received it (masked).',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const unsupported = missingElicitation(clientOf(ctx), 'url');
            if (unsupported) return unsupported;
            const state = ctx.mcpReq.requestState<WizardState>();
            if (state?.tool === 'url') {
                const v = inputResponse(ctx.mcpReq.inputResponses, 'signin');
                if (v.kind === 'elicit' && v.action !== 'accept') return text(`User ${pastTense(v.action)} the browser flow.`);
                return finishBrowserFlow(
                    state.flowId,
                    ctx,
                    token =>
                        `✅ Browser flow completed. Server received a token (${token.length} chars, masked: ${maskToken(token)}). The secret itself never went through the MCP client.`
                );
            }
            const { flow, url } = await createFlow('The MCP tool “elicit_url” asked you to connect a (fake) account.');
            return inputRequired({
                inputRequests: {
                    signin: inputRequired.elicitUrl({
                        message: 'Open this page to connect the (fake) service and enter any token there. The tool continues as soon as the page is submitted.',
                        url
                    })
                },
                requestState: await stateCodec.mint({ tool: 'url', flowId: flow.id })
            });
        }
    );

    // ---------------------------------------- URL mode, classic 2025-11-25 push style
    server.registerTool(
        'elicit_url_legacy_push',
        {
            title: 'Browser flow, 2025-11-25 style (URL elicitation + completion notification)',
            description:
                'Same as elicit_url but uses the 2025-11-25 push-style elicitation/create request and sends notifications/elicitation/complete when the page is submitted. Only works on 2025-era connections; useful to test clients that implement completion notifications.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async (_args, ctx: ServerContext) => {
            const client = clientOf(ctx);
            if (client.era === 'modern') {
                return text(
                    `Push-style elicitation is unavailable on this connection (protocol ${client.protocolVersion}): ` +
                        'server→client elicitation/create requests and notifications/elicitation/complete do not exist on 2026-07-28. ' +
                        'Use elicit_url (input_required) instead.',
                    { isError: true }
                );
            }
            const unsupported = missingElicitation(client, 'url');
            if (unsupported) return unsupported;
            try {
                const { flow, url } = await createFlow('The MCP tool “elicit_url_legacy_push” asked you to connect a (fake) account.');
                flow.onComplete = server.server.createElicitationCompletionNotifier(flow.id, { relatedRequestId: ctx.mcpReq.id });
                const result = await ctx.mcpReq.elicitInput(
                    {
                        mode: 'url',
                        message: 'Open this page to connect the (fake) service. The client should close the dialog automatically once you submit.',
                        url,
                        elicitationId: flow.id
                    },
                    { timeout: 10 * 60_000, signal: ctx.mcpReq.signal }
                );
                if (result.action !== 'accept') return text(`User ${pastTense(result.action)} the browser flow.`);
                return finishBrowserFlow(
                    flow.id,
                    ctx,
                    token => `✅ Browser flow completed (token ${maskToken(token)}; completion notification was sent to the client).`
                );
            } catch (e) {
                return text(
                    `Push-style URL elicitation failed: ${(e as Error).message}`,
                    { isError: true }
                );
            }
        }
    );

    // --------------------------------------------- progress, logging, cancel
    server.registerTool(
        'slow_task',
        {
            title: 'Slow task (progress, logs, cancellation)',
            description:
                'Run a fake long task that reports progress notifications and log messages, and stops early when the client cancels it.',
            inputSchema: z.object({
                steps: z.number().int().min(1).max(60).default(10),
                delayMs: z.number().int().min(50).max(5000).default(500)
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ steps, delayMs }, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            let done = 0;
            for (; done < steps; done++) {
                if (ctx.mcpReq.signal.aborted) break;
                await new Promise(r => setTimeout(r, delayMs));
                if (token !== undefined) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: done + 1, total: steps, message: `Step ${done + 1}/${steps}` }
                    });
                }
                if ((done + 1) % 3 === 0) await ctx.mcpReq.log('info', `slow_task reached step ${done + 1}`).catch(() => {});
            }
            return text(
                ctx.mcpReq.signal.aborted
                    ? `Cancelled after ${done} of ${steps} steps.`
                    : `Finished ${steps} steps.${token === undefined ? ' (Client did not request progress.)' : ''}`
            );
        }
    );

    // ------------------------------------------ non-spec form schema probes
    const describeProbe = (r: FormatProbeResult) => {
        const head = `${r.probe} – ${FORMAT_PROBES[r.probe].what}:`;
        if (r.action !== 'accept') return `${head} user ${pastTense(r.action)} the dialog (the client did show something).`;
        const value = r.content?.[r.probe];
        if (value === undefined) {
            const keys = Object.keys(r.content ?? {});
            return `${head} accepted, but the field was not returned${keys.length ? ` (content keys: ${keys.join(', ')})` : ' (empty content)'}.`;
        }
        return `${head} accepted, returned ${JSON.stringify(value)} (${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}).`;
    };

    server.registerTool(
        'elicit_format_probe',
        {
            title: 'Probe non-spec form fields (elicitation)',
            description:
                'Show form-elicitation dialogs that use schema features OUTSIDE the MCP spec (format "color", format "time", a regex pattern, a nested object, a free-text array, a file-like data-url field), one dialog per probe, and report what the client did with each. variant picks one probe; "all" runs them one after another.',
            inputSchema: z.object({
                variant: z
                    .enum(['all', ...FORMAT_PROBE_NAMES] as [string, ...string[]])
                    .default('all')
                    .describe(`all = every probe in sequence; or one of: ${FORMAT_PROBE_NAMES.join(', ')}`)
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ variant }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            const unsupported = missingElicitation(clientOf(ctx), 'form');
            if (unsupported) return unsupported;
            const state = ctx.mcpReq.requestState<WizardState>();

            let queue: FormatProbeName[];
            let results: FormatProbeResult[];
            if (state?.tool === 'probe' && state.queue.length) {
                const current = state.queue[0];
                const v = inputResponse(ctx.mcpReq.inputResponses, `probe_${current}`);
                if (v.kind !== 'elicit') return askProbe(state.queue, state.results);
                results = [...state.results, { probe: current, action: v.action, ...(v.content && { content: v.content }) }];
                queue = state.queue.slice(1);
            } else {
                queue = variant === 'all' ? [...FORMAT_PROBE_NAMES] : [variant as FormatProbeName];
                results = [];
            }
            if (queue.length) return askProbe(queue, results);

            return text(
                'These dialogs used schema features that are OUTSIDE the MCP elicitation spec (2025-11-25 and 2026-07-28 allow only flat ' +
                    'string/number/integer/boolean/enum/multi-select fields and the formats email, uri, date, date-time). ' +
                    'A client may reject them, render a fallback text box, or drop the field; none of that is a bug.\n\n' +
                    results.map(describeProbe).join('\n') +
                    '\n\nA probe the client REJECTED (an error instead of a dialog) never reaches this report: the client ends the whole tool call with an error. ' +
                    'Run single variants to find which probe it refuses (the server log shows the last tool.input_required probe).',
                { structuredContent: { variant, outsideSpec: true, results } }
            );

            async function askProbe(q: FormatProbeName[], r: FormatProbeResult[]) {
                const name = q[0];
                const index = (variant === 'all' ? FORMAT_PROBE_NAMES.indexOf(name) : 0) + 1;
                const total = variant === 'all' ? FORMAT_PROBE_NAMES.length : 1;
                return inputRequired({
                    inputRequests: {
                        [`probe_${name}`]: inputRequired.elicit({
                            message: `Non-spec probe ${index}/${total}: ${FORMAT_PROBES[name].what}. Fill it in if the client lets you; nothing is stored.`,
                            requestedSchema: formatProbeSchema(name)
                        })
                    },
                    requestState: await stateCodec.mint({ tool: 'probe', queue: q, results: r })
                });
            }
        }
    );

    // ------------------------------------------------------ returning files
    registerSampleFiles(server);

    server.registerTool(
        'return_files',
        {
            title: 'Return files in a tool result',
            description:
                'Return one tool result containing every way MCP can hand a file to a client: an embedded text resource (CSV), embedded blob resources (PNG and PDF), a resource_link (fetched via resources/read), an image block and an audio block (WAV). The first text block lists them, so you can see which ones the client dropped.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true }
        },
        async () => {
            const csv = getSampleFile('sample.csv')!;
            const png = getSampleFile('gradient.png')!;
            const pdf = getSampleFile('sample.pdf')!;
            const wav = getSampleFile('beep.wav')!;
            const notes = getSampleFile('linked-notes.md')!;
            const manifest = [
                { block: 2, type: 'resource', kind: 'embedded text', uri: sampleFileUri(csv.name), mimeType: csv.mimeType, size: sampleFileSize(csv) },
                { block: 3, type: 'resource', kind: 'embedded blob (image)', uri: sampleFileUri(png.name), mimeType: png.mimeType, size: sampleFileSize(png) },
                { block: 4, type: 'resource', kind: 'embedded blob (non-image)', uri: sampleFileUri(pdf.name), mimeType: pdf.mimeType, size: sampleFileSize(pdf) },
                { block: 5, type: 'resource_link', kind: 'link, client reads it with resources/read', uri: sampleFileUri(notes.name), mimeType: notes.mimeType, size: sampleFileSize(notes) },
                { block: 6, type: 'image', kind: 'image content', mimeType: png.mimeType, size: sampleFileSize(png) },
                { block: 7, type: 'audio', kind: 'audio content', mimeType: wav.mimeType, size: sampleFileSize(wav) }
            ];
            const lines = manifest.map(
                m => `${m.block}. ${m.type} – ${m.kind}: ${'uri' in m ? `${m.uri}, ` : ''}${m.mimeType}, ${formatBytes(m.size)}`
            );
            const content: CallToolResult['content'] = [
                {
                    type: 'text',
                    text:
                        'This result contains 7 content blocks. Block 1 is this text; the client should show or offer the others:\n' +
                        `${lines.join('\n')}\n` +
                        'Any item you cannot see, open or download was dropped (or only passed to the model) by the client.'
                },
                { type: 'resource', resource: sampleFileContents(csv) },
                { type: 'resource', resource: sampleFileContents(png) },
                { type: 'resource', resource: sampleFileContents(pdf) },
                {
                    type: 'resource_link',
                    uri: sampleFileUri(notes.name),
                    name: notes.name,
                    title: notes.title,
                    description: notes.description,
                    mimeType: notes.mimeType,
                    size: sampleFileSize(notes),
                    annotations: { audience: ['user'] }
                },
                { type: 'image', mimeType: png.mimeType, data: png.bytes!.toString('base64') },
                { type: 'audio', mimeType: wav.mimeType, data: wav.bytes!.toString('base64') }
            ];
            return { content, structuredContent: { items: manifest } };
        }
    );

    // ------------------------------- experimental files extension (draft)
    const maxUpload = uploadMaxBytes();
    server.registerTool(
        'upload_file_experimental',
        {
            title: 'Upload a file (EXPERIMENTAL x-mcp-file)',
            description:
                'EXPERIMENTAL, not part of the MCP spec: a tool whose "file" argument is marked with x-mcp-file, following the draft of the io.modelcontextprotocol/files extension (inline base64 only, no out-of-band upload). Returns the size and SHA-256 of the received file; nothing is stored.',
            inputSchema: z.object({
                file: z
                    .object({
                        id: z.string().min(1).max(128).describe('Client-chosen id, unique within the call'),
                        name: z.string().max(1024).optional().describe('File name'),
                        mimeType: z.string().min(1).max(255).describe('Media type, application/octet-stream if unknown'),
                        size: z.number().int().min(0).describe('Decoded size in bytes'),
                        digest: z
                            .object({ algorithm: z.literal('sha-256'), value: z.string().describe('base64url SHA-256, no padding') })
                            .optional(),
                        data: z.string().optional().describe('RFC 4648 base64 bytes (inline transfer)')
                    })
                    .meta({ 'x-mcp-file': { maxSize: maxUpload } })
                    .describe('The file (FileInput shape of the experimental io.modelcontextprotocol/files extension)')
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ file }) => {
            const fail = (msg: string) => text(`File "${file.name ?? file.id}" not accepted: ${msg}`, { isError: true });
            if (file.size > maxUpload) return fail(`size ${file.size} is above maxSize ${maxUpload} (UPLOAD_MAX_BYTES)`);
            if (file.data === undefined) {
                if (file.size > 0) return fail('no inline data; this server only supports inline transfer (no out-of-band upload)');
            }
            const decoded = decodeBase64Strict(file.data ?? '', maxUpload);
            if (!decoded.ok) return fail(decoded.error);
            if (decoded.bytes.length !== file.size) return fail(`declared size ${file.size} but ${decoded.bytes.length} bytes decoded`);
            if (file.digest && file.digest.value !== sha256Base64Url(decoded.bytes)) return fail('sha-256 digest does not match the data');
            const sha256 = sha256Hex(decoded.bytes);
            logger.info('upload.received', `upload_file_experimental: ${decoded.bytes.length} bytes`, { tool: 'upload_file_experimental', size: decoded.bytes.length, sha256 });
            return text(
                `EXPERIMENTAL x-mcp-file upload received: "${file.name ?? file.id}" (${file.mimeType}), ${formatBytes(decoded.bytes.length)} (${decoded.bytes.length} bytes), ` +
                    `SHA-256 ${sha256}${file.digest ? ' (digest verified)' : ''}. Nothing was stored.`,
                { structuredContent: { id: file.id, name: file.name ?? null, mimeType: file.mimeType, size: decoded.bytes.length, sha256, digestVerified: !!file.digest } }
            );
        }
    );

    // ------------------------------------------------------- MCP App (UI)
    registerAppResource(
        server,
        'Dialog Lab',
        DIALOG_APP_URI,
        {
            description: 'Interactive HTML dialog rendered by MCP-Apps-capable hosts',
            _meta: { ui: { prefersBorder: true } }
        },
        async () => ({
            contents: [{ uri: DIALOG_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: loadDialogAppHtml(), _meta: { ui: { prefersBorder: true } } }]
        })
    );

    registerAppTool(
        server,
        'open_dialog_lab',
        {
            title: 'Graphical dialog (MCP App)',
            description:
                'Open the "Dialog Lab": an interactive graphical dialog (MCP Apps / ui:// resource) with a colour picker, slider, star rating, drag-to-reorder list and drawing canvas. The user can submit the result to the server, send it as a chat message, or put it into the model context. Use dialog_lab_results afterwards to read what the user submitted.',
            inputSchema: {
                question: z.string().default('Configure your dream workspace').describe('Headline shown in the dialog'),
                items: z
                    .array(z.string())
                    .default(['Coffee', 'Music', 'Plants', 'Natural light', 'Second monitor'])
                    .describe('Items the user should rank by drag & drop')
            },
            annotations: { readOnlyHint: true },
            _meta: { ui: { resourceUri: DIALOG_APP_URI } }
        },
        async ({ question, items }) => ({
            content: [
                {
                    type: 'text',
                    text:
                        `Opened the Dialog Lab ("${question}"). If your client supports MCP Apps, an interactive dialog is now shown; ` +
                        'when the user submits it, call dialog_lab_results to read the answer. ' +
                        'If no UI appeared, this client does not render MCP Apps (ui:// resources).'
                }
            ],
            structuredContent: { question, items, openedAt: new Date().toISOString() }
        })
    );

    registerAppTool(
        server,
        'dialog_lab_submit',
        {
            title: 'Submit Dialog Lab result (app-only)',
            description: 'Called by the Dialog Lab UI to store the user\'s answers. Hidden from the model.',
            inputSchema: { data: z.record(z.string(), z.unknown()) },
            _meta: { ui: { resourceUri: DIALOG_APP_URI, visibility: ['app'] } }
        },
        async ({ data }) => {
            const size = Buffer.byteLength(JSON.stringify(data));
            if (size > MAX_DIALOG_SUBMISSION_BYTES) {
                return text(`Submission too large (${size} bytes, at most ${MAX_DIALOG_SUBMISSION_BYTES}); nothing stored.`, { isError: true });
            }
            const entry: DialogSubmission = { id: ++lastSubmissionId, receivedAt: new Date().toISOString(), data };
            dialogSubmissions.push(entry);
            if (dialogSubmissions.length > MAX_DIALOG_SUBMISSIONS) dialogSubmissions.shift();
            return text(`Stored submission #${entry.id}.`, { structuredContent: { id: entry.id, receivedAt: entry.receivedAt } });
        }
    );

    registerAppTool(
        server,
        'dialog_lab_upload',
        {
            title: 'Upload a file from the Dialog Lab (app-only)',
            description: `Called by the Dialog Lab UI with a base64-encoded file. Returns its size and SHA-256; the content is not stored or logged. Limit: ${formatBytes(maxUpload)} (UPLOAD_MAX_BYTES). Hidden from the model.`,
            inputSchema: {
                name: z.string().max(1024),
                mimeType: z.string().max(255),
                data: z.string().describe('Standard base64, no data: prefix')
            },
            _meta: { ui: { resourceUri: DIALOG_APP_URI, visibility: ['app'] } }
        },
        async ({ name, mimeType, data }) => {
            const decoded = decodeBase64Strict(data, maxUpload);
            if (!decoded.ok) {
                logger.info('upload.rejected', `dialog_lab_upload rejected: ${decoded.error}`, { tool: 'dialog_lab_upload', base64Length: data.length });
                return text(`Upload of ${JSON.stringify(name)} rejected: ${decoded.error}.`, {
                    isError: true,
                    structuredContent: { error: decoded.error, maxBytes: maxUpload }
                });
            }
            const size = decoded.bytes.length;
            const sha256 = sha256Hex(decoded.bytes);
            logger.info('upload.received', `dialog_lab_upload: ${size} bytes`, { tool: 'dialog_lab_upload', size, sha256 });
            return text(`Received ${JSON.stringify(name)} (${mimeType || 'unknown type'}): ${formatBytes(size)} (${size} bytes), SHA-256 ${sha256}. Nothing was stored.`, {
                structuredContent: { name, mimeType, size, sha256, maxBytes: maxUpload }
            });
        }
    );

    server.registerTool(
        'dialog_lab_results',
        {
            title: 'Read Dialog Lab results',
            description: 'Return what users submitted in the Dialog Lab graphical dialog (most recent first).',
            inputSchema: z.object({ limit: z.number().int().min(1).max(MAX_DIALOG_SUBMISSIONS).default(3) }),
            annotations: { readOnlyHint: true }
        },
        async ({ limit }) => {
            const list = dialogSubmissions.slice(-limit).reverse();
            if (!list.length) return text('No Dialog Lab submissions yet. Open it with open_dialog_lab and press "Submit to server".');
            const summarized = list.map(s => {
                const { sketchPng, ...rest } = (s.data ?? {}) as Record<string, unknown>;
                return { ...s, data: { ...rest, sketch: sketchPng ? `(PNG data URL, ${String(sketchPng).length} chars)` : 'none' } };
            });
            const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(summarized, null, 2) }];
            const png = (list[0].data as { sketchPng?: string } | undefined)?.sketchPng;
            if (typeof png === 'string' && png.startsWith('data:image/png;base64,')) {
                content.push({ type: 'image', mimeType: 'image/png', data: png.slice('data:image/png;base64,'.length) });
            }
            return { content, structuredContent: { submissions: summarized } };
        }
    );

    registerColorPicker(server); // pick_color, pick_color_submit, pick_color_result (src/colorPicker.ts)
    registerViewer3d(server); // view_3d, view_3d_select, view_3d_state, test://models/sample.glb (src/viewer3d.ts)

    // --------------------------------------------------------------- prompt
    server.registerPrompt(
        'try_all_dialogs',
        {
            title: 'Try all dialog features',
            description: 'A prompt that walks the assistant through every interactive feature of this server.'
        },
        async () => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text:
                            'Please test the MCP user-interaction features of the mcp-feature-test server, one at a time, telling me what to expect before each: ' +
                            '1) inspect_client, 2) elicit_confirm, 3) elicit_all_field_types, 4) elicit_parallel, 5) elicit_wizard, 6) elicit_url, ' +
                            '7) open_dialog_lab and afterwards dialog_lab_results, 8) pick_color and afterwards pick_color_result, 9) slow_task, 10) return_files, 11) elicit_format_probe (non-spec fields), 12) view_3d and afterwards view_3d_state. Summarize which features worked in this client.'
                    }
                }
            ]
        })
    );

    return server;
}
