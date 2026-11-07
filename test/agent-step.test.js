'use strict';
/**
 * The agent's step (design 2026-11-07): OpenVibe.Run publishes what one of a person's jobs is doing as
 * agent.step.started|ended, so the one timeline behind the Dock shows it. The payload is a title, an outcome and a
 * link: never args, inputs, output or a result body. A service's job has no person, so it publishes no step.
 *
 *   node test/agent-step.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { agentStepOf, AGENT_TOPICS } = require('../server/jobs/events');

async function checks(t) {
    const P = t.idsStub ? t.idsStub.newId('project') : require('openvibe-contracts').ids.newId('project');
    const ada = require('openvibe-contracts').ids.newId('user');
    t.network.members.set(`${P} ${ada}`, { role: 'admin' });
    const as = (subject, project) => ({
        token: t.network.signService({ sub: 'svc:watch', cap: ['run.job.submit', 'run.job.read', 'run.job.cancel'] }),
        headers: { 'X-OV-Subject': subject, 'X-OV-Project': project },
    });
    const stepRows = async () => (await t.db.many('SELECT event_id, envelope FROM run_events_outbox ORDER BY id'))
        .map((r) => ({ key: r.event_id, ...r.envelope }))
        .filter((e) => String(e.event_type || '').startsWith('agent.step.'));

    await check('the payload is a title, an outcome and a link: never args, inputs or the result', () => {
        const row = { id: 'job_01JAB2C3D4E5F6G7H8J9K0MNPS', project_id: P, requester: `user:${ada}`, via: 'service:watch', class: 'code',
            state: 'running', job: { args: { secret: 'the args a person typed' }, inputs: [{ url: 'https://example.test/private' }], limits: { wall_ms: 30000 } },
            ttl_ms: 630000, created_at: 1762000000000, updated_at: 1762000001000, started_ms: 1762000000500, finished_ms: null,
            wall_ms: 0, exit_reason: null, exit_code: null, node_id: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS', provider: null, region: null,
            result: { answer: 'the result body never leaves Run' }, error_code: null, error_detail: null, idempotency_key: 'k' };
        const step = agentStepOf(row, 'running', { baseUrl: 'https://openvibe.run' });
        assert.strictEqual(step.step_id, row.id);
        assert.strictEqual(step.mode, 'run');
        assert.strictEqual(step.product, 'run');
        assert.strictEqual(step.status, 'running');
        assert.strictEqual(step.title, 'A code job');
        assert.strictEqual(step.link, `https://openvibe.run/api/v1/jobs/${row.id}`);
        assert.ok(step.started_at && !Number.isNaN(Date.parse(step.started_at)), 'the start is a time');
        assert.strictEqual(step.ended_at, null, 'a running job has not ended');
        const raw = JSON.stringify(step);
        assert.ok(!raw.includes('the args a person typed'), 'no args');
        assert.ok(!raw.includes('example.test/private'), 'no inputs');
        assert.ok(!raw.includes('the result body never leaves Run'), 'no result');
        assert.ok(!('args' in step) && !('inputs' in step) && !('result' in step) && !('output' in step), 'no such field');
        assert.strictEqual(AGENT_TOPICS.started, 'agent.step.started');
        assert.strictEqual(AGENT_TOPICS.ended, 'agent.step.ended');
    });

    await check('a person\'s job publishes started (waiting) and ended (stopped), one row per change', async () => {
        const made = await t.call('POST', '/api/v1/jobs', { body: t.request(), ...as(ada, P) });
        assert.strictEqual(made.status, 201, made.text);
        const id = made.json.job.id;
        let rows = (await stepRows()).filter((e) => e.payload && e.payload.step_id === id);
        assert.strictEqual(rows.length, 1, JSON.stringify(rows));
        assert.strictEqual(rows[0].event_type, 'agent.step.started');
        assert.strictEqual(rows[0].key, `agent:${id}:queued`);
        assert.deepStrictEqual(rows[0].subject, { type: 'user', id: ada });
        assert.strictEqual(rows[0].payload.status, 'waiting');
        assert.strictEqual(rows[0].payload.mode, 'run');
        assert.ok(!JSON.stringify(rows[0].payload).includes('args'), 'no args field');

        const cancelled = await t.call('POST', `/api/v1/jobs/${id}/cancel`, as(ada, P));
        assert.strictEqual(cancelled.status, 200, cancelled.text);
        rows = (await stepRows()).filter((e) => e.payload && e.payload.step_id === id);
        const ended = rows.filter((e) => e.event_type === 'agent.step.ended');
        assert.strictEqual(ended.length, 1, JSON.stringify(rows));
        assert.strictEqual(ended[0].key, `agent:${id}:cancelled`);
        assert.strictEqual(ended[0].payload.status, 'stopped');
        assert.ok(ended[0].payload.ended_at, 'an ended step says when it ended');
        assert.strictEqual(rows.filter((e) => e.event_type === 'agent.step.started').length, 1, 'a repeat is never a second row');
    });

    await check('a service\'s own job publishes no step: there is no person to show it to', async () => {
        const before = (await stepRows()).length;
        const made = await t.call('POST', '/api/v1/jobs', {
            body: t.request(),
            token: t.network.signService({ sub: 'svc:builder', cap: ['run.job.submit'], project_id: P }),
        });
        assert.strictEqual(made.status, 201, made.text);
        assert.strictEqual((await stepRows()).length, before, 'no agent.step row for a service job');
    });
}

async function main() {
    const t = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'run-test-secret', BASE_URL: 'http://run.test' } });
    try { await checks(t); } finally { await t.close(); }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
