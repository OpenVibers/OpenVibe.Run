'use strict';
const assert = require('assert/strict');
const { ids } = require('openvibe-contracts');
const { createDeskClient } = require('../server/sessions/desks');
const { testDb } = require('./helpers/db');
const store = require('../server/sessions/store');

(async () => {
    const dbtest = await testDb();
    try {
        const machine = `dev_${ids.ulid()}`, owner = `usr_${ids.ulid()}`, session = `ses_${ids.ulid()}`;
        const body = { session, desk: store.deskOf(session), kind: 'browser', width: 1280, height: 800 };
        const calls = [];
        let mode = 'wait';
        const config = { oauth: { clientId: 'run', clientSecret: 'test-only' }, network: { internalUrl: 'https://network.test' },
            dispatch: { botUrl: 'https://bot.test', botAudience: 'openvibe.bot', timeoutMs: 1000 } };
        const client = createDeskClient({ config, fetchImpl: async (url, options) => {
            const json = value => new Response(JSON.stringify(value), { status: 200 });
            if (url.endsWith('/oauth/token')) return json({ access_token: 'test-only', token_type: 'Bearer', expires_in: 3600 });
            calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
            if (url.endsWith('/desk-hosts')) return json({ hosts: [{ machine_id: machine, trust: 'first-party', shared: true, online: true }] });
            if (url.includes('/internal/egress/')) return options.method === 'PUT' ? json({ mode, device_name: 'My home PC' }) : new Response(null, { status: 204 });
            return json({ ...body, shared: true });
        } });
        await client.hosts(owner);
        await assert.rejects(client.lease(machine, owner, body), { code: 'run.egress.waiting' });
        assert.equal(calls.filter(c => c.url.endsWith('/desk-leases')).length, 0, 'wait does not start a browser');
        mode = 'link';
        await client.lease(machine, owner, body);
        assert.deepEqual(calls.find(c => c.url.endsWith('/desk-leases')).body, body, 'no proxy credential is sent through the desk command');
        const at = Date.now();
        await store.insert(dbtest.db, { id: session, owner: `user:${owner}`, kind: 'browser', state: 'placing', width: 1280, height: 800,
            ttl_s: 3600, idle_s: 900, request_digest: 'test', reasons: [], created_at: at, updated_at: at });
        await store.update(dbtest.db, session, { state: 'running', machine, desk: body.desk });
        await client.get(machine, body.desk, owner);
        assert.ok(calls.some(c => c.url.endsWith('/renew')));
        await client.end(machine, body.desk, owner);
        const row = await store.get(dbtest.db, session);
        assert.equal(row.egress_label, 'Going out through: My home PC');
        assert.equal(store.present(row).placement.reasons[0], row.egress_label, 'label survives the client cache');
        const ends = calls.filter(c => c.method === 'DELETE');
        assert.ok(ends[0].url.includes('/internal/egress/'), 'revoke browsing before ending the desk');
        assert.ok(ends[1].url.includes('/desk-leases/'));
        await store.update(dbtest.db, session, { state: 'ended', ended_at: at + 1000, end_reason: 'ended' });
        const late = await store.update(dbtest.db, session, { state: 'running', machine, desk: body.desk });
        assert.equal(late.state, 'ended', 'late desk responses cannot revive an ended session');
        assert.equal((await store.get(dbtest.db, session)).state, 'ended');
        console.log('Link desk integration: wait before browser, credential separation, renew, revoke, persisted label and terminal session state passed');
    } finally { await dbtest.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
