'use strict';
/**
 * Run sessions (contracts 0.223.0, the Desks plan's D6): a browser desk placed for one person and leased through
 * OpenVibe.Bot. The desk client is a fake Bot here (the hosts, leases and commands it is asked for are recorded); the
 * last check runs the real client against a small HTTP Bot to see its token, scope and X-OV-Subject on the wire.
 *
 *   node test/sessions.test.js
 */
const assert = require('assert');
const http = require('http');
const contracts = require('openvibe-contracts');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const OWN = 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2A';
const SHARED = 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2B';
const OPENVIBE = 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2C';

function fakeDesks() {
    const calls = [];
    const leases = new Map();   // `${machine} ${desk}` → lease
    const state = {
        hosts: [
            { machine_id: OWN, trust: 'user-owned', shared: false, online: true, free: 2, max_browser_desks: 2 },
            { machine_id: SHARED, trust: 'community', shared: true, online: true, free: 3, max_browser_desks: 4 },
            { machine_id: OPENVIBE, trust: 'first-party', shared: true, online: true, free: 1, max_browser_desks: 4 },
        ],
        busy: new Set(),
    };
    return {
        calls, leases, state, enabled: true, note: 'a fake Bot',
        async hosts(subject) { calls.push(['hosts', subject]); return state.hosts.map((h) => ({ ...h })); },
        async lease(machine, subject, body) {
            calls.push(['lease', machine, subject, body]);
            if (state.busy.has(machine)) { const e = new Error('busy'); e.code = 'bot.machine_busy'; e.status = 409; throw e; }
            const lease = { machine_id: machine, desk: body.desk, session: body.session, owner: `user:${subject}`, kind: 'browser', width: body.width, height: body.height, shared: machine !== OWN, created_at: new Date().toISOString() };
            leases.set(`${machine} ${body.desk}`, lease);
            return lease;
        },
        async get(machine, desk) { calls.push(['get', machine, desk]); return leases.get(`${machine} ${desk}`) || null; },
        async act(machine, desk, subject, cmd) {
            calls.push(['act', machine, desk, subject, cmd]);
            if (!leases.has(`${machine} ${desk}`)) return null;
            return { machine_id: machine, desk, id: cmd.id, result: 'ack', data: cmd.kind === 'screen' ? { format: 'jpeg', width: 1280, height: 800, content_b64: '/9j/' } : { url: 'https://example.org/', title: 'Example' } };
        },
        async end(machine, desk) { calls.push(['end', machine, desk]); const had = leases.delete(`${machine} ${desk}`); return had ? { ended: true, stopped: true } : null; },
        status: () => ({ enabled: true }),
    };
}

(async () => {
    const desks = fakeDesks();
    const t = await boot({ appOpts: { desks }, env: { RUN_SESSIONS_PER_PERSON: '3', RUN_SESSION_LEASE_CHECK_MS: '1000' } });
    const { sessions } = t.app.locals;
    const ada = ids.newId('user');
    const bea = ids.newId('user');
    const as = (subject) => ({ token: t.network.signUser({ subject }) });
    const valid = (doc, id) => { const v = contracts.validate(id, doc); assert.ok(v.valid, `${id}: ${JSON.stringify(v.errors)}\n${JSON.stringify(doc)}`); };
    const usageOf = async (id) => (await t.db.many('SELECT envelope FROM run_usage_outbox ORDER BY id')).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope)).filter((u) => u.id.startsWith(`run:${id}:`));

    let ses;
    await check('a person opens a session: placed on a shared host (first-party first), its desk leased and running', async () => {
        const r = await t.call('POST', '/api/v1/sessions', { ...as(ada), body: { kind: 'browser', width: 1024, height: 700 } });
        assert.strictEqual(r.status, 201, r.text);
        valid(r.json, 'run.session@1');
        assert.deepStrictEqual([r.json.state, r.json.owner, r.json.via], ['placing', { type: 'user', id: ada }, null]);
        await sessions.tick();
        ses = (await t.call('GET', `/api/v1/sessions/${r.json.id}`, as(ada))).json;
        valid(ses, 'run.session@1');
        assert.strictEqual(ses.state, 'running');
        assert.deepStrictEqual([ses.placement.machine, ses.placement.trust, ses.placement.offer_id], [OPENVIBE, 'first-party', `desk:${OPENVIBE}`], 'first-party before community; the own machine only when asked');
        assert.match(ses.placement.desk, /^desk-s[0-9a-z]{16}$/);
        assert.ok(ses.placement.reasons.includes('an OpenVibe desk host with room'));
        const lease = desks.calls.find((c) => c[0] === 'lease');
        assert.deepStrictEqual(lease[3], { session: ses.id, desk: ses.placement.desk, kind: 'browser', width: 1024, height: 700 });
        assert.strictEqual(lease[2], ada, 'Bot is asked as the person');
        const started = (await t.outboxRows('run.session.started')).map((e) => e.payload || e);
        assert.ok(started.some((p) => p.id === ses.id && p.state === 'running'), 'run.session.started');
    });

    await check('commands reach its desk; anyone else\'s call is 404', async () => {
        const r = await t.call('POST', `/api/v1/sessions/${ses.id}/commands`, { ...as(ada), body: { id: 'c1', kind: 'browser', value: { action: 'open', url: 'https://example.org/' } } });
        assert.strictEqual(r.status, 200, r.text);
        valid(r.json, 'run.session-control-result@1');
        assert.deepStrictEqual([r.json.result, r.json.state, r.json.data.title], ['ack', 'running', 'Example']);
        const act = desks.calls.filter((c) => c[0] === 'act').at(-1);
        assert.deepStrictEqual([act[1], act[2], act[4].kind], [OPENVIBE, ses.placement.desk, 'browser']);
        assert.strictEqual((await t.call('POST', `/api/v1/sessions/${ses.id}/commands`, { ...as(ada), body: { kind: 'browser', value: { action: 'read', desk: 'desk-x' } } })).status, 422, 'a value naming a desk');
        assert.strictEqual((await t.call('POST', `/api/v1/sessions/${ses.id}/commands`, { ...as(ada), body: { kind: 'exec', value: { argv: ['id'] } } })).status, 422);
        assert.strictEqual((await t.call('GET', `/api/v1/sessions/${ses.id}`, as(bea))).status, 404);
        assert.strictEqual((await t.call('POST', `/api/v1/sessions/${ses.id}/end`, as(bea))).status, 404);
        assert.strictEqual((await t.call('GET', `/api/v1/sessions/${ses.id}`, { token: null })).status, 401);
        const list = (await t.call('GET', '/api/v1/sessions', as(ada))).json;
        valid(list, 'run.session-list-result@1');
        assert.deepStrictEqual(list.sessions.map((s) => s.id), [ses.id]);
        assert.deepStrictEqual((await t.call('GET', '/api/v1/sessions', as(bea))).json.sessions, []);
    });

    await check('a first-party service opens one for a person, with the capability; an app never does', async () => {
        const svc = (cap, sub = 'svc:actor') => ({ token: t.network.signService({ sub, cap }), headers: { 'X-OV-Subject': bea } });
        const ok = await t.call('POST', '/api/v1/sessions', { ...svc(['run.session.create']), body: { kind: 'browser', requirements: { kind: 'run.browser', mobility: 'session', latency_class: 'interactive', objective: 'cheapest', trust: ['user-owned'] } } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.deepStrictEqual([ok.json.owner.id, ok.json.via], [bea, 'service:actor']);
        await sessions.tick();
        const placed = (await t.call('GET', `/api/v1/sessions/${ok.json.id}`, svc(['run.session.read']))).json;
        assert.deepStrictEqual([placed.placement.machine, placed.placement.trust], [OWN, 'user-owned'], 'requirements naming user-owned: the person\'s own machine');
        assert.strictEqual((await t.call('POST', '/api/v1/sessions', { ...svc(['run.job.submit']), body: { kind: 'browser' } })).status, 403, 'needs run.session.create');
        const app = await t.call('POST', '/api/v1/sessions', { token: t.network.signService({ sub: 'app:widget', actor_type: 'app', cap: ['run.session.create'] }), headers: { 'X-OV-Subject': bea }, body: { kind: 'browser' } });
        assert.ok([401, 403].includes(app.status), `an app token never opens a session for a person (${app.status})`);
        assert.strictEqual((await t.call('POST', '/api/v1/sessions', { token: t.network.signService({ sub: 'svc:actor', cap: ['run.session.create'] }), body: { kind: 'browser' } })).status, 422, 'for a person');
        await t.call('POST', `/api/v1/sessions/${ok.json.id}/end`, svc(['run.session.control']));
    });

    await check('an idempotency key answers the first session; another body is a conflict; a person holds three at most', async () => {
        const body = { kind: 'browser', ttl_s: 600, idempotency_key: 'actor:tsk_1' };
        const a = await t.call('POST', '/api/v1/sessions', { ...as(bea), body });
        const b = await t.call('POST', '/api/v1/sessions', { ...as(bea), body });
        assert.deepStrictEqual([a.status, b.status, b.json.id], [201, 200, a.json.id]);
        assert.strictEqual((await t.call('POST', '/api/v1/sessions', { ...as(bea), body: { ...body, ttl_s: 700 } })).json.code, 'run.idempotency.conflict');
        await t.call('POST', '/api/v1/sessions', { ...as(bea), body: { kind: 'browser' } });
        await t.call('POST', '/api/v1/sessions', { ...as(bea), body: { kind: 'browser' } });
        const over = await t.call('POST', '/api/v1/sessions', { ...as(bea), body: { kind: 'browser' } });
        assert.deepStrictEqual([over.status, over.json.code], [429, 'run.session.limit']);
        const mine = (await t.call('GET', '/api/v1/sessions', as(bea))).json.sessions;
        await Promise.all(mine.map((s) => t.call('POST', `/api/v1/sessions/${s.id}/end`, as(bea))));
    });

    await check('a full host is skipped; its own machine named and not open ends unplaceable', async () => {
        desks.state.busy.add(OPENVIBE);
        const r = await t.call('POST', '/api/v1/sessions', { ...as(bea), body: { kind: 'browser' } });
        await sessions.tick();
        const s = (await t.call('GET', `/api/v1/sessions/${r.json.id}`, as(bea))).json;
        assert.deepStrictEqual([s.state, s.placement.machine, s.placement.trust], ['running', SHARED, 'community']);
        desks.state.busy.delete(OPENVIBE);
        await t.call('POST', `/api/v1/sessions/${s.id}/end`, as(bea));
        const named = await t.call('POST', '/api/v1/sessions', { ...as(bea), body: { kind: 'browser', machine: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2Z' } });
        await sessions.tick();
        const gone = (await t.call('GET', `/api/v1/sessions/${named.json.id}`, as(bea))).json;
        valid(gone, 'run.session@1');
        assert.deepStrictEqual([gone.state, gone.end.reason], ['ended', 'unplaceable']);
    });

    await check('idle, ttl and a lost host end it; desk time is metered a minute at a time; end gives the desk back', async () => {
        // Ada's first session has run a while: 2 minutes 30 seconds of desk time, then it idles out.
        t.clock.offset += 150_000;
        const before = (await t.call('GET', `/api/v1/sessions/${ses.id}`, as(ada))).json;
        assert.ok(before.usage.desk_seconds >= 150, `desk time counts while running (${before.usage.desk_seconds})`);
        t.clock.offset += 900_000;   // idle_s 900 passed since the last command
        await sessions.tick();
        const idle = (await t.call('GET', `/api/v1/sessions/${ses.id}`, as(ada))).json;
        valid(idle, 'run.session@1');
        assert.deepStrictEqual([idle.state, idle.end.reason], ['ended', 'idle']);
        assert.ok(desks.calls.some((c) => c[0] === 'end' && c[2] === ses.placement.desk), 'the desk was stopped and the lease given back');
        const readings = await usageOf(ses.id);
        readings.forEach((u) => valid(u, 'platform.usage-sample@1'));
        const total = readings.reduce((n, u) => n + u.quantity, 0);
        assert.ok(Math.abs(total - idle.usage.desk_seconds) < 0.2, `the readings add up to the desk time (${total} vs ${idle.usage.desk_seconds})`);
        assert.ok(readings.slice(0, -1).every((u) => u.quantity === 60) && readings.every((u) => u.operation === 'browser.desk' && u.subject === `user:${ada}` && u.node === OPENVIBE));
        const ended = (await t.outboxRows('run.session.ended')).map((e) => e.payload || e);
        assert.ok(ended.some((p) => p.id === ses.id && p.end.reason === 'idle'), 'run.session.ended');
        // A host that drops the desk: the next lease check ends the session host_lost, without stopping anything.
        const r = await t.call('POST', '/api/v1/sessions', { ...as(ada), body: { kind: 'browser', ttl_s: 120 } });
        await sessions.tick();
        const live = (await t.call('GET', `/api/v1/sessions/${r.json.id}`, as(ada))).json;
        desks.leases.clear();
        t.clock.offset += 5_000;
        await sessions.tick();
        const lost = (await t.call('GET', `/api/v1/sessions/${live.id}`, as(ada))).json;
        assert.deepStrictEqual([lost.state, lost.end.reason], ['ended', 'host_lost']);
        // ttl: a session's whole life is bounded.
        const s3 = await t.call('POST', '/api/v1/sessions', { ...as(ada), body: { kind: 'browser', ttl_s: 60, idle_s: 3600 } });
        await sessions.tick();
        t.clock.offset += 61_000;
        await sessions.tick();
        assert.strictEqual((await t.call('GET', `/api/v1/sessions/${s3.json.id}`, as(ada))).json.end.reason, 'ttl');
        // An ended session takes no command.
        const late = await t.call('POST', `/api/v1/sessions/${s3.json.id}/commands`, { ...as(ada), body: { kind: 'screen', value: {} } });
        assert.deepStrictEqual([late.status, late.json.code], [409, 'run.session.not_running']);
    });

    await check('the real desk client: Run\'s token for Bot with bot.desk.session, the person in X-OV-Subject', async () => {
        const seen = [];
        const bot = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, subject: req.headers['x-ov-subject'], body });
                if (req.url === '/api/v1/desk-hosts') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ hosts: [{ machine_id: SHARED, trust: 'community', online: true, free: 1 }] })); }
                if (req.method === 'POST' && /\/desk-leases$/.test(req.url)) { res.writeHead(409, { 'Content-Type': 'application/problem+json' }); return res.end(JSON.stringify({ code: 'bot.machine_busy', detail: 'full' })); }
                res.writeHead(404, { 'Content-Type': 'application/problem+json' });
                return res.end(JSON.stringify({ code: 'bot.lease_not_found' }));
            });
        });
        await new Promise((r) => bot.listen(0, '127.0.0.1', r));
        const { createDeskClient } = require('../server/sessions/desks');
        const config = { ...t.config, oauth: { clientId: 'run', clientSecret: 'secret' }, dispatch: { ...t.config.dispatch, botUrl: `http://127.0.0.1:${bot.address().port}` } };
        const client = createDeskClient({ config });
        assert.strictEqual(client.enabled, true);
        assert.deepStrictEqual((await client.hosts(ada)).map((h) => h.machine_id), [SHARED]);
        await assert.rejects(() => client.lease(SHARED, ada, { session: 'ses_x', desk: 'desk-x', kind: 'browser' }), (e) => e.code === 'bot.machine_busy' && e.status === 409);
        assert.strictEqual(await client.get(SHARED, 'desk-x', ada), null, '404: no such lease');
        assert.ok(seen.every((c) => c.subject === ada && /^Bearer /.test(c.auth)));
        assert.ok(t.network.tokenRequests.scopes.includes('bot.desk.session'), 'its token is scoped bot.desk.session');
        bot.close();
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
