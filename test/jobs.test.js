'use strict';
/**
 * The Run job API (plan T14 step 5, R1b) against the released contracts: one capability per route, the
 * project and the requester from the token, idempotent submit, project-scoped 404s, keyset paging,
 * cancel, the run.job.* events in the submitting transaction, the stream ticket and the SSE stream.
 *
 *   node test/jobs.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const PROBLEM = /application\/problem\+json/;
const decodeClaims = (token) => JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
/** An outbox row as the published envelope (the helper attaches the row's own key beside it). */
const envelopeOf = (row) => { const { outbox_key, ...envelope } = row; return envelope; };

async function checks(t) {
    const projectA = contracts.ids.newId('project');
    const projectB = contracts.ids.newId('project');
    const cap = (list, project, sub) => ({ cap: list, project, sub });

    await check('a valid run.job-create-request@1 → 201 created, queued, run.job.queued in the outbox', async () => {
        const r = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.created, true);
        assert.ok(contracts.validate('run.job-create-result@1', r.json).valid, JSON.stringify(r.json));
        const job = r.json.job;
        assert.match(job.id, /^job_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(job.state, 'queued');
        assert.strictEqual(job.project_id, projectA);
        assert.deepStrictEqual(job.requester, { type: 'service', id: 'builder' });
        assert.strictEqual(job.ttl_ms, 30_000 + 600_000);                           // limits.wall_ms + 600000
        assert.strictEqual(job.egress, 'none');
        assert.deepStrictEqual(job.requirements, { kind: 'run.function', mobility: 'job', latency_class: 'background', objective: 'balanced' });
        assert.strictEqual(job.placement, null);
        assert.match(job.idempotency_key, /^auto:[0-9a-z]+$/);                      // no key given: Run's own
        const queued = await t.outboxRows('run.job.queued', job.id);
        assert.strictEqual(queued.length, 1);
        // The outbox row's key is Run's own (the dossier's run:<job id>:<state>); the published envelope
        // carries a contract-valid evt_ document id (events.event-envelope@1 pins the pattern).
        assert.strictEqual(queued[0].outbox_key, `run:${job.id}:queued`);
        assert.match(queued[0].event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.deepStrictEqual(queued[0].subject, { type: 'job', id: job.id });
        assert.deepStrictEqual(queued[0].actor, { type: 'service', id: 'run' });
        assert.strictEqual(queued[0].visibility, 'internal');
        assert.ok(contracts.validate('run.job.queued@1', queued[0].payload).valid);
        assert.ok(contracts.validate('events.event-envelope@1', envelopeOf(queued[0])).valid);
    });

    await check('the same Idempotency-Key answers the first job (200, created false) with one row', async () => {
        const body = t.request();
        const first = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'thumb:photo-7' });
        assert.strictEqual(first.status, 201, first.text);
        const again = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'thumb:photo-7' });
        assert.strictEqual(again.status, 200, again.text);
        assert.strictEqual(again.json.created, false);
        assert.strictEqual(again.json.job.id, first.json.job.id);
        const rows = await t.db.many('SELECT * FROM run_jobs WHERE project_id = $1 AND idempotency_key = $2', [projectA, 'thumb:photo-7']);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, first.json.job.id);
        assert.strictEqual((await t.outboxRows('run.job.queued', first.json.job.id)).length, 1);   // never a second queued event
    });

    await check('body.idempotency_key works too, and the header disagreeing with it is 422', async () => {
        const body = { ...t.request(), idempotency_key: 'run:one' };
        const first = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'run:one' });
        assert.strictEqual(first.status, 201, first.text);
        assert.strictEqual(first.json.job.idempotency_key, 'run:one');
        const again = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'run:one' });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json.job.id, first.json.job.id);
        const clash = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'run:two' });
        assert.strictEqual(clash.status, 422, clash.text);
        assert.strictEqual(clash.json.code, 'run.invalid_input');
    });

    await check('the same key with a different body is 409 run.idempotency.conflict', async () => {
        await t.call('POST', '/api/v1/jobs', { body: t.request({ args: { width: 64 } }), ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'conflict:1' });
        const r = await t.call('POST', '/api/v1/jobs', { body: t.request({ args: { width: 128 } }), ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'conflict:1' });
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(r.json.code, 'run.idempotency.conflict');
        assert.match(r.headers.get('content-type') || '', PROBLEM);
    });

    await check('the idempotency key is scoped per project: another project may reuse it', async () => {
        const body = t.request();
        const mine = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder'), key: 'shared:key' });
        const theirs = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectB, 'svc:other'), key: 'shared:key' });
        assert.strictEqual(mine.status, 201, mine.text);
        assert.strictEqual(theirs.status, 201, theirs.text);
        assert.notStrictEqual(mine.json.job.id, theirs.json.job.id);
        assert.strictEqual(theirs.json.job.project_id, projectB);
    });

    await check('a second project never sees the row: 404, never 403', async () => {
        const job = t.request();
        const mine = await t.call('POST', '/api/v1/jobs', { body: job, ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const theirs = await t.call('GET', `/api/v1/jobs/${mine.json.job.id}`, cap(['run.job.read'], projectB, 'svc:other'));
        assert.strictEqual(theirs.status, 404, theirs.text);
        assert.strictEqual(theirs.json.code, 'run.job_not_found');
        const cancelTheirs = await t.call('POST', `/api/v1/jobs/${mine.json.job.id}/cancel`, cap(['run.job.cancel'], projectB, 'svc:other'));
        assert.strictEqual(cancelTheirs.status, 404);
        const ticketTheirs = await t.call('POST', `/api/v1/jobs/${mine.json.job.id}/stream/ticket`, cap(['run.job.stream'], projectB, 'svc:other'));
        assert.strictEqual(ticketTheirs.status, 404);
        const mineRead = await t.call('GET', `/api/v1/jobs/${mine.json.job.id}`, cap(['run.job.read'], projectA, 'svc:builder'));
        assert.strictEqual(mineRead.status, 200, mineRead.text);
        assert.ok(contracts.validate('run.job-read-result@1', mineRead.json).valid);
    });

    await check('the project and the requester come from the token, never the body', async () => {
        const body = { ...t.request(), project_id: projectB, requester: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' };
        const r = await t.call('POST', '/api/v1/jobs', { body, ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(r.status, 400, r.text);                                  // additionalProperties: false
        assert.strictEqual(r.json.code, 'run.invalid_request');
        assert.match(r.headers.get('content-type') || '', PROBLEM);
        const other = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectB, 'svc:builder') });
        assert.strictEqual(other.json.job.project_id, projectB);
        assert.deepStrictEqual(other.json.job.requester, { type: 'service', id: 'builder' });
    });

    await check('a body that fails run.job-create-request@1 is 400 problem+json with the contract errors', async () => {
        const r = await t.call('POST', '/api/v1/jobs', { body: { class: 'function' }, ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(r.status, 400, r.text);
        assert.match(r.headers.get('content-type') || '', PROBLEM);
        assert.strictEqual(r.json.code, 'run.invalid_request');
        assert.ok(Array.isArray(r.json.errors) && r.json.errors.length, JSON.stringify(r.json));
        const bad = await t.call('POST', '/api/v1/jobs', { body: t.request({ egress: 'everywhere' }), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(bad.status, 400);
        const unbalanced = await t.call('POST', '/api/v1/jobs', { body: t.request({ inputs: [{ name: 'a.txt', media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPS', sha256: 'a'.repeat(64) }, { name: 'a.txt', media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPS', sha256: 'b'.repeat(64) }] }), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(unbalanced.status, 422, unbalanced.text);                // duplicate input name
        assert.strictEqual(unbalanced.json.code, 'run.invalid_input');
    });

    await check('limits are bounded by the project caps, never silently lowered', async () => {
        const over = await t.call('POST', '/api/v1/jobs', { body: t.request({ limits: { wall_ms: 10_000_000, cpu_ms: 30_000, mem_bytes: 1 } }), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(over.status, 422, over.text);
        assert.strictEqual(over.json.code, 'run.limits.exceeded');
        const mem = await t.call('POST', '/api/v1/jobs', { body: t.request({ limits: { wall_ms: 1000, cpu_ms: 1000, mem_bytes: 8 * 1024 ** 3 } }), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(mem.status, 422);
        // The default lifetime (limits.wall_ms + 600000) is capped too: a project whose cap is lower refuses
        // the request rather than storing a job that outlives it.
        const kept = t.config.limits.maxTtlMs;
        t.config.limits.maxTtlMs = 600_000;
        try {
            const byDefault = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
            assert.strictEqual(byDefault.status, 422, byDefault.text);
            assert.strictEqual(byDefault.json.code, 'run.limits.exceeded');
            assert.match(byDefault.json.detail, /limits\.wall_ms \+ 600000/);
        } finally { t.config.limits.maxTtlMs = kept; }
        const args = await t.call('POST', '/api/v1/jobs', { body: t.request({ args: { blob: 'x'.repeat(520 * 1024) } }), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(args.status, 413, args.text);
        assert.strictEqual(args.json.code, 'run.args_too_large');
        const ttl = await t.call('POST', '/api/v1/jobs', { body: t.request({ ttl_ms: 86_400_000 * 2 }), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        assert.strictEqual(ttl.status, 400);                                        // the contract's own ceiling
    });

    await check('a token without the route capability is 403, a missing token 401, a user token 403', async () => {
        const wrong = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.list'], projectA, 'svc:builder') });
        assert.strictEqual(wrong.status, 403, wrong.text);
        assert.strictEqual(wrong.json.code, 'capability.denied');
        const listWithRead = await t.call('GET', '/api/v1/jobs', cap(['run.job.read'], projectA, 'svc:builder'));
        assert.strictEqual(listWithRead.status, 403);
        const anonymous = await t.call('GET', '/api/v1/jobs', { token: null });
        assert.strictEqual(anonymous.status, 401, anonymous.text);
        assert.strictEqual(anonymous.json.code, 'token.required');
        const user = await t.call('GET', '/api/v1/jobs', { token: t.network.signUser({}) });
        assert.strictEqual(user.status, 403, user.text);
        assert.strictEqual(user.json.code, 'capability.denied');
        const sandbox = await t.call('GET', '/api/v1/jobs', { token: t.network.signService({ cap: ['run.*'], project_id: projectA, actor_type: 'app', sub: `app:${contracts.ids.newId('app')}`, env: 'sandbox' }) });
        assert.strictEqual(sandbox.status, 401, sandbox.text);
        assert.strictEqual(sandbox.json.code, 'token.sandbox_refused');
    });

    await check('a service token with no project_id is refused 403 run.project_required', async () => {
        const r = await t.call('POST', '/api/v1/jobs', { body: t.request(), cap: ['run.job.submit'], sub: 'svc:run' });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'run.project_required');
    });

    await check('list is newest first with a keyset cursor, null on the last page', async () => {
        const project = contracts.ids.newId('project');
        const made = [];
        for (let i = 0; i < 3; i++) {
            const r = await t.call('POST', '/api/v1/jobs', { body: t.request({ args: { i } }), ...cap(['run.job.submit'], project, 'svc:builder') });
            assert.strictEqual(r.status, 201, r.text);
            made.push(r.json.job.id);
        }
        const page1 = await t.call('GET', '/api/v1/jobs?limit=2', cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(page1.status, 200, page1.text);
        assert.ok(contracts.validate('run.job-list-result@1', page1.json).valid, page1.text);
        assert.strictEqual(page1.json.jobs.length, 2);
        assert.ok(page1.json.next_cursor);
        const page2 = await t.call('GET', `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`, cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(page2.json.jobs.length, 1);
        assert.strictEqual(page2.json.next_cursor, null);
        const seen = [...page1.json.jobs, ...page2.json.jobs].map((j) => j.id);
        assert.deepStrictEqual(seen.slice().sort(), made.slice().sort());
        assert.strictEqual(new Set(seen).size, 3);
        const filtered = await t.call('GET', '/api/v1/jobs?state=queued', cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(filtered.json.jobs.length, 3);
        const none = await t.call('GET', '/api/v1/jobs?state=cancelled', cap(['run.job.list'], project, 'svc:builder'));
        assert.deepStrictEqual(none.json.jobs, []);
        assert.strictEqual(none.json.next_cursor, null);
        const bad = await t.call('GET', '/api/v1/jobs?state=gone', cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(bad.status, 400, bad.text);
        const badLimit = await t.call('GET', '/api/v1/jobs?limit=500', cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(badLimit.status, 400);
        const otherProject = await t.call('GET', '/api/v1/jobs', cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(otherProject.json.jobs.length, 3);                       // only this project's
        const snoop = await t.call('GET', `/api/v1/jobs?project_id=${projectB}`, cap(['run.job.list'], project, 'svc:builder'));
        assert.strictEqual(snoop.status, 403, snoop.text);                          // project_id is run.job.admin only
        assert.strictEqual(snoop.json.code, 'capability.denied');
    });

    await check('cancel of a queued job → cancelled + run.job.cancelled, and a repeat is one event', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        const first = await t.call('POST', `/api/v1/jobs/${id}/cancel`, cap(['run.job.cancel'], projectA, 'svc:builder'));
        assert.strictEqual(first.status, 200, first.text);
        assert.ok(contracts.validate('run.job-read-result@1', first.json).valid, first.text);
        assert.strictEqual(first.json.state, 'cancelled');
        assert.strictEqual(first.json.finished_at, undefined);
        assert.ok(first.json.timings.finished_at);
        assert.strictEqual(first.json.exit, null);                                  // never placed, never ran
        assert.strictEqual(first.json.placement, null);
        assert.deepStrictEqual(first.json.usage, { seconds: 0, wall_ms: 0, cpu_ms: null, mem_peak_bytes: null });
        assert.strictEqual(first.json.error, null);
        const events = await t.outboxRows('run.job.cancelled', id);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].outbox_key, `run:${id}:cancelled`);
        assert.ok(contracts.validate('run.job.cancelled@1', events[0].payload).valid);
        const again = await t.call('POST', `/api/v1/jobs/${id}/cancel`, cap(['run.job.cancel'], projectA, 'svc:builder'));
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json.state, 'cancelled');
        assert.strictEqual((await t.outboxRows('run.job.cancelled', id)).length, 1);   // a replay is one row
        const unknown = await t.call('POST', `/api/v1/jobs/job_01JAB2C3D4E5F6G7H8J9K0MNPQ/cancel`, cap(['run.job.cancel'], projectA, 'svc:builder'));
        assert.strictEqual(unknown.status, 404);
        const notAnId = await t.call('POST', '/api/v1/jobs/nope/cancel', cap(['run.job.cancel'], projectA, 'svc:builder'));
        assert.strictEqual(notAnId.status, 404);
    });

    await check('the stream ticket is a two-minute run-stream JWS for this one job', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        const r = await t.call('POST', `/api/v1/jobs/${id}/stream/ticket`, cap(['run.job.stream'], projectA, 'svc:builder'));
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(contracts.validate('run.job-stream-ticket-result@1', r.json).valid, r.text);
        assert.strictEqual(r.json.expires_in, 120);
        assert.strictEqual(r.json.job_id, id);
        assert.match(r.json.stream_url, new RegExp(`/api/v1/jobs/${id}/stream$`));
        const claims = decodeClaims(r.json.ticket);
        assert.strictEqual(claims.exp - claims.iat, 120);
        assert.strictEqual(claims.aud, 'openvibe.run');
        assert.strictEqual(claims.typ, 'run-stream');
        assert.strictEqual(claims.sub, id);
        assert.strictEqual(claims.project, projectA);
        assert.match(claims.jti, /^rsk_[0-9a-f]{24}$/);
        assert.strictEqual(new Date(r.json.expires_at).getTime(), claims.exp * 1000);
        const other = await t.call('POST', '/api/v1/jobs/job_01JAB2C3D4E5F6G7H8J9K0MNPQ/stream/ticket', cap(['run.job.stream'], projectA, 'svc:builder'));
        assert.strictEqual(other.status, 404);
    });

    await check('GET /jobs/:id/stream without a valid, unexpired ticket for that job is refused', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        const none = await t.sse(`/api/v1/jobs/${id}/stream`);
        assert.strictEqual(none.status, 401, JSON.stringify(none));
        assert.strictEqual(none.json.code, 'ticket.required');
        const junk = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: 'not.a.ticket' });
        assert.strictEqual(junk.status, 401);
        assert.strictEqual(junk.json.code, 'ticket.invalid');
        // A service token is not a ticket, even a valid one that holds run.job.stream.
        const token = t.network.signService({ cap: ['run.job.stream'], project_id: projectA, sub: 'svc:builder' });
        const asToken = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: token });
        assert.strictEqual(asToken.status, 401, asToken.text);
        assert.strictEqual(asToken.json.code, 'ticket.invalid');
        // Another job's ticket is refused for this job.
        const otherJob = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const otherTicket = await t.call('POST', `/api/v1/jobs/${otherJob.json.job.id}/stream/ticket`, cap(['run.job.stream'], projectA, 'svc:builder'));
        const mismatched = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: otherTicket.json.ticket });
        assert.strictEqual(mismatched.status, 403, mismatched.text);
        assert.strictEqual(mismatched.json.code, 'run.stream.ticket_mismatch');
        // An expired ticket is refused (the ticket lives 120 s).
        const fresh = await t.call('POST', `/api/v1/jobs/${id}/stream/ticket`, cap(['run.job.stream'], projectA, 'svc:builder'));
        t.clock.offset = 121_000;
        try {
            const expired = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: fresh.json.ticket });
            assert.strictEqual(expired.status, 401, expired.text);
            assert.strictEqual(expired.json.code, 'ticket.expired');
        } finally { t.clock.offset = 0; }
        // A ticket opens exactly one stream: the second use finds the jti consumed.
        const used = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: fresh.json.ticket });
        assert.strictEqual(used.status, 200, used.text);
        used.close();
        const replayed = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: fresh.json.ticket });
        assert.strictEqual(replayed.status, 401, replayed.text);
        assert.strictEqual(replayed.json.code, 'ticket.used');
    });

    await check('a streamed output event matches run.job-stream-event@1 with a monotonic seq', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        const s = await t.openStream(id, { project: projectA });
        assert.strictEqual(s.status, 200, s.text);
        const state = await s.waitFor((e) => e.event === 'state');
        assert.strictEqual(state.data.state, 'queued');
        assert.strictEqual(state.data.job_id, id);
        assert.strictEqual(state.id, String(state.data.seq));
        assert.ok(contracts.validate('run.job-stream-event@1', state.data).valid, JSON.stringify(state.data));
        // The dispatcher bridge feeds the job's stdout (plan T14 step 6); the stream just carries it.
        t.stream.output(id, 'resized 1 of 1\n');
        t.stream.output(id, 'done\n');
        const out1 = await s.waitFor((e) => e.event === 'output' && e.data.chunk === 'resized 1 of 1\n');
        const out2 = await s.waitFor((e) => e.event === 'output' && e.data.chunk === 'done\n');
        assert.ok(contracts.validate('run.job-stream-event@1', out1.data).valid, JSON.stringify(out1.data));
        assert.strictEqual(out1.data.seq + 1, out2.data.seq);
        assert.strictEqual(out1.id, String(out1.data.seq));
        await t.call('POST', `/api/v1/jobs/${id}/cancel`, cap(['run.job.cancel'], projectA, 'svc:builder'));
        const end = await s.waitFor((e) => e.event === 'end');
        assert.strictEqual(end.data.state, 'cancelled');
        assert.ok(contracts.validate('run.job-stream-event@1', end.data).valid, JSON.stringify(end.data));
        assert.ok(end.data.seq > out2.data.seq);
        assert.strictEqual(await s.waitForClose(5000), true);
    });

    await check('a reconnect replays what is kept and resumes after Last-Event-ID', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        const first = await t.openStream(id, { project: projectA });
        const seen = await first.waitFor((e) => e.event === 'state');
        t.stream.output(id, 'first chunk\n');
        const chunk = await first.waitFor((e) => e.event === 'output');
        first.close();
        const second = await t.openStream(id, { project: projectA, headers: { 'Last-Event-ID': String(chunk.data.seq) } });
        assert.strictEqual(second.status, 200, second.text);
        await t.wait(100);
        assert.deepStrictEqual(second.events.filter((e) => e.data && e.data.seq <= chunk.data.seq), [], 'nothing already seen is replayed');
        t.stream.output(id, 'after the reconnect\n');
        const next = await second.waitFor((e) => e.event === 'output');
        assert.strictEqual(next.data.chunk, 'after the reconnect\n');
        assert.ok(next.data.seq > chunk.data.seq);
        await t.call('POST', `/api/v1/jobs/${id}/cancel`, cap(['run.job.cancel'], projectA, 'svc:builder'));
        const end = await second.waitFor((e) => e.event === 'end');
        assert.ok(end.data.seq > next.data.seq);
        assert.strictEqual(await second.waitForClose(5000), true);
    });

    await check('a stream opened on an ended job replays what is kept and closes', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        await t.call('POST', `/api/v1/jobs/${id}/cancel`, cap(['run.job.cancel'], projectA, 'svc:builder'));
        // The reconnect a browser makes after a drop, with the id it last saw: everything kept is replayed
        // and the server ends the response after `end` (a ring that ended and lost its subscriber must not
        // leave the next caller with an empty, never-closing stream).
        const opened = await t.openStream(id, { project: projectA });
        assert.strictEqual(opened.status, 200, opened.text);
        const end = await opened.waitFor((e) => e.event === 'end');
        assert.strictEqual(end.data.state, 'cancelled');
        assert.strictEqual(await opened.waitForClose(5000), true);
        const resumed = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: (await t.call('POST', `/api/v1/jobs/${id}/stream/ticket`, cap(['run.job.stream'], projectA, 'svc:builder'))).json.ticket, headers: { 'Last-Event-ID': String(end.data.seq) } });
        assert.strictEqual(resumed.status, 200, resumed.text);
        assert.deepStrictEqual(resumed.events.filter((e) => e.data && e.data.seq > end.data.seq), []);
        assert.strictEqual(await resumed.waitForClose(5000), true);
        // A resume that missed the end still gets it, with the state it missed.
        const behind = await t.sse(`/api/v1/jobs/${id}/stream`, { ticket: (await t.call('POST', `/api/v1/jobs/${id}/stream/ticket`, cap(['run.job.stream'], projectA, 'svc:builder'))).json.ticket, headers: { 'Last-Event-ID': '1' } });
        const late = await behind.waitFor((e) => e.event === 'end');
        assert.strictEqual(late.data.state, 'cancelled');
        assert.strictEqual(await behind.waitForClose(5000), true);
    });

    await check('run.job.admin reads another project\'s job and lists every project', async () => {
        const mine = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const admin = cap(['run.job.read', 'run.job.admin']);
        const read = await t.call('GET', `/api/v1/jobs/${mine.json.job.id}`, admin);
        assert.strictEqual(read.status, 200, read.text);
        assert.strictEqual(read.json.project_id, projectA);
        const listed = await t.call('GET', `/api/v1/admin/jobs?project_id=${projectA}`, cap(['run.job.admin']));
        assert.strictEqual(listed.status, 200, listed.text);
        assert.ok(contracts.validate('run.job-list-result@1', listed.json).valid);
        assert.ok(listed.json.jobs.every((j) => j.project_id === projectA));
        const all = await t.call('GET', '/api/v1/admin/jobs?limit=200', cap(['run.job.admin']));
        assert.ok(all.json.jobs.length >= listed.json.jobs.length);
        const notAdmin = await t.call('GET', '/api/v1/admin/jobs', cap(['run.job.list'], projectA, 'svc:builder'));
        assert.strictEqual(notAdmin.status, 403, notAdmin.text);
        assert.strictEqual(notAdmin.json.code, 'capability.denied');
        // run.job.admin is internal: the manifest says it is never a delegated app or mod token, so an app
        // principal holding the grant is refused here too.
        const appToken = t.network.signService({ sub: `app:${contracts.ids.newId('app')}`, actor_type: 'app', env: 'production', cap: ['run.job.admin'], project_id: projectA });
        const viaApp = await t.call('GET', '/api/v1/admin/jobs', { token: appToken });
        assert.strictEqual(viaApp.status, 403, viaApp.text);
        assert.strictEqual(viaApp.json.code, 'capability.denied');
        assert.match(viaApp.json.detail, /internal/);
        // and an admin cancel reaches another project's job
        const cancelled = await t.call('POST', `/api/v1/jobs/${mine.json.job.id}/cancel`, cap(['run.job.cancel', 'run.job.admin']));
        assert.strictEqual(cancelled.status, 200, cancelled.text);
        assert.strictEqual(cancelled.json.state, 'cancelled');
    });

    await check('a running job (mirrored from Bot) is settled with its event and its error code', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const id = made.json.job.id;
        // What the dispatcher bridge does in plan T14 step 6: mirror Bot's answer, then settle the end state.
        const store = require('../server/jobs/store');
        const at = Date.now();
        const running = await store.mirror(t.db, id, { state: 'running', node_id: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2X', provider: null, region: 'eu-west', started_ms: at, exit_reason: null, exit_code: null, result: null, wall_ms: 0, usage_read: 0 }, at);
        assert.strictEqual(running.state, 'running');
        const read = await t.call('GET', `/api/v1/jobs/${id}`, cap(['run.job.read'], projectA, 'svc:builder'));
        assert.strictEqual(read.status, 200, read.text);
        assert.ok(contracts.validate('run.job-read-result@1', read.json).valid, read.text);
        assert.deepStrictEqual(read.json.placement, { node: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2X', provider: null, region: 'eu-west' });
        assert.ok(read.json.timings.placed_at && read.json.timings.started_at);
        // run.job.started carries state `running`: the event's payload contract is run.job.started@1, not a
        // run.job.running@1 (which does not exist) — the emitter and the row key follow that.
        const started = await t.db.tx((tx) => t.runEvents.started(tx, running));
        const startedRow = (await t.outboxRows('run.job.started', id))[0];
        assert.strictEqual(started.enqueued, true);
        assert.strictEqual(startedRow.outbox_key, `run:${id}:running`);
        assert.strictEqual(startedRow.event_type, 'run.job.started');
        assert.strictEqual(startedRow.payload.state, 'running');
        assert.ok(contracts.validate('run.job.started@1', startedRow.payload).valid, JSON.stringify(startedRow.payload));
        const settled = await t.db.tx((tx) => store.settle(tx, id, { state: 'failed', exit: 'limit', code: null, wallMs: 2350, errorDetail: 'mem_bytes exceeded', at: at + 2350 }));
        assert.strictEqual(settled.changed, true);
        const after = await t.call('GET', `/api/v1/jobs/${id}`, cap(['run.job.read'], projectA, 'svc:builder'));
        assert.strictEqual(after.json.state, 'failed');
        assert.deepStrictEqual(after.json.exit, { reason: 'limit', code: null });
        assert.deepStrictEqual(after.json.error, { code: 'run.job.limit', detail: 'mem_bytes exceeded' });
        assert.strictEqual(after.json.usage.wall_ms, 2350);
        assert.strictEqual(after.json.usage.seconds, 2.35);
        const again = await t.db.tx((tx) => store.settle(tx, id, { state: 'failed', exit: 'limit', at: at + 3000 }));
        assert.strictEqual(again.changed, false);                                   // an end state never changes
        assert.strictEqual(after.json.result, null);
        // The failed event is the run.job-read-result@1 projection, keyed run:<id>:failed, and a replay of
        // the same state is the row that is already there.
        const first = await t.db.tx((tx) => t.runEvents.failed(tx, settled.row));
        const row = (await t.outboxRows('run.job.failed', id))[0];
        assert.strictEqual(row.outbox_key, `run:${id}:failed`);
        assert.strictEqual(row.payload.state, 'failed');
        assert.deepStrictEqual(row.payload.error, { code: 'run.job.limit', detail: 'mem_bytes exceeded' });
        assert.ok(contracts.validate('run.job.failed@1', row.payload).valid);
        assert.strictEqual(first.enqueued, true);
        assert.strictEqual((await t.db.tx((tx) => t.runEvents.failed(tx, settled.row))).enqueued, false);
        assert.strictEqual((await t.outboxRows('run.job.failed', id)).length, 1);
        // An error code on a state whose contract requires `error: null` is never stored: a row this service
        // could not render must not be reachable.
        const other = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...cap(['run.job.submit'], projectA, 'svc:builder') });
        const odd = await t.db.tx((tx) => store.settle(tx, other.json.job.id, { state: 'cancelled', exit: 'cancelled', code: null, errorCode: 'run.job.stopped', errorDetail: 'nope', at: at + 10 }));
        assert.strictEqual(odd.changed, true);
        assert.strictEqual(odd.row.error_code, null);
        assert.strictEqual(odd.row.error_detail, null);
        const readable = await t.call('GET', `/api/v1/jobs/${other.json.job.id}`, cap(['run.job.read'], projectA, 'svc:builder'));
        assert.strictEqual(readable.status, 200, readable.text);
        assert.strictEqual(readable.json.error, null);
    });
}

async function main() {
    const t = await boot();
    try {
        await checks(t);
        await check('no secret and no job output is ever logged', async () => {
            const secretish = 'Bearer-not-a-token-should-never-be-logged';
            await t.call('POST', '/api/v1/jobs', { body: t.request(), token: secretish });
            assert.ok(!t.logs.some((l) => l.includes(secretish)), t.logs.join('\n'));
            assert.ok(!t.logs.some((l) => /resized 1 of 1/.test(l)), t.logs.join('\n'));
        });
    } finally {
        await t.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
