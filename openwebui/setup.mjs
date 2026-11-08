#!/usr/bin/env node
/**
 * Post-start configuration of a fresh Open WebUI (WEBUI_AUTH=False) via its REST API:
 *  - signs in as the implicit admin (admin@localhost) and prints/saves the API token
 *  - checks that the MCP tool server connections from TOOL_SERVER_CONNECTIONS are present
 *  - creates workspace models that wrap the fake LLM and have the MCP server(s) enabled by
 *    default (meta.toolIds), with native function calling
 *
 *   OWUI_URL=http://127.0.0.1:3602 node openwebui/setup.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.OWUI_URL ?? 'http://127.0.0.1:3602';
const BASE_MODEL = process.env.FAKE_MODEL_ID ?? 'fake-tool-caller';

async function api(method, path, token, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return json;
}

const { token } = await api('POST', '/api/v1/auths/signin', null, { email: '', password: '' });
mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out/token'), token);

const cfg = await api('GET', '/api/v1/configs/tool_servers', token);
const mcp = (cfg.TOOL_SERVER_CONNECTIONS ?? []).filter(c => c.type === 'mcp');
console.error(`MCP connections: ${mcp.map(c => `${c.info?.id} → ${c.url}`).join(', ') || '(none!)'}`);

const models = (await api('GET', '/api/models', token)).data.map(m => m.id);
if (!models.includes(BASE_MODEL)) throw new Error(`fake LLM model "${BASE_MODEL}" not visible; is the fake LLM running? models: ${models}`);

const existing = new Set((await api('GET', '/api/v1/models/', token).catch(() => ({ items: [] })))?.items?.map?.(m => m.id) ?? []);
for (const conn of mcp) {
    const id = conn.info.id === 'featuretest' ? 'mcp-tester' : `mcp-tester-${conn.info.id.replace(/^featuretest-?/, '')}`;
    if (existing.has(id) || models.includes(id)) {
        console.error(`model ${id} exists`);
        continue;
    }
    await api('POST', '/api/v1/models/create', token, {
        id,
        base_model_id: BASE_MODEL,
        name: id === 'mcp-tester' ? 'MCP Tester' : `MCP Tester (${conn.info.name})`,
        meta: { description: `Fake LLM + ${conn.info.name}`, toolIds: [`server:mcp:${conn.info.id}`] },
        params: { function_calling: 'native' }
    });
    console.error(`created model ${id} (tools: server:mcp:${conn.info.id})`);
}
console.log(token);
