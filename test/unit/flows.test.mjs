import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import '../helpers.mjs';
import { createFlow, flowWaitMs, getFlow, handleFlowRequest, MAX_FLOWS, setFlowBaseUrl, waitForFlow } from '../../dist/flows.js';

describe('URL-elicitation flow store and pages', () => {
    let srv;
    let base;
    before(async () => {
        srv = createServer((req, res) => {
            if (!handleFlowRequest(req, res)) res.writeHead(418).end('not a flow path');
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${srv.address().port}`;
        setFlowBaseUrl(`${base}/`); // trailing slash must be stripped
    });
    after(() => new Promise(r => srv.close(r)));

    const post = (url, body) => fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });

    describe('waitForFlow (client accepted before the page was submitted)', () => {
        it('resolves true once the page is submitted later', async () => {
            const { flow, url } = await createFlow('x');
            const waiting = waitForFlow(flow.id, 5_000);
            setTimeout(() => void post(url, 'token=late'), 50);
            assert.equal(await waiting, true);
            assert.equal(getFlow(flow.id).token, 'late');
        });

        it('resolves true immediately for an already completed flow', async () => {
            const { flow, url } = await createFlow('x');
            await post(url, 'token=early');
            assert.equal(await waitForFlow(flow.id, 0), true);
        });

        it('resolves false on timeout, unknown flow and abort', async () => {
            const { flow } = await createFlow('x');
            assert.equal(await waitForFlow(flow.id, 30), false);
            assert.equal(await waitForFlow('00000000-0000-0000-0000-000000000000', 1_000), false);
            const ac = new AbortController();
            const waiting = waitForFlow(flow.id, 5_000, ac.signal);
            setTimeout(() => ac.abort(), 20);
            assert.equal(await waiting, false);
        });

        it('several waiters on one flow all resolve', async () => {
            const { flow, url } = await createFlow('x');
            const all = Promise.all([waitForFlow(flow.id, 5_000), waitForFlow(flow.id, 5_000)]);
            await post(url, 'token=both');
            assert.deepEqual(await all, [true, true]);
        });

        it('FLOW_WAIT_MS configures the wait (default 5 min)', () => {
            const prev = process.env.FLOW_WAIT_MS;
            try {
                delete process.env.FLOW_WAIT_MS;
                assert.equal(flowWaitMs(), 300_000);
                process.env.FLOW_WAIT_MS = '1234';
                assert.equal(flowWaitMs(), 1234);
                process.env.FLOW_WAIT_MS = 'nonsense';
                assert.equal(flowWaitMs(), 300_000);
            } finally {
                if (prev === undefined) delete process.env.FLOW_WAIT_MS;
                else process.env.FLOW_WAIT_MS = prev;
            }
        });
    });

    it('creates flows with unguessable ids under the configured base URL', async () => {
        const a = await createFlow('purpose A');
        const b = await createFlow('purpose B');
        assert.match(a.url, new RegExp(`^${base}/flow/[0-9a-f-]{36}$`));
        assert.notEqual(a.flow.id, b.flow.id);
        assert.equal(getFlow(a.flow.id), a.flow);
        assert.equal(a.flow.token, undefined);
    });

    it('serves an HTML form with the (escaped) purpose', async () => {
        const { url } = await createFlow('<script>alert(1)</script> & co');
        const res = await fetch(url);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const html = await res.text();
        assert.match(html, /<form method="post">/);
        assert.match(html, /type="password"/);
        assert.ok(!html.includes('<script>alert(1)'), 'purpose must be HTML-escaped');
        assert.match(html, /&#60;script&#62;/);
    });

    it('rejects an empty token with 400 and keeps the flow open', async () => {
        const { flow, url } = await createFlow('x');
        const res = await post(url, 'token=%20%20');
        assert.equal(res.status, 400);
        assert.equal(getFlow(flow.id).completedAt, undefined);
    });

    it('stores the token, fires onComplete and shows "already completed" afterwards', async () => {
        const { flow, url } = await createFlow('x');
        let completed = 0;
        flow.onComplete = () => {
            completed++;
        };
        const res = await post(url, 'token=sk-secret-42');
        assert.equal(res.status, 200);
        assert.match(await res.text(), /All set/);
        assert.equal(flow.token, 'sk-secret-42');
        assert.ok(flow.completedAt);
        assert.equal(completed, 1);
        const again = await fetch(url);
        assert.match(await again.text(), /Already completed/);
    });

    it('answers unknown flow ids with 404 and ignores non-flow paths', async () => {
        const res = await fetch(`${base}/flow/00000000-0000-4000-8000-000000000000`);
        assert.equal(res.status, 404);
        assert.match(await res.text(), /Unknown or expired flow/);
        assert.equal((await fetch(`${base}/flow/not-a-uuid`)).status, 418);
        assert.equal((await fetch(`${base}/other`)).status, 418);
    });

    it('rejects absurdly large POST bodies with 413 and keeps the flow open', async () => {
        const { flow, url } = await createFlow('x');
        const res = await post(url, `token=${'a'.repeat(200 * 1024)}`);
        assert.equal(res.status, 413);
        assert.equal(flow.token, undefined);
        assert.equal(flow.completedAt, undefined);
    });

    it('completes a flow only once: a second POST is 409, keeps the token and does not notify again', async () => {
        const { flow, url } = await createFlow('x');
        let completed = 0;
        flow.onComplete = () => {
            completed++;
        };
        assert.equal((await post(url, 'token=first-token')).status, 200);
        const again = await post(url, 'token=attacker-token');
        assert.equal(again.status, 409);
        assert.equal(flow.token, 'first-token');
        assert.equal(completed, 1);
    });

    it('sends hardening headers on flow pages', async () => {
        const { url } = await createFlow('x');
        const res = await fetch(url);
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /form-action 'self'/);
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    });

    it('answers other HTTP methods with 405', async () => {
        const { flow, url } = await createFlow('x');
        const res = await fetch(url, { method: 'PUT', body: 'token=x' });
        assert.equal(res.status, 405);
        assert.match(res.headers.get('allow'), /POST/);
        assert.equal(flow.token, undefined);
    });

    it(`keeps at most MAX_FLOWS (${MAX_FLOWS}) flows, dropping the oldest`, async () => {
        const first = await createFlow('oldest');
        for (let i = 0; i < MAX_FLOWS; i++) await createFlow('filler');
        assert.equal(getFlow(first.flow.id), undefined, 'oldest flow was dropped');
        const last = await createFlow('newest');
        assert.ok(getFlow(last.flow.id));
    });
});
