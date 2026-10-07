'use strict';

/**
 * run.job.* events (contracts/events/payloads/run.job.*@1; migrations/0001_jobs.sql, run_events_outbox).
 *
 * Every emitter takes the caller's transaction handle t and the row the change produced, so the event is
 * written in the same transaction as the state change: an event exists if and only if its change
 * committed. The outbox row's event_id is `run:<job id>:<state>` — one row per (job, state), so a replay
 * (a retry, a double cancel) is the row that is already there and never a second event:
 *
 *   run.job.queued     state queued     event_id run:<id>:queued
 *   run.job.started    state running    event_id run:<id>:running
 *   run.job.succeeded  state succeeded  event_id run:<id>:succeeded
 *   run.job.failed     state failed     event_id run:<id>:failed
 *   run.job.cancelled  state cancelled  event_id run:<id>:cancelled
 *   run.job.expired    state expired    event_id run:<id>:expired
 *
 * The payload is the run.job-read-result@1 projection the payload contract describes — job_id,
 * project_id, requester, state, class, artifact, egress, placement, timings, exit, usage, error — never
 * args, inputs, the result body or the job's stdout, and never a credential.
 *
 * The row's key and the envelope's event_id are two different things on purpose. run_events_outbox is
 * keyed by Run's own `run:<job id>:<state>` (above), while the published envelope carries an `evt_<ULID>`
 * document id: events.event-envelope@1 (additionalProperties false) pins event_id to
 * `^evt_[0-9A-HJKMNP-TV-Z]{26}$`, and OpenVibe.Events validates every published envelope against it, so
 * the dossier's key cannot itself be the envelope's event_id — a row inserted with it would be published
 * and then refused. The row is written here, in the caller's transaction (the openvibe-sdk relay is the
 * only thing that moves rows to the bus); `enqueueOnce` returns whether the row is new, so a replay is a
 * quiet no-op rather than an error.
 */
const contracts = require('openvibe-contracts');
const { toJob } = require('./store');
const { ACTOR, TABLE } = require('../events/outbox');

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Event name per state, the state its payload carries, and its priority when the payload contract names
 * one (queued and started are low, failed is important; the other three say "normal", which
 * events.event-envelope@1 has no value for — the envelope's own default stands).
 */
const EVENT_OF_STATE = {
    queued: { event: 'run.job.queued', state: 'queued', contract: 'run.job.queued@1', priority: 'low' },
    // The job's state is `running`; its event — and so its payload contract — is run.job.started.
    running: { event: 'run.job.started', state: 'running', contract: 'run.job.started@1', priority: 'low' },
    succeeded: { event: 'run.job.succeeded', state: 'succeeded', contract: 'run.job.succeeded@1', priority: null },
    failed: { event: 'run.job.failed', state: 'failed', contract: 'run.job.failed@1', priority: 'important' },
    cancelled: { event: 'run.job.cancelled', state: 'cancelled', contract: 'run.job.cancelled@1', priority: null },
    expired: { event: 'run.job.expired', state: 'expired', contract: 'run.job.expired@1', priority: null },
};

/** The payload: run.job-read-result@1 without args, inputs, result or output. */
function payloadOf(row) {
    const job = toJob(row);
    return {
        job_id: job.id,
        project_id: job.project_id,
        requester: job.requester,
        state: job.state,
        class: job.class,
        artifact: job.artifact,
        egress: job.egress,
        placement: job.placement,
        timings: job.timings,
        exit: job.exit,
        usage: job.usage,
        error: job.error,
    };
}

/**
 * createRunEvents({ outbox, now }) → one emitter per state plus emit(t, row, state). Every emitter
 * validates the payload against its released contract before it reaches the outbox, so a projection bug
 * is an error here rather than a malformed event on the bus.
 */
function createRunEvents({ outbox, now = () => Date.now(), log = console }) {
    /**
     * The outbox row for one (job, state), written in the caller's transaction. The row's key is
     * `run:<job id>:<state>`; a row that is already there is left alone (ON CONFLICT DO NOTHING), which is
     * what makes a replay one row. → { envelope, enqueued }.
     */
    async function enqueueOnce(t, row, spec, payload, traceparent) {
        const key = `run:${row.id}:${spec.state}`;
        const prepared = outbox.events.prepare({
            event_type: spec.event,
            version: 1,
            source: 'run',
            actor: ACTOR,
            timestamp: new Date(now()).toISOString(),
            subject: { type: 'job', id: row.id },
            visibility: 'internal',
            ...(spec.priority ? { priority: spec.priority } : {}),
            payload,
        }, { now: now() });
        contracts.assertValid('events.event-envelope@1', prepared);
        const trace = traceparent && TRACEPARENT_RE.test(traceparent) ? traceparent : null;
        const inserted = await t.maybe(
            `INSERT INTO ${TABLE} (event_id, envelope, traceparent, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
            [key, JSON.stringify(prepared), trace, now()]);
        if (inserted && log && log.debug) log.debug(`[Run] ${spec.event} ${row.id}`);
        return { envelope: prepared, enqueued: Boolean(inserted) };
    }

    async function emit(t, row, state, { traceparent } = {}) {
        const spec = EVENT_OF_STATE[state];
        if (!spec) throw new Error(`run.job.*: ${state} is not a state Run emits (${Object.keys(EVENT_OF_STATE).join(', ')})`);
        const payload = payloadOf(row);
        // The payload contract is the event's own (run.job.started@1 for the running state: a state and
        // its event name are not always the same word, and run.job.running@1 does not exist).
        contracts.assertValid(spec.contract, payload);
        return enqueueOnce(t, row, spec, payload, traceparent);
    }

    return {
        emit,
        queued: (t, row, opts) => emit(t, row, 'queued', opts),
        started: (t, row, opts) => emit(t, row, 'running', opts),
        succeeded: (t, row, opts) => emit(t, row, 'succeeded', opts),
        failed: (t, row, opts) => emit(t, row, 'failed', opts),
        cancelled: (t, row, opts) => emit(t, row, 'cancelled', opts),
        expired: (t, row, opts) => emit(t, row, 'expired', opts),
        /** The emitter for a row that just reached its state (used by the dispatcher bridge, step 6). */
        ofState: (t, row, opts) => emit(t, row, row.state, opts),
    };
}

module.exports = { createRunEvents, payloadOf, EVENT_OF_STATE, TRACEPARENT_RE };
