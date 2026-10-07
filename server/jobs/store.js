'use strict';

/**
 * run_jobs (migrations/0001_jobs.sql): Run's own record of a job — the API, the placement and the project
 * scope (plan T14 R1). Bot owns the node link and the per-second metering, and Run never holds a Billing
 * token.
 *
 *   queued      stored, waiting for a node
 *   placed      sent to a node as platform.job@1, not yet started
 *   running     the node sent job_started
 *   succeeded / failed / cancelled / expired   one end state, from job_exit / the API's cancel / the ttl
 *
 * The `job` jsonb is the job record: the platform.job@1 body Run sends to the node (id, class, args,
 * ttl_ms, limits, net, inputs) plus the fields platform.job@1 has no place for and 0001_jobs.sql has no
 * column for — `requirements` (platform.workload-requirements@1, required by run.job-read-result@1 and by
 * placement), `placed_at` (timings.placed_at) and `cancel_requested` (a cancel of a placed or running job,
 * which the dispatcher bridge turns into a job_cancel in plan T14 step 6). server/dispatch/index.js
 * assembles the frame from the platform.job@1 keys alone and validates it before anything is sent.
 *
 * The store is row access only: every state change happens inside the caller's transaction, so the
 * run.job.* event (server/jobs/events.js) exists if and only if the change committed.
 */
const contracts = require('openvibe-contracts');
const { fail, iso, readCursor, cursorOf, requirementsDefault, newJobId } = require('../util');

// Run's own error code per platform.job-frame@1 job_exit reason (run.job-read-result@1 $defs.error).
const ERROR_OF_EXIT = {
    limit: 'run.job.limit',
    stopped: 'run.job.stopped',
    failed: 'run.job.worker_failed',
    ttl: 'run.job.ttl',
    exited: 'run.job.exit_nonzero',
    cancelled: null,
};
const END_STATES = ['succeeded', 'failed', 'cancelled', 'expired'];
const isEndState = (state) => END_STATES.includes(state);

// The keys of platform.job@1 — the frame body of the job, and nothing Run keeps beside it.
const FRAME_KEYS = ['id', 'class', 'artifact', 'args', 'ttl_ms', 'limits', 'net', 'inputs'];

/** The platform.job@1 body a node is sent: the job record's own platform keys (build with this, not a spread). */
function frameOf(record) {
    const out = {};
    for (const k of FRAME_KEYS) if (record && record[k] !== undefined) out[k] = record[k];
    return out;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Canonical JSON (keys sorted): two requests that differ only in key order are the same request. */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}

/** The comparable part of a request / a stored row: an idempotent repeat is judged on exactly this. */
function recordOf(row) {
    const job = obj(row.job);
    return {
        class: row.class,
        artifact: job.artifact ?? null,
        args: job.args ?? {},
        inputs: job.inputs ?? [],
        limits: job.limits,
        ttl_ms: Number(row.ttl_ms),
        egress: job.net ?? 'none',
        requirements: job.requirements ?? requirementsDefault(row.class),
    };
}

/**
 * Normalize a validated run.job-create-request@1 body into the row to store: defaults filled (args {},
 * inputs [], egress none, requirements the contract's default, ttl_ms limits.wall_ms + 600000), the id
 * minted by Run (job_<ULID>; Run owns run.job.* and passes it to Bot unchanged).
 */
function normalize(body, { projectId, requester, idempotencyKey, now }) {
    const job = {
        id: newJobId(now),
        class: body.class,
        ...(body.artifact ? { artifact: body.artifact } : {}),
        args: body.args || {},
        ttl_ms: body.ttl_ms != null ? body.ttl_ms : body.limits.wall_ms + 600_000,   // the contract's default
        limits: body.limits,
        net: body.egress || 'none',
        inputs: body.inputs || [],
        requirements: body.requirements || requirementsDefault(body.class),
    };
    // The platform.job@1 body the node will be sent (frameOf drops requirements — platform.job@1 has no
    // field for it), validated here once so a node can never be handed something off-contract.
    contracts.assertValid('platform.job@1', frameOf(job));
    return {
        id: job.id,
        project_id: projectId,
        requester,
        idempotency_key: idempotencyKey,
        class: job.class,
        job,
        ttl_ms: job.ttl_ms,
        state: 'queued',
        created_at: now,
        updated_at: now,
        wall_ms: 0,
        usage_read: 0,
    };
}

/** Insert a new job. The same (project_id, idempotency_key) already there returns that row, created:false. */
async function put(db, row) {
    const inserted = await db.maybe(
        `INSERT INTO run_jobs (id, project_id, requester, idempotency_key, class, job, ttl_ms, state, created_at, updated_at, wall_ms, usage_read)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (project_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [row.id, row.project_id, row.requester, row.idempotency_key, row.class, JSON.stringify(row.job), row.ttl_ms, row.state, row.created_at, row.updated_at, row.wall_ms, row.usage_read]);
    if (inserted) return { row: inserted, created: true };
    const existing = await db.maybe('SELECT * FROM run_jobs WHERE project_id = $1 AND idempotency_key = $2', [row.project_id, row.idempotency_key]);
    if (!existing) throw new Error('run_jobs: the insert conflicted but no row is visible');   // only a crashed transaction does this
    return { row: existing, created: false };
}

/**
 * Create a job from a validated run.job-create-request@1 body (plan T14 R1: the dispatcher bridge mints
 * the job id in Run, not in Bot). A repeat of the same idempotency_key with the same body returns the
 * first job (created:false); with a different body it is 409 run.idempotency.conflict.
 *
 * The unique index is permanent: a key is spent for its project for good, where run.job-create-request@1
 * promises the first-job answer "within 24 h". The 24 h window cannot be implemented on this table (no
 * migration may add a column or relax the index), and answering a repeat with the first job forever is the
 * safe direction — it can never run the work twice — so a key older than 24 h answers the same way rather
 * than being recycled. A caller that reuses a key for different work is refused, not silently served.
 */
async function mint(db, body, { projectId, requester, idempotencyKey, now }) {
    const row = normalize(body, { projectId, requester, idempotencyKey, now });
    const out = await put(db, row);
    if (out.created) return out;
    if (canonical(recordOf(out.row)) !== canonical(recordOf(row))) {
        fail(409, 'run.idempotency.conflict', `idempotency_key ${idempotencyKey} was first used by ${out.row.id} with a different body`);
    }
    return out;
}

/** Project-scoped get: null when the job does not exist or belongs to another project (→ 404, never 403). */
const get = (db, id, projectId = null) => db.maybe(`SELECT * FROM run_jobs WHERE id = $1${projectId ? ' AND project_id = $2' : ''}`, projectId ? [id, projectId] : [id]);

/** One page, newest first, keyset cursor (created_at, id) → { rows, nextCursor }. */
async function page(db, where, values, limit, cursor) {
    const conds = [...where];
    const params = [...values];
    if (cursor) {
        params.push(cursor.at, cursor.id);
        conds.push(`(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`);
    }
    params.push(limit + 1);
    const rows = await db.many(`SELECT * FROM run_jobs${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    const more = rows.length > limit;
    const out = more ? rows.slice(0, limit) : rows;
    return { rows: out, nextCursor: more && out.length ? cursorOf(out[out.length - 1]) : null };
}

/** The token project's jobs: GET /api/v1/jobs (run.job.list). */
function list(db, projectId, { state = null, limit = 50, cursor = null } = {}) {
    const where = ['project_id = $1'];
    const values = [projectId];
    if (state) { values.push(state); where.push(`state = $${values.length}`); }
    return page(db, where, values, limit, cursor ? readCursor(cursor) : null);
}

/**
 * The dispatcher bridge's three reads (plan T14 step 6, server/jobs/poller.js). Row access only: every
 * state change happens in the poller's transaction, so the run.job.* event exists if and only if it
 * committed. No migration adds a state index (0001_jobs.sql is the final schema), so each is a plain scan
 * of a small table; the poller bounds how much of it one tick takes.
 */

/** Jobs still waiting for a node, oldest first: what the poller places and sends. */
const waiting = (db, limit) => db.many(`SELECT * FROM run_jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT $1`, [limit]);

/** Jobs a node may hold — placed or running — oldest first: what the poller mirrors from Bot. */
const active = (db, limit) => db.many(`SELECT * FROM run_jobs WHERE state IN ('placed', 'running') ORDER BY created_at, id LIMIT $1`, [limit]);

/** Jobs whose lifetime ran out (created_at + ttl_ms <= at) and that have not ended, oldest first: the sweeper. */
const dueTtl = (db, at, limit = 500) => db.many(`SELECT * FROM run_jobs WHERE state IN ('queued', 'placed', 'running') AND created_at + ttl_ms <= $1 ORDER BY created_at, id LIMIT $2`, [at, limit]);

/** Every project's jobs: GET /api/v1/admin/jobs (run.job.admin); project_id narrows it. */
function adminList(db, { project_id: projectId = null, state = null, limit = 50, cursor = null } = {}) {
    const where = [];
    const values = [];
    if (projectId) { values.push(projectId); where.push(`project_id = $${values.length}`); }
    if (state) { values.push(state); where.push(`state = $${values.length}`); }
    return page(db, where, values, limit, cursor ? readCursor(cursor) : null);
}

/**
 * Cancel one job (POST /api/v1/jobs/:id/cancel, run.job.cancel). A queued job was never sent anywhere:
 * cancelled now. A placed or running job may be on a node this instant (Run marked it placed as soon as
 * Bot took the frame, before the node's job_started arrived), so it is only marked cancel_requested: the
 * dispatcher bridge sends job_cancel and the job reaches `cancelled` when Bot reports it (plan T14 step 6,
 * job_exit reason cancelled). An ended job changes nothing.
 * → { row, cancelled, cancelRequested } — cancelled means the row moved to 'cancelled' now.
 */
async function cancel(db, id, projectId, at) {
    const moved = await db.maybe(
        `UPDATE run_jobs SET state = 'cancelled', updated_at = $3, finished_ms = $3
         WHERE id = $1 AND project_id = $2 AND state = 'queued' RETURNING *`,
        [id, projectId, at]);
    if (moved) return { row: moved, cancelled: true, cancelRequested: false };
    const asked = await db.maybe(
        `UPDATE run_jobs SET job = jsonb_set(job, '{cancel_requested}', 'true'::jsonb), updated_at = $3
         WHERE id = $1 AND project_id = $2 AND state IN ('placed', 'running')
           AND job->>'cancel_requested' IS DISTINCT FROM 'true' RETURNING *`,
        [id, projectId, at]);
    if (asked) return { row: asked, cancelled: false, cancelRequested: true };
    return { row: await get(db, id, projectId), cancelled: false, cancelRequested: false };
}

/**
 * Copy what Bot answers for a job (plan T14 step 6, R1c): state, placement, timings, exit, result and the
 * metered wall clock. Run keeps its own job record otherwise untouched; the first placement stamps
 * placed_at, which run.job-read-result@1 requires from `placed` on. → the row, or null.
 */
async function mirror(db, id, bot = {}, at) {
    const placed = bot.node_id ? at : null;
    // Bot's answer moves the row only into a state the row can back: an end state never changes (the answer
    // of a job the API cancelled or the ttl swept while the poll was in flight cannot revive it), Run's
    // requirements (run.job-read-result@1: a placement for placed/running/succeeded, started_at for running)
    // decide the rest, and an answer missing them leaves the state as it is.
    return db.maybe(
        `UPDATE run_jobs SET
             state = CASE
                 WHEN state IN ('succeeded', 'failed', 'cancelled', 'expired') THEN state
                 WHEN $2::text IS NULL THEN state
                 WHEN $2::text IN ('placed', 'running', 'succeeded') AND COALESCE($3, node_id) IS NULL THEN state
                 WHEN $2::text = 'running' AND COALESCE($6, started_ms) IS NULL THEN state
                 ELSE $2::text END,
             node_id = COALESCE($3, node_id),
             provider = COALESCE($4, provider),
             region = COALESCE($5, region),
             started_ms = COALESCE($6, started_ms),
             finished_ms = COALESCE($7, finished_ms),
             exit_reason = COALESCE($8, exit_reason),
             exit_code = COALESCE($9, exit_code),
             result = COALESCE($10, result),
             wall_ms = GREATEST(wall_ms, COALESCE($11, 0)),
             usage_read = GREATEST(usage_read, COALESCE($12, 0)),
             job = CASE WHEN $13::bigint IS NULL OR job ? 'placed_at' THEN job
                        ELSE jsonb_set(job, '{placed_at}', to_jsonb($13::bigint)) END,
             updated_at = $14
         WHERE id = $1 RETURNING *`,
        [id, bot.state ?? null, bot.node_id ?? null, bot.provider ?? null, bot.region ?? null, bot.started_ms ?? null,
            bot.finished_at ?? null, bot.exit_reason ?? null, bot.exit_code ?? null,
            bot.result === undefined || bot.result === null ? null : JSON.stringify(bot.result),
            bot.wall_ms ?? null, bot.usage_read ?? null, placed, at]);
}

/**
 * Reach an end state (the API's cancel uses cancel(), the ttl sweeper and the dispatcher bridge use this).
 * The first settlement wins; a second is a no-op (changed:false), so the run.job.* event of a state is
 * enqueued once. `exit` is the platform.job-frame@1 job_exit reason, `code` its exit status; the error
 * code is derived from the reason unless the caller names one (run.job.unplaceable, run.job.ttl).
 * → { row, changed }
 */
async function settle(db, id, { state, exit = null, code = null, result = null, wallMs = null, errorCode = null, errorDetail = null, at }) {
    if (!isEndState(state)) fail(422, 'run.invalid_input', `settle: ${state} is not an end state`);
    // run.job-read-result@1 requires `error` on failed and expired and null everywhere else, so an error
    // code is only ever written for those two: a caller asking for one on a cancel or a success is ignored
    // rather than allowed to store a row this service could no longer render.
    const failed = state === 'failed' || state === 'expired';
    const derived = state === 'failed' ? ERROR_OF_EXIT[exit] || 'run.job.worker_failed' : state === 'expired' ? ERROR_OF_EXIT[exit] || 'run.job.unplaceable' : null;
    const row = await db.maybe(
        `UPDATE run_jobs SET state = $2, exit_reason = COALESCE($3, exit_reason), exit_code = $4, result = $5,
                wall_ms = GREATEST(wall_ms, COALESCE($6, 0)), finished_ms = $7, updated_at = $7,
                error_code = CASE WHEN $8::boolean THEN COALESCE($9, $10) ELSE NULL END,
                error_detail = CASE WHEN $8::boolean THEN $11 ELSE NULL END
         WHERE id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled', 'expired')
         RETURNING *`,
        [id, state, exit, code, result === null || result === undefined ? null : JSON.stringify(result), wallMs,
            at, failed, errorCode, derived, errorDetail]);
    if (row) return { row, changed: true };
    return { row: await get(db, id), changed: false };
}

/**
 * One job as run.job-read-result@1 — exactly the contract's shape: placement null while queued, timings
 * from the row (and the job record's placed_at), usage.seconds the metered wall clock / 1000, result only
 * when succeeded, error only when failed or expired.
 */
function toJob(row) {
    const job = obj(row.job);
    const state = row.state;
    const wallMs = Number(row.wall_ms || 0);
    const requester = contracts.ids.parseSubject(String(row.requester));
    return {
        id: row.id,
        project_id: row.project_id,
        requester,
        state,
        class: row.class,
        artifact: job.artifact ?? null,
        inputs: job.inputs ?? [],
        limits: job.limits,
        ttl_ms: Number(row.ttl_ms),
        egress: job.net ?? 'none',
        requirements: job.requirements ?? requirementsDefault(row.class),
        idempotency_key: row.idempotency_key ?? null,
        placement: row.node_id ? { node: row.node_id, provider: row.provider ?? null, region: row.region ?? null } : null,
        timings: {
            created_at: iso(row.created_at),
            placed_at: job.placed_at != null ? iso(job.placed_at) : null,
            started_at: iso(row.started_ms),
            finished_at: iso(row.finished_ms),
        },
        exit: row.exit_reason ? { reason: row.exit_reason, code: row.exit_code == null ? null : Number(row.exit_code) } : null,
        result: state === 'succeeded' ? (row.result ?? null) : null,
        usage: { seconds: wallMs / 1000, wall_ms: wallMs, cpu_ms: null, mem_peak_bytes: null },
        error: row.error_code ? { code: row.error_code, detail: row.error_detail ?? null } : null,
    };
}

/** The read result, validated against the contract (a store bug is a 500 here, never a bad body on the wire). */
function readResult(row) {
    const job = toJob(row);
    contracts.assertValid('run.job-read-result@1', job);
    return job;
}

module.exports = {
    // The store surface the API and the dispatcher bridge (plan T14 step 6) use.
    put, mint, get, list, adminList, cancel, mirror, settle, toJob, readResult, frameOf,
    // The poller's reads (waiting → placed → active → ended).
    waiting, active, dueTtl,
};
