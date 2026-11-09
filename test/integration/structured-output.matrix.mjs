// structured_output and structured_output_array in the protocol matrix
// (stdio/HTTP × both eras): the advertised outputSchema, every variant as the
// official TypeScript client receives it, and the 2025-era {"result": …} wrap
// of an array root. Called from matrix.mjs.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { textOf } from '../helpers.mjs';

const REPORT = { project: 'mcp-feature-test', status: 'failed', passed: 42, failed: 3, durationMs: 1234.5, tags: ['ci', 'nightly'] };
const METRICS = [
    { name: 'cpu', value: 0.42 },
    { name: 'memoryMiB', value: 512 },
    { name: 'requests', value: 1337 }
];

/** @param {{ era: 'modern'|'legacy', client: import('@modelcontextprotocol/client').Client, call: (name: string, args?: object) => Promise<any> }} o */
export function structuredOutputTests({ era, client, call }) {
    it('structured_output: tools/list advertises a strict object outputSchema', async () => {
        const { tools } = await client.listTools();
        const s = tools.find(t => t.name === 'structured_output').outputSchema;
        assert.equal(s.type, 'object');
        assert.deepEqual(s.required.sort(), ['durationMs', 'failed', 'passed', 'project', 'status', 'tags']);
        assert.equal(s.additionalProperties, false);
        assert.equal(s.properties.passed.type, 'integer');
        assert.deepEqual(s.properties.status.enum, ['passed', 'failed']);
    });

    it('structured_output object: data plus the same JSON as text', async () => {
        const r = await call('structured_output', { variant: 'object' });
        assert.deepEqual(r.structuredContent, REPORT);
        assert.equal(r.content.length, 1);
        assert.deepEqual(JSON.parse(textOf(r)), REPORT);
    });

    it('structured_output data_only: no text block at all', async () => {
        const r = await call('structured_output', { variant: 'data_only' });
        assert.deepEqual(r.structuredContent, REPORT);
        assert.deepEqual(r.content, []);
    });

    it('structured_output text_differs: the text contradicts the data', async () => {
        const r = await call('structured_output', { variant: 'text_differs' });
        assert.equal(r.structuredContent.passed, 42);
        assert.match(textOf(r), /7 tests passed, 0 failed/);
    });

    it('structured_output invalid: the official client refuses data that violates the schema', async () => {
        await assert.rejects(call('structured_output', { variant: 'invalid' }), e => {
            assert.equal(e.code, -32602);
            assert.match(e.message, /does not match the tool's output schema/);
            assert.match(e.message, /required property 'durationMs'/);
            assert.match(e.message, /passed must be integer/);
            assert.match(e.message, /status must be equal to one of the allowed values/);
            return true;
        });
    });

    it('structured_output error: isError without structuredContent is accepted', async () => {
        const r = await call('structured_output', { variant: 'error' });
        assert.equal(r.isError, true);
        assert.equal(r.structuredContent, undefined);
        assert.match(textOf(r), /deliberate tool error/);
    });

    it(`structured_output_array: ${era === 'modern' ? 'a bare array (SEP-2106)' : 'wrapped as {"result": […]} on 2025-era connections'}, plus the JSON as text`, async () => {
        const { tools } = await client.listTools();
        const s = tools.find(t => t.name === 'structured_output_array').outputSchema;
        const r = await call('structured_output_array');
        if (era === 'modern') {
            assert.equal(s.type, 'array');
            assert.deepEqual(r.structuredContent, METRICS);
        } else {
            assert.equal(s.type, 'object');
            assert.equal(s.properties.result.type, 'array');
            assert.deepEqual(s.required, ['result']);
            assert.deepEqual(r.structuredContent, { result: METRICS });
        }
        assert.deepEqual(JSON.parse(textOf(r)), METRICS, 'the SDK adds the JSON as text for values that are not objects');
    });
}
