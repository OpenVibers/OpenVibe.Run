'use strict';

/**
 * The Bot client — Run → OpenVibe.Bot over Bot's internal jobs API (plan T14 step 6, R1c). Bot owns the
 * node link, the job row and the per-second metering; Run owns run.job.*, the project scope and the
 * placement, so this client never writes a usage record (Run holds no Billing token, plan T14 L1).
 *
 *   send({ nodeId, job, project, subject, provider })   POST {RUN_BOT_URL}/api/v1/jobs           → { job, sent }
 *   cancel(jobId)                                       POST …/api/v1/jobs/{id}/cancel          → { job, sent } | null
 *   state(jobId)                                        GET  …/api/v1/jobs/{id}                 → { job, stdout } | null
 *
 * Bot's answer's `job` is its own run_jobs record (id, node_id, state, sent_at, started_ms, finished_at,
 * exit_reason, exit_code, wall_ms, usage_read, result, project_id, subject, provider, fault_code) and
 * `stdout` is the last 1 MiB it holds of the job's output. None of it is trusted as authority: the poller
 * validates it against Run's own row (server/jobs/poller.js) and never lets Bot name another node or
 * project.
 *
 * The token is a Network client-credentials service token for audience `openvibe.bot` holding
 * `bot.job.dispatch` (contracts/manifests/capabilities/bot.job.dispatch.json), minted from
 * OV_OAUTH_CLIENT_ID/OV_OAUTH_CLIENT_SECRET against OV_NETWORK_INTERNAL_URL and cached until 60 s before
 * expiry by openvibe-sdk/auth's createServiceTokenClient; a 401 from Bot drops the cached token and the
 * call is tried once more. Unset client secret: the bridge is off and nothing is sent. The token, the
 * Authorization header and the job body are never logged, and never put in an error.
 *
 * Errors: a DispatchError carrying Bot's own RFC 9457 code (409 bot.class_unadvertised, …) is permanent;
 * a transport failure, a timeout or a 5xx is `retryable` (the poller tries again next tick); a 404 is
 * `null` — Bot does not know the job (bot.job_not_found), which for state() is how the poller learns a job
 * it sent has disappeared.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

/** Bot's own capability this client holds (contracts/manifests/capabilities/bot.job.dispatch.json). */
const BOT_DISPATCH = 'bot.job.dispatch';

class DispatchError extends Error {
    constructor(status, code, detail, { retryable = false } = {}) {
        super(detail || code);
        this.name = 'DispatchError';
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.retryable = retryable;
    }
}

/**
 * createBotClient({ config, fetchImpl, now, log }) → the three calls plus status().
 * enabled is false without OV_OAUTH_CLIENT_SECRET: Run cannot mint a Bot token, so nothing is sent.
 */
function createBotClient({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const { botUrl, botAudience, timeoutMs } = config.dispatch;
    const { clientId, clientSecret } = config.oauth;
    const tokenUrl = `${config.network.internalUrl}/oauth/token`;
    const tokens = clientSecret
        ? createServiceTokenClient({ tokenUrl, clientId, clientSecret, audience: botAudience, scope: BOT_DISPATCH, fetch: fetchImpl, now })
        : null;
    const enabled = Boolean(tokens && botUrl);
    const note = enabled
        ? `the dispatcher bridge to Bot: ${botUrl}, audience ${botAudience}, capability ${BOT_DISPATCH}`
        : 'the dispatcher bridge to Bot is off: OV_OAUTH_CLIENT_SECRET is unset, so Run cannot mint its Network client-credentials token';

    /** One call: mint (or reuse) the token, fetch, and turn Bot's answer into a value or a DispatchError. */
    async function call(method, path, { body } = {}) {
        if (!enabled) throw new DispatchError(503, 'run.dispatch.disabled', note, { retryable: true });
        for (let attempt = 0; ; attempt++) {
            const headers = { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
            try { Object.assign(headers, await tokens.authHeaders()); }
            catch (e) { throw new DispatchError(503, 'run.dispatch.no_token', 'Run could not mint its Bot token from Network', { retryable: true }); }
            let res;
            try {
                res = await fetchImpl(`${botUrl}${path}`, {
                    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (e) {
                const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
                throw new DispatchError(503, 'run.dispatch.unavailable', `Bot did not answer (${why})`, { retryable: true });
            }
            // A rotated or clock-skewed token Bot no longer accepts: drop the cache and try once more.
            if (res.status === 401 && attempt === 0) { tokens.invalidate(); continue; }
            const doc = await res.json().catch(() => null);
            if (res.ok) return doc || {};
            const code = doc && typeof doc.code === 'string' ? doc.code : null;
            const detail = doc && typeof doc.detail === 'string' ? doc.detail.slice(0, 300) : null;
            if (res.status === 404 && code === 'bot.job_not_found') return null;
            const why = `Bot answered HTTP ${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
            if (res.status >= 500) throw new DispatchError(503, code || 'run.dispatch.unavailable', why, { retryable: true });
            throw new DispatchError(502, code || 'run.dispatch.refused', why, { retryable: false });
        }
    }

    return {
        enabled,
        note,
        /** Hand one job to one device (POST /api/v1/jobs); Bot validates the platform.job@1 body itself. */
        async send({ nodeId, job, project, subject = null, provider = null }) {
            if (!nodeId) throw new DispatchError(422, 'run.dispatch.no_node', 'send: Bot needs a node_id (a device) to place the job on');
            const out = await call('POST', '/api/v1/jobs', { body: { node_id: nodeId, job, project_id: project, subject, provider } });
            if (!out || !out.job || typeof out.job.id !== 'string') throw new DispatchError(502, 'run.dispatch.refused', 'Bot answered without a job record');
            return { job: out.job, sent: Boolean(out.sent) };
        },
        /** Ask Bot to stop a job; null when Bot has no such job (nothing to stop). Idempotent at Bot. */
        cancel: (jobId) => call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`),
        /** Bot's own record of a job and the stdout it holds; null when Bot has never seen it. */
        state: (jobId) => call('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`),
        status: () => ({ enabled, note, bot_url: botUrl, audience: botAudience, capability: BOT_DISPATCH, timeout_ms: timeoutMs, token_url: tokenUrl }),
    };
}

module.exports = { createBotClient, DispatchError, BOT_DISPATCH };
