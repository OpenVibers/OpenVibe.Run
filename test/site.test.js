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
            assert.match(r.text, /<title>OpenVibe\.Run: run jobs on your own machine/);
            assert.ok(r.text.includes('href="https://openvibe.bot/machines"'), 'it leads with pairing your own machine');
            assert.match(r.text, /<th scope="row">browser<\/th>[\s\S]*?Built, not switched on yet/, 'the class table says what works today');
            const faq = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((j) => j['@type'] === 'FAQPage');
            assert.ok(faq && faq.mainEntity.length >= 4, 'the catalog\'s questions as FAQPage data');
            for (const q of faq.mainEntity) assert.ok(r.text.includes(`<summary>${q.name}</summary>`), `and on the page: ${q.name}`);
            assert.ok(r.text.includes("require('openvibe-sdk/run')") || r.text.includes('require(&#39;openvibe-sdk/run&#39;)'), 'the SDK sample');
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
            assert.ok(manifest.icons.length === 4 && manifest.icons.every((i) => /^\/shared\/icons\/[a-z0-9-]+-(maskable-)?(192|512)\.png\?v=/.test(i.src)), 'the shared icon set, which the site serves');
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
        await check('a browser that asks for a missing page gets the site 404 page in the Frame', async () => {
            const r = await t.call('GET', '/no-such-page-xyz', { token: null, headers: { Accept: 'text/html' } });
            assert.strictEqual(r.status, 404);
            assert.match(r.headers.get('content-type'), /^text\/html/);
            assert.ok(r.text.includes('<h1>Page not found</h1>'), r.text.slice(0, 300));
            assert.ok(r.text.includes('There is no page at this address on run.test. The link may be old or mistyped.'));
            assert.ok(r.text.includes('id="navbar-mount"'), 'the page is in the site Frame');
            assert.ok(r.text.includes('<meta name="robots" content="noindex, follow">'));
            assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex');
            assert.ok(r.text.includes('class="sc-btn sc-primary" href="/"'), 'home is the first way back');
            const api = await t.call('GET', '/no-such-page-xyz', { token: null, headers: { Accept: 'application/json' } });
            assert.strictEqual(api.status, 404);
            assert.match(api.headers.get('content-type'), /problem\+json/);
        });
    } finally {
        await t.close();
    }
    done();
})();
