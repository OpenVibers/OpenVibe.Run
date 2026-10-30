'use strict';
/**
 * Account export and deletion → Run (ADR-033; openvibe-sdk/account-data).
 *
 * Run keeps two things about a person:
 *
 * - their open browser sessions (run_sessions, server/sessions/), keyed `owner = user:usr_…`. The export carries each
 *   session's settings and timing, never its ticket or stream secret; deletion removes them.
 * - the jobs they submitted (run_jobs.requester = `user:usr_…`). The export carries the job, its result and its
 *   timings; the row itself stays, because it is the project's record of the work and of what it cost, but the
 *   requester becomes `user:deleted`, so the job no longer leads to a person.
 *
 * Telemetry samples that name a person are covered by the SDK itself (telemetry.json, then subject NULL).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    {
        table: 'run_sessions', subject: 'owner', value: (usr) => `user:${usr}`, file: 'sessions.json', order: 'created_at',
        columns: ['id', 'via', 'kind', 'state', 'width', 'height', 'ttl_s', 'idle_s', 'machine_asked', 'requirements', 'machine', 'created_at', 'started_at', 'last_used_at', 'ended_at', 'end_reason', 'end_detail', 'metered_minutes', 'updated_at'],
    },
    // The jobs are handled by the service itself (the requester is tombstoned, not deleted), so they are not in the
    // table map; they are listed as covered in the test's guard.
];

/** The jobs the person submitted: their own work, with its result. */
async function extraExport(db, subject) {
    const jobs = await db.many(`SELECT id, project_id, class, state, provider, region, job, result, ttl_ms, created_at, updated_at, started_ms, finished_ms, wall_ms, usage_read, error_code
        FROM run_jobs WHERE requester = $1 ORDER BY created_at DESC LIMIT 5000`, [`user:${subject}`]);
    return jobs.length ? [{ name: 'jobs.json', content: jobs }] : [];
}

/** The requester of the person's jobs becomes a tombstone: the job stays, the person does not lead to it. */
async function extraErase(t, subjects, counts) {
    const forms = subjects.map((s) => `user:${s}`);
    counts.add(counts.retained, 'run_jobs_tombstoned', await t.exec(`UPDATE run_jobs SET requester = 'user:deleted' WHERE requester = ANY($1::text[])`, [forms]));
}

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'run', tables: TABLES, extraExport, extraErase, log });
}

module.exports = { create, TABLES, TOPICS, extraExport, extraErase };
