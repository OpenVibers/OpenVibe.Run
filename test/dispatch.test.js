'use strict';
/**
 * The dispatcher bridge (plan T14 steps 6 and 7): a submitted job is placed on a node from the Fabric offers
 * (the stub Network's registry + openvibe-sdk/placement), sent to OpenVibe.Bot once, mirrored from Bot's own
 * record, streamed, cancelled and expired — all against an in-process fake Bot that verifies the Network
 * service token Run mints for it (audience openvibe.bot, capability bot.job.dispatch).
 *
 *   node test/dispatch.test.js
 *
 * The fake Bot is a real HTTP server (not a fetch stub), so Run's token client, its Authorization header,
 * its timeouts and Bot's 404/409 answers travel the wire the way they will in production, and the token
 * cache is observable (the stub Network counts its /oauth/token calls). The job loop is driven by hand
 * (RUN_JOBS=off) except where a test starts it on purpose.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const contracts = require('openvibe-contracts');
const { serviceAuth, capabilities, ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const DEVICE = 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2X';   // the device Bot dispatches to (offer.node_id)
const OTHER_DEVICE = 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2XQ';
const PROJECT = () => ids.newId('project');

/** A contract-valid platform.resource-offer@1 for a paired Node advertising worker:<class>. */
function offer(over = {}) {
    return {
        offer_id: 'off_node_01',
        kind: 'node',
        node_id: DEVICE,
        region: 'eu-west',
        cell: 'wnam-1',
        trust: 'first-party',
        capabilities: ['node:http', 'worker:function'],
        health: { status: 'up', checked_at: new Date().toISOString() },
        pricing: { model: 'prepaid' },
        updated_at: new Date().toISOString(),
        ...over,
    };
}

/**
 * A fake OpenVibe.Bot: its three job routes, a device registry and a job record shaped like
 * server/jobs/index.js presentJob(). Every call is verified to carry Run's service token for audience
 * openvibe.bot holding bot.job.dispatch — the real auth path, not a bypass. The Network keys it verifies
 * against are handed to it after boot() (useNetwork).
 */
async function startFakeBot() {
    const keys = { publicPem: null, issuer: null };
    const devices = new Map([[DEVICE, { classes: ['function'] }]]);
    const jobs = new Map();
    const calls = [];
    const mode = { exitOnCancel: true };
    const chunkSeq = new Map();

    const present = (row) => ({
        id: row.id, node_id: row.node_id, class: row.class, state: row.state,
        project_id: row.project_id, subject: row.subject, provider: row.provider,
        cancel_requested: row.cancel_requested, fault_code: row.fault_code ?? null,
        sent_at: row.sent_at ?? null, started_ms: row.started_ms ?? null, finished_at: row.finished_at ?? null,
        exit_reason: row.exit_reason ?? null, exit_code: row.exit_code ?? null, wall_ms: row.wall_ms ?? null,
        usage_read: row.usage_read ?? 0, result: row.result ?? null, job: row.job,
        created_at: row.created_at, updated_at: row.updated_at,
    });
    const stdoutOf = (row) => {
        const chunks = row.chunks || [];
        return {
            text: chunks.map((c) => c.chunk).join(''), first_seq: chunks.length ? chunks[0].seq : null,
            last_seq: chunks.length ? chunks[chunks.length - 1].seq : null, truncated: false,
        };
    };
    const body = (req) => new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); } });
    });

    const server = http.createServer(async (req, res) => {
        const answer = (status, doc) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); };
        const url = new URL(req.url, 'http://bot.test');
        if (url.pathname === '/api/health') return answer(200, { ok: true, service: 'bot' });
        const parts = url.pathname.split('/').filter(Boolean);   // api v1 jobs [id] [cancel]
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) return answer(401, { code: 'bot.sign_in', detail: 'sign in to do that' });
        const verified = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey: keys.publicPem, issuer: keys.issuer, audience: 'openvibe.bot' });
        if (!verified.ok) return answer(401, { code: verified.code, detail: verified.reason });
        if (!capabilities.grants(verified.claims.cap, 'bot.job.dispatch')) return answer(403, { code: 'capability.denied', detail: 'bot.job.dispatch not granted' });
        if (verified.claims.sub !== 'svc:run') return answer(403, { code: 'bot.forbidden', detail: 'job dispatch is Run\'s' });

        if (req.method === 'POST' && url.pathname === '/api/v1/jobs') {
            const doc = await body(req);
            calls.push({ method: 'POST', path: url.pathname, body: doc, claims: verified.claims });
            if (!doc || !doc.project_id) return answer(422, { code: 'bot.invalid_input', detail: 'project_id is required (Run is the payer)' });
            const device = devices.get(doc.node_id);
            if (!device) return answer(404, { code: 'bot.device_not_found', detail: 'no such device, or it is revoked' });
            if (!device.classes.includes(doc.job && doc.job.class)) return answer(409, { code: 'bot.class_unadvertised', detail: `the device does not advertise the runtime class ${doc.job && doc.job.class}` });
            const known = jobs.get(doc.job.id);
            if (known) return answer(201, { job: present(known), sent: false });   // Bot's dispatch is idempotent by job id
            const now = Date.now();
            const row = { ...doc, id: doc.job.id, class: doc.job.class, state: 'queued', cancel_requested: false, created_at: now, updated_at: now, chunks: [] };
            row.sent_at = device.connected === false ? null : now;
            jobs.set(row.id, row);
            // A test hook: what happens on the wire between Bot taking the frame and Run recording it.
            if (mode.onDispatch) await mode.onDispatch(doc);
            return answer(201, { job: present(row), sent: row.sent_at != null });
        }
        if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'jobs' && parts[3]) {
            const row = jobs.get(parts[3]);
            if (req.method === 'POST' && parts[4] === 'cancel') {
                calls.push({ method: 'POST', path: url.pathname, claims: verified.claims });
                if (!row) return answer(404, { code: 'bot.job_not_found', detail: 'no such job' });
                row.cancel_requested = true;
                row.updated_at = Date.now();
                const sent = row.sent_at != null && row.exit_reason == null;
                // A killed process has no exit status: job_exit cancelled carries code null.
                if (mode.exitOnCancel && row.exit_reason == null) finish(row, { reason: 'cancelled', code: null });
                return answer(200, { job: present(row), sent });
            }
            if (req.method === 'GET' && !parts[4]) {
                calls.push({ method: 'GET', path: url.pathname, claims: verified.claims });
                if (!row) return answer(404, { code: 'bot.job_not_found', detail: 'no such job' });
                return answer(200, { job: present(row), stdout: stdoutOf(row) });
            }
        }
        return answer(404, { code: 'bot.not_found', detail: 'no such route' });
    });

    /** job_started: the node's process started (Bot keeps the first started_ms). */
    function start(id, startedMs = Date.now()) {
        const row = jobs.get(id);
        row.started_ms = row.started_ms ?? startedMs;
        row.state = row.exit_reason == null ? 'running' : row.state;
        row.updated_at = Date.now();
    }
    /** job_stdout: one chunk, the job's own chunk_seq from 1. */
    function stdout(id, chunk) {
        const row = jobs.get(id);
        const seq = (chunkSeq.get(id) || 0) + 1;
        chunkSeq.set(id, seq);
        row.chunks.push({ seq, chunk });
    }
    /** job_exit: the end state and the metered wall clock (Bot is the meter). */
    function finish(row, { reason, code = 0, wallMs = 0, result = null }) {
        row.state = reason === 'exited' && code === 0 ? 'succeeded' : reason === 'cancelled' ? 'cancelled' : reason === 'ttl' ? 'expired' : 'failed';
        row.exit_reason = reason; row.exit_code = code; row.wall_ms = wallMs; row.result = result;
        row.usage_read = Math.ceil(wallMs / 1000);
        row.finished_at = Date.now(); row.updated_at = Date.now();
    }
    const exit = (id, opts) => finish(jobs.get(id), opts);
    /** Bot restarted without this job (or lost it): the job it once took is gone. */
    const forget = (id) => jobs.delete(id);
    const url = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

    return {
        url, calls, devices, jobs, mode, start, stdout, exit, forget, present,
        /** The Network stub this Bot verifies Run's token against (after boot). */
        useNetwork: (network) => { keys.publicPem = network.publicPem; keys.issuer = network.issuer; },
        callsOf: (method, path) => calls.filter((c) => c.method === method && (!path || c.path === path)),
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

async function main() {
    const bot = await startFakeBot();
    const t = await boot({
        env: {
            OV_OAUTH_CLIENT_SECRET: crypto.randomBytes(12).toString('hex'),
            RUN_BOT_URL: bot.url,
            RUN_OFFERS_TTL_MS: '0',                   // every tick reads the registry; the stub is local
            RUN_DISPATCH_UNKNOWN_POLLS: '3',
            RUN_JOBS: 'off',                          // the tests drive dispatch.poll() themselves
        },
    });
    bot.useNetwork(t.network);
    const submit = (over = {}, opts = {}) => t.submit(over, { sub: 'svc:builder', ...opts, project: opts.project || PROJECT() });
    const read = (id, project) => t.call('GET', `/api/v1/jobs/${id}`, { cap: ['run.job.read'], project, sub: 'svc:builder' });

    try {
        await check('the bridge is on: health and readiness say so', async () => {
            const health = await t.call('GET', '/api/health', { token: null });
            assert.strictEqual(health.json.dispatcher.enabled, true, health.text);
            assert.match(health.json.dispatcher.note, /openvibe\.bot/);
            assert.strictEqual(health.json.dispatcher.bot_url, bot.url);
            const ready = await t.call('GET', '/api/ready', { token: null });
            assert.strictEqual(ready.status, 200, ready.text);
            assert.strictEqual(ready.json.checks.bot.status, 'ok', ready.text);       // Bot answers, and it is not required
            assert.strictEqual(ready.json.checks.bot.required, false);
            assert.ok(ready.json.poller, 'readiness reports the poller');
            assert.strictEqual(ready.json.poller.running, false);                    // nothing starts before start()
            assert.strictEqual(ready.json.jobs_active, 0);
        });

        await check('the poller starts and stops; nothing runs at module load', async () => {
            assert.strictEqual(t.dispatch.status().poller.ticks, 0);
            assert.strictEqual(t.dispatch.start().running, true);
            t.dispatch.stop();
            assert.strictEqual(t.dispatch.status().poller.running, false);
        });

        await check('a queued job is placed from the offers and sent to Bot exactly once', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const sentBefore = bot.callsOf('POST', '/api/v1/jobs').length;
            const job = await submit({}, { project });
            assert.strictEqual(job.state, 'queued');
            const first = await t.dispatch.poll();
            const mine = first.find((a) => a.job_id === job.id);
            assert.strictEqual(mine.state, 'placed');
            const sent = bot.callsOf('POST', '/api/v1/jobs');
            assert.strictEqual(sent.length, sentBefore + 1, JSON.stringify(sent.map((c) => c.body && c.body.job.id)));
            const call = sent[sent.length - 1];
            // The platform.job@1 body, the device the offer names, and Run's own project and requester.
            assert.strictEqual(call.body.node_id, DEVICE);
            assert.strictEqual(call.body.project_id, project);
            assert.strictEqual(call.body.subject, 'service:builder');
            assert.deepStrictEqual(call.claims.aud, ['openvibe.bot']);               // the audience Bot checks
            assert.deepStrictEqual(call.claims.cap, ['bot.job.dispatch']);
            assert.deepStrictEqual(call.body.job, {
                id: job.id, class: 'function', artifact: { name: 'thumbnail', version: '1.2.0' }, args: { width: 320 },
                ttl_ms: 30_000 + 600_000, limits: { wall_ms: 30_000, cpu_ms: 30_000, mem_bytes: 268_435_456 }, net: 'none', inputs: [],
            });
            assert.ok(contracts.validate('platform.job@1', call.body.job).valid);
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'placed');
            assert.deepStrictEqual(read1.json.placement, { node: DEVICE, provider: null, region: 'eu-west' });
            assert.ok(read1.json.timings.placed_at);
            assert.strictEqual(read1.json.timings.started_at, null);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            assert.strictEqual((await t.outboxRows('run.job.queued', job.id)).length, 1);   // placed has no event of its own
            assert.strictEqual((await t.outboxRows('run.job.started', job.id)).length, 0);
            // It is sent once: the next polls only mirror what Bot answers.
            await t.dispatch.poll();
            await t.dispatch.poll();
            assert.strictEqual(bot.callsOf('POST', '/api/v1/jobs').length, sentBefore + 1, 'a placed job is never sent again');
        });

        await check('placed→running→succeeded mirrors with exactly one event each and Bot\'s meter', async () => {
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            bot.start(job.id, Date.now());
            const running = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(running.state, 'running');
            const started = await t.outboxRows('run.job.started', job.id);
            assert.strictEqual(started.length, 1);
            assert.strictEqual(started[0].outbox_key, `run:${job.id}:running`);
            assert.strictEqual(started[0].payload.state, 'running');
            assert.strictEqual(started[0].payload.placement.node, DEVICE);
            assert.strictEqual(started[0].payload.timings.finished_at, null);
            assert.ok(contracts.validate('run.job.started@1', started[0].payload).valid, JSON.stringify(started[0].payload));

            const result = { thumb: 'med_01JAB2C3D4E5F6G7H8J9K0MNPS' };
            bot.exit(job.id, { reason: 'exited', code: 0, wallMs: 2350, result });
            const ended = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(ended.state, 'succeeded');
            const read1 = await read(job.id, project);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            assert.strictEqual(read1.json.state, 'succeeded');
            assert.deepStrictEqual(read1.json.exit, { reason: 'exited', code: 0 });
            assert.deepStrictEqual(read1.json.result, result);
            assert.deepStrictEqual(read1.json.usage, { seconds: 2.35, wall_ms: 2350, cpu_ms: null, mem_peak_bytes: null });
            assert.strictEqual(read1.json.error, null);
            const ok = await t.outboxRows('run.job.succeeded', job.id);
            assert.strictEqual(ok.length, 1);
            assert.strictEqual(ok[0].outbox_key, `run:${job.id}:succeeded`);
            assert.strictEqual(ok[0].payload.result, undefined);                     // the payload never carries the result
            assert.ok(contracts.validate('run.job.succeeded@1', ok[0].payload).valid);
            // Later polls change nothing: an end state never changes and its event is one row.
            await t.dispatch.poll();
            await t.dispatch.poll();
            assert.strictEqual((await t.outboxRows('run.job.succeeded', job.id)).length, 1);
            assert.strictEqual((await read(job.id, project)).json.state, 'succeeded');
        });

        await check('a non-zero exit mirrors failed with run.job.exit_nonzero; a killed job with run.job.limit', async () => {
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            bot.start(job.id);
            await t.dispatch.poll();
            bot.exit(job.id, { reason: 'exited', code: 3, wallMs: 1200 });
            assert.strictEqual((await t.dispatch.poll()).find((a) => a.job_id === job.id).state, 'failed');
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'failed');
            assert.deepStrictEqual(read1.json.exit, { reason: 'exited', code: 3 });
            assert.strictEqual(read1.json.error.code, 'run.job.exit_nonzero');
            assert.strictEqual(read1.json.usage.wall_ms, 1200);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            const rows = await t.outboxRows('run.job.failed', job.id);
            assert.strictEqual(rows.length, 1);
            assert.ok(contracts.validate('run.job.failed@1', rows[0].payload).valid);
            assert.strictEqual(rows[0].payload.error.code, 'run.job.exit_nonzero');

            const limited = await submit({}, { project: PROJECT() });
            await t.dispatch.poll();
            bot.start(limited.id);
            await t.dispatch.poll();
            bot.exit(limited.id, { reason: 'limit', code: null, wallMs: 5000 });
            await t.dispatch.poll();
            const read2 = await read(limited.id, await t.db.value('SELECT project_id FROM run_jobs WHERE id = $1', [limited.id]));
            assert.strictEqual(read2.json.state, 'failed');
            assert.strictEqual(read2.json.error.code, 'run.job.limit');               // job_exit reason limit
            assert.deepStrictEqual(read2.json.exit, { reason: 'limit', code: null });
        });

        await check('the job\'s stdout reaches the SSE stream in order, with monotonic seq', async () => {
            const project = PROJECT();
            const job = await submit({}, { project });
            const s = await t.openStream(job.id, { project });
            const seed = await s.waitFor((e) => e.event === 'state');
            assert.strictEqual(seed.data.state, 'queued');
            await t.dispatch.poll();                                                 // placed
            const placed = await s.waitFor((e) => e.event === 'state' && e.data.state === 'placed');
            assert.ok(placed.data.seq > seed.data.seq);
            bot.start(job.id);
            bot.stdout(job.id, 'resized 1 of 1\n');
            await t.dispatch.poll();
            bot.stdout(job.id, 'done\n');
            await t.dispatch.poll();
            const out1 = await s.waitFor((e) => e.event === 'output' && e.data.chunk === 'resized 1 of 1\n');
            const out2 = await s.waitFor((e) => e.event === 'output' && e.data.chunk === 'done\n');
            assert.ok(contracts.validate('run.job-stream-event@1', out1.data).valid, JSON.stringify(out1.data));
            assert.strictEqual(out1.data.seq + 1, out2.data.seq);
            assert.strictEqual(out1.id, String(out1.data.seq));
            assert.strictEqual(out1.data.job_id, job.id);
            // Output is never streamed twice: a poll with no new chunk says nothing.
            const before = s.events.filter((e) => e.event === 'output').length;
            await t.dispatch.poll();
            await t.wait(50);
            assert.strictEqual(s.events.filter((e) => e.event === 'output').length, before);
            bot.exit(job.id, { reason: 'exited', code: 0, wallMs: 1000 });
            await t.dispatch.poll();
            const end = await s.waitFor((e) => e.event === 'end');
            assert.strictEqual(end.data.state, 'succeeded');
            assert.ok(end.data.seq > out2.data.seq);
            assert.strictEqual(await s.waitForClose(5000), true);
        });

        await check('a class the node does not advertise fails the job run.job.worker_failed', async () => {
            // The offer advertises worker:function (a stale report); the device Bot knows advertises code.
            t.setOffers([offer({ offer_id: 'off_stale' })]);
            bot.devices.set(DEVICE, { classes: ['code'] });
            const project = PROJECT();
            const job = await submit({}, { project });
            const answer = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(answer.state, 'failed');
            assert.strictEqual(answer.error, 'run.job.worker_failed');
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'failed');
            assert.strictEqual(read1.json.error.code, 'run.job.worker_failed');
            assert.match(read1.json.error.detail, /bot\.class_unadvertised/);
            assert.strictEqual(read1.json.usage.wall_ms, 0);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            const failed = await t.outboxRows('run.job.failed', job.id);
            assert.strictEqual(failed.length, 1);
            assert.ok(contracts.validate('run.job.failed@1', failed[0].payload).valid);
            bot.devices.set(DEVICE, { classes: ['function'] });
        });

        await check('no offer for worker:<class>: the job waits queued, and expires as run.job.unplaceable at its ttl', async () => {
            t.setOffers([]);
            const project = PROJECT();
            const sentBefore = bot.callsOf('POST', '/api/v1/jobs').length;
            const job = await submit({}, { project });
            const answer = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(answer.state, 'queued');                                    // waits for capacity
            assert.strictEqual(bot.callsOf('POST', '/api/v1/jobs').length, sentBefore);   // nothing reached Bot
            assert.strictEqual((await read(job.id, project)).json.state, 'queued');
            // Its ttl runs out with no offer: expired, run.job.unplaceable (ADR-036 section 2).
            await t.db.exec('UPDATE run_jobs SET created_at = created_at - 100000000 WHERE id = $1', [job.id]);
            assert.strictEqual((await t.dispatch.sweep()).find((a) => a.job_id === job.id).state, 'expired');
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'expired');
            assert.strictEqual(read1.json.error.code, 'run.job.unplaceable');
            assert.match(read1.json.error.detail, /worker:function/);
            assert.strictEqual(read1.json.placement, null);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            assert.ok(contracts.validate('run.job.expired@1', (await t.outboxRows('run.job.expired', job.id))[0].payload).valid);

            // An offer for another class is not a candidate either: the filter is this job's own class.
            t.setOffers([offer({ offer_id: 'off_code', capabilities: ['worker:code'] })]);
            bot.devices.set(DEVICE, { classes: ['function', 'code'] });
            const other = await submit({}, { project: PROJECT() });
            assert.strictEqual((await t.dispatch.poll()).find((a) => a.job_id === other.id).state, 'queued');
            await t.db.exec('UPDATE run_jobs SET created_at = created_at - 100000000 WHERE id = $1', [other.id]);
            await t.dispatch.sweep();                                                     // it waited; now it is out of the way

            // And the same class with an offer is placed, provider and region included.
            t.setOffers([offer({ offer_id: 'off_both', provider: 'ovh', capabilities: ['worker:function', 'worker:code'] })]);
            const ok = await submit({}, { project: PROJECT() });
            const placed = (await t.dispatch.poll()).find((a) => a.job_id === ok.id);
            assert.strictEqual(placed.state, 'placed');
            assert.strictEqual(placed.node_id, DEVICE);
            const row = await t.db.maybe('SELECT provider, region FROM run_jobs WHERE id = $1', [ok.id]);
            assert.deepStrictEqual({ provider: row.provider, region: row.region }, { provider: 'ovh', region: 'eu-west' });
            bot.devices.set(DEVICE, { classes: ['function'] });
        });

        await check('a user-owned node is eligible only when the job\'s requirements name it', async () => {
            bot.devices.set(OTHER_DEVICE, { classes: ['function'] });
            t.setOffers([offer({ offer_id: 'off_user', trust: 'user-owned', node_id: OTHER_DEVICE })]);
            const projectA = PROJECT();
            const plain = await submit({}, { project: projectA });
            const denied = (await t.dispatch.poll()).find((a) => a.job_id === plain.id);
            assert.strictEqual(denied.state, 'queued');                              // user-owned is never a default: no eligible node
            const readA = await read(plain.id, projectA);
            assert.strictEqual(readA.json.state, 'queued');
            assert.strictEqual(readA.json.placement, null);
            await t.db.exec('UPDATE run_jobs SET created_at = created_at - 100000000 WHERE id = $1', [plain.id]);
            await t.dispatch.sweep();
            const projectB = PROJECT();
            const named = await submit({ requirements: { kind: 'run.function', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['user-owned', 'first-party'] } }, { project: projectB });
            const placed = (await t.dispatch.poll()).find((a) => a.job_id === named.id);
            assert.strictEqual(placed.state, 'placed');
            assert.strictEqual(placed.node_id, OTHER_DEVICE);
            bot.devices.delete(OTHER_DEVICE);
        });

        await check('a job cancelled while its frame is in flight is not placed, and Bot is told to stop it', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const job = await submit({}, { project });
            // The cancel lands after Bot took the frame and before Run recorded the placement.
            bot.mode.onDispatch = async (doc) => {
                if (doc.job.id !== job.id) return;
                bot.mode.onDispatch = null;
                const asked = await t.call('POST', `/api/v1/jobs/${job.id}/cancel`, { cap: ['run.job.cancel'], project, sub: 'svc:builder' });
                assert.strictEqual(asked.status, 200, asked.text);
                assert.strictEqual(asked.json.state, 'cancelled');              // queued: cancelled at once, never sent anywhere
            };
            const answer = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            bot.mode.onDispatch = null;
            assert.strictEqual(answer.raced, true);
            assert.strictEqual(answer.stopped, true);
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'cancelled');                 // an end state never changes
            assert.strictEqual(read1.json.placement, null);
            assert.strictEqual(bot.jobs.get(job.id).cancel_requested, true);   // the frame Run had sent is cancelled
            assert.strictEqual((await t.outboxRows('run.job.cancelled', job.id)).length, 1);
            assert.strictEqual((await t.outboxRows('run.job.started', job.id)).length, 0);
        });

        await check('Bot losing a job it was sent: the job fails after a bounded number of polls', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            bot.forget(job.id);
            const first = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(first.bot_404, 1);
            assert.strictEqual((await read(job.id, project)).json.state, 'placed');   // not failed on the first miss
            const second = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(second.bot_404, 2);
            const third = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(third.state, 'failed');
            assert.strictEqual(third.error, 'run.job.worker_failed');
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'failed');
            assert.match(read1.json.error.detail, /Bot has no job/);
            assert.strictEqual((await t.outboxRows('run.job.failed', job.id)).length, 1);
            await t.dispatch.poll();
            assert.strictEqual((await read(job.id, project)).json.state, 'failed');   // never mirrored forever
            assert.strictEqual((await t.outboxRows('run.job.failed', job.id)).length, 1);
        });

        await check('cancel of a running job reaches Bot and settles cancelled when Bot confirms', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            bot.start(job.id);
            await t.dispatch.poll();
            assert.strictEqual((await read(job.id, project)).json.state, 'running');
            const cancelsBefore = bot.callsOf('POST', `/api/v1/jobs/${job.id}/cancel`).length;
            const asked = await t.call('POST', `/api/v1/jobs/${job.id}/cancel`, { cap: ['run.job.cancel'], project, sub: 'svc:builder' });
            assert.strictEqual(asked.status, 200, asked.text);
            // Run does not say cancelled for work a node may still be doing: Bot was asked, and its answer decides.
            assert.strictEqual(asked.json.state, 'running');
            assert.strictEqual(bot.callsOf('POST', `/api/v1/jobs/${job.id}/cancel`).length, cancelsBefore + 1);
            const answer = (await t.dispatch.poll()).find((a) => a.job_id === job.id);
            assert.strictEqual(answer.state, 'cancelled');
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'cancelled');
            assert.deepStrictEqual(read1.json.exit, { reason: 'cancelled', code: null });
            assert.strictEqual(read1.json.error, null);
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            const rows = await t.outboxRows('run.job.cancelled', job.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].outbox_key, `run:${job.id}:cancelled`);
            assert.ok(contracts.validate('run.job.cancelled@1', rows[0].payload).valid);
            await t.dispatch.poll();
            assert.strictEqual(bot.callsOf('POST', `/api/v1/jobs/${job.id}/cancel`).length, cancelsBefore + 1, 'one job_cancel per job');
        });

        await check('ttl_ms running out ends the job expired, and cancels on Bot when a node holds it', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const sentBefore = bot.callsOf('POST', '/api/v1/jobs').length;
            const job = await submit({ ttl_ms: 1000 }, { project });                 // the contract's floor for ttl_ms
            await t.db.exec('UPDATE run_jobs SET created_at = created_at - 1000000 WHERE id = $1', [job.id]);
            const swept = (await t.dispatch.sweep()).find((a) => a.job_id === job.id);
            assert.strictEqual(swept.state, 'expired');
            assert.strictEqual(swept.changed, true);
            assert.strictEqual(bot.callsOf('POST', '/api/v1/jobs').length, sentBefore);   // the sweep runs before placement
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.state, 'expired');
            assert.deepStrictEqual(read1.json.exit, { reason: 'ttl', code: null });
            assert.strictEqual(read1.json.error.code, 'run.job.ttl');
            assert.ok(contracts.validate('run.job-read-result@1', read1.json).valid, read1.text);
            const rows = await t.outboxRows('run.job.expired', job.id);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].outbox_key, `run:${job.id}:expired`);
            assert.ok(contracts.validate('run.job.expired@1', rows[0].payload).valid);

            // A job a node holds: expired, and Bot asked to stop it.
            const held = await submit({}, { project: PROJECT() });
            await t.dispatch.poll();
            bot.start(held.id);
            await t.dispatch.poll();
            const before = bot.callsOf('POST', `/api/v1/jobs/${held.id}/cancel`).length;
            await t.db.exec('UPDATE run_jobs SET created_at = created_at - 10000000 WHERE id = $1', [held.id]);
            const second = (await t.dispatch.sweep()).find((a) => a.job_id === held.id);
            assert.strictEqual(second.state, 'expired');
            assert.strictEqual(bot.callsOf('POST', `/api/v1/jobs/${held.id}/cancel`).length, before + 1);
            const read2 = await read(held.id, await t.db.value('SELECT project_id FROM run_jobs WHERE id = $1', [held.id]));
            assert.strictEqual(read2.json.state, 'expired');
            assert.strictEqual(read2.json.error.code, 'run.job.ttl');
            assert.strictEqual(read2.json.placement.node, DEVICE);                   // the placement it had is kept
        });

        await check('the Bot token is minted once and reused, never per call', async () => {
            assert.strictEqual(t.network.tokenRequests.n, 1, JSON.stringify(t.network.tokenRequests));
            assert.deepStrictEqual(t.network.tokenRequests.audiences, ['openvibe.bot']);
            assert.deepStrictEqual(t.network.tokenRequests.scopes, ['bot.job.dispatch']);
        });

        await check('the stream accepts a Bearer service token holding run.job.stream, and only that', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const job = await submit({}, { project });
            await t.dispatch.poll();
            const token = t.network.signService({ cap: ['run.job.stream'], project_id: project, sub: 'svc:watcher' });
            const s = await t.sse(`/api/v1/jobs/${job.id}/stream`, { headers: { Authorization: `Bearer ${token}` } });
            assert.strictEqual(s.status, 200, s.text);
            const state = await s.waitFor((e) => e.event === 'state');
            assert.strictEqual(state.data.job_id, job.id);
            bot.start(job.id);
            bot.stdout(job.id, 'from the token stream\n');
            await t.dispatch.poll();
            const out = await s.waitFor((e) => e.event === 'output');
            assert.strictEqual(out.data.chunk, 'from the token stream\n');
            s.close();

            const weak = t.network.signService({ cap: ['run.job.read'], project_id: project, sub: 'svc:watcher' });
            const denied = await t.sse(`/api/v1/jobs/${job.id}/stream`, { headers: { Authorization: `Bearer ${weak}` } });
            assert.strictEqual(denied.status, 403, denied.text);
            assert.strictEqual(denied.json.code, 'capability.denied');
            const stranger = t.network.signService({ cap: ['run.job.stream'], project_id: PROJECT(), sub: 'svc:watcher' });
            const hidden = await t.sse(`/api/v1/jobs/${job.id}/stream`, { headers: { Authorization: `Bearer ${stranger}` } });
            assert.strictEqual(hidden.status, 404, hidden.text);                     // another project's job: 404, never 403
            const noProject = t.network.signService({ cap: ['run.job.stream'], sub: 'svc:watcher' });
            const unowned = await t.sse(`/api/v1/jobs/${job.id}/stream`, { headers: { Authorization: `Bearer ${noProject}` } });
            assert.strictEqual(unowned.status, 403, unowned.text);
            assert.strictEqual(unowned.json.code, 'run.project_required');
            const anonymous = await t.sse(`/api/v1/jobs/${job.id}/stream`);
            assert.strictEqual(anonymous.status, 401, anonymous.text);
            assert.strictEqual(anonymous.json.code, 'ticket.required');
        });

        await check('the loop runs on its own between start() and stop()', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const job = await submit({}, { project });
            t.config.dispatch.pollMs = 50;                 // the loop's own interval (RUN_POLL_MS)
            t.dispatch.start();
            const deadline = Date.now() + 5000;
            let state = 'queued';
            while (Date.now() < deadline) {
                state = await t.db.value('SELECT state FROM run_jobs WHERE id = $1', [job.id]);
                if (state !== 'queued') break;
                await t.wait(25);
            }
            const ticks = t.dispatch.status().poller.ticks;
            t.dispatch.stop();
            assert.strictEqual(state, 'placed', `the poller placed the job by itself (saw ${state})`);
            assert.ok(ticks > 0, 'the loop ticked');
            assert.strictEqual(t.dispatch.status().poller.running, false);
        });

        await check('Bot never moves Run\'s own placement or project', async () => {
            t.setOffers([offer()]);
            const project = PROJECT();
            const job = await submit({}, { project });
            // Other checks may have left waiting jobs ahead of this one in the per-tick budget: poll until it is sent.
            for (let i = 0; i < 10 && !bot.jobs.get(job.id); i++) await t.dispatch.poll();
            const row = bot.jobs.get(job.id);
            assert.ok(row, `the job reached Bot (${JSON.stringify((await read(job.id, project)).json.state)})`);
            row.node_id = OTHER_DEVICE;                     // Bot claims another node
            await t.dispatch.poll();
            const read1 = await read(job.id, project);
            assert.strictEqual(read1.json.placement.node, DEVICE);
            row.node_id = DEVICE;
            row.project_id = PROJECT();                     // and another payer
            await t.dispatch.poll();
            const read2 = await read(job.id, project);
            assert.strictEqual(read2.json.project_id, project);
            assert.strictEqual(read2.json.state, 'placed');
            row.project_id = project;
        });

        await check('no secret and no job output is ever logged by the bridge', async () => {
            const secret = t.config.oauth.clientSecret;
            assert.ok(secret);
            assert.ok(!t.logs.some((l) => l.includes(secret)), t.logs.join('\n'));
            assert.ok(!t.logs.some((l) => /from the token stream|resized 1 of 1/.test(l)), t.logs.join('\n'));
        });
    } finally {
        t.dispatch.stop();
        await t.close();
        await bot.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
