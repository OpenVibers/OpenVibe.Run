'use strict';

/**
 * Run's own metering (plan T14 R4a, decision B): the usage of a job an external managed-browser provider ran.
 * Bot meters every job it carries and Run never posts those; a provider is not a paired Node and writes no usage,
 * so for its jobs — and only for them — Run queues the readings and posts them to OpenVibe.Billing's
 * billing.usage.record (POST <RUN_BILLING_URL>/api/v1/usage, one reading per request), the pattern of OpenVibe.Bot's
 * server/jobs/metering.js.
 *
 * The readings: one platform.usage-sample@1 per wall-clock second Run bills — the provider's claim clamped to Run's
 * own observed duration plus 5 s (server/dispatch/browser-provider.js meter()) — written in the transaction that
 * settles the job, so they exist if and only if the end state committed. id = idempotency_key = run:<job id>:<n>
 * (the key platform.job@1 reserves; a provider job never reaches Bot, so the two never meter one job), service run,
 * operation browser.invoke, unit s, quantity 1 (the partial last second (wall_ms mod 1000)/1000), at = Run's own
 * placed_at + n*1000, node the offer the job was placed on, provider browser-provider, source
 * openvibe-run.browser-provider, project and subject from Run's row — never from the provider. `resource` is left
 * out: platform.usage-sample@1 makes it a rate-card metric, never a job id, and no card names one for this yet.
 *
 * The relay (openvibe-sdk createPgOutbox on run_usage_outbox, migrations/0003_usage_outbox.sql) runs while
 * RUN_BILLING_URL and OV_OAUTH_CLIENT_SECRET are set: Run mints a Network service token for audience
 * openvibe.billing holding billing.usage.record and uses it for nothing else. Unset: readings wait in the table,
 * nothing is sent, and the jobs still run. Billing down, 401/403/404/429/5xx: retried with backoff across
 * restarts, never dropped. Billing refusing the reading itself (400, 409, 413, 422): the row is kept with its
 * error and never sent again, so nothing is billed twice. The token is never logged.
 */
const contracts = require('openvibe-contracts');
const { createPgOutbox } = require('openvibe-sdk/events');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const TABLE = 'run_usage_outbox';
const SCHEMA = 'platform.usage-sample@1';
const SERVICE = 'run';
const OPERATION = 'browser.invoke';
const UNIT = 's';
const SOURCE = 'openvibe-run.browser-provider';
const BILLING_SCOPE = 'billing.usage.record';
const REFUSED = new Set([400, 409, 413, 422]);

/**
 * The readings a billed wall clock stands for: seconds 0 … floor(wallMs/1000)-1 with quantity 1 and, when
 * wallMs mod 1000 > 0, second floor(wallMs/1000) with quantity (wallMs mod 1000)/1000. Nothing for 0 ms.
 */
function readingsOf({ jobId, wallMs, startMs, node, provider, project, subject }) {
    if (!Number.isInteger(wallMs) || wallMs < 0) throw new TypeError(`wall_ms must be an integer >= 0, not ${wallMs}`);
    if (!Number.isInteger(startMs) || startMs < 0) throw new TypeError('the start must be an integer >= 0');
    const one = (n, quantity) => {
        const key = `run:${jobId}:${n}`;
        const r = {
            id: key, idempotency_key: key, service: SERVICE, operation: OPERATION, unit: UNIT, quantity,
            at: new Date(startMs + n * 1000).toISOString(), source: SOURCE,
        };
        if (node) r.node = node;
        if (provider) r.provider = provider;
        if (project) r.project = project;
        if (subject) r.subject = subject;
        return r;
    };
    const full = Math.floor(wallMs / 1000);
    const out = [];
    for (let n = 0; n < full; n++) out.push(one(n, 1));
    if (wallMs % 1000 > 0) out.push(one(full, (wallMs % 1000) / 1000));
    return out;
}

/** Queue readings inside the caller's transaction; a key already queued changes nothing. → how many were new. */
async function enqueue(t, readings, at) {
    let added = 0;
    for (const reading of readings) {
        contracts.assertValid(SCHEMA, reading);
        const row = await t.maybe(`INSERT INTO ${TABLE} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
            [reading.idempotency_key, JSON.stringify(reading), at]);
        if (row) added++;
    }
    return added;
}

// createPgOutbox's `events` seam pointed at Billing. isPermanent() reads err.status: 422 rejects the row, 503 retries.
function billingSink({ url, authorization, onUnauthorized, fetchImpl, timeoutMs }) {
    return {
        prepare: (reading) => reading,
        async publish(reading) {
            const res = await fetchImpl(`${url}/api/v1/usage`, {
                method: 'POST', redirect: 'error',
                headers: { Authorization: await authorization(), 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(reading), signal: AbortSignal.timeout(timeoutMs),
            });
            await res.body?.cancel?.().catch(() => {});
            // A minted token Billing no longer accepts (rotated key, clock): drop it so the next sweep mints afresh.
            if (res.status === 401 && onUnauthorized) onUnauthorized();
            // 201 written, 200 an identical reading replayed: either way Billing holds it.
            if (!res.ok) { const err = new Error(`billing.usage.record answered ${res.status}`); err.status = REFUSED.has(res.status) ? 422 : 503; throw err; }
            return { event_id: reading.id, seq: null };
        },
    };
}

/**
 * createUsageRelay({ db, config, fetchImpl, now, log }) → { enabled, note, start, stop, kick, flush, pending,
 * rejected, status }. Off (every call a no-op) without RUN_BILLING_URL or OV_OAUTH_CLIENT_SECRET.
 */
function createUsageRelay({ db, config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const { url, audience, intervalMs, timeoutMs } = config.billing;
    const { clientId, clientSecret } = config.oauth;
    const count = (where) => (db ? db.value(`SELECT count(*)::int FROM ${TABLE} WHERE ${where}`).then(Number) : Promise.resolve(0));
    const pending = () => count('sent_at IS NULL AND rejected_at IS NULL');
    const rejected = () => count('rejected_at IS NOT NULL');
    const enabled = Boolean(db && url && clientSecret);
    const note = enabled
        ? `the usage relay to Billing: ${url}, audience ${audience}, capability ${BILLING_SCOPE} (external-provider jobs only)`
        : !url ? 'the usage relay is off: RUN_BILLING_URL is unset (external-provider readings wait in run_usage_outbox)'
            : 'the usage relay is off: OV_OAUTH_CLIENT_SECRET is unset, so Run cannot mint its Billing token (readings wait)';
    if (!enabled) {
        const idle = async () => ({ sent: 0, failed: 0, rejected: 0 });
        return { enabled, note, start() {}, stop: async () => {}, kick() {}, flush: idle, pending, rejected, status: () => ({ enabled, note }) };
    }
    const tokens = createServiceTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId, clientSecret, audience, scope: BILLING_SCOPE, fetch: fetchImpl, now,
    });
    const authorization = async () => {
        try { return (await tokens.authHeaders()).Authorization; }
        catch (e) { const err = new Error('Run could not mint its Billing token from Network'); err.status = 503; throw err; }
    };
    let lastError = null;
    const relay = createPgOutbox(db, {
        events: billingSink({ url, authorization, onUnauthorized: () => tokens.invalidate(), fetchImpl, timeoutMs }),
        table: TABLE, batchSize: 1, intervalMs, now,
        onError: (err) => { const m = err && err.message; if (m !== lastError) log.warn(`[Run] usage reading not delivered: ${m}`); lastError = m; },
    });
    return {
        enabled, note, pending, rejected,
        start: relay.start, stop: relay.stop, kick: relay.kick, flush: relay.flush,
        status: () => ({ enabled, note, billing_url: url, audience, capability: BILLING_SCOPE, interval_ms: intervalMs, last_error: lastError }),
    };
}

module.exports = { readingsOf, enqueue, createUsageRelay, TABLE, SERVICE, OPERATION, UNIT, SOURCE };
