'use strict';

/**
 * Run → OpenVibe.Bench: record one bench.match@1 (the race's judgement) on Bench's
 * POST /api/v1/matches (capability bench.judgement.cast, audience openvibe.bench).
 *
 * The match is validated against the released contract before it is sent, so a broken body is Run's own
 * 500/422 and never a Bench refusal. The token is a Network client-credentials service token minted from
 * OV_OAUTH_CLIENT_ID/OV_OAUTH_CLIENT_SECRET and cached until 60 s before expiry by openvibe-sdk/auth; a
 * 401 drops the cache and the call is tried once more. A Bench that cannot answer is a 503 to the caller
 * and the race stays unjudged: names are only revealed after the match is recorded.
 *
 * Bench has no matchmaker endpoint yet (checked 2026-11-13, Contracts 0.422.0), so the matchmaker fallback
 * lives in server/races/matchmaker.js.
 */
const contracts = require('openvibe-contracts');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const BENCH_JUDGE = 'bench.judgement.cast';

class BenchError extends Error {
    constructor(status, code, detail) {
        super(detail || code);
        this.name = 'BenchError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

/**
 * createBenchRecorder({ config, fetchImpl, now, log }) → { enabled, note, record, status }.
 * `enabled` is false without OV_OAUTH_CLIENT_SECRET (Run cannot mint the Bench token); record() then
 * answers 503 and nothing is sent.
 */
function createBenchRecorder({ config = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const bench = config.bench || {};
    const url = String(bench.url || '').replace(/\/+$/, '');
    const audience = bench.audience || 'openvibe.bench';
    const timeoutMs = bench.timeoutMs || 8000;
    const { clientId, clientSecret } = config.oauth || {};
    const tokens = clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId, clientSecret, audience, scope: BENCH_JUDGE, fetch: fetchImpl, now })
        : null;
    const enabled = Boolean(tokens && url);
    const note = enabled
        ? `Bench matches: ${url}, audience ${audience}, capability ${BENCH_JUDGE}`
        : 'Bench matches are off: OV_OAUTH_CLIENT_SECRET is unset, so Run cannot mint its Network client-credentials token';

    /** One call: mint (or reuse) the token, fetch, and turn Bench's answer into a value or a BenchError. */
    async function call(match) {
        if (!enabled) throw new BenchError(503, 'run.bench_unavailable', note);
        for (let attempt = 0; ; attempt++) {
            const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
            try { Object.assign(headers, await tokens.authHeaders()); }
            catch (e) { throw new BenchError(503, 'run.bench_unavailable', 'Run could not mint its Bench token from Network'); }
            let res;
            try {
                res = await fetchImpl(`${url}/api/v1/matches`, {
                    method: 'POST', headers, body: JSON.stringify(match), signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (e) {
                const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
                throw new BenchError(503, 'run.bench_unavailable', `Bench did not answer (${why}); the race stays unjudged`);
            }
            // A rotated or clock-skewed token: drop the cache and try once more.
            if (res.status === 401 && attempt === 0) { tokens.invalidate(); continue; }
            const doc = await res.json().catch(() => null);
            if (res.ok && doc) return { created: res.status === 201, match: doc.match || null };
            const code = doc && typeof doc.code === 'string' ? doc.code : null;
            const detail = doc && typeof doc.detail === 'string' ? doc.detail.slice(0, 300) : null;
            const why = `Bench answered HTTP ${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
            if (res.status >= 500) throw new BenchError(503, 'run.bench_unavailable', `${why}; the race stays unjudged`);
            throw new BenchError(502, 'run.bench_refused', `${why}; the race stays unjudged`);
        }
    }

    return {
        enabled,
        note,
        /** Record one match. The body is validated against bench.match@1 here, before any call. */
        async record(match) {
            contracts.assertValid('bench.match@1', match);
            return call(match);
        },
        status: () => ({ enabled, note, url, audience, capability: BENCH_JUDGE, timeout_ms: timeoutMs }),
    };
}

module.exports = { createBenchRecorder, BenchError, BENCH_JUDGE };
