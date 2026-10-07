'use strict';

/**
 * The dispatcher bridge Run → Bot — SEAM ONLY: plan T14 step 6 (R1c) builds this, and every method here
 * is a no-op until then. Run accepts jobs, scopes them to a project and queues them (plan T14 step 5,
 * R1b); it does not yet hand them to a node, so every job stays `queued` and no node ever sees it.
 *
 * Bot owns the node link and the per-second metering (OpenVibe.Bot server/jobs: dispatch(), cancel(),
 * createJobFrames(); migrations/0004_run_jobs.sql). Step 6 replaces this module with the real bridge:
 *
 *   place(row)   the platform.job@1 body — store.frameOf(row.job), the job record's own platform keys,
 *                validated against platform.job@1, never the requirements/placed_at/cancel_requested Run
 *                keeps beside it — sent to Bot with Run's service token `svc:run` for audience
 *                openvibe.bot holding bot.job.dispatch, which places it on a node advertising
 *                worker:<class>
 *   poll()       what Bot answered since the last poll; store.mirror() copies state, placement, timings,
 *                exit, result and the metered wall clock back, store.settle() reaches the end state, and
 *                jobs/events.js emits run.job.started|succeeded|failed|cancelled|expired in the same
 *                transaction; stream.js carries the job's stdout
 *   cancel(row)  a job whose cancel_requested marker is set: Bot's job_cancel
 *   sweep()      ttl_ms ran out before placement: settle expired with run.job.unplaceable or run.job.ttl
 *
 * The interface is fixed here so server/index.js and the API already call it the way the bridge will be
 * called; only this file changes in step 6. The seam is never enabled by configuration: RUN_BOT_URL and
 * RUN_BOT_AUDIENCE (server/config.js) are read only by the real bridge.
 */

/** The runtime class a job needs a node to advertise (platform.resource-offer@1 `worker:<class>`). */
const workerCapability = (runtimeClass) => `worker:${runtimeClass}`;

/**
 * createDispatcher({ config, db, store, events, stream, log, now }) → the dispatcher interface.
 * `enabled` is false until plan T14 step 6: nothing is sent to a node, nothing is mirrored.
 */
function createDispatcher({ config = null, db = null, store = null, events = null, stream = null, log = console, now = () => Date.now() } = {}) {
    const enabled = false;
    const note = 'the dispatcher bridge to Bot is not built yet (plan T14 step 6, R1c): every job stays queued';

    /** Send a queued job to a node. → { placed, reason }. No-op until step 6. */
    async function place(row) {
        return { placed: false, reason: 'dispatcher.noop', job_id: row && row.id, worker: row && workerCapability(row.class) };
    }

    /** Cancel a placed or running job on its node (after the API marked cancel_requested). → { cancelled, reason }. */
    async function cancel(row) {
        return { cancelled: false, reason: 'dispatcher.noop', job_id: row && row.id };
    }

    /** What Bot answered since the last poll. → [ { job_id, state, … } ]. Empty until step 6. */
    async function poll() { return []; }

    /** The ttl sweep: jobs whose ttl_ms ran out before placement (run.job.unplaceable / run.job.ttl). → [ { job_id, state } ]. */
    async function sweep() { return []; }

    function start() { /* step 6 starts the poller here; nothing runs at module load */ }
    function stop() {}

    return {
        enabled, note, place, cancel, poll, sweep, start, stop,
        status: () => ({ enabled, note, bot_url: config ? config.dispatch.botUrl : null, audience: config ? config.dispatch.botAudience : null }),
        now,
        // Kept so step 6's bridge has its dependencies in one place without changing the seam's signature.
        deps: { config, db, store, events, stream, log },
    };
}

module.exports = { createDispatcher, workerCapability };
