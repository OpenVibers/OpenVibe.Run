'use strict';

/**
 * Run → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   run.job.queued      a job was stored queued (POST /api/v1/jobs; never for an idempotent repeat)
 *   run.job.started     the node sent job_started
 *   run.job.succeeded   job_exit reason exited with code 0
 *   run.job.failed      job_exit with another code, or reason limit, stopped or failed
 *   run.job.cancelled   POST /api/v1/jobs/:id/cancel, or job_exit reason cancelled
 *   run.job.expired     ttl_ms ran out (run.job.unplaceable or run.job.ttl)
 *
 * A row is written inside the transaction that makes the change (jobs/events.js: the row is keyed by
 * `run:<job id>:<state>`, and it validates its envelope against events.event-envelope@1 and its payload
 * against run.job.<state>@1 itself), so an event exists if and only if its change committed. This module
 * owns the relay: it publishes with Run's service token (events.event.publish) when EVENTS_URL and
 * OV_OAUTH_CLIENT_SECRET are set, and otherwise rows wait in run_events_outbox and status() says so.
 * Payloads carry ids, states and results only — never a credential, never the job's stdout.
 */
const { createServiceOutbox } = require('openvibe-sdk/events');

const TABLE = 'run_events_outbox';   // migrations/0001_jobs.sql
const ACTOR = { type: 'service', id: 'run' };
const EVENT_TYPES = ['run.job.queued', 'run.job.started', 'run.job.succeeded', 'run.job.failed', 'run.job.cancelled', 'run.job.expired'];

function createRunOutbox({ db, config, fetchImpl, now, log = console }) {
    return createServiceOutbox({
        db,
        source: 'run',
        table: TABLE,
        eventsUrl: config.events.url,
        networkInternalUrl: config.network.internalUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.intervalMs,
        log,
        eventTypes: EVENT_TYPES,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...(now ? { now } : {}),
    });
}

module.exports = { createRunOutbox, TABLE, ACTOR, EVENT_TYPES };
