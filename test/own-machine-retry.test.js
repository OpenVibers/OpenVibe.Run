'use strict';
// A person's own machine below the learned bar is still tried for their queued job (11-18: one failed linux job, from a
// misconfigured function, left the operator's only node at 47% and every later job of that class unplaceable). It is
// free to try again and nobody is there to ask; any other offer below the bar still waits.
//   node test/own-machine-retry.test.js
const assert = require('node:assert/strict');
const { createPlacement } = require('../server/dispatch/placement');

(async () => {
    const now = Date.parse('2026-11-18T01:20:00Z');
    const OWNER = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
    const node = 'dev_01M78BBJ86HVWY7Y66DJ394GZC';
    const offer = (owner) => ({ offer_id: `node:${node}`, node_id: node, kind: 'node', region: 'us', trust: 'user-owned', owner, capabilities: ['worker:linux'],
        health: { status: 'up', checked_at: new Date(now).toISOString() }, pricing: { model: 'prepaid' }, updated_at: new Date(now).toISOString() });
    const config = { network: { url: 'https://network.invalid', internalUrl: 'http://network.invalid' }, oauth: { clientId: 'run', clientSecret: 'secret-not-real' },
        dispatch: { offersTtlMs: 0, timeoutMs: 1000 }, compute: {} };
    let owned = [offer(OWNER)];
    const fetchImpl = async (url) => {
        if (String(url).endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 300, token_type: 'Bearer' }) };
        if (String(url).includes('/internal/resources')) return { ok: true, status: 200, json: async () => ({ offers: owned }) };
        return { ok: true, status: 200, json: async () => ({ offers: [] }) };
    };
    // One failed linux job learned on that node, as in production.
    const learned = { forPerson: async () => [{ person_id: OWNER, person: OWNER, option_key: `node:${node}`, key: `node:${node}`, step_kind: 'linux', kind: 'linux', ok_w: 0, n_w: 1, updated_at: new Date(now - 60000).toISOString() }] };
    const placer = createPlacement({ config, now: () => now, fetchImpl, outcomes: learned, log: { warn() {}, debug() {} } });
    const row = { id: 'job_x', class: 'linux', requester: `user:${OWNER}`, job: { requirements: { kind: 'host.browser-check', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['first-party', 'user-owned'] } } };

    const chosen = await placer.choose(row);
    assert.ok(chosen, 'the person\'s own machine is tried again');
    assert.equal(chosen.node_id, node);
    assert.ok(chosen.reasons.some((r) => /below the learned bar \(\d+% expected\), but it is the person's own machine: tried again/.test(r)), JSON.stringify(chosen.reasons));

    // Someone else's machine below the bar: still waits.
    owned = [offer('usr_01JAB2C3D4E5F6G7H8J9K0MNPT')];
    assert.equal(await placer.choose(row), null, 'only the requester\'s own machine is retried');
    console.log('own machine retry: passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
