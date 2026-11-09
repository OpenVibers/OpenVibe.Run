'use strict';
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
(async () => {
    const machine = 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2A';
    const browsers = new Map();
    const desks = { enabled: true, hosts: async () => [{ machine_id: machine, trust: 'first-party', online: true, free: 4, max_browser_desks: 4 }],
        lease: async (_m, _s, b) => { browsers.set(b.desk, { cookies: [], origins: [] }); return { desk: b.desk }; },
        get: async (_m, d) => browsers.has(d) ? {} : null,
        end: async (_m, d) => browsers.delete(d),
        act: async (_m, d, _s, cmd) => {
            if (!browsers.has(d)) return null;
            const v = cmd.value;
            if (v.action === 'profile_import') browsers.set(d, structuredClone(v.profile));
            if (v.action === 'profile_sign_out') { const p = browsers.get(d); p.cookies = p.cookies.filter(c => c.domain.replace(/^\./, '') !== v.site); p.origins = p.origins.filter(o => new URL(o.origin).hostname !== v.site); }
            return { result: 'ack', data: v.action === 'profile_export' ? structuredClone(browsers.get(d)) : { done: true } };
        } };
    const t = await boot({ appOpts: { desks } });
    const owner = 'user:' + ids.newId('user'), actor = 'act_01J8Z4M2Q0R7T9YV3K6N8P1W2A';
    let sessions = t.app.locals.sessions;
    try {
        await check('encrypted Actor profile survives a session and service restart; sign-out is site-specific', async () => {
            const start = async () => { const r = await sessions.create(owner, 'service:actor', { kind: 'browser' }, { template: 'kept-browser', actor }); await sessions.tick(); return sessions.get(r.row.id); };
            const one = await start(); assert.equal(one.state, 'running');
            await sessions.grantControl(one,{kind:'ai',subject:'svc_actor'});
            await sessions.takeControl(await sessions.get(one.id));
            const history=await sessions.timeline(one);
            assert.equal(history.actions[0].action,'owner_take_back');
            assert.equal(history.actions[0].actor.kind,'person');
            await assert.rejects(() => sessions.create(owner, 'service:actor', { kind: 'browser' }, { template: 'kept-browser', actor }), e => e.status === 409);
            browsers.set(one.desk, { cookies: [{ name: 'login', value: 'synthetic-signin-a', domain: '.a.example', path: '/' }, { name: 'login', value: 'synthetic-signin-b', domain: 'b.example', path: '/' }], origins: [{ origin: 'https://a.example', entries: [['theme', 'dark']] }] });
            await sessions.finish(one, 'ended');
            const stored = await t.db.one('SELECT sealed FROM run_actor_profiles WHERE owner=$1', [owner]);
            assert.ok(!stored.sealed.includes('synthetic-signin') && !stored.sealed.includes('a.example'));
            sessions = require('../server/sessions/service').createSessions({ config: t.config, db: t.db, desks, outbox: t.outbox, log: { warn() {} } });
            const two = await start();
            assert.equal(browsers.get(two.desk).cookies.length, 2);
            assert.deepEqual(await sessions.profileSites(owner, actor), { sites: ['a.example', 'b.example'] });
            assert.deepEqual(await sessions.profileSites('user:' + ids.newId('user'), actor), { sites: [] });
            await sessions.signOut(owner, actor, 'a.example');
            assert.deepEqual(browsers.get(two.desk).cookies.map(c => c.domain), ['b.example']);
            assert.deepEqual(browsers.get(two.desk).origins, []);
            await sessions.finish(two, 'ended');
            const three = await start();
            assert.deepEqual(browsers.get(three.desk).cookies.map(c => c.domain), ['b.example']);
            await sessions.finish(three, 'ended');
        });
    } finally { await t.close(); }
})().then(done).catch(e => { console.error(e); process.exit(1); });
