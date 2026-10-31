'use strict';
/**
 * ADR-033: Run's part of an account export and deletion. A person's open browser sessions are exported (their
 * settings and timing, never a ticket) and deleted; someone else's stay. The guard fails when a new table with a
 * person column is neither covered nor exempted with a reason.
 *
 * The consumer's route is checked too: POST /internal/events answers the delivery (a bad signature is refused),
 * so a route that never answers is caught here and not in production.
 */
const assert = require('assert');
const { uncovered } = require('openvibe-sdk/account-data');
const { testDb } = require('./helpers/db');
const { boot } = require('./helpers/app');
const { TABLES, create } = require('../server/account-data');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';

(async () => {
    const d = await testDb();
    try {
        const accountData = create({ db: d.db });
        const missing = await uncovered(d.db, { tables: [...TABLES, 'run_jobs'], exempt: { account_data_events: 'the ledger of requests itself: which export and deletion Run applied' } });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);

        for (const [subject, name, jobId] of [[A, 'ada', 'job_01JZ0000000000000000000ADA'], [B, 'bo', 'job_01JZ0000000000000000000BQB']]) {
            await d.db.exec(`INSERT INTO run_sessions (id, owner, kind, state, width, height, ttl_s, idle_s, request_digest, created_at, updated_at)
                VALUES ($1, $2, 'browser', 'ended', 1280, 720, 900, 60, 'digest', 1, 1)`, [`ses_${name}`, `user:${subject}`]);
            await d.db.exec(`INSERT INTO run_jobs (id, project_id, requester, idempotency_key, class, job, ttl_ms, state, created_at, updated_at)
                VALUES ($1, 'proj_1', $2, $3, 'browser', '{}', 1000, 'succeeded', 1, 1)`, [jobId, `user:${subject}`, `idem-${name}`]);
            await d.db.exec(`INSERT INTO placement_outcomes (person_id, option_key, step_kind, ok_w, n_w, updated_at)
                VALUES ($1, $2, 'browser', 1, 1, now())`, [subject, `off_${name}`]);
        }
        const part = await accountData.exportPart(A);
        const file = part.files.find((f) => f.name === 'sessions.json');
        assert.ok(file, 'sessions.json is in the part');
        assert.strictEqual(file.content.length, 1);
        assert.strictEqual(file.content[0].id, 'ses_ada');
        const jobs = part.files.find((f) => f.name === 'jobs.json');
        assert.ok(jobs, 'jobs.json is in the part');
        assert.deepStrictEqual(jobs.content.map((j) => j.id), ['job_01JZ0000000000000000000ADA'], 'only their own job');
        const learned = part.files.find((f) => f.name === 'placement-outcomes.json');
        assert.ok(learned, 'placement-outcomes.json is in the part');
        assert.deepStrictEqual(learned.content.map((r) => r.option_key), ['off_ada'], 'only their own placement counts');

        const counts = await accountData.erase([A]);
        assert.strictEqual(counts.erased.run_sessions, 1);
        const left = (await d.db.many('SELECT owner FROM run_sessions')).map((r) => r.owner);
        assert.deepStrictEqual(left, [`user:${B}`], 'only Bo\'s session is left');
        assert.strictEqual(await d.db.value('SELECT requester FROM run_jobs WHERE id = $1', ['job_01JZ0000000000000000000ADA']), 'user:deleted', 'the job stays, without its requester');
        assert.strictEqual(await d.db.value('SELECT requester FROM run_jobs WHERE id = $1', ['job_01JZ0000000000000000000BQB']), `user:${B}`, 'Bo\'s job is untouched');
        assert.strictEqual(counts.retained.run_jobs_tombstoned, 1);
        assert.strictEqual(Number(await d.db.value('SELECT count(*) FROM placement_outcomes WHERE person_id = $1', [A])), 0, 'Ada\'s placement counts are erased');
        assert.strictEqual(Number(await d.db.value('SELECT count(*) FROM placement_outcomes WHERE person_id = $1', [B])), 1, 'Bo\'s stay');

        // The route answers: an unsigned delivery is refused (401), not lost (404) and not accepted.
        const t = await boot({ db: d.db, env: { RUN_EVENTS_SECRET: 's'.repeat(40) }, appOpts: { accountData } });
        const r = await t.call('POST', '/internal/events', { body: {}, token: null });
        assert.strictEqual(r.status, 401, `the consumer refuses an unsigned delivery: ${r.text}`);
        await t.close();
        console.log('  ✓ export, erase, the guard and the route');
    } finally { await d.close(); }
})();
