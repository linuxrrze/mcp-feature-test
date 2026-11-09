/**
 * Structured tool output: `outputSchema` in tools/list and `structuredContent`
 * in the result (2025-06-18; any JSON value as root since 2026-07-28, SEP-2106).
 *
 *  - structured_output        – object root. Variants show whether a client
 *                               handles the recommended shape (`object`: data
 *                               plus a JSON copy as text), shows structured
 *                               data when there is no text (`data_only`),
 *                               which of data and text reaches the model when
 *                               they disagree (`text_differs`), whether it
 *                               validates against the schema (`invalid`), and
 *                               whether it wrongly expects data on errors (`error`).
 *  - structured_output_array  – an array root, allowed since 2026-07-28. The
 *                               SDK wraps it as {"result": [...]} (schema and
 *                               value) on 2025-era connections, and adds the
 *                               JSON as a text block (SEP-2106; it does that
 *                               only for values that are not objects).
 *
 * The SDK validates every result against the tool's outputSchema and refuses
 * mismatches. `invalid` must reach the client anyway, so the registered schema
 * advertises the strict JSON Schema but skips the check for exactly the
 * payload objects that variant built (tracked by identity); every other result
 * is still validated by the SDK.
 */
import type { CallToolResult, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const STRUCTURED_VARIANTS = ['object', 'data_only', 'text_differs', 'invalid', 'error'] as const;
export type StructuredVariant = (typeof STRUCTURED_VARIANTS)[number];

export const buildReportSchema = z
    .object({
        project: z.string().meta({ description: 'Project name' }),
        status: z.enum(['passed', 'failed']).meta({ description: 'Overall result' }),
        passed: z.number().int().min(0).meta({ description: 'Number of passed tests' }),
        failed: z.number().int().min(0).meta({ description: 'Number of failed tests' }),
        durationMs: z.number().min(0).meta({ description: 'Wall-clock duration in milliseconds' }),
        tags: z.array(z.string()).meta({ description: 'Free-form labels' })
    })
    .meta({ title: 'Build report', description: 'A (fake) CI build report' });
export type BuildReport = z.infer<typeof buildReportSchema>;

/** The report every valid variant returns. */
export const SAMPLE_REPORT: BuildReport = { project: 'mcp-feature-test', status: 'failed', passed: 42, failed: 3, durationMs: 1234.5, tags: ['ci', 'nightly'] };

/** What the text block of `text_differs` claims instead (passed 7, not 42). */
export const DIFFERING_TEXT = 'Build report for mcp-feature-test: 7 tests passed, 0 failed, status passed.';

/** Payloads `invalid` built on purpose; only these skip the SDK's output check. */
const deliberatelyInvalid = new WeakSet<object>();

/** The strict schema, except that the SDK lets the deliberately invalid payloads through. */
export function strictExceptDeliberate<S extends z.ZodType>(schema: S): StandardSchemaWithJSON {
    const std = schema['~standard'];
    return {
        '~standard': {
            ...std,
            validate: (value: unknown) =>
                typeof value === 'object' && value !== null && deliberatelyInvalid.has(value) ? { value } : std.validate(value)
        }
    } as unknown as StandardSchemaWithJSON;
}

/** A payload that breaks the schema three ways: wrong type, value outside the enum, missing required field. */
export function makeInvalidReport(): Record<string, unknown> {
    const { durationMs: _dropped, ...rest } = SAMPLE_REPORT;
    const bad = { ...rest, passed: 'forty-two', status: 'maybe' };
    deliberatelyInvalid.add(bad);
    return bad;
}

export const metricListSchema = z
    .array(z.object({ name: z.string(), value: z.number() }))
    .meta({ title: 'Metrics', description: 'Name/value pairs (array root)' });

export const SAMPLE_METRICS = [
    { name: 'cpu', value: 0.42 },
    { name: 'memoryMiB', value: 512 },
    { name: 'requests', value: 1337 }
];

export function registerStructuredOutput(server: McpServer): void {
    server.registerTool(
        'structured_output',
        {
            title: 'Structured output (outputSchema)',
            description:
                'Return a fake build report as structuredContent, declared by an outputSchema. Variants: object (valid data plus the same JSON as text, as the spec recommends), ' +
                'data_only (valid data, no text block at all), ' +
                'text_differs (the text block reports different numbers than the data), invalid (data that violates the outputSchema), ' +
                'error (an isError result without structuredContent, which the spec allows).',
            inputSchema: z.object({ variant: z.enum(STRUCTURED_VARIANTS).default('object') }),
            outputSchema: strictExceptDeliberate(buildReportSchema),
            annotations: { readOnlyHint: true }
        },
        async ({ variant }): Promise<CallToolResult> => {
            switch (variant) {
                case 'object':
                    // 2025-06-18: a tool returning structured content SHOULD also return it serialized as text.
                    return { content: [{ type: 'text', text: JSON.stringify(SAMPLE_REPORT) }], structuredContent: { ...SAMPLE_REPORT } };
                case 'data_only':
                    // The SDK adds a JSON text block only for values that are not objects, so this stays empty.
                    return { content: [], structuredContent: { ...SAMPLE_REPORT } };
                case 'text_differs':
                    return { content: [{ type: 'text', text: DIFFERING_TEXT }], structuredContent: { ...SAMPLE_REPORT } };
                case 'invalid': {
                    const bad = makeInvalidReport();
                    return {
                        content: [{ type: 'text', text: `This result deliberately violates the outputSchema (passed is a string, status "maybe" is not allowed, durationMs is missing):\n${JSON.stringify(bad)}` }],
                        structuredContent: bad
                    };
                }
                case 'error':
                    return { content: [{ type: 'text', text: 'Build report unavailable (deliberate tool error; no structuredContent, which is allowed for errors).' }], isError: true };
            }
        }
    );

    server.registerTool(
        'structured_output_array',
        {
            title: 'Structured output with an array root',
            description:
                'Return a list of metrics whose outputSchema has an array root. Allowed on 2026-07-28 (SEP-2106); on 2025-era connections the schema and the value arrive wrapped as {"result": [...]}.',
            inputSchema: z.object({}),
            outputSchema: metricListSchema,
            annotations: { readOnlyHint: true }
        },
        async (): Promise<CallToolResult> => ({ content: [], structuredContent: SAMPLE_METRICS.map(m => ({ ...m })) as unknown as CallToolResult['structuredContent'] })
    );
}
