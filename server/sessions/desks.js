'use strict';

/**
 * The desk client: Run → OpenVibe.Bot for its sessions (contracts 0.223.0, capability bot.desk.session). Bot owns the
 * machines and their desks; Run asks it, as the session's person (X-OV-Subject), where a desk may go, leases one,
 * acts on it and ends it:
 *
 *   hosts(subject)                              GET    /api/v1/desk-hosts                          → [{ machine_id, trust, … }]
 *   lease(machine, subject, body)               POST   /api/v1/machines/:id/desk-leases            → bot.desk-lease@1
 *   get(machine, desk, subject)                 GET    /api/v1/machines/:id/desk-leases/:desk      → the lease | null (404)
 *   act(machine, desk, subject, { id, kind, value })  POST …/desk-leases/:desk/commands           → bot.command-result@1 fields
 *   end(machine, desk, subject)                 DELETE /api/v1/machines/:id/desk-leases/:desk      → { ended, stopped } | null
 *
 * The token is Run's Network client-credentials token for audience openvibe.bot with scope bot.desk.session (a 401
 * drops it and the call is tried once more). Off without OV_OAUTH_CLIENT_SECRET: every call fails retryable and
 * sessions wait placing. A DeskError carries Bot's own code (409 bot.machine_busy, 404 bot.device_not_found …).
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const SCOPE = 'bot.desk.session';

class DeskError extends Error {
    constructor(status, code, detail, { retryable = false } = {}) {
        super(detail || code);
        this.name = 'DeskError';
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.retryable = retryable;
    }
}

function createDeskClient({ config, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const { botUrl, botAudience, timeoutMs } = config.dispatch;
    const { clientId, clientSecret } = config.oauth;
    const tokens = clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId, clientSecret, audience: botAudience, scope: SCOPE, fetch: fetchImpl, now })
        : null;
    const enabled = Boolean(tokens && botUrl);
    const note = enabled ? `sessions lease desks on Bot: ${botUrl}, capability ${SCOPE}` : 'sessions are off: OV_OAUTH_CLIENT_SECRET is unset, so Run cannot mint its Bot token';

    async function call(method, path, subject, body) {
        if (!enabled) throw new DeskError(503, 'run.session.disabled', note, { retryable: true });
        for (let attempt = 0; ; attempt++) {
            const headers = { Accept: 'application/json', 'X-OV-Subject': subject, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
            try { Object.assign(headers, await tokens.authHeaders()); }
            catch { throw new DeskError(503, 'run.session.no_token', 'Run could not mint its Bot token from Network', { retryable: true }); }
            let res;
            try {
                res = await fetchImpl(`${botUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.max(timeoutMs, 35000)) });
            } catch (e) {
                const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'no answer in time' : 'unreachable';
                throw new DeskError(503, 'run.session.bot_unavailable', `Bot did not answer (${why})`, { retryable: true });
            }
            if (res.status === 401 && attempt === 0) { tokens.invalidate(); continue; }
            const doc = await res.json().catch(() => null);
            if (res.ok) return doc || {};
            const code = doc && typeof doc.code === 'string' ? doc.code : null;
            const detail = doc && typeof doc.detail === 'string' ? doc.detail.slice(0, 300) : null;
            if (res.status === 404) return null;
            throw new DeskError(res.status, code || 'run.session.bot_refused', detail || `Bot answered HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
        }
    }
    const m = (id) => encodeURIComponent(id);
    return {
        enabled,
        note,
        async hosts(subject) { const out = await call('GET', '/api/v1/desk-hosts', subject); return out && Array.isArray(out.hosts) ? out.hosts : []; },
        lease: (machine, subject, body) => call('POST', `/api/v1/machines/${m(machine)}/desk-leases`, subject, body),
        get: (machine, desk, subject) => call('GET', `/api/v1/machines/${m(machine)}/desk-leases/${m(desk)}`, subject),
        act: (machine, desk, subject, cmd) => call('POST', `/api/v1/machines/${m(machine)}/desk-leases/${m(desk)}/commands`, subject, cmd),
        end: (machine, desk, subject) => call('DELETE', `/api/v1/machines/${m(machine)}/desk-leases/${m(desk)}`, subject),
        status: () => ({ enabled, note, bot_url: botUrl, capability: SCOPE }),
    };
}

module.exports = { createDeskClient, DeskError, SCOPE };
