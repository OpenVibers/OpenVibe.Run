'use strict';

/**
 * Run's side of OpenVibe.Network: the signing key every token is verified against, and offline
 * verification of a person's user token.
 *
 * Run calls no Network route: it verifies service tokens (audience openvibe.run) with the JWKS key and
 * accepts a Network user token as a Bearer exactly as Bot does. Only a token that names a project
 * (an app, agent or service principal with project_id) can act on jobs — every route says so.
 */
const crypto = require('crypto');
const { verifyUserToken } = require('openvibe-sdk/auth');

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

module.exports = { createKeyProvider, createUserAuth };
