'use strict';

/**
 * The dispatcher bridge Run → Bot (plan T14 step 6, R1c; step 7, R3). Run accepts jobs, scopes them to a
 * project and queues them (plan T14 step 5, R1b); this module is what makes a queued job run on a node:
 *
 *   place(row)   the platform.job@1 body — store.frameOf(row.job), the job record's own platform keys,
 *                never the requirements/placed_at/cancel_requested Run keeps beside it — is placed on a
 *                node from OpenVibe.Network's offers (server/dispatch/placement.js, openvibe-sdk/placement
 *                plan()) advertising worker:<class>, and sent to Bot with Run's service token `svc:run` for
 *                audience openvibe.bot holding bot.job.dispatch (server/dispatch/bot.js). Run records the
 *                node, provider and region on its own row (store.mirror).
 *   poll()       one tick of the loop (server/jobs/poller.js, RUN_POLL_MS): the ttl sweep, the placement of
 *                every queued job, and the mirror of every placed or running job — state, placement,
 *                timings, exit, result and the metered wall clock — with run.job.started|succeeded|failed|
 *                cancelled|expired emitted once each (jobs/events.js, in the state change's transaction) and
 *                the job's stdout carried into stream.js.
 *   cancel(row)  a job whose cancel_requested marker is set: Bot's job_cancel, once per job (Bot repeats it
 *                on every reconnect until the job ends). The job reaches `cancelled` when Bot says so.
 *   sweep()      ttl_ms ran out before placement: settle expired with run.job.unplaceable (never placed) or
 *                run.job.ttl (a node may hold it), and cancel on Bot.
 *
 * The managed-browser provider (plan T14 R4a, server/dispatch/browser-provider.js): with RUN_BROWSER_PROVIDER_URL
 * and its key set, class browser jobs may be placed on a kind=provider offer named `browser-provider` and sent to
 * the provider instead of Bot; Run meters those jobs itself (clamped to its own observed duration + 5 s) and its
 * usage relay (server/jobs/usage.js) posts the readings to Billing. The rest of the bridge is unchanged.
 *
 * `enabled` is false when neither Bot nor the provider can be called: without Network client credentials
 * (OV_OAUTH_CLIENT_SECRET) Run cannot mint the token Bot requires, and without the provider's URL and key the
 * adapter is off, so nothing is sent and every job stays queued — the same no-op the seam was before step 6,
 * now for a stated reason. Nothing starts at module load: server/index.js calls start().
 */
const { createBotClient } = require('./bot');
const { createBrowserProviderAdapter, PROVIDER: BROWSER_PROVIDER } = require('./browser-provider');
const { createPlacement, workerCapability } = require('./placement');
const { createPoller } = require('../jobs/poller');
const { createUsageRelay } = require('../jobs/usage');

/**
 * createDispatcher({ config, db, store, events, stream, log, now, fetchImpl, bot, provider, usageRelay,
 * placement }) → the dispatcher interface. Every dependency is injectable so tests build their own Bot,
 * provider, offers and clock.
 */
function createDispatcher({ config = null, db = null, store = null, events = null, stream = null, log = console,
    now = () => Date.now(), fetchImpl = globalThis.fetch, bot = null, provider = null, usageRelay = null, placement = null } = {}) {
    const botClient = bot || createBotClient({ config, fetchImpl, now, log });
    const adapter = provider || createBrowserProviderAdapter({ config, fetchImpl, now, log });
    const relay = usageRelay || createUsageRelay({ db, config, fetchImpl, now, log });
    // Provider offers are placement candidates only while the adapter can be called.
    const placer = placement || createPlacement({ config, fetchImpl, now, log, providers: adapter.enabled ? { [BROWSER_PROVIDER]: ['browser'] } : {} });
    const poller = createPoller({ config, db, store, events, stream, bot: botClient, provider: adapter, usageRelay: relay, placement: placer, now, log });
    const enabled = Boolean(botClient.enabled || adapter.enabled);
    const note = botClient.enabled
        ? (adapter.enabled ? `${botClient.note}; ${adapter.note}` : botClient.note)
        : adapter.enabled
            ? `${adapter.note}; ${botClient.note}: only browser jobs on the provider leave queued`
            : `${botClient.note}: every job stays queued (plan T14 step 6 is built, but Run cannot call Bot)`;

    /** Send a queued job to a node. → { placed, reason }. Never throws: the poller retries. */
    async function place(row) {
        if (!enabled) return { placed: false, reason: 'dispatch.disabled', job_id: row && row.id, worker: row && workerCapability(row.class) };
        try {
            const answer = await poller.placeOne(row, now());
            // placed means a node holds the job now (a job that ended here — no offer, a refusal — has none).
            return { placed: Boolean(answer.node_id), reason: answer.reason || answer.error || null, job_id: answer.job_id, node_id: answer.node_id || null, worker: workerCapability(row.class) };
        } catch (e) {
            log.warn(`[Run] job ${row && row.id}: placement failed (${e.code || e.message})`);
            return { placed: false, reason: e.code || 'dispatch.error', job_id: row && row.id, worker: row && workerCapability(row.class) };
        }
    }

    /** Cancel a placed or running job on its node (after the API marked cancel_requested). → { cancelled, reason }. */
    async function cancel(row) {
        if (!enabled) return { cancelled: false, reason: 'dispatch.disabled', job_id: row && row.id };
        const out = await poller.cancelNow(row);
        return { ...out, job_id: row && row.id };
    }

    const poll = () => (enabled ? poller.tick() : Promise.resolve([]));
    const sweep = () => (enabled ? poller.sweep() : Promise.resolve([]));

    return {
        enabled, note, place, cancel, poll, sweep,
        // Codes C9c: may this job run pinned to that machine now? → { ok, offer? , code?, detail? }; throws when
        // Network cannot be read (the caller answers 503, never a guessed offline).
        pinStatus: (nodeId, runtimeClass, requester, opts) => placer.pinStatus(nodeId, runtimeClass, requester, opts),
        start: () => { relay.start(); return poller.start(); },
        stop: () => { poller.stop(); return relay.stop(); },
        status: () => ({
            enabled, note,
            bot_url: config ? config.dispatch.botUrl : null,
            audience: config ? config.dispatch.botAudience : null,
            browser_provider: adapter.status(),
            usage_relay: relay.status(),
            placement: placer.status(),
            poller: poller.status(),
        }),
        now,
        // Kept so step 6's bridge has its dependencies in one place without changing the seam's signature.
        deps: { config, db, store, events, stream, log, bot: botClient, provider: adapter, usageRelay: relay, placement: placer, poller },
    };
}

module.exports = { createDispatcher, workerCapability };
