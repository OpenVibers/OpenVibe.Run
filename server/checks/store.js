'use strict';
/**
 * The checks scheduler's rows (migrations/0020_checks.sql), row access only. A state change that also emits a
 * run.job.* event happens in the caller's transaction; the scheduler's own claim/complete updates are
 * conditional UPDATEs, so two ticks (or two processes) cannot queue the same workflow job twice or report a
 * check run twice.
 */
const json = (v) => (v == null ? null : JSON.stringify(v));
const num = (v) => (v == null ? null : Number(v));

// ── App ──────────────────────────────────────────────────────────────────────

const getApp = (db) => db.maybe('SELECT * FROM run_checks_app WHERE id = 1');

async function putApp(db, row, at) {
    return db.maybe(
        `INSERT INTO run_checks_app (id, app_id, slug, name, html_url, pem_enc, webhook_secret_enc, client_id, client_secret_enc, created_at, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (id) DO UPDATE SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, name = EXCLUDED.name,
             html_url = EXCLUDED.html_url, pem_enc = EXCLUDED.pem_enc, webhook_secret_enc = EXCLUDED.webhook_secret_enc,
             client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [row.app_id, row.slug, row.name, row.html_url || null, row.pem_enc, row.webhook_secret_enc, row.client_id || null, row.client_secret_enc || null, at]);
}

const deleteApp = (db) => db.maybe('DELETE FROM run_checks_app WHERE id = 1 RETURNING id');

// ── installation tokens ─────────────────────────────────────────────────────

const getToken = (db, installationId) => db.maybe('SELECT * FROM run_checks_tokens WHERE installation_id = $1', [installationId]);

const putToken = (db, installationId, tokenEnc, expiresAt, at) => db.maybe(
    `INSERT INTO run_checks_tokens (installation_id, token_enc, expires_at, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (installation_id) DO UPDATE SET token_enc = EXCLUDED.token_enc, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [installationId, tokenEnc, expiresAt, at]);

const deleteToken = (db, installationId) => db.maybe('DELETE FROM run_checks_tokens WHERE installation_id = $1 RETURNING installation_id', [installationId]);
const clearTokens = (db) => db.maybe('DELETE FROM run_checks_tokens RETURNING installation_id');
const sweepTokens = (db, at) => db.maybe('DELETE FROM run_checks_tokens WHERE expires_at <= $1 RETURNING installation_id', [at]);

// ── installations ───────────────────────────────────────────────────────────

async function upsertInstallation(db, { installationId, login, accountId = null, accountType = null, suspendedAt = null }, at) {
    return db.maybe(
        `INSERT INTO run_checks_installations (installation_id, account_login, account_id, account_type, suspended_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (installation_id) DO UPDATE SET account_login = EXCLUDED.account_login, account_id = EXCLUDED.account_id,
             account_type = EXCLUDED.account_type, suspended_at = EXCLUDED.suspended_at, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [installationId, login, accountId, accountType, suspendedAt, at]);
}

const listInstallations = (db) => db.many('SELECT * FROM run_checks_installations ORDER BY account_login, installation_id');
const clearInstallations = (db) => db.maybe('DELETE FROM run_checks_installations RETURNING installation_id');

// ── deliveries ──────────────────────────────────────────────────────────────

/** Claim one X-GitHub-Delivery. → true when it was new, false when it is a replay. */
async function claimDelivery(db, { deliveryId, event, at, expiresAt }) {
    const row = await db.maybe(
        `INSERT INTO run_checks_deliveries (delivery_id, event, received_at, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
        [deliveryId, event, at, expiresAt]);
    return Boolean(row);
}

const releaseDelivery = (db, deliveryId) => db.maybe('DELETE FROM run_checks_deliveries WHERE delivery_id = $1 RETURNING delivery_id', [deliveryId]);

const sweepDeliveries = (db, at) => db.maybe('DELETE FROM run_checks_deliveries WHERE expires_at <= $1', [at]);

// ── plans and jobs ──────────────────────────────────────────────────────────

/** Insert a plan and its flat jobs in the caller's transaction. */
async function insertPlan(t, { plan, jobs }, at) {
    const row = await t.maybe(
        `INSERT INTO run_checks_plans (id, delivery_id, repo, repo_owner, sha, event, ref, branch, installation_id, workflow_path, workflow_name, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $12) RETURNING *`,
        [plan.id, plan.delivery_id || null, plan.repo, plan.owner, plan.sha, plan.event, plan.ref, plan.branch || null,
            plan.installation_id || null, plan.workflow_path, plan.workflow_name, at]);
    for (const job of jobs) {
        await t.maybe(
            `INSERT INTO run_checks_jobs (id, plan_id, job_key, job_name, display_name, workflow_path, workflow_job_key, stage, needs, matrix,
                 matrix_group, max_parallel, timeout_minutes, check_state, state, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, 'queued', 'waiting', $14, $14)`,
            [job.id, plan.id, job.job_key, job.job_name, job.display_name, job.workflow_path, job.workflow_job_key, job.stage,
                JSON.stringify(job.needs || []), json(job.matrix), job.matrix_group || null, job.max_parallel || null,
                job.timeout_minutes, at]);
    }
    return row;
}

const getPlan = (db, id) => db.maybe('SELECT *, repo_owner AS owner FROM run_checks_plans WHERE id = $1', [id]);
const getPlanByDelivery = (db, deliveryId) => db.many('SELECT *, repo_owner AS owner FROM run_checks_plans WHERE delivery_id = $1 ORDER BY created_at, id', [deliveryId]);
const listActivePlans = (db, limit = 50) => db.many(`SELECT *, repo_owner AS owner FROM run_checks_plans WHERE state = 'active' ORDER BY created_at, id LIMIT $1`, [limit]);

const setPlanState = (db, id, state, at) => db.maybe(
    `UPDATE run_checks_plans SET state = $2, updated_at = $3 WHERE id = $1 AND state = 'active' RETURNING *`, [id, state, at]);

const getJobs = (db, planId) => db.many('SELECT * FROM run_checks_jobs WHERE plan_id = $1 ORDER BY stage, job_key', [planId]);
const getJob = (db, id) => db.maybe('SELECT * FROM run_checks_jobs WHERE id = $1', [id]);

/** A tick claims a waiting job before it mints a Run job; two ticks can never mint two. */
const claimQueue = (db, id, at) => db.maybe(
    `UPDATE run_checks_jobs SET state = 'queuing', updated_at = $2 WHERE id = $1 AND state = 'waiting' AND run_job_id IS NULL RETURNING *`, [id, at]);

const resetJobToWaiting = (db, id, at) => db.maybe(
    `UPDATE run_checks_jobs SET state = 'waiting', run_job_id = NULL, check_state = 'queued', started_at = NULL, updated_at = $2
     WHERE id = $1 AND state <> 'completed' RETURNING *`, [id, at]);

/** Link the Run job a claim minted (in the same transaction as the mint when possible). */
const linkRunJob = (t, id, runJobId, at) => t.maybe(
    `UPDATE run_checks_jobs SET run_job_id = $2, state = 'queued', attempts = attempts + 1, queued_at = COALESCE(queued_at, $3), updated_at = $3
     WHERE id = $1 RETURNING *`, [id, runJobId, at]);

/** A crash between claim and mint leaves `queuing` behind: a later tick may retry it. */
const resetStaleQueuing = (db, at, staleMs = 5 * 60_000) => db.many(
    `UPDATE run_checks_jobs SET state = 'waiting', updated_at = $1 WHERE state = 'queuing' AND updated_at < $2 RETURNING id`, [at, at - staleMs]);

const markRunning = (db, id, at, nodeId = null) => db.maybe(
    `UPDATE run_checks_jobs SET state = 'running', check_state = 'in_progress', started_at = COALESCE(started_at, $2), node_id = COALESCE($3, node_id), updated_at = $2
     WHERE id = $1 AND state IN ('queued', 'running') RETURNING *`, [id, at, nodeId]);

const setCheckRun = (db, id, checkRunId, at) => db.maybe(
    `UPDATE run_checks_jobs SET check_run_id = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [id, checkRunId, at]);

const bumpReportError = (db, id, at) => db.maybe(
    `UPDATE run_checks_jobs SET report_errors = report_errors + 1, updated_at = $2 WHERE id = $1 RETURNING *`, [id, at]);

/** Complete once: the condition makes a second tick (or a second process) a quiet no-op. */
const completeJob = (db, id, { conclusion, summary = null, error = null, queueMs = null, runMs = null, startedAt = null, finishedAt = null, nodeId = null, at }) => db.maybe(
    `UPDATE run_checks_jobs SET state = 'completed', check_state = 'completed', conclusion = $2, summary = $3, error = $4,
         queue_ms = COALESCE($5, queue_ms), run_ms = COALESCE($6, run_ms), started_at = COALESCE(started_at, $7),
         finished_at = $8, node_id = COALESCE($9, node_id), updated_at = $8
     WHERE id = $1 AND state <> 'completed' RETURNING *`,
    [id, conclusion, summary, error, queueMs, runMs, startedAt, finishedAt, nodeId]);

/** The Run jobs whose check run has not been settled yet, with the Run row beside them. */
const unsettledRuns = (db) => db.many(
    `SELECT cj.*, rj.state AS run_state, rj.result AS run_result, rj.started_ms AS run_started_ms, rj.finished_ms AS run_finished_ms,
            rj.node_id AS run_node_id, rj.exit_reason AS run_exit_reason, rj.error_code AS run_error_code
     FROM run_checks_jobs cj JOIN run_jobs rj ON rj.id = cj.run_job_id
     WHERE cj.state IN ('queued', 'running') AND cj.check_state <> 'completed'
     ORDER BY cj.updated_at, cj.id LIMIT 500`);

// ── shadow ──────────────────────────────────────────────────────────────────

async function shadowNode(db, { repo, sha, workflowName = '', jobName, checkRunId = null, conclusion, queueMs = null, runMs = null, startedAt = null, finishedAt = null, at }) {
    const hit = await db.maybe(
        `UPDATE run_checks_shadow SET node_conclusion = $5, check_run_id = COALESCE($6, check_run_id), queue_ms = $7, run_ms = $8,
             node_started_at = $9, node_finished_at = $10, updated_at = $11
         WHERE repo = $1 AND sha = $2 AND job_name = $3 AND ($4 = '' OR workflow_name = '' OR workflow_name = $4)
         RETURNING *`,
        [repo, sha, jobName, workflowName || '', conclusion, checkRunId, queueMs, runMs, startedAt, finishedAt, at]);
    if (hit) return hit;
    return db.maybe(
        `INSERT INTO run_checks_shadow (repo, sha, workflow_name, job_name, check_run_id, node_conclusion, queue_ms, run_ms, node_started_at, node_finished_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
        [repo, sha, workflowName || '', jobName, checkRunId, conclusion, queueMs, runMs, startedAt, finishedAt, at]);
}

async function shadowActions(db, { repo, sha, workflowName = '', jobName, conclusion, startedAt = null, finishedAt = null, at }) {
    const hit = await db.maybe(
        `UPDATE run_checks_shadow SET actions_conclusion = $5, actions_started_at = $6, actions_finished_at = $7, updated_at = $8,
             workflow_name = CASE WHEN workflow_name = '' THEN $4 ELSE workflow_name END
         WHERE repo = $1 AND sha = $2 AND job_name = $3 AND ($4 = '' OR workflow_name = '' OR workflow_name = $4)
         RETURNING *`,
        [repo, sha, jobName, workflowName || '', conclusion, startedAt, finishedAt, at]);
    if (hit) return hit;
    return db.maybe(
        `INSERT INTO run_checks_shadow (repo, sha, workflow_name, job_name, actions_conclusion, actions_started_at, actions_finished_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
        [repo, sha, workflowName || '', jobName, conclusion, startedAt, finishedAt, at]);
}

/** Agreement per repo: paired rows, agreed rows, and the node's average queue/run time. */
async function agreement(db, repo = null) {
    const rows = await db.many(
        `SELECT repo,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE node_conclusion IS NOT NULL AND actions_conclusion IS NOT NULL)::int AS paired,
                COUNT(*) FILTER (WHERE node_conclusion IS NOT NULL AND actions_conclusion IS NOT NULL AND node_conclusion = actions_conclusion)::int AS agreed,
                AVG(queue_ms) AS queue_avg, AVG(run_ms) AS run_avg
         FROM run_checks_shadow
         WHERE ($1::text IS NULL OR repo = $1)
         GROUP BY repo ORDER BY repo`,
        [repo || null]);
    return rows.map((r) => ({
        repo: r.repo,
        checks: Number(r.total || 0),
        paired: Number(r.paired || 0),
        agreed: Number(r.agreed || 0),
        agreement: Number(r.paired || 0) ? Number(r.agreed || 0) / Number(r.paired) : null,
        queue_ms: num(r.queue_avg),
        run_ms: num(r.run_avg),
    }));
}

module.exports = {
    getApp, putApp, deleteApp,
    getToken, putToken, deleteToken, clearTokens, sweepTokens,
    upsertInstallation, listInstallations, clearInstallations,
    claimDelivery, releaseDelivery, sweepDeliveries,
    insertPlan, getPlan, getPlanByDelivery, listActivePlans, setPlanState,
    getJobs, getJob, claimQueue, resetJobToWaiting, linkRunJob, resetStaleQueuing,
    markRunning, setCheckRun, bumpReportError, completeJob, unsettledRuns,
    shadowNode, shadowActions, agreement,
};
