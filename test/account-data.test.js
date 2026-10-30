'use strict';
/**
 * ADR-033: Run's part of an account export and deletion. A person's open browser sessions are exported (their
 * settings and timing, never a ticket) and deleted; someone else's stay. The guard fails when a new table with a
 * person column is neither covered nor exempted with a reason.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { testDb } = require('./helpers/db');
const { TABLES, create } = require('../server/account-data');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';

(async () => {
    const d = await testDb();
    try {
        const accountData = create({ db: d.db });
        await accountData.ensureSchema();
        const missing = await uncovered(d.db, { tables: [...TABLES, 'run_jobs'], exempt: { account_data_events: 'the ledger of requests itself: which export and deletion Run applied' } });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);

        for (const [subject, name, jobId] of [[A, 'ada', 'job_01JZ0000000000000000000ADA'], [B, 'bo', 'job_01JZ0000000000000000000BQB']]) {
            await d.db.exec(`INSERT INTO run_sessions (id, owner, kind, state, width, height, ttl_s, idle_s, request_digest, created_at, updated_at)
                VALUES ($1, $2, 'browser', 'ended', 1280, 720, 900, 60, 'digest', 1, 1)`, [`ses_${name}`, `user:${subject}`]);
            await d.db.exec(`INSERT INTO run_jobs (id, project_id, requester, idempotency_key, class, job, ttl_ms, state, created_at, updated_at)
                VALUES ($1, 'proj_1', $2, $3, 'browser', '{}', 1000, 'succeeded', 1, 1)`, [jobId, `user:${subject}`, `idem-${name}`]);
        }
        const part = await accountData.exportPart(A);
        const file = part.files.find((f) => f.name === 'sessions.json');
        assert.ok(file, 'sessions.json is in the part');
        assert.strictEqual(file.content.length, 1);
        assert.strictEqual(file.content[0].id, 'ses_ada');
        const jobs = part.files.find((f) => f.name === 'jobs.json');
        assert.ok(jobs, 'jobs.json is in the part');
        assert.deepStrictEqual(jobs.content.map((j) => j.id), ['job_01JZ0000000000000000000ADA'], 'only their own job');

        const counts = await accountData.erase([A]);
        assert.strictEqual(counts.erased.run_sessions, 1);
        const left = (await d.db.many('SELECT owner FROM run_sessions')).map((r) => r.owner);
        assert.deepStrictEqual(left, [`user:${B}`], 'only Bo\'s session is left');
        assert.strictEqual(await d.db.value('SELECT requester FROM run_jobs WHERE id = $1', ['job_01JZ0000000000000000000ADA']), 'user:deleted', 'the job stays, without its requester');
        assert.strictEqual(await d.db.value('SELECT requester FROM run_jobs WHERE id = $1', ['job_01JZ0000000000000000000BQB']), `user:${B}`, 'Bo\'s job is untouched');
        assert.strictEqual(counts.retained.run_jobs_tombstoned, 1);
        console.log('  ✓ export, erase and the guard');
    } finally { await d.close(); }
})();
