'use strict';
/**
 * The public site of openvibe.run: the front page in the OpenVibe Frame (its own CSP, cached briefly), the legal
 * pages, robots.txt, the sitemap, the icon and the manifest; the API's 404 stays an RFC 9457 problem.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    try {
        await check('GET / is the front page in the Frame, with its CSP, and says only what works', async () => {
            const r = await t.call('GET', '/', { token: null, headers: { Accept: 'text/html' } });
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /text\/html/);
            assert.match(r.text, /<title>OpenVibe\.Run: run a job on a node that can/);
            assert.match(r.text, /id="navbar-mount"/);
            assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
            assert.match(r.headers.get('cache-control'), /max-age=300/);
            assert.ok(r.text.includes('POST /api/v1/jobs/:id/stream/ticket'), 'the stream ticket route as the API names it');
            assert.ok(r.text.includes('&quot;artifact&quot;') || r.text.includes('"artifact"'), 'the example names an artifact, as the job contract requires');
            assert.ok(!/coming soon|placeholder/i.test(r.text), 'no placeholder copy');
            // The showcase stylesheet is the pinned copy under /shared, content-addressed, and it answers.
            const css = /<link rel="stylesheet" href="(\/shared\/showcase\.css\?v=[0-9a-f]{12})">/.exec(r.text);
            assert.ok(css, 'showcase.css is linked from /shared');
            const sheet = await t.call('GET', css[1], { token: null });
            assert.strictEqual(sheet.status, 200);
            assert.match(sheet.headers.get('content-type'), /text\/css/);
        });
        await check('the legal pages, robots.txt, the sitemap, the icon and the manifest', async () => {
            for (const p of ['/terms', '/privacy', '/dmca']) assert.strictEqual((await t.call('GET', p, { token: null })).status, 200, p);
            const robots = await t.call('GET', '/robots.txt', { token: null });
            assert.match(robots.text, /Disallow: \/api\//);
            assert.match(robots.text, /Sitemap: .*\/sitemap\.xml/);
            assert.match((await t.call('GET', '/sitemap.xml', { token: null })).text, /<loc>[^<]*\/terms<\/loc>/);
            assert.match((await t.call('GET', '/favicon.ico', { token: null })).headers.get('content-type'), /image\/svg\+xml/);
            const manifest = JSON.parse((await t.call('GET', '/manifest.webmanifest', { token: null })).text);
            assert.strictEqual(manifest.name, 'OpenVibe.Run');
        });
        await check('/updates: the shared update log in the Frame, one heading, in the sitemap', async () => {
            const r = await t.call('GET', '/updates', { token: null });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('<h1>What shipped on OpenVibe.Run</h1>') && r.text.includes('data-ov-shipped="log" data-service="run"'));
            assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1);
            assert.match(r.text, /<script src="\/shared\/shipped\.js\?v=[0-9a-f]+" defer><\/script>/);
            assert.match(r.headers.get('content-security-policy'), /connect-src 'self' https:\/\/openvibe\.network/);
            assert.match((await t.call('GET', '/sitemap.xml', { token: null })).text, /<loc>[^<]*\/updates<\/loc>/);
        });
        await check('an unknown API path is still a problem+json 404', async () => {
            const r = await t.call('GET', '/api/v1/nothing-here', { token: null });
            assert.strictEqual(r.status, 404);
            assert.match(r.headers.get('content-type'), /problem\+json/);
        });
    } finally {
        await t.close();
    }
    done();
})();
