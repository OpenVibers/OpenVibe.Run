'use strict';
const crypto = require('crypto');
const { createStreamTickets } = require('../jobs/ticket');
const error = (status, message) => Object.assign(new Error(message), { status, code: 'run.profile.unavailable' });
function createProfiles({ config, db, now = Date.now, log = console }) {
    const tickets = createStreamTickets({ config, log, now });
    tickets.start();
    // Use Run's existing durable private key; no extra secret and no plaintext profile on disk.
    const key = !tickets.status().ephemeral && tickets.get() ? crypto.hkdfSync('sha256', tickets.get().export({ type: 'pkcs8', format: 'der' }), Buffer.from('run-actor-profiles-v1'), Buffer.from('browser-storage'), 32) : null;
    const aad = (owner, actor) => Buffer.from(JSON.stringify([owner, actor]));
    function seal(owner, actor, value) {
        if (!key) throw error(503, 'Saved sign-ins need Run’s durable signing key.');
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > 47000) throw error(422, 'Saved sign-ins exceed this computer’s limit.');
        const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad(owner, actor));
        return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64');
    }
    function open(owner, actor, text) {
        if (!text) return { cookies: [], origins: [] };
        if (!key) throw error(503, 'Saved sign-ins need Run’s durable signing key.');
        const bytes = Buffer.from(text, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(aad(owner, actor)); decipher.setAuthTag(bytes.subarray(-16));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
    }
    async function read(owner, actor) {
        const row = await db.maybe('SELECT sealed FROM run_actor_profiles WHERE owner=$1 AND actor_id=$2', [owner, actor]);
        return open(owner, actor, row && row.sealed);
    }
    async function write(owner, actor, value) {
        if (!value || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) throw error(502, 'This computer could not save its sign-ins.');
        await db.exec(`INSERT INTO run_actor_profiles(owner,actor_id,sealed,updated_at) VALUES($1,$2,$3,$4)
            ON CONFLICT(owner,actor_id) DO UPDATE SET sealed=EXCLUDED.sealed,updated_at=EXCLUDED.updated_at`, [owner, actor, seal(owner, actor, value), now()]);
    }
    async function sites(owner, actor) {
        const p = await read(owner, actor);
        return [...new Set([...p.cookies.map(c => String(c.domain || '').replace(/^\./, '').toLowerCase()), ...p.origins.map(o => { try { return new URL(o.origin).hostname; } catch { return ''; } })].filter(Boolean))].sort();
    }
    async function forget(owner, actor, site) {
        const p = await read(owner, actor);
        // Signing out of a site signs out of its subdomains too (accounts.google.com when the person signs out of
        // google.com): a cookie or a storage origin on the site or under it goes.
        const under = (host) => { const h = String(host || '').replace(/^\./, '').toLowerCase(); return h === site || h.endsWith(`.${site}`); };
        p.cookies = p.cookies.filter(c => !under(c.domain));
        p.origins = p.origins.filter(o => { try { return !under(new URL(o.origin).hostname); } catch { return true; } });
        await write(owner, actor, p);
    }
    async function lock(owner, actor, fn) {
        return db.tx(async t => {
            await t.exec('INSERT INTO run_actor_profiles(owner,actor_id,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [owner, actor, now()]);
            await t.one('SELECT actor_id FROM run_actor_profiles WHERE owner=$1 AND actor_id=$2 FOR UPDATE', [owner, actor]);
            return fn(t);
        });
    }
    return { lock, enabled: Boolean(key), read, write, sites, forget };
}
module.exports = { createProfiles };
