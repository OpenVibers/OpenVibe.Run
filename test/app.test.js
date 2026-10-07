'use strict';
/**
 * The skeleton around the job API (plan T14 step 4, R1a and step 5): liveness, truthful readiness, the
 * release manifest, the loopback-only /metrics, the JSON body limits and the dispatcher seam.
 *
 *   node test/app.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

async function main() {
    const t = await boot();
    const project = contracts.ids.newId('project');
    try {
        await check('liveness: GET /api/health is ok and says what it can back', async () => {
            const r = await t.call('GET', '/api/health', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.ok, true);
            assert.strictEqual(r.json.service, 'run');
            assert.strictEqual(r.json.version, require('../package.json').version);
            assert.strictEqual(r.json.streams, 0);
            assert.strictEqual(r.json.events.enabled, false);                       // EVENTS_URL unset in the test
            // The dispatcher bridge exists (plan T14 step 6), but without OV_OAUTH_CLIENT_SECRET Run cannot
            // mint the Bot token it needs: nothing is sent and every job stays queued.
            assert.strictEqual(r.json.dispatcher.enabled, false);
            assert.match(r.json.dispatcher.note, /OV_OAUTH_CLIENT_SECRET/);
        });

        await check('readiness: GET /api/ready reports the database, and honestly skips what is absent', async () => {
            const r = await t.call('GET', '/api/ready', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.ready, true, r.text);
            assert.strictEqual(r.json.status, 'ready', r.text);
            assert.strictEqual(r.json.service, 'run');
            assert.strictEqual(r.json.checks.db.status, 'ok');
            assert.strictEqual(r.json.checks.db.required, true);
            assert.deepStrictEqual(r.json.failed, []);
            assert.deepStrictEqual(r.json.skipped, ['valkey', 'events', 'bot']);     // nothing is claimed that is not read
            assert.strictEqual(r.json.checks.valkey.status, 'skipped');              // VALKEY_URL unset
            assert.strictEqual(r.json.checks.events.status, 'skipped');              // the relay is off
            assert.strictEqual(r.json.checks.bot.status, 'skipped');
            assert.match(r.json.checks.bot.reason, /OV_OAUTH_CLIENT_SECRET/);        // not probed: Run cannot call Bot
            assert.strictEqual(r.json.jobs_queued, 0);
            assert.strictEqual(r.json.jobs_active, 0);
            assert.strictEqual(r.json.poller.running, false);                        // nothing starts in the app factory
            assert.strictEqual(r.json.events_outbox.pending, 0);
            assert.strictEqual(r.json.checks.network_jwks.status, 'ok');             // the stub Network's key loaded
        });

        await check('GET /release.json serves the manifest for this release', async () => {
            const r = await t.call('GET', '/release.json', { token: null });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.service, 'run');
            assert.strictEqual(r.json.contracts_version, require('openvibe-contracts/package.json').version);
            assert.strictEqual(r.json.packages['openvibe-sdk'], require('openvibe-sdk/package.json').version);
            assert.ok(r.json.components.server, 'the release names its server component');
        });

        await check('GET /metrics is for a direct loopback caller, never a forwarded one', async () => {
            const direct = await t.call('GET', '/metrics', { token: null });
            assert.strictEqual(direct.status, 200, direct.text);
            assert.match(direct.headers.get('content-type') || '', /text\/plain/);
            assert.match(direct.text, /run_jobs_queued/);
            for (const header of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded']) {
                const forwarded = await t.call('GET', '/metrics', { token: null, headers: { [header]: '203.0.113.7' } });
                assert.strictEqual(forwarded.status, 404, `${header} must not reach /metrics`);
            }
            const proxied = await fetch(`${t.base}/metrics`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
            assert.strictEqual(proxied.status, 404);
        });

        await check('with no Bot credentials the bridge is off: a submitted job stays queued', async () => {
            const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), cap: ['run.job.submit'], project, sub: 'svc:builder' });
            assert.strictEqual(made.status, 201, made.text);
            assert.strictEqual(made.json.job.state, 'queued');
            assert.strictEqual(t.app.locals.dispatch.enabled, false);
            assert.deepStrictEqual(await t.app.locals.dispatch.poll(), []);
            assert.deepStrictEqual(await t.app.locals.dispatch.sweep(), []);
            assert.strictEqual((await t.app.locals.dispatch.place({ id: made.json.job.id, class: 'function' })).placed, false);
            const read = await t.call('GET', `/api/v1/jobs/${made.json.job.id}`, { cap: ['run.job.read'], project, sub: 'svc:builder' });
            assert.strictEqual(read.json.state, 'queued');
            assert.strictEqual(read.json.placement, null);
        });

        await check('a body that is not JSON is 400 problem+json', async () => {
            const token = t.network.signService({ cap: ['run.job.submit'], project_id: project, sub: 'svc:builder' });
            const res = await fetch(`${t.base}/api/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{not json' });
            const text = await res.text();
            assert.strictEqual(res.status, 400, text);
            assert.match(res.headers.get('content-type') || '', /application\/problem\+json/);
            const body = JSON.parse(text);
            assert.strictEqual(body.code, 'request.malformed_json');
            assert.ok(body.request_id && body.trace_id);                            // the problem carries the request context
        });

        await check('an unknown API route is a problem+json 404, never a page', async () => {
            const r = await t.call('GET', '/api/v1/nope', { token: null });
            assert.strictEqual(r.status, 404, r.text);
            assert.match(r.headers.get('content-type') || '', /application\/problem\+json/);
            assert.strictEqual(r.json.code, 'not_found');
            const internal = await t.call('GET', '/internal/events', { token: null });
            assert.strictEqual(internal.status, 404);
            const underMetrics = await t.call('GET', '/metrics/nope', { token: null });
            assert.strictEqual(underMetrics.status, 404);
        });

        await check('the skeleton sends the security headers an API should', async () => {
            const r = await t.call('GET', '/api/health', { token: null });
            assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
            assert.ok(r.headers.get('x-frame-options'));
            assert.strictEqual(r.headers.get('x-powered-by'), null);
            assert.match(r.headers.get('x-openvibe-request-id') || '', /^req_[0-9a-f]{24}$/);
        });
    } finally {
        await t.close();
    }

    // A second boot, in production, with no stream key: the API still serves, stream tickets answer 503.
    const strict = await boot({ env: { NODE_ENV: 'production', RUN_STREAM_PRIVATE_KEY: '', RUN_STREAM_KEY_FILE: '' } });
    try {
        await check('production with no stream key: the API serves, stream tickets answer 503', async () => {
            const project2 = contracts.ids.newId('project');
            assert.strictEqual(strict.app.locals.tickets.get(), null);
            const made = await strict.call('POST', '/api/v1/jobs', { body: strict.request(), cap: ['run.job.submit'], project: project2, sub: 'svc:builder' });
            assert.strictEqual(made.status, 201, made.text);
            const ticket = await strict.call('POST', `/api/v1/jobs/${made.json.job.id}/stream/ticket`, { cap: ['run.job.stream'], project: project2, sub: 'svc:builder' });
            assert.strictEqual(ticket.status, 503, ticket.text);
            assert.strictEqual(ticket.json.code, 'run.stream.disabled');
            const read = await strict.call('GET', `/api/v1/jobs/${made.json.job.id}`, { cap: ['run.job.read'], project: project2, sub: 'svc:builder' });
            assert.strictEqual(read.status, 200, read.text);
            const health = await strict.call('GET', '/api/health', { token: null });
            assert.strictEqual(health.status, 200);
        });
    } finally {
        await strict.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
