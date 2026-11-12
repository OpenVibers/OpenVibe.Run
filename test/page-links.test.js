'use strict';
// Every page of openvibe.run gives the shared navbar the site's own page list (the owner, 2026-11-12): the home,
// /updates, /terms, /privacy and /dmca all send Your machine / How it works / API, addressed from any page.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { NAV_LINKS } = require('../server/web/home');

function initLinks(html) {
    const at = html.indexOf('OpenVibeNavbar.init');
    if (at < 0) return null;
    const start = html.indexOf('links', at);
    const open = html.indexOf('[', start);
    let depth = 0, q = null, esc = false;
    for (let i = open; i < html.length; i += 1) {
        const c = html[i];
        if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '[') depth += 1; else if (c === ']') { depth -= 1; if (!depth) return JSON.parse(html.slice(open, i + 1)); }
    }
    return null;
}

(async () => {
    const t = await boot();
    try {
        const own = NAV_LINKS.map(({ label, href }) => ({ label, href }));
        await check('every page sends Run\'s own list, not the shared fallback', async () => {
            for (const path of ['/', '/updates', '/terms', '/privacy', '/dmca']) {
                const r = await t.call('GET', path, { token: null });
                assert.strictEqual(r.status, 200, `${path} answered ${r.status}`);
                const links = (initLinks(r.text) || []).map(({ label, href }) => ({ label, href }));
                assert.deepStrictEqual(links, own, `${path} sends Run's list`);
            }
        });
        await check('every row is a route or a section of the home', async () => {
            for (const { href } of NAV_LINKS) {
                const [path, hash] = href.split('#');
                const r = await t.call('GET', path || '/', { token: null });
                assert.strictEqual(r.status, 200, `${path} is a route`);
                if (hash) assert.ok(r.text.includes(`id="${hash}"`), `${href} names a section on the home`);
            }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
