'use strict';
/**
 * The shared navbar's token (the owner, 11-14: the menu's Alerts said "Your notifications are on your account" on
 * Run): the access cookie is HTTP-only (httpOnlyAccess), so the navbar asks /auth/navbar-token, same-origin and
 * never cached, and the page tells it where (tokenUrl). Signed out is 401; another site is refused.
 */
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    try {
        // A person's session token, signed by the stub Network's own key (the real verification path).
        const at = jwt.sign({ sub: '57', subject_id: 'usr_01HZY6Q4N8V2P6M4QK9J3T7R0X', username: 'ada', display_name: 'ada', role: 'user' },
            t.network.privatePem, { algorithm: 'RS256', issuer: t.network.issuer, audience: 'openvibe.network', expiresIn: '1h' });

        await check('the signed-in person gets their token, same-origin and never cached', async () => {
            const r = await t.call('GET', '/auth/navbar-token', { token: null, headers: { Cookie: `ov_token=${at}`, 'Sec-Fetch-Site': 'same-origin' } });
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.json, { token: at });
            assert.match(r.headers.get('cache-control') || '', /no-store/, 'never cached');
        });

        await check('signed out is 401', async () => {
            const r = await t.call('GET', '/auth/navbar-token', { token: null, headers: { 'Sec-Fetch-Site': 'same-origin' } });
            assert.strictEqual(r.status, 401);
        });

        await check('another site is refused', async () => {
            const r = await t.call('GET', '/auth/navbar-token', { token: null, headers: { Cookie: `ov_token=${at}`, 'Sec-Fetch-Site': 'cross-site' } });
            assert.strictEqual(r.status, 403);
        });

        await check('the page tells the navbar where to ask', async () => {
            const r = await t.call('GET', '/', { token: null, headers: { Accept: 'text/html' } });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('"tokenUrl":"/auth/navbar-token"'), r.text.slice(0, 400));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
