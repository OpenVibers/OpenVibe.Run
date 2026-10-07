'use strict';

/**
 * /api/v1 — Run's job API for services (capability-guarded Network tokens for audience openvibe.run).
 * The route → capability map is fixed by the six capability manifests (contracts/manifests/capabilities/
 * run.job.*.json) and must not be invented:
 *
 * | Method & path                     | Capability       | Request → answer                              |
 * |-----------------------------------|------------------|-----------------------------------------------|
 * | POST /jobs                        | run.job.submit   | run.job-create-request@1 → run.job-create-result@1 (201 created, 200 idempotent repeat) |
 * | GET  /jobs/:id                    | run.job.read     | common.no-body@1 → run.job-read-result@1       |
 * | GET  /jobs?state=&limit=&cursor=  | run.job.list     | run.job-list-query@1 → run.job-list-result@1   |
 * | POST /jobs/:id/cancel             | run.job.cancel   | common.no-body@1 → run.job-read-result@1       |
 * | POST /jobs/:id/stream/ticket      | run.job.stream   | common.no-body@1 → run.job-stream-ticket-result@1 |
 * | GET  /jobs/:id/stream             | run.job.stream   | a ticket (never a service token) → text/event-stream of run.job-stream-event@1 |
 * | GET  /admin/jobs                  | run.job.admin    | run.job-list-query@1 (with project_id) → run.job-list-result@1 |
 *
 * The project and the requester always come from the token (claims.project_id, claims.sub), NEVER from the
 * body: a body field is never read for either. run.job.admin additionally reads and cancels any project's
 * job (the manifest says so) and is the only way to pass project_id to a list. Another project's job is
 * always 404 run.job_not_found, never 403: the answer must not say whether the id exists.
 *
 * Errors are RFC 9457 problem+json: 400 run.invalid_request (the body does not match its contract), 401
 * token.required / ticket.*, 403 capability.denied / run.project_required, 404 run.job_not_found, 409
 * run.idempotency.conflict, 413 run.args_too_large, 422 run.limits.exceeded / run.invalid_input.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { ids } = contracts;
const { fail, iso, isJobId } = require('../util');
const store = require('../jobs/store');

// The six capabilities this router enforces, one per route above (contracts/manifests/capabilities).
const CAP = {
    submit: 'run.job.submit',
    read: 'run.job.read',
    list: 'run.job.list',
    cancel: 'run.job.cancel',
    stream: 'run.job.stream',
    admin: 'run.job.admin',
};
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const STATES = ['queued', 'placed', 'running', 'succeeded', 'failed', 'cancelled', 'expired'];

/** POST /jobs: validate a run.job-create-request@1 body, or answer 400 with the contract's own errors. */
function validCreate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'run.invalid_request', 'the body must be a JSON object (run.job-create-request@1)');
    const v = contracts.validate('run.job-create-request@1', body);
    if (!v.valid) {
        const err = new Error('the body does not match run.job-create-request@1');
        err.status = 400;
        err.code = 'run.invalid_request';
        err.detail = v.errors.map((e) => `${e.path} ${e.message}`).join('; ').slice(0, 1000);
        err.extra = { errors: v.errors.slice(0, 20) };
        throw err;
    }
    return body;
}

/** The project's own caps (server/config.js): a request over one is refused 422, never silently lowered. */
function checkLimits(body, caps) {
    if (body.limits.wall_ms > caps.maxWallMs) fail(422, 'run.limits.exceeded', `limits.wall_ms is at most ${caps.maxWallMs} ms for a project`);
    if (body.limits.cpu_ms > caps.maxCpuMs) fail(422, 'run.limits.exceeded', `limits.cpu_ms is at most ${caps.maxCpuMs} ms for a project`);
    if (body.limits.mem_bytes > caps.maxMemBytes) fail(422, 'run.limits.exceeded', `limits.mem_bytes is at most ${caps.maxMemBytes} bytes for a project`);
    // The lifetime is checked whether the caller named it or took the contract's default
    // (limits.wall_ms + 600000): a default that lands over the cap is refused, never quietly shortened.
    const ttl = body.ttl_ms != null ? body.ttl_ms : body.limits.wall_ms + 600_000;
    if (ttl > caps.maxTtlMs) fail(422, 'run.limits.exceeded', `ttl_ms is at most ${caps.maxTtlMs} ms for a project (${body.ttl_ms != null ? 'asked for' : 'the default, limits.wall_ms + 600000, is'} ${ttl} ms)`);
    if (body.args !== undefined && Buffer.byteLength(JSON.stringify(body.args)) > caps.maxArgsBytes) fail(413, 'run.args_too_large', `args serialize to at most ${caps.maxArgsBytes} bytes`);
    const names = (body.inputs || []).map((i) => i.name);
    if (new Set(names).size !== names.length) fail(422, 'run.invalid_input', 'input names must be unique');
    // egress public/openvibe-only is not refused here: which node may run it is placement's decision and
    // the job waits queued until a node offers it (the dispatcher bridge, plan T14 step 6).
}

/** The idempotency key of a submit: body.idempotency_key or the Idempotency-Key header, never disagreeing. */
function idempotencyKey(req, body) {
    const header = req.get('Idempotency-Key');
    const inBody = body.idempotency_key;
    if (header != null && inBody != null && header !== inBody) fail(422, 'run.invalid_input', 'the Idempotency-Key header and body.idempotency_key disagree');
    const key = header != null ? header : inBody;
    if (key == null) return `auto:${ids.ulid().toLowerCase()}`;
    if (!IDEMPOTENCY_RE.test(key)) fail(422, 'run.invalid_input', 'idempotency_key must match ^[A-Za-z0-9._:-]{1,128}$');
    return key;
}

/** GET /jobs and GET /admin/jobs: a run.job-list-query@1 query string, or 400. */
function listQuery(query) {
    const q = {
        ...(query.state !== undefined ? { state: query.state } : {}),
        ...(query.project_id !== undefined ? { project_id: query.project_id } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    };
    const v = contracts.validate('run.job-list-query@1', q);
    if (!v.valid) fail(400, 'run.invalid_request', `the query does not match run.job-list-query@1: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    return { state: q.state ?? null, project_id: q.project_id ?? null, limit: q.limit === undefined ? 50 : Number(q.limit), cursor: q.cursor ?? null };
}

/** The archived run.job-stream-ticket-result@1 answer (validated against its contract before it is sent). */
function ticketResult({ ticket, expiresAtMs, expiresIn, streamUrl, jobId }) {
    const body = { ticket, expires_at: iso(expiresAtMs), expires_in: expiresIn, stream_url: streamUrl, job_id: jobId };
    contracts.assertValid('run.job-stream-ticket-result@1', body);
    return body;
}

/**
 * v1Router({ config, db, valkey, apiAuth, stream, tickets, events, dispatch, now, log }).
 * Every route is mounted with apiAuth.requireCapability('run.job.…') — exactly the capability of its
 * manifest — and the middleware of the app ran first, so req.principal is always resolved.
 */
function v1Router({ config, db, apiAuth, stream, tickets, events, dispatch, now = () => Date.now(), log = console }) {
    const r = express.Router();
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    /** The route's capability, from the token's grant list (openvibe-contracts capabilities.check). */
    const guard = apiAuth.requireCapability;
    const admin = (req) => apiAuth.granted(req.principal, 'run.job.admin');

    /**
     * One job, scoped to the token's project — or to any project with run.job.admin. Null when the id is
     * not a job id, does not exist, or belongs to another project: all three are the same 404 to the caller.
     */
    async function getJob(req, id) {
        if (!isJobId(id)) return null;
        if (admin(req)) return store.get(db, id, null);
        return store.get(db, id, apiAuth.requireProject(req).project);
    }

    r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

    // ── POST /jobs — run.job.submit ────────────────────────────────────────────
    r.post('/jobs', guard('run.job.submit'), wrap(async (req, res) => {
        const { project: projectId, requester } = apiAuth.requireProject(req);
        const body = validCreate(req.body);
        checkLimits(body, config.limits);
        const key = idempotencyKey(req, body);
        const at = now();
        const out = await db.tx(async (t) => {
            const made = await store.mint(t, body, { projectId, requester, idempotencyKey: key, now: at });
            // The queued event is written in the same transaction as the row (never for an idempotent repeat:
            // the row key run:<job id>:queued is already taken, and that replay is the row that exists).
            if (made.created) await events.queued(t, made.row, { traceparent: req.ov && req.ov.traceparent });
            return made;
        });
        // The job stays queued: the dispatcher bridge is plan T14 step 6 (server/dispatch/index.js).
        if (out.created && dispatch.enabled) await dispatch.place(out.row);
        if (out.created) stream.seed(out.row);
        res.status(out.created ? 201 : 200).json({ created: out.created, job: store.readResult(out.row) });
    }));

    // ── GET /jobs — run.job.list ───────────────────────────────────────────────
    r.get('/jobs', guard('run.job.list'), wrap(async (req, res) => {
        const q = listQuery(req.query);
        // "project_id: Admin only (run.job.admin): list this project's jobs; with run.job.list it is refused 403."
        if (q.project_id && !admin(req)) fail(403, 'capability.denied', 'run.job.admin is required to list another project\'s jobs');
        const projectId = q.project_id || apiAuth.requireProject(req).project;
        const { rows, nextCursor } = await store.list(db, projectId, q);
        res.json({ jobs: rows.map(store.readResult), next_cursor: nextCursor });
    }));

    // ── GET /jobs/:id — run.job.read ───────────────────────────────────────────
    r.get('/jobs/:id', guard('run.job.read'), wrap(async (req, res) => {
        const row = await getJob(req, req.params.id);
        if (!row) fail(404, 'run.job_not_found', 'no such job');
        res.json(store.readResult(row));
    }));

    // ── POST /jobs/:id/cancel — run.job.cancel ─────────────────────────────────
    r.post('/jobs/:id/cancel', guard('run.job.cancel'), wrap(async (req, res) => {
        const row = await getJob(req, req.params.id);
        if (!row) fail(404, 'run.job_not_found', 'no such job');
        const at = now();
        const out = await db.tx(async (t) => {
            const moved = await store.cancel(t, row.id, row.project_id, at);
            if (moved.cancelled) await events.cancelled(t, moved.row, { traceparent: req.ov && req.ov.traceparent });   // run:<id>:cancelled — a replay is the same row
            return moved;
        });
        // A running job is only marked: the dispatcher bridge sends job_cancel and its job_exit ends it (step 6).
        if (out.cancelRequested && dispatch.enabled) await dispatch.cancel(out.row);
        if (out.cancelled) stream.state(out.row.id, out.row.state, at);
        res.json(store.readResult(out.row));
    }));

    // ── POST /jobs/:id/stream/ticket — run.job.stream ──────────────────────────
    r.post('/jobs/:id/stream/ticket', guard('run.job.stream'), wrap(async (req, res) => {
        const row = await getJob(req, req.params.id);
        if (!row) fail(404, 'run.job_not_found', 'no such job');
        if (!tickets.get()) fail(503, 'run.stream.disabled', 'stream tickets are disabled: no stream key is configured (RUN_STREAM_PRIVATE_KEY or RUN_STREAM_KEY_FILE)');
        const { ticket, claims } = tickets.mint({ jobId: row.id, projectId: row.project_id });
        stream.seed(row);   // the stream that follows replays this job's state even if this process never saw it
        res.json(ticketResult({
            ticket, expiresAtMs: claims.exp * 1000, expiresIn: claims.exp - claims.iat,
            streamUrl: `${config.baseUrl}/api/v1/jobs/${row.id}/stream`, jobId: row.id,
        }));
    }));

    // ── GET /jobs/:id/stream — run.job.stream, ticket only ─────────────────────
    // A browser cannot send a header on an EventSource, and a service token must never ride in a query
    // string (it would land in logs): this route accepts the two-minute ticket the POST above mints, and
    // nothing else. The ticket names the job and the project, so the stream is scoped without any query.
    r.get('/jobs/:id/stream', wrap(async (req, res) => {
        const token = Array.isArray(req.query.ticket) ? null : req.query.ticket;
        if (token == null || token === '') fail(401, 'ticket.required', 'open the stream with ?ticket= from POST /api/v1/jobs/:id/stream/ticket');
        const verified = tickets.verify(token);   // single use: the jti is consumed here, so one ticket opens one stream
        if (!verified.ok) fail(401, verified.code, verified.reason);
        if (verified.claims.sub !== req.params.id) fail(403, 'run.stream.ticket_mismatch', 'this ticket is for another job');
        const row = await store.get(db, req.params.id, verified.claims.project);
        if (!row) fail(404, 'run.job_not_found', 'no such job');
        if (!stream.canAttach(row.id)) fail(503, 'run.stream.busy', 'too many streams on this job; try again shortly');

        const lastEventId = Number.parseInt(String(req.get('Last-Event-ID') || req.query.last_event_id || '0'), 10) || 0;
        stream.seed(row);   // a restart or another process: replay the state the row is in

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');   // nginx: never buffer an event stream
        res.flushHeaders?.();

        let sub = null;
        const finish = () => {
            clearInterval(beat);
            if (sub) sub.unsubscribe();
            if (!res.writableEnded) res.end();
        };
        const write = (event) => {
            res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            // The contract: end is the job's last event and the server closes the stream after it.
            if (event.type === 'end') finish();
        };
        // A comment every heartbeat keeps proxies and the client from timing the stream out; the replay
        // happens inside subscribe, before the first beat.
        const beat = setInterval(() => { res.write(': keep-alive\n\n'); }, config.stream.heartbeatMs);
        beat.unref?.();
        sub = stream.subscribe(row.id, { lastEventId, onEvent: write });
        req.on('close', finish);
        res.on('close', finish);
        if (sub.ended) finish();   // an ended job: the replay is the whole answer
    }));

    // ── GET /admin/jobs — run.job.admin ────────────────────────────────────────
    r.get('/admin/jobs', guard('run.job.admin'), wrap(async (req, res) => {
        const q = listQuery(req.query);
        const { rows, nextCursor } = await store.adminList(db, q);
        res.json({ jobs: rows.map(store.readResult), next_cursor: nextCursor });
    }));

    return r;
}

module.exports = { v1Router, CAP, IDEMPOTENCY_RE, validCreate, checkLimits, idempotencyKey, listQuery, ticketResult };
