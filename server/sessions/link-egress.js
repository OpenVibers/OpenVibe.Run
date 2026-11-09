'use strict';

const crypto = require('crypto');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const revokers = new Map();
const labels = new Map(); // Display only; never an authorization cache or a credential store.

function createLinkEgress({ config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const tokens = config.oauth.clientSecret ? createServiceTokenClient({ tokenUrl: `${config.network.internalUrl}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.network',
        scope: 'network.registry.read', fetch: fetchImpl, now }) : null;
    async function call(method, path, body) {
        if (!tokens) throw Object.assign(new Error('Browsing connection unavailable'), { retryable: true });
        for (let attempt = 0; attempt < 2; attempt++) {
            const r = await fetchImpl(`${config.network.internalUrl}/internal/egress/sessions/${path}`, { method,
                headers: { ...(await tokens.authHeaders()), 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000), redirect: 'error' });
            if (r.status === 401 && attempt === 0) { tokens.invalidate(); continue; }
            if (!r.ok) throw Object.assign(new Error('Browsing connection unavailable'), { code: 'run.egress.unavailable', retryable: true });
            return r.status === 204 ? null : r.json();
        }
    }
    return {
        async prepare(machine, owner, body) {
            const route = await call('PUT', encodeURIComponent(body.session), { owner, machine, desk: body.desk,
                credential: crypto.randomBytes(32).toString('base64url'), expires_at: now() + 120_000 });
            revokers.set(body.session, () => call('DELETE', encodeURIComponent(body.session)));
            if (route.mode === 'wait') throw Object.assign(new Error('Waiting for my computer'), { code: 'run.egress.waiting', retryable: true });
            if (!['link', 'direct'].includes(route.mode)) throw Object.assign(new Error('Browsing connection unavailable'), { retryable: true });
            labels.set(body.session, route.mode === 'link' ? String(route.device_name || 'My computer').slice(0, 100) : "OpenVibe's address");
            return route;
        },
        async renew(session) {
            await call('POST', `${encodeURIComponent(session)}/renew`);
            revokers.set(session, () => call('DELETE', encodeURIComponent(session)));
        },
        async end(session) { labels.delete(session); revokers.delete(session); await call('DELETE', encodeURIComponent(session)); },
    };
}

function goingOutThrough(session) { const name = labels.get(session); return name ? `Going out through: ${name}` : null; }
async function revokeKnownSession(session) {
    const revoke = revokers.get(session); revokers.delete(session); labels.delete(session);
    if (revoke) await revoke();
}
module.exports = { createLinkEgress, goingOutThrough, revokeKnownSession };
