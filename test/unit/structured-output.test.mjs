// structured_output internals: the strict schema, the deliberately invalid
// payload, the narrow validation bypass, and what the server really puts on
// the wire (in-process, 2025 handshake).
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { configureLogger } from '../../dist/log.js';
import { createFeatureTestServer } from '../../dist/server.js';
import {
    DIFFERING_TEXT,
    SAMPLE_METRICS,
    SAMPLE_REPORT,
    STRUCTURED_VARIANTS,
    buildReportSchema,
    makeInvalidReport,
    metricListSchema,
    strictExceptDeliberate
} from '../../dist/structuredOutput.js';

configureLogger({ level: 'silent' });

describe('build report schema', () => {
    it('accepts the sample report and the sample metrics', () => {
        assert.deepEqual(buildReportSchema.parse(SAMPLE_REPORT), SAMPLE_REPORT);
        assert.deepEqual(metricListSchema.parse(SAMPLE_METRICS), SAMPLE_METRICS);
    });

    it('the invalid payload breaks it three ways', () => {
        const r = buildReportSchema.safeParse(makeInvalidReport());
        assert.equal(r.success, false);
        const paths = r.error.issues.map(i => i.path.join('.')).sort();
        assert.deepEqual(paths, ['durationMs', 'passed', 'status']);
    });

    it('the text of text_differs contradicts the data', () => {
        assert.match(DIFFERING_TEXT, /7 tests passed/);
        assert.notEqual(SAMPLE_REPORT.passed, 7);
    });

    it('lists the variants in a stable order', () => {
        assert.deepEqual([...STRUCTURED_VARIANTS], ['object', 'data_only', 'text_differs', 'invalid', 'error']);
    });
});

describe('strictExceptDeliberate', () => {
    const wrapped = strictExceptDeliberate(buildReportSchema)['~standard'];

    it('lets only the payload objects makeInvalidReport() built through', () => {
        const bad = makeInvalidReport();
        assert.deepEqual(wrapped.validate(bad), { value: bad });
        const copy = structuredClone(bad);
        assert.ok(wrapped.validate(copy).issues?.length, 'an equal copy is still rejected');
        assert.ok(wrapped.validate({ project: 'x' }).issues?.length);
        assert.ok(wrapped.validate(null).issues?.length);
    });

    it('still validates good data normally', () => {
        assert.deepEqual(wrapped.validate({ ...SAMPLE_REPORT }).value, SAMPLE_REPORT);
    });

    it('advertises the strict JSON Schema unchanged', () => {
        const opts = { target: 'draft-2020-12' };
        assert.deepEqual(wrapped.jsonSchema.output(opts), buildReportSchema['~standard'].jsonSchema.output(opts));
    });
});

describe('on the wire', () => {
    let client;
    afterEach(async () => {
        await client?.close();
        client = undefined;
    });

    /** Connect and record every message the server sends to the client. */
    async function connectRecording() {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await createFeatureTestServer({ transport: 'stdio' }).connect(serverSide);
        client = new Client({ name: 'wire-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(clientSide);
        const received = [];
        const deliver = clientSide.onmessage;
        clientSide.onmessage = (msg, extra) => {
            received.push(msg);
            deliver(msg, extra);
        };
        return received;
    }

    it('the server really sends the invalid data; the official client refuses it only once it knows the schema', async () => {
        const received = await connectRecording();
        const call = () => client.callTool({ name: 'structured_output', arguments: { variant: 'invalid' } });

        // Before tools/list the client has no outputSchema to check against and passes the data on.
        const unchecked = await call();
        assert.equal(unchecked.structuredContent.passed, 'forty-two');
        const wire = received.find(m => m.result?.structuredContent)?.result;
        assert.ok(wire, 'a result reached the client');
        assert.equal(wire.structuredContent.status, 'maybe');
        assert.equal('durationMs' in wire.structuredContent, false);
        assert.equal(wire.isError, undefined, 'not marked as an error');

        // After tools/list it caches the schema and refuses the same result.
        await client.listTools();
        await assert.rejects(call(), /does not match the tool's output schema/);
    });

    it('a server-side bug in any other variant would still be caught by the SDK', async () => {
        // Simulate one: validate a copy of the invalid payload with the registered schema.
        const r = strictExceptDeliberate(buildReportSchema)['~standard'].validate(JSON.parse(JSON.stringify(makeInvalidReport())));
        assert.ok(r.issues?.length);
    });
});
