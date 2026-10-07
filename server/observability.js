'use strict';

/**
 * Truthful readiness (GET /api/ready) and the Run gauges (GET /metrics, loopback only).
 *
 *   db            required  a real round trip through the pool (db.ready(): the store that answered)
 *   valkey        optional  a real PING; without it nothing is shared between processes
 *   network_jwks  optional  the Network signing key has loaded; without it no token can be verified
 *   events        optional  OpenVibe.Events answers /api/health; without it run.job.* events wait in the outbox
 *   bot           optional  OpenVibe.Bot answers /api/health; skipped until the dispatcher bridge exists
 *
 * Gauges: jobs queued, placed or running, ended, and the outbox backlog. Counts only, never subjects, and
 * never a job's payload; a scrape whose read failed leaves them out.
 */
const { sql } = require('openvibe-sdk/db');
const { createReadiness, skip } = require('openvibe-shared/ready');
const { TABLE: OUTBOX } = require('./events/outbox');

const PING_TTL_MS = 15_000;

function probe(url, fetchImpl) {
    return async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
        try { await res.body?.cancel(); } catch { /* not needed */ }
        return res.ok ? { ok: true, detail: { http_status: res.status } } : { ok: false, error: `answered HTTP ${res.status}`, detail: { http_status: res.status } };
    };
}

function createRunReadiness({ db, valkey = null, keys, config, outbox, stream = null, dispatch = null, release = null, fetchImpl = globalThis.fetch }) {
    const events = outbox.enabled
        ? probe(`${config.events.url}/api/health`, fetchImpl)
        : () => skip('events relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset): run.job.* events wait in the outbox');
    const bot = dispatch && dispatch.enabled
        ? probe(`${config.dispatch.botUrl}/api/health`, fetchImpl)
        : () => skip('the dispatcher bridge to Bot is not built yet (plan T14 step 6): jobs stay queued');
    return createReadiness({
        service: 'run',
        release,
        checks: [
            { name: 'db', required: true, check: () => db.ready() },
            { name: 'valkey', required: false, check: () => (valkey ? valkey.ready() : skip('VALKEY_URL unset: nothing is shared between processes (one process only)')) },
            { name: 'network_jwks', required: false, check: () => (keys.get() ? true : 'Network signing key not loaded yet: tokens cannot be verified') },
            { name: 'events', required: false, cacheMs: outbox.enabled ? PING_TTL_MS : 0, timeoutMs: 2500, check: events },
            { name: 'bot', required: false, cacheMs: dispatch && dispatch.enabled ? PING_TTL_MS : 0, timeoutMs: 2500, check: bot },
        ],
        details: async (body) => (body.checks.db.status === 'ok'
            ? { jobs_queued: await queued(db), events_outbox: await outbox.status(), streams: stream ? stream.status().streams : null }
            : { jobs_queued: null, events_outbox: null, streams: null }),
    });
}

async function queued(db) {
    return Number(await db.value(`SELECT count(*)::int FROM run_jobs WHERE state = 'queued'`) || 0);
}

/** Run's gauges on the openvibe-shared/metrics registry; refresh() reads them all in one query. */
function registerRunGauges(registry, { db, stream = null, now = () => Date.now(), log = console }) {
    let snap = null;
    const read = (f) => () => (snap ? f(snap) : undefined);
    registry.gauge({ name: 'run_jobs_queued', help: 'Jobs stored and waiting for a node', collect: read((s) => s.queued) });
    registry.gauge({ name: 'run_jobs_active', help: 'Jobs placed or running on a node', collect: read((s) => s.active) });
    registry.gauge({ name: 'run_jobs_ended', help: 'Jobs in an end state', collect: read((s) => s.ended) });
    registry.gauge({ name: 'run_outbox_pending', help: 'run.job.* events waiting in the outbox', collect: read((s) => s.outbox) });
    registry.gauge({ name: 'run_streams', help: 'Open job streams on this process', collect: () => (stream ? stream.status().streams : undefined) });
    return {
        async refresh() {
            try {
                snap = await Promise.race([
                    db.one(sql`SELECT
                        (SELECT count(*) FROM run_jobs WHERE state = 'queued')::int AS queued,
                        (SELECT count(*) FROM run_jobs WHERE state IN ('placed', 'running'))::int AS active,
                        (SELECT count(*) FROM run_jobs WHERE state IN ('succeeded', 'failed', 'cancelled', 'expired'))::int AS ended,
                        (SELECT count(*) FROM ${sql.ident(OUTBOX)} WHERE sent_at IS NULL AND rejected_at IS NULL)::int AS outbox`),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
                ]);
            } catch (e) {
                snap = null;
                log.warn(`[Run] gauges not read: ${e.message}`);
            }
        },
    };
}

module.exports = { createRunReadiness, registerRunGauges };
