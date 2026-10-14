'use strict';
/**
 * The managed-browser provider adapter (plan T14 R4a, server/dispatch/browser-provider.js): a class browser job
 * placed on a kind=provider offer named `browser-provider` is sent to the provider's own API instead of Bot,
 * mirrored from its validated browser-provider.job-state@1, cancelled and expired there — and metered by Run
 * itself, the provider's claimed wall time clamped to Run's observed duration + 5 s, its readings relayed to
 * Billing with Run's own token (audience openvibe.billing, billing.usage.record).
 *
 *   node test/dispatch-browser-provider.test.js
 *
 * The fake provider and the fake Billing are real HTTP servers, so the key header, the Idempotency-Key, the
 * timeouts and the 404/5xx answers travel the wire. The job loop is driven by hand (RUN_JOBS=off).
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const contracts = require('openvibe-contracts');
const { serviceAuth, capabilities, ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const KEY = `bpk_${crypto.randomBytes(16).toString('hex')}`;
const PROJECT = () => ids.newId('project');
const OFFER_ID = 'off_browser_01';
const LIMITS = { wall_ms: 60_000, cpu_ms: 60_000, mem_bytes: 1_073_741_824 };

/** A contract-valid platform.resource-offer@1 of the managed-browser provider. */
function providerOffer(over = {}) {
    return {
        offer_id: OFFER_ID,
        kind: 'provider',
        provider: 'browser-provider',
        region: 'eu-west',
        trust: 'first-party',
        capabilities: ['worker:browser'],
        health: { status: 'up', checked_at: new Date().toISOString() },
        pricing: { model: 'prepaid' },
        updated_at: new Date().toISOString(),
        ...over,
    };
}

const body = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); } });
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const closer = (server) => () => new Promise((r) => { server.closeAllConnections(); server.close(r); });

/**
 * A fake managed-browser provider under /v1: POST /jobs (idempotent by job id), GET /jobs/:id and POST
 * /jobs/:id/cancel, every call checked for `Authorization: Bearer <KEY>`. Every request it receives is
 * validated against browser-provider.job-create-request@1, and every answer it gives is a valid
 * job-state@1 unless a test asks for a broken one (mode.broken).
 */
async function startFakeProvider() {
    const jobs = new Map();
    const calls = [];
    const mode = { fail5xx: new Map(), missing: new Set(), broken: new Map() };   // fail5xx: job id → answers left to fail
    const stateOf = (row) => ({
        id: row.id, state: row.state, started_ms: row.started_ms, finished_ms: row.finished_ms, wall_ms: row.wall_ms,
        exit_reason: row.exit_reason, exit_code: row.exit_code, result: row.result, stdout: null,
    });
    const server = http.createServer(async (req, res) => {
        const answer = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
        const url = new URL(req.url, 'http://provider.test');
        const parts = url.pathname.split('/').filter(Boolean);   // v1 jobs [id] [cancel]
        const doc = req.method === 'POST' ? await body(req) : null;
        calls.push({ method: req.method, path: url.pathname, headers: req.headers, body: doc });
        if (req.headers.authorization !== `Bearer ${KEY}`) return answer(401, { code: 'provider.unauthorized', detail: 'bad key' });
        // A provider that echoes the key back in its error text: Run must never log it.
        if (parts[0] !== 'v1' || parts[1] !== 'jobs') return answer(404, { code: 'provider.not_found' });
        const target = parts[2] || (doc && doc.id);
        if (mode.fail5xx.get(target) > 0) {
            mode.fail5xx.set(target, mode.fail5xx.get(target) - 1);
            return answer(503, { code: 'provider.down', detail: `overloaded (key ${KEY})` });
        }
        if (req.method === 'POST' && parts.length === 2) {
            if (!contracts.validate('browser-provider.job-create-request@1', doc).valid) return answer(422, { code: 'provider.invalid', detail: 'not a job-create-request@1' });
            if (req.headers['idempotency-key'] !== doc.id) return answer(400, { code: 'provider.idempotency', detail: 'Idempotency-Key must be the job id' });
            const known = jobs.get(doc.id);
            if (known) return answer(200, { job: stateOf(known), created: false });
            const row = { id: doc.id, request: doc, state: 'queued', started_ms: null, finished_ms: null, wall_ms: 0, exit_reason: null, exit_code: null, result: null };
            jobs.set(row.id, row);
            return answer(201, { job: stateOf(row), created: true });
        }
        const row = jobs.get(parts[2]);
        if (!row || mode.missing.has(parts[2])) return answer(404, { code: 'provider.job_not_found' });
        if (mode.broken.has(row.id)) return answer(200, mode.broken.get(row.id)(stateOf(row)));
        if (req.method === 'GET' && parts.length === 3) return answer(200, stateOf(row));
        if (req.method === 'POST' && parts[3] === 'cancel') {
            if (!row.exit_reason) Object.assign(row, { state: 'cancelled', exit_reason: 'cancelled', exit_code: null, finished_ms: Date.now() });
            return answer(200, stateOf(row));
        }
        return answer(404, { code: 'provider.not_found' });
    });
    const url = await listen(server);
    return {
        url, jobs, calls, mode,
        callsOf: (method, path) => calls.filter((c) => c.method === method && c.path === path),
        start(id, startedMs = Date.now()) { Object.assign(jobs.get(id), { state: 'running', started_ms: startedMs }); },
        finish(id, { state = 'succeeded', exit = 'exited', code = 0, wallMs, result = null }) {
            Object.assign(jobs.get(id), { state, exit_reason: exit, exit_code: code, wall_ms: wallMs, result, finished_ms: Date.now() });
        },
        close: closer(server),
    };
}

/** A fake OpenVibe.Billing: POST /api/v1/usage, verifying Run's own token (openvibe.billing, billing.usage.record). */
async function startFakeBilling() {
    const keys = { publicPem: null, issuer: null };
    const readings = [];
    const server = http.createServer(async (req, res) => {
        const answer = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
        const auth = String(req.headers.authorization || '');
        const verified = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey: keys.publicPem, issuer: keys.issuer, audience: 'openvibe.billing' });
        if (!verified.ok) return answer(401, { code: verified.code });
        if (!capabilities.grants(verified.claims.cap, 'billing.usage.record')) return answer(403, { code: 'capability.denied' });
        if (req.method !== 'POST' || req.url !== '/api/v1/usage') return answer(404, {});
        const doc = await body(req);
        readings.push({ doc, claims: verified.claims });
        return answer(201, { ok: true });
    });
    const url = await listen(server);
    return {
        url, readings,
        useNetwork(network) { keys.publicPem = network.publicPem; keys.issuer = network.issuer; },
        close: closer(server),
    };
}

async function main() {
    const provider = await startFakeProvider();
    const billing = await startFakeBilling();
    const providerEnv = { RUN_BROWSER_PROVIDER_URL: `${provider.url}/v1/`, RUN_BROWSER_PROVIDER_API_KEY: KEY, RUN_BROWSER_PROVIDER_TIMEOUT_MS: '2000' };
    const t = await boot({
        env: {
            OV_OAUTH_CLIENT_SECRET: crypto.randomBytes(12).toString('hex'),
            RUN_BOT_URL: 'http://127.0.0.1:9',                // no node offer is published: nothing goes to Bot
            RUN_BILLING_URL: billing.url,
            RUN_DISPATCH_UNKNOWN_POLLS: '2',
            ...providerEnv,
        },
    });
    billing.useNetwork(t.network);
    const submit = (over = {}, opts = {}) => t.submit({ class: 'browser', artifact: undefined, args: { url: 'https://example.com' }, limits: LIMITS, ...over },
        { sub: 'svc:builder', ...opts, project: opts.project || PROJECT() });
    const read = (id, project) => t.call('GET', `/api/v1/jobs/${id}`, { cap: ['run.job.read'], project, sub: 'svc:builder' });
    const projectOf = (id) => t.db.value('SELECT project_id FROM run_jobs WHERE id = $1', [id]);
    const readingsOf = (id) => t.db.many('SELECT event_id, envelope, sent_at FROM run_usage_outbox WHERE event_id LIKE $1 ORDER BY id', [`run:${id}:%`]);
    const pollOne = async (id) => (await t.dispatch.poll()).find((a) => a.job_id === id);
    const adapter = t.dispatch.deps.provider;
    t.setOffers([providerOffer()]);

    try {
        await check('config: the provider and the Billing relay come from Run\'s env; the timeout has a default and a floor', async () => {
            const { loadConfig } = require('../server/config');
            const off = loadConfig({});
            assert.deepStrictEqual(off.browserProvider, { url: '', apiKey: '', timeoutMs: 8000 });
            assert.strictEqual(off.billing.url, '');
            const on = loadConfig({ RUN_BROWSER_PROVIDER_URL: ' https://browser.example/v1/ ', RUN_BROWSER_PROVIDER_API_KEY: 'k', RUN_BROWSER_PROVIDER_TIMEOUT_MS: '5' });
            assert.deepStrictEqual(on.browserProvider, { url: 'https://browser.example/v1', apiKey: 'k', timeoutMs: 100 });
        });

        await check('the adapter is on: status names the provider and never its key', async () => {
            const health = await t.call('GET', '/api/health', { token: null });
            const bp = health.json.dispatcher.browser_provider;
            assert.strictEqual(bp.enabled, true, health.text);
            assert.strictEqual(bp.key_set, true);
            assert.strictEqual(bp.url, provider.url);                                    // the origin only
            assert.strictEqual(health.json.dispatcher.usage_relay.enabled, true);
            assert.ok(!health.text.includes(KEY));
            assert.ok(!JSON.stringify(t.dispatch.status()).includes(KEY));
        });

        await check('a browser job is placed on the provider offer and sent once, as the frame alone', async () => {
            const project = PROJECT();
            const job = await submit({}, { project });
            const placed = await pollOne(job.id);
            assert.strictEqual(placed.state, 'placed', JSON.stringify(placed));
            const posts = provider.callsOf('POST', '/v1/jobs').filter((c) => c.body && c.body.id === job.id);
            assert.strictEqual(posts.length, 1);
            const call = posts[0];
            assert.strictEqual(call.headers.authorization, `Bearer ${KEY}`);
            assert.strictEqual(call.headers['idempotency-key'], job.id);
            // No project, no subject, no requester, no credential: the provider never learns who pays.
            assert.deepStrictEqual(call.body, { id: job.id, class: 'browser', args: { url: 'https://example.com' }, inputs: [], limits: LIMITS, egress: 'none' });
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'placed');
            assert.deepStrictEqual(read1.json.placement, { node: OFFER_ID, provider: 'browser-provider', region: 'eu-west' });
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            await t.dispatch.poll();
            await t.dispatch.poll();
            assert.strictEqual(provider.callsOf('POST', '/v1/jobs').filter((c) => c.body && c.body.id === job.id).length, 1, 'a placed job is never sent again');
        });

        await check('running → succeeded mirrors once; the claim within the cap is billed and relayed to Billing', async () => {
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            provider.start(job.id);
            assert.strictEqual((await pollOne(job.id)).state, 'running');
            assert.strictEqual((await t.outboxRows('run.job.started', job.id)).length, 1);
            t.clock.offset += 4000;                                                      // Run observes 4 s pass
            provider.finish(job.id, { wallMs: 2500, result: { title: 'Example Domain' } });
            assert.strictEqual((await pollOne(job.id)).state, 'succeeded');
            const read1 = await read(job.id, project);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            assert.deepStrictEqual(read1.json.exit, { reason: 'exited', code: 0 });
            assert.deepStrictEqual(read1.json.result, { title: 'Example Domain' });
            assert.strictEqual(read1.json.usage.wall_ms, 2500);
            assert.strictEqual(read1.json.usage.seconds, 2.5);
            assert.strictEqual((await t.outboxRows('run.job.succeeded', job.id)).length, 1);
            // One reading per billed second, the partial last one as a fraction; project and subject are Run's own.
            const rows = await readingsOf(job.id);
            assert.deepStrictEqual(rows.map((r) => r.event_id), [0, 1, 2].map((n) => `run:${job.id}:${n}`));
            const docs = rows.map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
            assert.deepStrictEqual(docs.map((d) => d.quantity), [1, 1, 0.5]);
            for (const d of docs) {
                assert.ok(contracts.validate('platform.usage-sample@1', d).valid, JSON.stringify(d));
                assert.strictEqual(d.project, project);
                assert.strictEqual(d.subject, 'service:builder');
                assert.strictEqual(d.service, 'run');
                assert.strictEqual(d.provider, 'browser-provider');
            }
            // Later polls bill nothing twice.
            await t.dispatch.poll();
            assert.strictEqual((await readingsOf(job.id)).length, 3);
            // The relay posts them with Run's own Billing token, used for nothing else.
            await t.dispatch.deps.usageRelay.flush();
            const got = billing.readings.filter((r) => r.doc.id.startsWith(`run:${job.id}:`));
            assert.strictEqual(got.length, 3);
            assert.deepStrictEqual(got[0].claims.aud, ['openvibe.billing']);
            assert.deepStrictEqual(got[0].claims.cap, ['billing.usage.record']);
            assert.ok((await readingsOf(job.id)).every((r) => r.sent_at != null));
            assert.ok(t.network.tokenRequests.audiences.includes('openvibe.billing'));
        });

        await check('an over-claimed meter is clamped to Run\'s observed duration + 5 s and logged', async () => {
            const direct = adapter.meter({ jobId: 'job_x', claimedMs: 20_000, observedMs: 1000 });
            assert.deepStrictEqual(direct, { wallMs: 6000, claimedMs: 20_000, capMs: 6000, clamped: true });
            assert.strictEqual(adapter.meter({ claimedMs: 3000, observedMs: 1000 }).wallMs, 3000);
            assert.strictEqual(adapter.meter({ claimedMs: -5, observedMs: 1000 }).wallMs, 0);

            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            provider.start(job.id);
            await t.dispatch.poll();
            t.clock.offset += 2000;
            provider.finish(job.id, { wallMs: 60_000 });
            const ended = await pollOne(job.id);
            assert.strictEqual(ended.state, 'succeeded');
            assert.strictEqual(ended.clamped, true);
            const wall = (await read(job.id, project)).json.usage.wall_ms;
            assert.ok(wall >= 7000 && wall < 9000, `billed ${wall} ms, not observed (~2 s) + 5 s`);
            const docs = (await readingsOf(job.id)).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
            assert.strictEqual(docs.length, Math.ceil(wall / 1000));
            assert.strictEqual(Math.round(docs.reduce((s, d) => s + d.quantity, 0) * 1000), wall);
            assert.ok(t.logs.some((l) => l.includes(job.id) && /claims 60000 ms/.test(l) && /clamped/.test(l)), t.logs.join('\n'));
            assert.ok(adapter.status().clamped >= 2);
        });

        await check('cancel: a placed provider job is stopped at the provider and ends cancelled', async () => {
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            provider.start(job.id);
            await t.dispatch.poll();
            const asked = await t.call('POST', `/api/v1/jobs/${job.id}/cancel`, { cap: ['run.job.cancel'], project, sub: 'svc:builder' });
            assert.strictEqual(asked.status, 200, asked.text);
            assert.strictEqual(provider.callsOf('POST', `/v1/jobs/${job.id}/cancel`).length, 1);
            assert.strictEqual((await pollOne(job.id)).state, 'cancelled');
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'cancelled');
            assert.deepStrictEqual(read1.json.exit, { reason: 'cancelled', code: null });
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            assert.strictEqual((await t.outboxRows('run.job.cancelled', job.id)).length, 1);
            await t.dispatch.poll();
            assert.strictEqual(provider.callsOf('POST', `/v1/jobs/${job.id}/cancel`).length, 1, 'one cancel per job');
        });

        await check('expire: a provider job whose ttl runs out is stopped at the provider and ends expired', async () => {
            const job = await submit();
            await t.dispatch.poll();
            provider.start(job.id);
            await t.dispatch.poll();
            await t.db.exec('UPDATE run_jobs SET created_at = created_at - 10000000 WHERE id = $1', [job.id]);
            const swept = (await t.dispatch.sweep()).find((a) => a.job_id === job.id);
            assert.strictEqual(swept.state, 'expired');
            assert.strictEqual(provider.callsOf('POST', `/v1/jobs/${job.id}/cancel`).length, 1);
            const read1 = await read(job.id, await projectOf(job.id));
            assert.strictEqual(read1.json.state, 'expired');
            assert.strictEqual(read1.json.error.code, 'run.job.ttl');
            assert.strictEqual(read1.json.placement.node, OFFER_ID);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
        });

        await check('a provider that does not know the job (404) fails it with run.job.worker_failed', async () => {
            const job = await submit();
            await t.dispatch.poll();
            provider.mode.missing.add(job.id);
            assert.strictEqual((await pollOne(job.id)).state, 'placed');                 // one 404 is not yet the end
            assert.strictEqual((await pollOne(job.id)).state, 'failed');
            const read1 = await read(job.id, await projectOf(job.id));
            assert.strictEqual(read1.json.error.code, 'run.job.worker_failed');
            assert.match(read1.json.error.detail, /browser provider has no job/);
            assert.strictEqual((await readingsOf(job.id)).length, 0);
        });

        await check('a 5xx is retried on the next tick, for the send and for the state', async () => {
            const job = await submit();
            provider.mode.fail5xx.set(job.id, 1);
            const first = await pollOne(job.id);
            assert.strictEqual(first.state, 'queued');
            assert.strictEqual(first.reason, 'run.dispatch.unavailable');
            assert.strictEqual((await pollOne(job.id)).state, 'placed');
            provider.start(job.id);
            provider.mode.fail5xx.set(job.id, 1);
            assert.strictEqual((await pollOne(job.id)).state, 'placed');                 // the state answer was a 503
            assert.strictEqual((await pollOne(job.id)).state, 'running');
        });

        await check('a malformed or foreign state is never adopted', async () => {
            const job = await submit();
            await t.dispatch.poll();
            provider.start(job.id);
            await t.dispatch.poll();
            provider.finish(job.id, { wallMs: 1000 });
            for (const broken of [
                (s) => ({ ...s, wall_ms: 'lots' }),                                         // not a job-state@1
                (s) => ({ ...s, project_id: PROJECT() }),                                   // a field the contract has no place for
                (s) => ({ ...s, id: ids.newId('job') }),                                    // another job's state
            ]) {
                provider.mode.broken.set(job.id, broken);
                const answer = await pollOne(job.id);
                assert.strictEqual(answer.state, 'running', JSON.stringify(answer));
                assert.strictEqual(answer.refused, true);
            }
            assert.strictEqual((await readingsOf(job.id)).length, 0);
            provider.mode.broken.delete(job.id);
            assert.strictEqual((await pollOne(job.id)).state, 'succeeded');
            assert.ok(adapter.status().malformed >= 3);
        });

        await check('the provider\'s key is never in a log, a status or a read result', async () => {
            assert.ok(t.logs.some((l) => /browser provider/.test(l)), 'the bridge logged its provider calls');
            assert.ok(!t.logs.some((l) => l.includes(KEY)), t.logs.join('\n'));
            assert.ok(!JSON.stringify(t.dispatch.status()).includes(KEY));
            const rows = await t.db.many('SELECT job::text AS job FROM run_jobs');
            assert.ok(!rows.some((r) => r.job.includes(KEY)));
        });
    } finally {
        t.dispatch.stop();
        await t.close();
    }

    // Without RUN_BILLING_URL the provider's jobs still run; their readings wait and nothing is sent.
    const quiet = await boot({ env: { OV_OAUTH_CLIENT_SECRET: crypto.randomBytes(12).toString('hex'), RUN_BOT_URL: 'http://127.0.0.1:9', ...providerEnv } });
    try {
        await check('without RUN_BILLING_URL a provider job still runs and its readings wait unsent', async () => {
            assert.strictEqual(quiet.dispatch.status().usage_relay.enabled, false);
            quiet.setOffers([providerOffer()]);
            const job = await quiet.submit({ class: 'browser', artifact: undefined, args: {}, limits: LIMITS });
            await quiet.dispatch.poll();
            provider.start(job.id);
            await quiet.dispatch.poll();
            quiet.clock.offset += 3000;
            provider.finish(job.id, { wallMs: 1500 });
            assert.strictEqual((await quiet.dispatch.poll()).find((a) => a.job_id === job.id).state, 'succeeded');
            const rows = await quiet.db.many('SELECT sent_at FROM run_usage_outbox WHERE event_id LIKE $1', [`run:${job.id}:%`]);
            assert.strictEqual(rows.length, 2);
            assert.ok(rows.every((r) => r.sent_at == null));
            assert.ok(!billing.readings.some((r) => r.doc.id.startsWith(`run:${job.id}:`)));
        });
    } finally {
        await quiet.close();
    }

    // Without the provider's URL (or its key) the adapter is off: a browser job stays queued, nothing is sent.
    for (const [name, env] of [['RUN_BROWSER_PROVIDER_URL', { RUN_BROWSER_PROVIDER_API_KEY: KEY }], ['RUN_BROWSER_PROVIDER_API_KEY', { RUN_BROWSER_PROVIDER_URL: `${provider.url}/v1` }]]) {
        const off = await boot({ env: { OV_OAUTH_CLIENT_SECRET: crypto.randomBytes(12).toString('hex'), RUN_BOT_URL: 'http://127.0.0.1:9', ...env } });
        try {
            await check(`without ${name} the adapter is off and a browser job stays queued`, async () => {
                const status = off.dispatch.status().browser_provider;
                assert.strictEqual(status.enabled, false);
                assert.match(status.note, new RegExp(`${name} is unset`));
                // A node offer cannot borrow the provider's name to reach Bot either.
                off.setOffers([providerOffer(), providerOffer({ offer_id: 'off_node_x', kind: 'node', node_id: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2X' })]);
                const before = provider.calls.length;
                const job = await off.submit({ class: 'browser', artifact: undefined, args: {}, limits: LIMITS });
                assert.strictEqual((await off.dispatch.poll()).find((a) => a.job_id === job.id).state, 'queued');
                assert.strictEqual((await off.dispatch.poll()).find((a) => a.job_id === job.id).state, 'queued');
                assert.strictEqual(provider.calls.length, before);
                assert.strictEqual(await off.db.value('SELECT state FROM run_jobs WHERE id = $1', [job.id]), 'queued');
            });
        } finally {
            await off.close();
        }
    }

    await check('outside development the provider URL must be https (or loopback): the key never travels in clear', async () => {
        const { createBrowserProviderAdapter } = require('../server/dispatch/browser-provider');
        const plain = createBrowserProviderAdapter({ config: { isProduction: true, browserProvider: { url: 'http://browser.example/v1', apiKey: KEY, timeoutMs: 1000 } }, log: { warn() {} } });
        assert.strictEqual(plain.enabled, false);
        assert.match(plain.note, /must be https/);
        assert.ok(!plain.note.includes(KEY));
        const secure = createBrowserProviderAdapter({ config: { isProduction: true, browserProvider: { url: 'https://browser.example/v1', apiKey: KEY, timeoutMs: 1000 } }, log: { warn() {} } });
        assert.strictEqual(secure.enabled, true);
    });

    await provider.close();
    await billing.close();
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
