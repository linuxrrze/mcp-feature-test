/**
 * Client capability tracking.
 *
 * - 2025-era connections declare clientInfo + capabilities once, in `initialize`.
 *   We log them from the `oninitialized` hook (one event per connection).
 * - 2026-07-28 has no handshake: every request carries clientInfo + capabilities
 *   in its `_meta` envelope. We log the first time a distinct combination shows up
 *   and afterwards only bump counters (HTTP builds a server per request, so this
 *   registry lives at module level).
 *
 * The registry is exposed read-only through the `list_seen_clients` tool.
 */
import { createHash } from 'node:crypto';
import { logger } from './log.js';

export type Era = 'modern' | 'legacy';
export type TransportKind = 'stdio' | 'http';

export interface ClientInfo {
    name: string;
    version: string;
    title?: string;
    [key: string]: unknown;
}

export type Capabilities = Record<string, any>;

export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

export interface CapabilitySummary {
    elicitation: { form: boolean; url: boolean };
    /** MCP Apps (ext-apps) UI extension. */
    ui: { supported: boolean; mimeTypes: string[] };
    sampling: { supported: boolean; tools: boolean; context: boolean };
    roots: { supported: boolean; listChanged: boolean };
    tasks: boolean;
    /** Keys under `capabilities.extensions` other than the UI extension. */
    otherExtensions: string[];
    /** Keys under `capabilities.experimental`. */
    experimental: string[];
    /** Any other top-level capability keys we don't know about. */
    otherCapabilities: string[];
}

const KNOWN_TOP_LEVEL = new Set(['elicitation', 'sampling', 'roots', 'tasks', 'extensions', 'experimental']);

/** Interpret a raw ClientCapabilities object (works for both eras). */
export function summarizeCapabilities(caps: Capabilities | null | undefined): CapabilitySummary {
    const c = caps ?? {};
    const elic = c.elicitation;
    // Spec: an empty `elicitation: {}` object means form mode only (backwards compatibility with 2025-06-18).
    const elicKeys = elic && typeof elic === 'object' ? Object.keys(elic) : [];
    const ext = c.extensions && typeof c.extensions === 'object' ? (c.extensions as Record<string, any>) : {};
    const ui = ext[UI_EXTENSION_ID];
    const mimeTypes = Array.isArray(ui?.mimeTypes) ? ui.mimeTypes.map(String) : [];
    return {
        elicitation: { form: !!elic && (!!elic.form || elicKeys.length === 0), url: !!elic?.url },
        ui: { supported: !!ui, mimeTypes },
        sampling: { supported: !!c.sampling, tools: !!c.sampling?.tools, context: !!c.sampling?.context },
        roots: { supported: !!c.roots, listChanged: !!c.roots?.listChanged },
        tasks: !!c.tasks,
        otherExtensions: Object.keys(ext).filter(k => k !== UI_EXTENSION_ID),
        experimental: c.experimental && typeof c.experimental === 'object' ? Object.keys(c.experimental) : [],
        otherCapabilities: Object.keys(c).filter(k => !KNOWN_TOP_LEVEL.has(k))
    };
}

const yes = (b: boolean) => (b ? 'yes' : 'no');

/** Human-readable multi-line table (used in text logs and tool output). */
export function formatCapabilitySummary(s: CapabilitySummary, raw?: Capabilities | null): string {
    const lines = [
        `elicitation    form: ${yes(s.elicitation.form)}   url: ${yes(s.elicitation.url)}`,
        `MCP Apps UI    ${s.ui.supported ? `yes  mimeTypes: ${s.ui.mimeTypes.join(', ') || '(none listed)'}` : 'no'}`,
        `sampling       ${s.sampling.supported ? `yes${s.sampling.tools ? '  +tools' : ''}${s.sampling.context ? '  +context' : ''}` : 'no'}`,
        `roots          ${s.roots.supported ? `yes${s.roots.listChanged ? '  (listChanged)' : ''}` : 'no'}`,
        `tasks          ${yes(s.tasks)}`,
        `extensions     ${s.otherExtensions.length ? s.otherExtensions.join(', ') : '(none besides UI)'}`,
        `experimental   ${s.experimental.length ? s.experimental.join(', ') : '(none)'}`
    ];
    if (s.otherCapabilities.length) lines.push(`other          ${s.otherCapabilities.join(', ')}`);
    if (raw !== undefined) lines.push(`raw            ${JSON.stringify(raw ?? null)}`);
    return lines.join('\n');
}

/** JSON.stringify with sorted object keys, so equal capability objects produce equal keys. */
export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.keys(value as object)
            .sort()
            .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

export interface ClientObservation {
    clientInfo: ClientInfo | null;
    capabilities: Capabilities | null;
    protocolVersion: string | null;
    era: Era;
    transport: TransportKind;
}

export interface SeenClient extends ClientObservation {
    /** Stable fingerprint of name/version/protocol/era/transport/capabilities. */
    key: string;
    summary: CapabilitySummary;
    firstSeen: string;
    lastSeen: string;
    /** 2025-era: number of `initialize` handshakes. 2026-07-28 has no connection concept (stays 0). */
    connections: number;
    requests: number;
    toolCalls: number;
}

const MAX_RECORDS = 200;
const seen = new Map<string, SeenClient>();

export function fingerprint(o: ClientObservation): string {
    const material = stableStringify([o.clientInfo?.name, o.clientInfo?.version, o.protocolVersion, o.era, o.transport, o.capabilities]);
    return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

const describeClient = (o: ClientObservation) =>
    `${o.clientInfo ? `${o.clientInfo.title ?? o.clientInfo.name} ${o.clientInfo.version}` : 'unknown client'} ` +
    `(protocol ${o.protocolVersion ?? '?'}, ${o.era} era, ${o.transport})`;

function logClient(kind: 'connected' | 'seen', o: ClientObservation, rec: SeenClient): void {
    const verb = kind === 'connected' ? 'client connected' : 'new client seen';
    logger.info(
        `client.${kind}`,
        `${verb}: ${describeClient(o)}`,
        {
            key: rec.key,
            clientInfo: o.clientInfo,
            protocolVersion: o.protocolVersion,
            era: o.era,
            transport: o.transport,
            summary: rec.summary,
            capabilities: o.capabilities
        },
        formatCapabilitySummary(rec.summary, o.capabilities)
    );
}

function upsert(o: ClientObservation): { rec: SeenClient; isNew: boolean } {
    const key = fingerprint(o);
    const now = new Date().toISOString();
    let rec = seen.get(key);
    const isNew = !rec;
    if (!rec) {
        rec = { ...o, key, summary: summarizeCapabilities(o.capabilities), firstSeen: now, lastSeen: now, connections: 0, requests: 0, toolCalls: 0 };
        seen.set(key, rec);
        if (seen.size > MAX_RECORDS) seen.delete(seen.keys().next().value!);
    }
    rec.lastSeen = now;
    return { rec, isNew };
}

/** 2025-era: called once per connection after the initialize handshake. Always logs. */
export function recordConnection(o: ClientObservation): SeenClient {
    const { rec } = upsert(o);
    rec.connections++;
    logClient('connected', o, rec);
    return rec;
}

/**
 * Called for every incoming request. On 2026-07-28 traffic this logs the first
 * sighting of a combination (2025-era connections were already logged by
 * {@link recordConnection}).
 */
export function recordRequest(o: ClientObservation, method: string): SeenClient {
    const { rec, isNew } = upsert(o);
    rec.requests++;
    if (method === 'tools/call') rec.toolCalls++;
    if (isNew && o.era === 'modern') logClient('seen', o, rec);
    return rec;
}

/** Most recently active first. */
export function listSeenClients(): SeenClient[] {
    return [...seen.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map(r => structuredClone(r));
}

/** For tests. */
export function resetSeenClients(): void {
    seen.clear();
}
