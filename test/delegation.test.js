'use strict';
/**
 * Project delegation (ADR-003 amendment 2026-10-12): a first-party service acting for a person (X-OV-Subject)
 * names a project with X-OV-Project, and Run asks Network (the stub's members route, through Run's own client
 * credentials) whether the person is an admin or owner of it. The person is the requester, the service is via;
 * the service submits and reads only its own jobs for that person; everyone else naming a project is refused.
 *
 *   node test/delegation.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const { ids } = contracts;

async function checks(t) {
    const P = ids.newId('project');
    const Q = ids.newId('project');
    const ada = ids.newId('user');
    const bo = ids.newId('user');
    const dev = ids.newId('user');
    const viewer = ids.newId('user');
    const old = ids.newId('user');
    t.network.members.set(`${P} ${ada}`, { role: 'admin' });
    t.network.members.set(`${P} ${bo}`, { role: 'owner' });
    t.network.members.set(`${P} ${dev}`, { role: 'developer' });
    t.network.members.set(`${P} ${viewer}`, { role: 'viewer' });
    t.network.members.set(`${Q} ${old}`, { role: 'owner', archived: true });

    // A first-party service token (no project of its own) acting for `subject` in `project`.
    const as = (subject, project, { sub = 'svc:watch', cap = ['run.job.submit', 'run.job.read', 'run.job.list', 'run.job.cancel', 'run.job.stream'] } = {}) => ({
        token: t.network.signService({ sub, cap }),
        headers: { 'X-OV-Subject': subject, 'X-OV-Project': project },
    });
    const refused = (r, what) => {
        assert.strictEqual(r.status, 403, `${what}: ${r.text}`);
        assert.strictEqual(r.json.code, 'project.not_delegated', what);
    };

    let jobId;
    await check('an admin member: the job is the project\'s, the person is the requester, the service is via', async () => {
        const r = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(ada, P), key: 'watch.chk_1.0' });
        assert.strictEqual(r.status, 201, r.text);
        assert.ok(contracts.validate('run.job-create-result@1', r.json).valid, JSON.stringify(r.json));
        jobId = r.json.job.id;
        assert.strictEqual(r.json.job.project_id, P);
        assert.deepStrictEqual(r.json.job.requester, { type: 'user', id: ada });
        const [row] = await t.db.many('SELECT requester, via FROM run_jobs WHERE id = $1', [jobId]);
        assert.deepStrictEqual({ ...row }, { requester: `user:${ada}`, via: 'service:watch' });
        const queued = await t.outboxRows('run.job.queued', jobId);
        assert.strictEqual(queued.length, 1);
        assert.ok(contracts.validate('run.job.queued@1', queued[0].payload).valid);
        // Run asked Network as itself, for exactly the capability the read needs.
        assert.ok(t.network.tokenRequests.scopes.includes('network.project.member.read'));
        assert.ok(t.network.tokenRequests.audiences.includes('openvibe.network'));
        assert.match(String(t.network.memberState.lastAuth), /^Bearer /);
        // An owner is accepted too.
        const owner = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(bo, P) });
        assert.strictEqual(owner.status, 201, owner.text);
    });

    await check('the delegated caller reads its own job; another person, another service: the same 404', async () => {
        const mine = await t.call('GET', `/api/v1/jobs/${jobId}`, as(ada, P));
        assert.strictEqual(mine.status, 200, mine.text);
        assert.strictEqual(mine.json.id, jobId);
        const otherPerson = await t.call('GET', `/api/v1/jobs/${jobId}`, as(bo, P));
        const otherService = await t.call('GET', `/api/v1/jobs/${jobId}`, as(ada, P, { sub: 'svc:actor' }));
        const missing = await t.call('GET', `/api/v1/jobs/${ids.newId('job')}`, as(ada, P));
        for (const r of [otherPerson, otherService]) { assert.strictEqual(r.status, 404, r.text); assert.strictEqual(r.json.code, 'run.job_not_found'); }
        assert.strictEqual(otherPerson.text.replace(/"request_id":"[^"]*"|"trace_id":"[^"]*"/g, ''), missing.text.replace(/"request_id":"[^"]*"|"trace_id":"[^"]*"/g, ''), 'never says the job exists');
        // The project's own token still sees every job of the project.
        const project = await t.call('GET', `/api/v1/jobs/${jobId}`, { token: t.network.signService({ sub: `app:${ids.newId('app')}`, actor_type: 'app', env: 'production', cap: ['run.job.read'], project_id: P }) });
        assert.strictEqual(project.status, 200, project.text);
    });

    await check('list, cancel and stream stay with project tokens', async () => {
        refused(await t.call('GET', '/api/v1/jobs', as(ada, P)), 'list');
        refused(await t.call('POST', `/api/v1/jobs/${jobId}/cancel`, as(ada, P)), 'cancel');
        refused(await t.call('POST', `/api/v1/jobs/${jobId}/stream/ticket`, as(ada, P)), 'stream ticket');
        const d = as(ada, P);
        const stream = await t.sse(`/api/v1/jobs/${jobId}/stream`, { headers: { Authorization: `Bearer ${d.token}`, ...d.headers } });
        assert.strictEqual(stream.status, 403, stream.text);
        assert.strictEqual(stream.json.code, 'project.not_delegated');
        const [row] = await t.db.many('SELECT state FROM run_jobs WHERE id = $1', [jobId]);
        assert.strictEqual(row.state, 'queued', 'the refused cancel changed nothing');
    });

    await check('a developer, a viewer, a non-member and an archived project are refused alike', async () => {
        const stranger = ids.newId('user');
        for (const [subject, project, what] of [[dev, P, 'developer'], [viewer, P, 'viewer'], [stranger, P, 'non-member'], [old, Q, 'archived project'], [ada, ids.newId('project'), 'unknown project']]) {
            refused(await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(subject, project) }), what);
        }
        const made = await t.db.many('SELECT id FROM run_jobs WHERE project_id = $1 AND requester = $2', [P, `user:${dev}`]);
        assert.strictEqual(made.length, 0, 'no job was made for a refused delegation');
    });

    await check('only a first-party service naming a person may name a project', async () => {
        const body = t.request();
        // An app (a mod or an agent is refused by the same svc: test): its project is its token's own.
        refused(await t.call('POST', '/api/v1/jobs', { body, token: t.network.signService({ sub: `app:${ids.newId('app')}`, actor_type: 'app', env: 'production', cap: ['run.job.submit'], project_id: P }), headers: { 'X-OV-Subject': ada, 'X-OV-Project': P } }), 'an app token');
        // A service with no person to act for.
        refused(await t.call('POST', '/api/v1/jobs', { body, token: t.network.signService({ sub: 'svc:watch', cap: ['run.job.submit'] }), headers: { 'X-OV-Project': P } }), 'no X-OV-Subject');
        // A token that already names a project cannot name another.
        refused(await t.call('POST', '/api/v1/jobs', { body, token: t.network.signService({ sub: 'svc:watch', cap: ['run.job.submit'], project_id: Q }), headers: { 'X-OV-Subject': ada, 'X-OV-Project': P } }), 'a token with project_id');
        // Malformed headers.
        refused(await t.call('POST', '/api/v1/jobs', { body, ...as(ada, 'prj_nope') }), 'a malformed project');
        refused(await t.call('POST', '/api/v1/jobs', { body, ...as('usr_nope', P) }), 'a malformed subject');
        // A person's own token.
        refused(await t.call('POST', '/api/v1/jobs', { body, token: t.network.signUser({ subject: ada }), headers: { 'X-OV-Project': P } }), 'a user token');
        // The service still needs its own grant: delegation adds no capability.
        const noGrant = await t.call('POST', '/api/v1/jobs', { body, ...as(ada, P, { cap: ['run.job.read'] }) });
        assert.strictEqual(noGrant.status, 403, noGrant.text);
        assert.strictEqual(noGrant.json.code, 'capability.denied');
    });

    await check('a yes is cached at most 60 s; a removed member is refused after it', async () => {
        const before = t.network.memberState.reads;
        assert.strictEqual((await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(bo, P) })).status, 201);
        assert.strictEqual(t.network.memberState.reads, before, 'served from the cache (bo was confirmed by an earlier check)');
        t.network.members.delete(`${P} ${bo}`);
        assert.strictEqual((await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(bo, P) })).status, 201, 'within the minute');
        t.clock.offset += 61_000;
        try {
            refused(await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(bo, P) }), 'after the minute');
            assert.ok(t.network.memberState.reads > before, 'asked Network again');
        } finally { t.clock.offset -= 61_000; }
    });

    await check('Network unavailable: 503 project.check_unavailable, never a guess', async () => {
        t.clock.offset += 61_000;   // past every cached yes
        t.network.memberState.fail = true;
        try {
            const r = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(ada, P) });
            assert.strictEqual(r.status, 503, r.text);
            assert.strictEqual(r.json.code, 'project.check_unavailable');
        } finally { t.network.memberState.fail = false; t.clock.offset -= 61_000; }
    });

    await check('a delegated repeat answers its own first job; a key someone else spent is 409 without naming it', async () => {
        const again = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(ada, P), key: 'watch.chk_1.0' });
        assert.strictEqual(again.status, 200, again.text);
        assert.strictEqual(again.json.created, false);
        assert.strictEqual(again.json.job.id, jobId);
        const theirs = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(ada, P, { sub: 'svc:actor' }), key: 'watch.chk_1.0' });
        assert.strictEqual(theirs.status, 409, theirs.text);
        assert.strictEqual(theirs.json.code, 'run.idempotency.conflict');
        assert.ok(!theirs.text.includes(jobId), 'the conflict does not name the job');
        // The project's own token reusing a delegated key is refused the same way (the key is spent).
        const project = await t.call('POST', '/api/v1/jobs', { body: t.request(), cap: ['run.job.submit'], project: P, sub: 'svc:builder', key: 'watch.chk_1.0' });
        assert.strictEqual(project.status, 409, project.text);
    });
}

async function main() {
    // Run's own client secret is set: the membership read goes through the real client-credentials path.
    const t = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'run-test-secret' } });
    try {
        await checks(t);
    } finally {
        await t.close();
    }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
