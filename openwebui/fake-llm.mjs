#!/usr/bin/env node
/**
 * Deterministic fake OpenAI-compatible LLM for Open WebUI tests (no dependencies).
 *
 *   node openwebui/fake-llm.mjs            # listens on 127.0.0.1:3601 (PORT / HOST env)
 *
 * Endpoints: GET /v1/models, POST /v1/chat/completions (stream and non-stream).
 *
 * Behaviour (only looks at the LAST message):
 *  - user message containing `call <tool_name> {json args}` (args optional) and the
 *    request offers a tool whose function name equals or ends with <tool_name>
 *      → assistant message with exactly one tool call to that tool
 *  - last message is a tool result
 *      → plain text "Tool result: <first 600 chars>"
 *  - anything else (incl. Open WebUI background tasks: title, tags, follow-ups)
 *      → short fixed text, so the background tasks finish quickly
 *
 * Every request is logged to stderr as one JSON line (model, last role, tool names).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3601);
const HOST = process.env.HOST ?? '127.0.0.1';
const MODEL = process.env.FAKE_MODEL_ID ?? 'fake-tool-caller';

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p?.text ?? ''))).join('\n');
    return '';
}

let counter = 0;

function decide(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1] ?? {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools.map(t => t?.function?.name).filter(Boolean);

    if (last.role === 'tool') {
        const t = textOf(last.content);
        return { text: `Tool result: ${t.length > 600 ? `${t.slice(0, 600)}…` : t}` };
    }
    if (last.role === 'user') {
        const t = textOf(last.content);
        const m = /\bcall\s+([A-Za-z0-9_.:-]+)\s*(\{[\s\S]*\})?/.exec(t);
        if (m && toolNames.length) {
            const wanted = m[1];
            const name = toolNames.find(n => n === wanted) ?? toolNames.find(n => n.endsWith(wanted));
            if (name) {
                let args = {};
                if (m[2]) {
                    try {
                        args = JSON.parse(m[2]);
                    } catch {
                        /* keep {} */
                    }
                }
                return { toolCall: { id: `call_${Date.now()}_${++counter}`, name, arguments: JSON.stringify(args) } };
            }
            return { text: `Fake LLM: no offered tool matches "${wanted}". Offered: ${toolNames.join(', ') || '(none)'}` };
        }
        if (m) return { text: `Fake LLM: you asked for "${m[1]}" but this request offered no tools. Enable the MCP server for the chat.` };
    }
    // Background tasks (title / tags / follow-up generation) and anything else.
    if (/### Task:/.test(textOf(last.content)) && /title/i.test(textOf(last.content))) return { text: '{"title": "MCP feature test"}' };
    if (/### Task:/.test(textOf(last.content))) return { text: '{}' };
    return { text: 'Fake LLM ready. Say e.g. `call inspect_client` or `call elicit_confirm {"item":"x.txt"}`.' };
}

function sse(res, obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/v1/, '');
    if (req.method === 'GET' && path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'fake' }] }));
        return;
    }
    if (req.method === 'POST' && path === '/chat/completions') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            /* empty */
        }
        const d = decide(body);
        const last = (body.messages ?? []).at(-1) ?? {};
        console.error(
            JSON.stringify({
                t: new Date().toISOString(),
                stream: !!body.stream,
                lastRole: last.role,
                last: textOf(last.content).slice(0, 120),
                tools: (body.tools ?? []).map(t => t?.function?.name),
                decision: d.toolCall ? `tool:${d.toolCall.name}` : 'text'
            })
        );
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const model = body.model ?? MODEL;
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const base = { id, object: 'chat.completion.chunk', created, model };
            sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            if (d.toolCall) {
                sse(res, {
                    ...base,
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    { index: 0, id: d.toolCall.id, type: 'function', function: { name: d.toolCall.name, arguments: d.toolCall.arguments } }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                });
                sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
            } else {
                sse(res, { ...base, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] });
                sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            }
            sse(res, { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
            res.end('data: [DONE]\n\n');
            return;
        }
        const message = d.toolCall
            ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: d.toolCall.id, type: 'function', function: { name: d.toolCall.name, arguments: d.toolCall.arguments } }]
              }
            : { role: 'assistant', content: d.text };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                id,
                object: 'chat.completion',
                created,
                model,
                choices: [{ index: 0, message, finish_reason: d.toolCall ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            })
        );
        return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, HOST, () => console.error(`[fake-llm] http://${HOST}:${PORT}/v1 (model "${MODEL}")`));
