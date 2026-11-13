'use strict';
/**
 * The checks scheduler (research-2026-11-13/shared-node-checks.md, piece 2). Every GitHub call goes to a
 * stub through an injected fetch; no test reaches github.com. The signature, delivery dedupe, allow-list,
 * planner, check-run calls, manifest exchange + sealed secrets, owner gate, agreement query and the
 * lost-node retry are exercised end to end through the app's real routes.
 *
 *   node test/checks.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { planWorkflows, eventMatches, matrixCombinations } = require('../server/checks/planner');
const { keyOf, seal, open } = require('../server/checks/crypto');

const SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const PROJECT = ids.newId('project');
const SHA = 'a'.repeat(40);
const WEBHOOK_SECRET = 'test-webhook-secret';
const APP_ID = 4242;

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A GitHub API stub: workflows at a SHA, check runs, the installation token and the manifest conversion. */
function startGitHubStub() {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const conversion = {
        id: APP_ID, slug: 'openvibe-checks', name: 'OpenVibe Checks', html_url: 'https://github.test/apps/openvibe-checks',
        pem, webhook_secret: WEBHOOK_SECRET, client_id: 'Iv1.checks', client_secret: 'test-client-secret-not-real',
    };
    const files = new Map();
    const calls = [];
    const checkRuns = new Map();
    let nextCheckRun = 5000;
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(String(url));
        if (u.origin !== 'https://github.test') return globalThis.fetch(url, init);
        const method = init.method || 'GET';
        let body = null;
        if (init.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }
        calls.push({ method, path: u.pathname + u.search, body, authorization: String((init.headers && init.headers.Authorization) || '') });

        if (method === 'POST' && u.pathname === '/app-manifests/code-ok/conversions') return jsonResponse(200, conversion);
        if (method === 'POST' && u.pathname === '/app-manifests/code-bad/conversions') return jsonResponse(500, { message: 'boom' });
        if (method === 'GET' && u.pathname === '/users/OpenVibers' && stub.ownerType) return jsonResponse(200, { login: 'OpenVibers', type: stub.ownerType });
        if (method === 'GET' && u.pathname === '/app/installations') return jsonResponse(200, [{ id: 42, account: { login: 'OpenVibers', id: 7, type: 'Organization' }, suspended_at: null }]);
        if (method === 'POST' && u.pathname === '/app/installations/42/access_tokens') return jsonResponse(201, { token: 'test-installation-token-not-real', expires_at: new Date(Date.now() + 3600e3).toISOString() });
        if (method === 'GET' && u.pathname === '/repos/OpenVibers/demo/contents/.github/workflows') {
            return jsonResponse(200, [...files.keys()].map((path) => ({ type: 'file', name: path.split('/').pop(), path, sha: 'b'.repeat(40) })));
        }
        if (method === 'GET' && u.pathname.startsWith('/repos/OpenVibers/demo/contents/')) {
            const path = decodeURIComponent(u.pathname.slice('/repos/OpenVibers/demo/contents/'.length));
            const source = files.get(path);
            if (source == null) return jsonResponse(404, { message: 'Not Found' });
            return new Response(source, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        if (method === 'POST' && u.pathname === '/repos/OpenVibers/demo/check-runs') {
            const id = nextCheckRun++;
            checkRuns.set(id, { ...(body || {}) });
            return jsonResponse(201, { id, html_url: `https://github.test/OpenVibers/demo/runs/${id}` });
        }
        if (method === 'PATCH' && /^\/repos\/OpenVibers\/demo\/check-runs\/\d+$/.test(u.pathname)) {
            const id = Number(u.pathname.split('/').pop());
            checkRuns.set(id, { ...(checkRuns.get(id) || {}), ...(body || {}) });
            return jsonResponse(200, { id, ...(checkRuns.get(id) || {}) });
        }
        return jsonResponse(404, { message: `stub has no route for ${method} ${u.pathname}` });
    };
    const stub = { fetchImpl, calls, checkRuns, files, conversion, ownerType: null, setFile: (path, source) => files.set(path, source) };
    return stub;
}

async function bootChecks(gh, extraEnv = {}) {
    const t = await boot({
        env: {
            RUN_JOBS: 'on',
            RUN_SECRETS_KEY: SECRETS_KEY,
            RUN_CHECKS_PROJECT: PROJECT,
            RUN_CHECKS_GITHUB_API: 'https://github.test',
            RUN_CHECKS_GITHUB_WEB: 'https://github.test',
            OWNER_USERNAME: 'goosely',
            // The demo repository reports live (queued → in_progress → completed); the quiet shadow test clears it.
            RUN_CHECKS_LIVE: 'OpenVibers/demo',
            ...extraEnv,
        },
        appOpts: { fetchImpl: gh.fetchImpl },
    });
    return t;
}

async function seedApp(t, gh) {
    const key = keyOf(SECRETS_KEY);
    await t.db.maybe(
        `INSERT INTO run_checks_app (id, app_id, slug, name, html_url, pem_enc, webhook_secret_enc, client_id, client_secret_enc, created_at, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [gh.conversion.id, gh.conversion.slug, gh.conversion.name, gh.conversion.html_url,
            seal(key, gh.conversion.pem, `app:${gh.conversion.id}:pem`),
            seal(key, WEBHOOK_SECRET, `app:${gh.conversion.id}:webhook_secret`),
            gh.conversion.client_id, seal(key, gh.conversion.client_secret, `app:${gh.conversion.id}:client_secret`), Date.now()]);
}

function userCookie(t, { username = 'goosely', subject = ids.newId('user') } = {}) {
    const token = jwt.sign({ sub: String(Date.now()), subject_id: subject, username, display_name: username, role: 'user' },
        t.network.privatePem, { algorithm: 'RS256', issuer: t.network.issuer, audience: 'openvibe.network', expiresIn: '1h' });
    return `ov_token=${token}`;
}

const setCookies = (res) => (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean));

async function postWebhook(t, event, payload, { delivery = crypto.randomUUID(), secret = WEBHOOK_SECRET, signature = true } = {}) {
    const raw = Buffer.from(JSON.stringify(payload));
    const headers = { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery };
    if (signature) headers['X-Hub-Signature-256'] = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    const res = await fetch(`${t.base}/webhooks/github`, { method: 'POST', headers, body: raw });
    return { status: res.status, text: await res.text(), headers: res.headers };
}

const repoOf = (full = 'OpenVibers/demo') => {
    const [owner, name] = full.split('/');
    return { full_name: full, name, owner: { login: owner, id: 7, type: 'Organization' }, default_branch: 'main', clone_url: `https://github.com/${full}.git`, private: false };
};
const installationOf = () => ({ id: 42, account: { login: 'OpenVibers', id: 7, type: 'Organization' }, suspended_at: null });
const pushPayload = (over = {}) => ({ ref: 'refs/heads/main', after: SHA, repository: repoOf(), installation: installationOf(), ...over });

const CI = `
name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    name: Build
  test:
    needs: build
    runs-on: ubuntu-latest
    name: Test
`;

async function main() {
    console.log('checks scheduler');

    await check('planner: on branches, needs stages, matrix include/exclude, reusable sub-play', async () => {
        assert.equal(eventMatches('push', { event: 'pull_request', branch: 'main' }), false);
        assert.equal(eventMatches({ push: { branches: ['main'] } }, { event: 'push', branch: 'main' }), true);
        assert.equal(eventMatches({ push: { branches: ['release/**'] } }, { event: 'push', branch: 'main' }), false);
        const combos = matrixCombinations({ matrix: { node: [18, 20], os: ['ubuntu-latest'], include: [{ node: 22, experimental: true }, { os: 'macos-latest', node: 18 }], exclude: [{ node: 20 }] } });
        assert.equal(combos.length, 3);
        assert.deepEqual(combos.map((c) => c.node), [18, 22, 18]);
        assert.deepEqual(combos[2], { os: 'macos-latest', node: 18 });

        const workflows = [
            { path: '.github/workflows/ci.yml', source: CI },
            { path: '.github/workflows/pr.yml', source: 'on: pull_request\njobs:\n  pr: {runs-on: ubuntu-latest}\n' },
        ];
        const planned = await planWorkflows({ workflows, event: 'push', branch: 'main' });
        assert.equal(planned.errors.length, 0);
        assert.equal(planned.workflows.length, 1);
        const byKey = Object.fromEntries(planned.workflows[0].jobs.map((j) => [j.key, j]));
        assert.equal(byKey.build.stage, 0);
        assert.equal(byKey.test.stage, 1);
        assert.deepEqual(byKey.test.needs, ['build']);

        const reusable = [{ path: '.github/workflows/ci.yml', source: 'on: push\njobs:\n  setup: {runs-on: ubuntu-latest}\n  call:\n    needs: setup\n    uses: ./.github/workflows/reuse.yml\n  after:\n    needs: call\n' }];
        const sub = await planWorkflows({
            workflows: reusable, event: 'push', branch: 'main',
            readWorkflow: async () => 'on: workflow_call\njobs:\n  build: {runs-on: ubuntu-latest}\n  test:\n    needs: build\n',
        });
        const jobs = Object.fromEntries(sub.workflows[0].jobs.map((j) => [j.key, j]));
        assert.equal(jobs.setup.stage, 0);
        assert.equal(jobs['call/build'].stage, 1);
        assert.deepEqual(jobs['call/build'].needs, ['setup']);
        assert.equal(jobs['call/test'].stage, 2);
        assert.equal(jobs['call/test'].display_name, 'call / test');
        assert.deepEqual(jobs.after.needs.sort(), ['call/build', 'call/test']);
    });

    await check('owner gate on /admin/checks', async () => {
        const gh = startGitHubStub();
        const t = await bootChecks(gh);
        try {
            const anon = await fetch(`${t.base}/admin/checks`, { redirect: 'manual' });
            assert.equal(anon.status, 302);
            assert.match(anon.headers.get('location'), /^\/auth\/login/);
            const other = await fetch(`${t.base}/admin/checks`, { headers: { Cookie: userCookie(t, { username: 'not-the-owner' }) } });
            assert.equal(other.status, 403);
            const owner = await fetch(`${t.base}/admin/checks`, { headers: { Cookie: userCookie(t) } });
            assert.equal(owner.status, 200);
            const bearer = await fetch(`${t.base}/admin/checks`, { headers: { Authorization: `Bearer ${t.network.signUser({ username: 'goosely' })}` } });
            assert.equal(bearer.status, 200, 'the owner may also present a Network user token');
            const html = await owner.text();
            assert.match(html, /Create the GitHub App/);
            assert.match(html, /method="post"/);
            assert.match(html, /organizations\/OpenVibers\/settings\/apps\/new\?state=/);
            const manifest = JSON.parse(html.match(/name="manifest" value="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
            assert.equal(manifest.name, 'OpenVibe Checks');
            assert.deepEqual(manifest.default_permissions, { checks: 'write', statuses: 'write', contents: 'read', pull_requests: 'read', metadata: 'read', actions: 'read' });
            assert.deepEqual(manifest.default_events, ['push', 'pull_request', 'check_suite', 'workflow_job']);
            assert.equal(manifest.public, false);
            assert.equal(manifest.hook_attributes.url, `${t.config.baseUrl}/webhooks/github`);
            assert.equal(manifest.setup_url, `${t.config.baseUrl}/admin/checks?installed=1`, 'GitHub returns to Run after installing');
        } finally { await t.close(); }
    });

    await check('a user account (OpenVibers is one): the App is made at /settings/apps/new, by GitHub\'s answer or by RUN_CHECKS_ORG_TYPE', async () => {
        const gh = startGitHubStub();
        gh.ownerType = 'User';
        const t = await bootChecks(gh);
        try {
            const html = await (await fetch(`${t.base}/admin/checks`, { headers: { Cookie: userCookie(t) } })).text();
            assert.match(html, /action="https:\/\/github\.test\/settings\/apps\/new\?state=/);
            assert.doesNotMatch(html, /organizations\/OpenVibers\/settings\/apps\/new/);
        } finally { await t.close(); }
        const gh2 = startGitHubStub();
        const t2 = await bootChecks(gh2, { RUN_CHECKS_ORG_TYPE: 'user' });
        try {
            const html = await (await fetch(`${t2.base}/admin/checks`, { headers: { Cookie: userCookie(t2) } })).text();
            assert.match(html, /action="https:\/\/github\.test\/settings\/apps\/new\?state=/, 'the setting decides without asking GitHub');
            assert.ok(!gh2.calls.some((c) => c.path.startsWith('/users/')), 'no lookup when the type is set');
        } finally { await t2.close(); }
    });

    await check('manifest exchange: state checked, secrets sealed, raw PEM never in a row or the page', async () => {
        const gh = startGitHubStub();
        const t = await bootChecks(gh);
        try {
            const cookie = userCookie(t);
            const page = await fetch(`${t.base}/admin/checks`, { headers: { Cookie: cookie } });
            assert.equal(page.status, 200);
            const html = await page.text();
            const state = new URL(html.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams.get('state');
            const stateCookie = setCookies(page).find((c) => c.startsWith('ov_checks_state='));
            assert.ok(stateCookie);
            const created = await fetch(`${t.base}/admin/checks/created?code=code-ok&state=${encodeURIComponent(state)}`, {
                headers: { Cookie: `${cookie}; ${stateCookie.split(';')[0]}` }, redirect: 'manual',
            });
            assert.equal(created.status, 303);
            assert.equal(created.headers.get('location'), 'https://github.test/apps/openvibe-checks/installations/new', 'straight on to installing it');

            const row = await t.db.maybe('SELECT * FROM run_checks_app WHERE id = 1');
            assert.equal(Number(row.app_id), APP_ID);
            assert.equal(row.slug, 'openvibe-checks');
            assert.ok(row.pem_enc && !row.pem_enc.includes(gh.conversion.pem));
            assert.ok(!JSON.stringify(row).includes(gh.conversion.pem));
            assert.ok(!JSON.stringify(row).includes('test-client-secret-not-real'));
            const key = keyOf(SECRETS_KEY);
            assert.equal(open(key, row.pem_enc, `app:${APP_ID}:pem`), gh.conversion.pem);
            assert.equal(open(key, row.webhook_secret_enc, `app:${APP_ID}:webhook_secret`), WEBHOOK_SECRET);
            assert.equal(open(key, row.client_secret_enc, `app:${APP_ID}:client_secret`), 'test-client-secret-not-real');

            const after = await fetch(`${t.base}/admin/checks?created=1`, { headers: { Cookie: cookie } });
            const afterHtml = await after.text();
            assert.match(afterHtml, /installed|created/);
            assert.match(afterHtml, /Install OpenVibe Checks on OpenVibers/);
            assert.ok(!afterHtml.includes(gh.conversion.pem));
            assert.ok(!afterHtml.includes('test-client-secret-not-real'));
            assert.ok(!afterHtml.includes(WEBHOOK_SECRET));
        } finally { await t.close(); }
    });

    await check('webhook: signature good/bad/missing and delivery dedupe', async () => {
        const gh = startGitHubStub();
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            const delivery = crypto.randomUUID();
            const good = await postWebhook(t, 'ping', { zen: 'hello' }, { delivery });
            assert.equal(good.status, 204);
            const again = await postWebhook(t, 'ping', { zen: 'hello' }, { delivery });
            assert.equal(again.status, 204);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_deliveries'), 1);
            const bad = await postWebhook(t, 'ping', { zen: 'hello' }, { delivery: crypto.randomUUID(), secret: 'wrong' });
            assert.equal(bad.status, 401);
            const missing = await postWebhook(t, 'ping', { zen: 'hello' }, { delivery: crypto.randomUUID(), signature: false });
            assert.equal(missing.status, 401);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_deliveries'), 1);
        } finally { await t.close(); }
    });

    await check('webhook: a repository outside OpenVibers is ignored (no read, no plan)', async () => {
        const gh = startGitHubStub();
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            const payload = pushPayload({ repository: repoOf('SomeoneElse/demo') });
            const res = await postWebhook(t, 'push', payload, { delivery: crypto.randomUUID() });
            assert.equal(res.status, 204);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_plans'), 0);
            assert.equal(gh.calls.filter((c) => c.path.includes('/contents/')).length, 0);
        } finally { await t.close(); }
    });

    await check('push plans the workflow, queues stage 0 and creates a queued check run per job', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            const res = await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            assert.equal(res.status, 204);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_plans'), 1);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_jobs'), 2);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 1);
            const created = gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/OpenVibers/demo/check-runs');
            assert.equal(created.length, 2);
            assert.deepEqual(created.map((c) => c.body.name).sort(), ['openvibe / Build', 'openvibe / Test']);
            assert.ok(created.every((c) => c.body.status === 'queued' && c.body.head_sha === SHA));
            const tokenCalls = gh.calls.filter((c) => c.path === '/app/installations/42/access_tokens');
            assert.equal(tokenCalls.length, 1, 'installation token is cached');
            assert.ok(tokenCalls[0].authorization.startsWith('Bearer eyJ'));
            assert.ok(gh.calls.filter((c) => c.path.includes('/contents/')).every((c) => c.authorization === 'Bearer test-installation-token-not-real'));
            const tokenRow = await t.db.maybe('SELECT * FROM run_checks_tokens WHERE installation_id = 42');
            assert.ok(tokenRow, 'the installation token is cached in the database');
            assert.ok(!tokenRow.token_enc.includes('test-installation-token-not-real'));
            assert.equal(open(keyOf(SECRETS_KEY), tokenRow.token_enc, 'installation:42'), 'test-installation-token-not-real');

            const run = await t.db.maybe('SELECT * FROM run_jobs');
            assert.equal(run.class, 'code');
            assert.equal(run.job.artifact.name, 'openvibe-codes');
            assert.equal(run.job.artifact.version, '1.0.0');
            assert.equal(run.job.args.kind, 'check');
            assert.equal(run.job.args.repo, 'https://github.com/OpenVibers/demo.git');
            assert.equal(run.job.args.sha, SHA);
            assert.equal(run.job.args.workflow, '.github/workflows/ci.yml');
            assert.equal(run.job.args.job, 'build');
            assert.equal(run.job.args.event, 'push');
            assert.equal(run.job.args.ref, 'refs/heads/main');
            assert.equal(run.job.net, 'public');
            assert.deepEqual(run.job.requirements.trust, ['first-party', 'user-owned']);
            assert.equal(run.project_id, PROJECT);
            assert.equal(run.requester, 'service:checks');
            const waiting = await t.db.maybe("SELECT * FROM run_checks_jobs WHERE state = 'waiting'");
            assert.equal(waiting.display_name, 'Test');
            assert.deepEqual(waiting.needs, ['build']);
        } finally { await t.close(); }
    });

    await check('check runs: in_progress when the node starts, completed with the steps and details_url', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            assert.equal((await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() })).status, 204);
            const build = await t.db.maybe("SELECT cj.id AS check_job_id, cj.check_run_id, rj.id AS run_job_id FROM run_checks_jobs cj JOIN run_jobs rj ON rj.id = cj.run_job_id WHERE cj.display_name = 'Build'");
            await t.db.maybe("UPDATE run_jobs SET state = 'running', started_ms = $2, node_id = 'dev_node_1' WHERE id = $1", [build.run_job_id, Date.now()]);
            await t.checks.tick();
            let check = gh.checkRuns.get(Number(build.check_run_id));
            assert.equal(check.status, 'in_progress');
            assert.ok(check.started_at);
            assert.match(check.details_url, new RegExp(`/api/v1/jobs/${build.run_job_id}$`));

            const finished = Date.now();
            await t.db.maybe(
                "UPDATE run_jobs SET state = 'succeeded', finished_ms = $2, wall_ms = 1200, result = $3::jsonb WHERE id = $1",
                [build.run_job_id, finished, JSON.stringify({ ok: true, conclusion: 'success', steps: [{ name: 'ok', conclusion: 'success', ms: 10 }], ms: 1200 })]);
            await t.checks.tick();
            check = gh.checkRuns.get(Number(build.check_run_id));
            assert.equal(check.status, 'completed');
            assert.equal(check.conclusion, 'success');
            assert.match(check.output.summary, /ok/);
            assert.match(check.details_url, new RegExp(`/api/v1/jobs/${build.run_job_id}$`));
            const row = await t.db.maybe('SELECT * FROM run_checks_jobs WHERE id = $1', [build.check_job_id]);
            assert.equal(row.state, 'completed');
            assert.equal(row.conclusion, 'success');
            assert.ok(Number(row.queue_ms) >= 0 && Number(row.run_ms) >= 0);
            const next = await t.db.maybe("SELECT cj.*, rj.id AS run_job_id FROM run_checks_jobs cj LEFT JOIN run_jobs rj ON rj.id = cj.run_job_id WHERE cj.display_name = 'Test'");
            assert.ok(next.run_job_id, 'the later stage is queued when its need succeeds');
            const shadow = await t.db.maybe("SELECT * FROM run_checks_shadow WHERE job_name = 'Build'");
            assert.equal(shadow.node_conclusion, 'success');
        } finally { await t.close(); }
    });

    await check("RUN_CHECKS_OWNER makes each check the owner's own job, so their own machines can run it", async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const owner = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
        const t = await bootChecks(gh, { RUN_CHECKS_OWNER: owner });
        try {
            await seedApp(t, gh);
            assert.equal((await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() })).status, 204);
            const run = await t.db.maybe('SELECT * FROM run_jobs');
            assert.equal(run.requester, `user:${owner}`);
            assert.deepEqual(run.job.requirements.trust, ['first-party', 'user-owned']);
            assert.match(t.checks.status().runs_as, /checks owner/);
        } finally { await t.close(); }
    });

    await check('quiet shadow: no check run until a job finishes; a failure shows neutral, the shadow row keeps it', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh, { RUN_CHECKS_LIVE: '' });
        try {
            await seedApp(t, gh);
            assert.equal((await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() })).status, 204);
            const posts = () => gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/OpenVibers/demo/check-runs');
            const patches = () => gh.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/repos/OpenVibers/demo/check-runs/'));
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 1, 'the job is still planned and queued');
            assert.equal(posts().length, 0, 'no queued check run in quiet shadow');
            assert.match(t.checks.status().reporting, /quiet shadow everywhere/);

            const build = await t.db.maybe("SELECT cj.id AS check_job_id, rj.id AS run_job_id FROM run_checks_jobs cj JOIN run_jobs rj ON rj.id = cj.run_job_id WHERE cj.display_name = 'Build'");
            await t.db.maybe("UPDATE run_jobs SET state = 'running', started_ms = $2, node_id = 'dev_node_1' WHERE id = $1", [build.run_job_id, Date.now()]);
            await t.checks.tick();
            assert.equal(posts().length + patches().length, 0, 'no in-progress check run either');
            assert.equal(await t.db.value('SELECT check_state FROM run_checks_jobs WHERE id = $1', [build.check_job_id]), 'in_progress');

            await t.db.maybe(
                "UPDATE run_jobs SET state = 'failed', finished_ms = $2, wall_ms = 900, result = $3::jsonb WHERE id = $1",
                [build.run_job_id, Date.now(), JSON.stringify({ ok: false, conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure', ms: 800 }], ms: 900 })]);
            await t.checks.tick();
            const made = posts();
            const buildRun = made.find((c) => c.body.name === 'openvibe / Build');
            assert.ok(buildRun, 'the finished job gets its check run');
            assert.equal(buildRun.body.status, 'completed');
            assert.equal(buildRun.body.conclusion, 'neutral', 'a shadow failure never fails the commit');
            assert.match(buildRun.body.output.title, /node said failure; Actions decides/);
            assert.ok(buildRun.body.completed_at && buildRun.body.head_sha === SHA);
            assert.equal(patches().length, 0);
            const row = await t.db.maybe('SELECT * FROM run_checks_jobs WHERE id = $1', [build.check_job_id]);
            assert.equal(row.conclusion, 'failure', 'Run keeps the real conclusion');
            assert.ok(row.check_run_id, 'the check run id is kept');
            const shadow = await t.db.maybe("SELECT * FROM run_checks_shadow WHERE job_name = 'Build'");
            assert.equal(shadow.node_conclusion, 'failure');

            // The later stage is skipped because its need failed: shown as skipped, never as pending or failed.
            const testRun = made.find((c) => c.body.name === 'openvibe / Test');
            assert.ok(testRun, 'the skipped stage is reported once');
            assert.equal(testRun.body.status, 'completed');
            assert.equal(testRun.body.conclusion, 'skipped');
            assert.equal(made.length, 2);
        } finally { await t.close(); }
    });

    await check('quiet shadow: a success shows as success; RUN_CHECKS_LIVE=* reports every repository live', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh, { RUN_CHECKS_LIVE: '' });
        try {
            await seedApp(t, gh);
            await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            const build = await t.db.maybe("SELECT rj.id AS run_job_id FROM run_checks_jobs cj JOIN run_jobs rj ON rj.id = cj.run_job_id WHERE cj.display_name = 'Build'");
            await t.db.maybe("UPDATE run_jobs SET state = 'succeeded', started_ms = $2, finished_ms = $3, wall_ms = 500, result = $4::jsonb WHERE id = $1",
                [build.run_job_id, Date.now() - 1000, Date.now(), JSON.stringify({ ok: true, conclusion: 'success', steps: [{ name: 'ok', conclusion: 'success', ms: 10 }] })]);
            await t.checks.tick();
            const made = gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/OpenVibers/demo/check-runs');
            assert.equal(made.length, 1);
            assert.equal(made[0].body.conclusion, 'success');
            assert.equal(made[0].body.output.title, 'Build');
        } finally { await t.close(); }
        const gh2 = startGitHubStub();
        gh2.setFile('.github/workflows/ci.yml', CI);
        const t2 = await bootChecks(gh2, { RUN_CHECKS_LIVE: '*' });
        try {
            await seedApp(t2, gh2);
            await postWebhook(t2, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            const queued = gh2.calls.filter((c) => c.method === 'POST' && c.path === '/repos/OpenVibers/demo/check-runs');
            assert.equal(queued.length, 2);
            assert.ok(queued.every((c) => c.body.status === 'queued'));
            assert.equal(t2.checks.status().reporting, 'live everywhere');
        } finally { await t2.close(); }
    });

    await check('shadow: workflow_job completed records the Actions conclusion; agreement is per repo and owner-only', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            const build = await t.db.maybe("SELECT cj.id, cj.check_run_id, rj.id AS run_job_id FROM run_checks_jobs cj JOIN run_jobs rj ON rj.id = cj.run_job_id WHERE cj.display_name = 'Build'");
            const started = Date.now() - 5000;
            await t.db.maybe("UPDATE run_jobs SET state = 'succeeded', started_ms = $2, finished_ms = $3, wall_ms = 4000, result = $4::jsonb WHERE id = $1",
                [build.run_job_id, started, Date.now(), JSON.stringify({ ok: true, conclusion: 'success', steps: [{ name: 'ok', conclusion: 'success', ms: 10 }] })]);
            await t.checks.tick();

            const actions = await postWebhook(t, 'workflow_job', {
                action: 'completed', repository: repoOf(), installation: installationOf(),
                workflow_job: { id: 9001, name: 'Build', head_sha: SHA, conclusion: 'success', workflow_name: 'CI', started_at: new Date(started).toISOString(), completed_at: new Date().toISOString() },
            }, { delivery: crypto.randomUUID() });
            assert.equal(actions.status, 204);
            const pair = await t.db.maybe("SELECT * FROM run_checks_shadow WHERE repo = 'OpenVibers/demo' AND sha = $1 AND job_name = 'Build'", [SHA]);
            assert.equal(pair.actions_conclusion, 'success');
            assert.equal(pair.node_conclusion, 'success');

            const owner = userCookie(t);
            const anon = await fetch(`${t.base}/api/v1/checks/agreement?repo=OpenVibers/demo`);
            assert.equal(anon.status, 401);
            const other = await fetch(`${t.base}/api/v1/checks/agreement?repo=OpenVibers/demo`, { headers: { Cookie: userCookie(t, { username: 'ada' }) } });
            assert.equal(other.status, 403);
            const agreement = await fetch(`${t.base}/api/v1/checks/agreement?repo=OpenVibers/demo`, { headers: { Cookie: owner } });
            assert.equal(agreement.status, 200);
            const body = await agreement.json();
            assert.equal(body.repos.length, 1);
            assert.equal(body.repos[0].repo, 'OpenVibers/demo');
            assert.equal(body.repos[0].paired, 1);
            assert.equal(body.repos[0].agreement, 1);
            assert.ok(body.repos[0].run_ms >= 0);
        } finally { await t.close(); }
    });

    await check('pull_request opened plans at the head SHA; closed and a fork head do not', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/pr.yml', 'name: PR\non: pull_request\njobs:\n  pr:\n    runs-on: ubuntu-latest\n    name: PR check\n');
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            const pr = (over = {}) => ({
                action: 'opened', number: 7, repository: repoOf(), installation: installationOf(),
                pull_request: { number: 7, head: { sha: SHA, ref: 'feature', repo: repoOf() }, base: { ref: 'main' } },
                ...over,
            });
            assert.equal((await postWebhook(t, 'pull_request', pr(), { delivery: crypto.randomUUID() })).status, 204);
            const plan = await t.db.maybe('SELECT * FROM run_checks_plans');
            assert.equal(plan.event, 'pull_request');
            assert.equal(plan.ref, 'refs/pull/7/merge');
            assert.equal(plan.branch, 'main');
            const run = await t.db.maybe('SELECT * FROM run_jobs');
            assert.equal(run.job.args.event, 'pull_request');
            assert.equal(run.job.args.ref, 'refs/pull/7/merge');

            const before = await t.db.value('SELECT COUNT(*) FROM run_checks_plans');
            const reads = gh.calls.length;
            assert.equal((await postWebhook(t, 'pull_request', pr({ action: 'closed' }), { delivery: crypto.randomUUID() })).status, 204);
            const fork = pr({ pull_request: { number: 8, head: { sha: SHA, ref: 'feature', repo: repoOf('Fork/demo') }, base: { ref: 'main' } } });
            assert.equal((await postWebhook(t, 'pull_request', fork, { delivery: crypto.randomUUID() })).status, 204);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_plans'), before);
            assert.equal(gh.calls.length, reads, 'closed and fork deliveries make no GitHub call');
        } finally { await t.close(); }
    });

    await check('a failed need skips the later job and its check run', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            const build = await t.db.maybe("SELECT cj.id AS check_job_id, cj.check_run_id, rj.id AS run_job_id FROM run_checks_jobs cj JOIN run_jobs rj ON rj.id = cj.run_job_id WHERE cj.display_name = 'Build'");
            await t.db.maybe("UPDATE run_jobs SET state = 'failed', finished_ms = $2, exit_reason = 'exited', exit_code = 1, result = $3::jsonb WHERE id = $1",
                [build.run_job_id, Date.now(), JSON.stringify({ ok: false, conclusion: 'failure', steps: [{ name: 'test', conclusion: 'failure', ms: 5 }] })]);
            await t.checks.tick();
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 1, 'the later stage is not queued');
            const test = await t.db.maybe("SELECT * FROM run_checks_jobs WHERE display_name = 'Test'");
            assert.equal(test.state, 'completed');
            assert.equal(test.conclusion, 'skipped');
            const checkRun = gh.checkRuns.get(Number(test.check_run_id));
            assert.equal(checkRun.status, 'completed');
            assert.equal(checkRun.conclusion, 'skipped');
            const plan = await t.db.maybe('SELECT * FROM run_checks_plans');
            assert.equal(plan.state, 'failed');
        } finally { await t.close(); }
    });

    await check('matrix max-parallel limits the queued combinations', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/matrix.yml', 'name: Matrix\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      max-parallel: 1\n      matrix:\n        node: [18, 20]\n');
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 1);
            const waiting = await t.db.many("SELECT * FROM run_checks_jobs WHERE state = 'waiting'");
            assert.equal(waiting.length, 1);
            const first = await t.db.maybe('SELECT * FROM run_jobs');
            await t.db.maybe("UPDATE run_jobs SET state = 'succeeded', finished_ms = $2, wall_ms = 100, result = $3::jsonb WHERE id = $1",
                [first.id, Date.now(), JSON.stringify({ ok: true, conclusion: 'success', steps: [] })]);
            await t.checks.tick();
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 2);
            const second = await t.db.maybe('SELECT * FROM run_jobs WHERE id <> $1', [first.id]);
            assert.deepEqual(second.job.args.matrix, { node: 20 });
        } finally { await t.close(); }
    });

    await check('RUN_JOBS=off: no outbound call and no plan', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', CI);
        const t = await bootChecks(gh, { RUN_JOBS: 'off' });
        try {
            await seedApp(t, gh);
            assert.equal(t.checks.start(), false, 'the tick does not start with the background jobs off');
            const res = await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            assert.equal(res.status, 204);
            assert.equal(gh.calls.length, 0);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_checks_plans'), 0);
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 0);
        } finally { await t.close(); }
    });

    await check('a lost node is retried once elsewhere, then the check fails', async () => {
        const gh = startGitHubStub();
        gh.setFile('.github/workflows/ci.yml', 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    name: Build\n');
        const t = await bootChecks(gh);
        try {
            await seedApp(t, gh);
            await postWebhook(t, 'push', pushPayload(), { delivery: crypto.randomUUID() });
            const first = await t.db.maybe('SELECT * FROM run_jobs');
            const job = await t.db.maybe('SELECT * FROM run_checks_jobs');
            assert.equal(job.attempts, 1);
            await t.db.maybe("UPDATE run_jobs SET state = 'failed', finished_ms = $2, exit_reason = 'failed' WHERE id = $1", [first.id, Date.now()]);
            await t.checks.tick();
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 2);
            const second = await t.db.maybe("SELECT * FROM run_jobs WHERE id <> $1", [first.id]);
            const retried = await t.db.maybe('SELECT * FROM run_checks_jobs WHERE id = $1', [job.id]);
            assert.equal(retried.attempts, 2);
            assert.equal(retried.state, 'queued');
            assert.equal(retried.check_state, 'queued');
            assert.equal(retried.check_run_id, job.check_run_id);
            assert.notEqual(second.id, first.id);

            await t.db.maybe("UPDATE run_jobs SET state = 'failed', finished_ms = $2, exit_reason = 'failed' WHERE id = $1", [second.id, Date.now()]);
            await t.checks.tick();
            assert.equal(await t.db.value('SELECT COUNT(*) FROM run_jobs'), 2, 'no third attempt');
            const doneRow = await t.db.maybe('SELECT * FROM run_checks_jobs WHERE id = $1', [job.id]);
            assert.equal(doneRow.state, 'completed');
            assert.equal(doneRow.conclusion, 'failure');
            const checkRun = gh.checkRuns.get(Number(job.check_run_id));
            assert.equal(checkRun.status, 'completed');
            assert.equal(checkRun.conclusion, 'failure');
        } finally { await t.close(); }
    });

    done();
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
