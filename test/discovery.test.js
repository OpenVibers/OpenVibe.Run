'use strict';
/**
 * What openvibe.run tells crawlers: /llms.txt, /llms-full.txt and IndexNow (the key file and the boot ping,
 * both only with INDEXNOW_KEY).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { createIndexNow } = require('openvibe-shared/indexnow');
const discovery = require('../server/web/discovery');

const KEY = require('crypto').randomBytes(16).toString('hex');

(async () => {
    const t = await boot();
    try {
        await check('/llms.txt answers 200 text/plain with the site name, and lists no API, admin, job or stream URL', async () => {
            const r = await t.call('GET', '/llms.txt', { token: null });
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.text, /^# OpenVibe\.Run\n/);
            assert.ok(r.text.includes('http://run.test/terms'));
            assert.ok(!/\/api\/|\/internal\/|\/admin|\/jobs|\/stream/.test(r.text), 'no machine route is listed');
        });
        await check('/llms-full.txt answers 200 text/plain within maxBytes and carries the front page text', async () => {
            const r = await t.call('GET', '/llms-full.txt', { token: null });
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.ok(Buffer.byteLength(r.text) <= discovery.MAX_BYTES);
            assert.match(r.text, /^# OpenVibe\.Run\n/);
            assert.match(r.text, /How a job runs/);
            assert.ok(!/<[a-z]+[ >]/.test(r.text), 'plain text, no markup');
            assert.ok(!/\/internal\/|\/admin/.test(r.text));
        });
        await check('without INDEXNOW_KEY the key route is 404 and no notify call is made', async () => {
            assert.strictEqual(t.app.locals.indexnow.enabled, false);
            assert.strictEqual((await t.call('GET', `/${KEY}.txt`, { token: null })).status, 404);
            const sent = [];
            const off = createIndexNow({ host: 'https://run.test', key: '', fetch: async (...a) => { sent.push(a); return { status: 200 }; } });
            assert.strictEqual(discovery.notify(off, { baseUrl: 'https://run.test' }), false);
            await off.flush();
            await off.ping(['https://run.test/']);
            assert.strictEqual(sent.length, 0);
        });
    } finally {
        await t.close();
    }

    const sent = [];
    const indexnow = createIndexNow({ host: 'https://run.test', key: KEY, fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 200 }; } });
    const k = await boot({ env: { INDEXNOW_KEY: KEY, BASE_URL: 'https://run.test' }, appOpts: { indexnow } });
    try {
        await check('with INDEXNOW_KEY the key route serves the key, and notify sends the public pages in one batch', async () => {
            const r = await k.call('GET', `/${KEY}.txt`, { token: null });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.text, KEY);
            assert.strictEqual((await k.call('GET', '/other-key.txt', { token: null })).status, 404);
            assert.strictEqual(discovery.notify(k.app.locals.indexnow, k.app.locals.config), true);
            await indexnow.flush();
            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].key, KEY);
            assert.strictEqual(sent[0].keyLocation, `https://run.test/${KEY}.txt`);
            assert.deepStrictEqual(sent[0].urlList.slice(0, 2), ['https://run.test/', 'https://run.test/terms']);
            assert.ok(sent[0].urlList.every((u) => !/\/api\/|\/internal\//.test(u)));
        });
    } finally {
        await k.close();
    }
    done();
})();
