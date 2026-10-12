'use strict';

/**
 * Run's side of OpenVibe.Network: the signing key every token is verified against, offline verification
 * of a person's user token, and the one Network read Run makes — a person's membership of a project, for
 * project delegation.
 *
 * Run verifies service tokens (audience openvibe.run) with the JWKS key and accepts a Network user token
 * as a Bearer exactly as Bot does. Only a token that names a project (an app, agent or service principal
 * with project_id), or a first-party service delegated into a project (X-OV-Subject + X-OV-Project, see
 * createProjectMembership), can act on jobs — every route says so.
 */
const crypto = require('crypto');
const { verifyUserToken, createServiceTokenClient } = require('openvibe-sdk/auth');

const MEMBER_READ = 'network.project.member.read';
const DELEGABLE_ROLES = new Set(['admin', 'owner']);
const MEMBER_TTL_MS = 60_000;   // the amendment's ceiling: a removed member or an archived project stops new jobs within a minute

/** Network's RS256 public key: OV_NETWORK_PUBLIC_KEY when the operator pins it, else the JWKS at boot. */
function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    let pem = config.network.publicKey ? crypto.createPublicKey(config.network.publicKey).export({ type: 'spki', format: 'pem' }) : null;
    let timer = null;
    async function load() {
        const url = `${config.network.internalUrl}/api/.well-known/jwks`;
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`JWKS ${res.status}`);
            const body = await res.json();
            const jwk = (body.keys || []).find((k) => k.kty === 'RSA');
            if (jwk) pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
            else if (typeof body.public_key === 'string') pem = crypto.createPublicKey(body.public_key).export({ type: 'spki', format: 'pem' });
            else throw new Error('JWKS contained no keys');
            return pem;
        } catch (e) {
            log.warn(`[Run] Network key not loaded from ${url}: ${e.message}`);
            return null;
        }
    }
    function start() {
        if (config.network.publicKey || timer) return;
        const retry = () => load().then((k) => { if (!k) setTimeout(retry, 30_000).unref(); });
        retry();
        timer = setInterval(async () => { await load(); }, 6 * 60 * 60 * 1000);
        timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { get: () => pem, load, start, stop };
}

/**
 * Offline verification of a Network user token (openvibe-sdk/auth: RS256, issuer, expiry, and a typed
 * token — a realtime or stream ticket — is never a session). Service principals are not user tokens.
 * Returns the claims, or null.
 */
function createUserAuth(config, keys) {
    async function verify(token) {
        if (!token) return null;
        const publicKey = keys.get();
        if (!publicKey) return null;
        try {
            const claims = await verifyUserToken(token, { publicKey, issuer: config.network.issuer });
            return claims && typeof claims === 'object' ? claims : null;
        } catch { return null; }
    }
    return { verify };
}

/**
 * Project delegation (ADR-003 amendment 2026-10-12): may a first-party service start a job for this person in
 * this project? Network states the membership (GET /internal/projects/:project/members/:subject, capability
 * network.project.member.read, minted through Run's own client); the decision is Run's: only an admin or owner of
 * a project that is not archived may be acted for. A yes is cached for MEMBER_TTL_MS, a no never (the person may
 * have just been added). → { ok: true } | { ok: false } (a 404, another role, an archived project), and throws
 * when Network cannot be asked (no client secret, no token, an error answer, a timeout): the caller answers 503.
 */
function createProjectMembership(config, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const { clientId, clientSecret } = config.oauth;
    const tokens = clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId, clientSecret, audience: 'openvibe.network', scope: MEMBER_READ, fetch: fetchImpl, now })
        : null;
    const yes = new Map();   // `${project} ${subject}` → when the yes expires
    async function allows(project, subject) {
        const key = `${project} ${subject}`;
        const until = yes.get(key);
        if (until && until > now()) return { ok: true };
        yes.delete(key);
        if (!tokens) throw new Error('OV_OAUTH_CLIENT_SECRET is unset: Run cannot ask Network about a project membership');
        const url = `${config.network.internalUrl}/internal/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(subject)}`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(5000) });
        if (res.status === 404) return { ok: false };
        if (!res.ok) throw new Error(`Network answered ${res.status} to the membership read`);
        const body = await res.json();
        const ok = !!body && body.project_id === project && body.subject === subject && DELEGABLE_ROLES.has(body.role) && body.archived === false;
        if (ok) {
            if (yes.size > 10_000) yes.clear();
            yes.set(key, now() + MEMBER_TTL_MS);
        }
        return { ok };
    }
    return { allows, enabled: Boolean(tokens) };
}

module.exports = { createKeyProvider, createUserAuth, createProjectMembership, MEMBER_TTL_MS, DELEGABLE_ROLES };
