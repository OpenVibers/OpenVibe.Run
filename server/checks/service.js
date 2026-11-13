'use strict';
/**
 * The checks scheduler (research-2026-11-13/shared-node-checks.md, piece 2).
 *
 *   /admin/checks                    the network owner's page: the App's state and the manifest-flow button
 *   /admin/checks/created            the manifest redirect: state checked, code exchanged, secrets sealed
 *   POST /webhooks/github            raw body, HMAC-SHA256 of the stored webhook secret (constant time),
 *                                    X-GitHub-Delivery dedupe, only the allow-list's repositories, only
 *                                    pull_request opened/synchronize/reopened and push to the default branch
 *   GET  /api/v1/checks/agreement    node vs Actions agreement, queue ms and run ms per repo (owner only)
 *
 * A matching event reads the workflows at the SHA with an installation token, plans act's jobs, creates one
 * queued GitHub check run per planned job and queues the first stage as ordinary Run jobs (class code,
 * `openvibe-codes@1.0.0`, args `{ kind: 'check', … }`). A tick follows the Run jobs, reports in_progress and
 * completed to GitHub, retries a node that went away once, skips the jobs that need a job that did not
 * succeed, and writes the shadow pair of the node's conclusion beside the Actions one.
 *
 * Nothing runs at module load. server/index.js starts the tick only with RUN_JOBS on; the webhook and the
 * owner page are request-driven. Every outbound call needs the App: before it exists the webhook answers
 * 503 and the page shows how to create it.
 */
const crypto = require('crypto');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { createSsoClient } = require('openvibe-sdk/sso');
const store = require('./store');
const { createGitHub } = require('./github');
const { planWorkflows } = require('./planner');
const { keyOf, seal, open } = require('./crypto');
const views = require('./views');

const TOKEN_MARGIN_MS = 5 * 60_000;
const DELIVERY_TTL_MS = 7 * 24 * 3600_000;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const CHECK_CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale']);
const MAP_CONCLUSION = { success: 'success', failure: 'failure', cancelled: 'cancelled', timed_out: 'timed_out', timedout: 'timed_out', skipped: 'skipped' };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const parseJson = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    try { return obj(JSON.parse(v)); } catch { return {}; }
};
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const newPlanId = () => `chkplan_${ids.ulid()}`;
const newJobId = () => `chkjob_${ids.ulid()}`;

/** The manifest posted to GitHub. Public configuration only; the secrets come back from the conversion call. */
function manifestFor({ baseUrl } = {}) {
    return {
        name: 'OpenVibe Checks',
        url: baseUrl,
        hook_attributes: { url: `${baseUrl}/webhooks/github`, active: true },
        redirect_url: `${baseUrl}/admin/checks/created`,
        public: false,
        default_permissions: {
            checks: 'write', statuses: 'write', contents: 'read', pull_requests: 'read', metadata: 'read', actions: 'read',
        },
        default_events: ['push', 'pull_request', 'check_suite', 'workflow_job'],
    };
}

/**
 * createChecks({ config, db, jobsStore, events, now, fetchImpl, log, sso }) → the checks service.
 * `jobsStore` is server/jobs/store.js (mint, frameOf, …); `events` is server/jobs/events.js.
 */
function createChecks({ config, db, jobsStore = null, events = null, now = () => Date.now(), fetchImpl = globalThis.fetch, log = console, userAuth = null, sso = null } = {}) {
    const cfg = (config && config.checks) || {};
    const key = keyOf(cfg.secretsKey);
    const owners = (Array.isArray(cfg.owners) && cfg.owners.length ? cfg.owners : ['OpenVibers'])
        .map((o) => String(o).toLowerCase()).filter(Boolean);
    const org = cfg.org || 'OpenVibers';
    const project = PROJECT_RE.test(String(cfg.project || '')) ? String(cfg.project) : null;
    const githubWeb = String(cfg.githubWeb || 'https://github.com').replace(/\/+$/, '');
    const tickMs = Math.max(500, Number(cfg.tickMs) || 5000);
    const enabled = cfg.enabled !== false && Boolean(key);
    // Whose job a check is. A person's own machine (a user-owned node such as the owner's home tower) runs only that
    // person's jobs: placement offers it only to their jobs and Bot refuses anyone else's. The checks are the network
    // owner's own CI, so with RUN_CHECKS_OWNER naming them (usr_…) each check is their job and can run on their
    // machines; without it a check is the service's and only first-party nodes can take it.
    const checksRequester = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(cfg.owner || '')) ? `user:${cfg.owner}` : 'service:checks';
    // Quiet shadow (the default for every repository not in RUN_CHECKS_LIVE): see createCheckRun's `completed` and
    // finishJob. Live repositories report queued → in_progress → completed with the node's own conclusion.
    const live = new Set((Array.isArray(cfg.live) ? cfg.live : []).map((r) => String(r).toLowerCase()));
    const isLive = (repo) => live.has('*') || live.has(String(repo || '').toLowerCase());
    /** What a quiet shadow check shows on GitHub: success and skipped as they are, anything else neutral. */
    const shadowShown = (conclusion) => (conclusion === 'success' || conclusion === 'skipped' ? conclusion : 'neutral');
    const github = createGitHub({ config, fetchImpl, now, log });
    const tokenCache = new Map();   // installation id → { token, expiresAt }
    let timer = null;
    let loggedNoProject = false;

    let ssoClient = sso;
    if (!ssoClient && config && config.baseUrl && config.oauth && config.oauth.clientId) {
        try {
            ssoClient = createSsoClient({
                site: 'run', siteName: 'OpenVibe.Run', baseUrl: config.baseUrl,
                clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
                redirectUri: `${config.baseUrl}/auth/callback`, scope: 'profile theme',
                networkUrl: config.network.url, networkInternalUrl: config.network.internalUrl,
                issuer: config.network.issuer, publicKey: config.network.publicKey, audience: ['openvibe.network'],
                secureCookies: config.isProduction, httpOnlyAccess: true, fetch: fetchImpl, log,
            });
        } catch (e) { log.warn(`[Run] checks: sign-in for /admin/checks is unavailable (${e.message})`); }
    }
    const optionalAuth = ssoClient ? ssoClient.optionalAuth() : (_req, _res, next) => next();

    /** A Bearer Network user token as a session (the API's own verify), for a script or the owner's API client. */
    function bearerAuth(req, res, next) {
        if (req.user || !userAuth) return next();
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return next();
        userAuth.verify(header.slice(7).trim()).then((claims) => { if (claims) req.user = claims; next(); }, () => next());
    }

    /** The configured owner: their Network subject, or the Network owner's username (the same rule Network uses). */
    function isOwner(user) {
        if (!user) return false;
        const subject = String(user.subject_id || '');
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) return false;
        if (cfg.owner && subject === cfg.owner) return true;
        const username = String(user.username || '').toLowerCase();
        return Boolean(username) && username === String(cfg.ownerUsername || 'goosely').toLowerCase();
    }

    function ownerPage(req, res, next) {
        optionalAuth(req, res, () => bearerAuth(req, res, () => {
            if (!req.user) return res.redirect(302, `/auth/login?next=${encodeURIComponent(req.originalUrl || '/admin/checks')}`);
            if (!isOwner(req.user)) return res.status(403).type('html').send(views.errorPage({ title: 'Owner access required', text: 'Only the network owner can manage the checks App.', back: '/' }));
            return next();
        }));
    }

    function ownerApi(req, res, next) {
        optionalAuth(req, res, () => bearerAuth(req, res, () => {
            if (!req.user) return res.status(401).json({ error: 'owner session required' });
            if (!isOwner(req.user)) return res.status(403).json({ error: 'owner access required' });
            return next();
        }));
    }

    /** The App row with its sealed fields opened, or null. Never exposes a secret; `unreadable` says a key is wrong. */
    async function appRow() {
        const row = await store.getApp(db);
        if (!row) return null;
        if (!key) return { ...row, unreadable: true };
        try {
            return {
                ...row,
                pem: open(key, row.pem_enc, `app:${row.app_id}:pem`),
                webhook_secret: open(key, row.webhook_secret_enc, `app:${row.app_id}:webhook_secret`),
                client_secret: row.client_secret_enc ? open(key, row.client_secret_enc, `app:${row.app_id}:client_secret`) : null,
            };
        } catch (e) {
            log.warn(`[Run] checks: the App secrets cannot be opened (${e.message}); create the App again`);
            return { ...row, unreadable: true };
        }
    }

    /** An installation token, from memory or the sealed cache, refreshed five minutes before it expires. */
    async function tokenFor(app, installationId) {
        if (!app || app.unreadable || !app.pem) throw new Error('checks: the App has no readable key');
        const id = Number(installationId);
        const held = tokenCache.get(id);
        if (held && held.expiresAt - now() > TOKEN_MARGIN_MS) return held.token;
        const row = await store.getToken(db, id).catch(() => null);
        if (row && Number(row.expires_at) - now() > TOKEN_MARGIN_MS) {
            try {
                const token = open(key, row.token_enc, `installation:${id}`);
                tokenCache.set(id, { token, expiresAt: Number(row.expires_at) });
                return token;
            } catch { await store.deleteToken(db, id).catch(() => null); }
        }
        const issued = await github.createInstallationToken(app, id);
        const sealed = seal(key, issued.token, `installation:${id}`);
        await store.putToken(db, id, sealed, issued.expiresAt, now()).catch((e) => log.warn(`[Run] checks: the installation token cache could not be written (${e.code || e.message})`));
        tokenCache.set(id, issued);
        return issued.token;
    }

    /** Context for one plan: the App and an installation token, best effort (a missing token only loses the report). */
    async function planContext(plan) {
        const app = await appRow();
        if (!app || app.unreadable) return { app, token: null };
        if (!plan || !plan.installation_id) return { app, token: null };
        try { return { app, token: await tokenFor(app, plan.installation_id) }; } catch (e) {
            log.warn(`[Run] checks: no installation token for ${plan.repo} (${e.code || e.message})`);
            return { app, token: null };
        }
    }

    const detailsUrlOf = (runJobId) => (runJobId ? `${config.baseUrl}/api/v1/jobs/${encodeURIComponent(runJobId)}` : null);

    // ── planning ───────────────────────────────────────────────────────────────

    /**
     * Plan one webhook event: read the workflows at the SHA, keep the ones whose `on` matches, expand jobs,
     * create a plan, one queued check run per job, and queue the first stage. → { plans, errors }.
     */
    async function planForEvent({ repo, owner, name, sha, event, ref, branch, action = null, installationId, deliveryId = null }) {
        // The drill/test switch: RUN_JOBS=off means the background side is not running, so a delivery is
        // recorded and answered, but no workflow is read and no outbound call is made.
        if (!enabled) return { plans: [], skipped: 'disabled' };
        if (!config.jobs.enabled) return { plans: [], skipped: 'jobs_off' };
        if (!project) {
            if (!loggedNoProject) { log.warn('[Run] checks: RUN_CHECKS_PROJECT is not set, so no workflow is planned'); loggedNoProject = true; }
            return { plans: [], skipped: 'no_project' };
        }
        if (!SHA_RE.test(String(sha || ''))) return { plans: [], skipped: 'bad_sha' };
        const app = await appRow();
        if (!app || app.unreadable || !app.pem) return { plans: [], skipped: 'no_app' };
        const token = await tokenFor(app, installationId);
        const workflows = await github.listWorkflows(app, token, { owner, repo: name, sha });
        const readWorkflow = async (uses) => {
            if (uses.local) return github.readFile(app, token, { owner, repo: name, path: uses.path, ref: sha });
            if (!owners.includes(String(uses.owner || '').toLowerCase())) return null;
            return github.readFile(app, token, { owner: uses.owner, repo: uses.repo, path: uses.path, ref: uses.ref });
        };
        const planned = await planWorkflows({ workflows, event, branch, action, readWorkflow, log });
        const made = [];
        for (const wf of planned.workflows) {
            const plan = {
                id: newPlanId(), delivery_id: deliveryId, repo, owner, sha, event, ref, branch,
                installation_id: installationId, workflow_path: wf.path, workflow_name: wf.name,
            };
            const jobs = wf.jobs.map((job) => ({ ...job, id: newJobId(), job_key: job.key, matrix_group: job.group && job.max_parallel ? job.group : null }));
            await db.tx((t) => store.insertPlan(t, { plan, jobs }, now()));
            made.push(plan);
            await ensureCheckRuns(plan, jobs, token);
            await queueReady(plan.id);
        }
        return { plans: made, errors: planned.errors };
    }

    /** Create the missing GitHub check runs for a plan's jobs (queued). A GitHub failure is logged, never fatal. */
    async function ensureCheckRuns(plan, jobs, token) {
        if (!token || !isLive(plan.repo)) return;
        for (const job of jobs) {
            if (job.check_run_id || job.state === 'completed') continue;
            try {
                const run = await github.createCheckRun(token, {
                    owner: plan.owner, repo: plan.repo.split('/')[1], name: `openvibe / ${job.display_name}`,
                    headSha: plan.sha, detailsUrl: detailsUrlOf(job.run_job_id), externalId: job.id,
                });
                await store.setCheckRun(db, job.id, run.id, now());
            } catch (e) {
                log.warn(`[Run] checks: check run for ${plan.repo} ${job.display_name} was not created (${e.code || e.message})`);
            }
        }
    }

    // ── running and finishing ──────────────────────────────────────────────────

    /** The conclusion a node job's result/state means, in GitHub's vocabulary. */
    function conclusionOf(row, result) {
        const direct = MAP_CONCLUSION[String(result && result.conclusion || '').toLowerCase()];
        if (direct) return direct;
        if (result && result.ok === false) return 'failure';
        if (row.run_state === 'succeeded') return 'success';
        if (row.run_state === 'cancelled') return 'cancelled';
        if (row.run_state === 'expired') return row.run_exit_reason === 'ttl' ? 'timed_out' : 'failure';
        return 'failure';
    }

    function summaryOf(job, result, row) {
        const steps = Array.isArray(result && result.steps) ? result.steps.slice(0, 100) : [];
        const lines = [];
        if (steps.length) {
            lines.push('| Step | Result | Time |', '| --- | --- | --- |');
            for (const step of steps) {
                const name = String(obj(step).name || 'step').replace(/\|/g, '\\|').slice(0, 200);
                const conclusion = String(obj(step).conclusion || '').replace(/\|/g, '\\|').slice(0, 40);
                const ms = Number(obj(step).ms);
                lines.push(`| ${name} | ${conclusion} | ${Number.isFinite(ms) && ms >= 0 ? `${ms} ms` : ''} |`);
            }
        } else {
            lines.push(`The node job ended ${row.run_state}${row.run_exit_reason ? ` (${row.run_exit_reason})` : ''}.`);
        }
        if (row.run_error_code) lines.push('', `Run error: \`${String(row.run_error_code).slice(0, 100)}\``);
        return lines.join('\n').slice(0, 60_000);
    }

    /**
     * Report one completed workflow job to GitHub, then mark it complete and write the shadow pair. A failed
     * report is retried by later ticks (up to five times), so a short GitHub outage does not lose the check.
     * → true when the row is complete.
     */
    async function finishJob(plan, job, { conclusion, summary, error = null, queueMs = null, runMs = null, startedAt = null, finishedAt = null, nodeId = null }) {
        const at = finishedAt || now();
        const real = CHECK_CONCLUSIONS.has(conclusion) ? conclusion : 'failure';
        if (!job.check_run_id && !isLive(plan.repo)) {
            // Quiet shadow: the check run is made once, already complete; a failure shows as neutral, its title
            // says what the node found, and Actions stays the check that decides.
            const { token } = await planContext(plan);
            if (token) {
                const shown = shadowShown(real);
                const title = shown === real ? job.display_name : `${job.display_name}: shadow, node said ${real}; Actions decides`;
                try {
                    const run = await github.createCheckRun(token, {
                        owner: plan.owner, repo: plan.repo.split('/')[1], name: `openvibe / ${job.display_name}`,
                        headSha: plan.sha, detailsUrl: detailsUrlOf(job.run_job_id), externalId: job.id,
                        completed: {
                            conclusion: shown, output: { title: title.slice(0, 250), summary: summary || 'Completed' },
                            startedAt: startedAt ? new Date(startedAt).toISOString() : null, completedAt: new Date(at).toISOString(),
                        },
                    });
                    await store.setCheckRun(db, job.id, run.id, now());
                    job = { ...job, check_run_id: run.id };
                } catch (e) {
                    const bumped = await store.bumpReportError(db, job.id, now());
                    const errors = Number((bumped && bumped.report_errors) || 0);
                    if (errors < 5) {
                        log.warn(`[Run] checks: shadow check run for ${plan.repo} ${job.display_name} was not created (${e.code || e.message}); retrying`);
                        return false;
                    }
                    log.warn(`[Run] checks: giving up on the shadow check run for ${plan.repo} ${job.display_name} (${e.code || e.message})`);
                }
            }
        } else if (job.check_run_id) {
            const { token } = await planContext(plan);
            if (!token) {
                log.warn(`[Run] checks: no token; ${plan.repo} ${job.display_name} completes without a check run update`);
            } else {
                try {
                    await github.updateCheckRun(token, {
                        owner: plan.owner, repo: plan.repo.split('/')[1], checkRunId: job.check_run_id,
                        status: 'completed', conclusion: CHECK_CONCLUSIONS.has(conclusion) ? conclusion : 'failure',
                        output: { title: job.display_name.slice(0, 250), summary: summary || 'Completed' },
                        detailsUrl: detailsUrlOf(job.run_job_id), completedAt: new Date(at).toISOString(),
                    });
                } catch (e) {
                    const bumped = await store.bumpReportError(db, job.id, now());
                    const errors = Number((bumped && bumped.report_errors) || 0);
                    if (errors < 5) {
                        log.warn(`[Run] checks: check run for ${plan.repo} ${job.display_name} was not updated (${e.code || e.message}); retrying`);
                        return false;
                    }
                    log.warn(`[Run] checks: giving up on check run ${job.check_run_id} after ${errors} failures (${e.code || e.message})`);
                }
            }
        }
        const done = await store.completeJob(db, job.id, {
            conclusion: CHECK_CONCLUSIONS.has(conclusion) ? conclusion : 'failure', summary, error,
            queueMs, runMs, startedAt, finishedAt: at, nodeId, at,
        });
        if (done) {
            await store.shadowNode(db, {
                repo: plan.repo, sha: plan.sha, workflowName: plan.workflow_name, jobName: job.display_name,
                checkRunId: job.check_run_id, conclusion: done.conclusion, queueMs: done.queue_ms, runMs: done.run_ms,
                startedAt: done.started_at, finishedAt: done.finished_at, at,
            }).catch((e) => log.warn(`[Run] checks: shadow row for ${plan.repo} failed (${e.code || e.message})`));
        }
        return true;
    }

    /** A job whose need did not succeed is skipped; its check run says so. */
    async function skipJob(plan, job, reason) {
        return finishJob(plan, job, { conclusion: 'skipped', summary: `Skipped: ${reason}`, finishedAt: now() });
    }

    /** Queue one waiting workflow job as a Run job (class code, openvibe-codes@1.0.0) in one transaction. */
    async function queueJob(plan, job) {
        const claimed = await store.claimQueue(db, job.id, now());
        if (!claimed) return null;
        const timeoutMs = Math.max(1, Number(claimed.timeout_minutes) || 30) * 60_000;
        const matrix = parseJson(claimed.matrix);
        const body = {
            class: 'code',
            artifact: { name: 'openvibe-codes', version: '1.0.0' },
            args: {
                kind: 'check',
                repo: `https://github.com/${plan.repo}.git`,
                sha: plan.sha,
                workflow: claimed.workflow_path,
                job: claimed.workflow_job_key,
                ...(Object.keys(matrix || {}).length ? { matrix } : {}),
                event: plan.event,
                ref: plan.ref,
                timeout_ms: timeoutMs,
            },
            limits: { wall_ms: timeoutMs, cpu_ms: timeoutMs, mem_bytes: 4 * 1024 ** 3 },
            ttl_ms: Math.min(timeoutMs + 600_000, 86_400_000),
            egress: 'public',
            requirements: { kind: 'run.code', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['first-party', 'user-owned'] },
        };
        const idempotencyKey = `checks:${claimed.id}:${Number(claimed.attempts) + 1}`;
        try {
            const out = await db.tx(async (t) => {
                const made = await jobsStore.mint(t, body, { projectId: project, requester: checksRequester, via: null, idempotencyKey, now: now() });
                if (made.created && events) await events.queued(t, made.row, {});
                await store.linkRunJob(t, claimed.id, made.row.id, now());
                return made;
            });
            return out.row;
        } catch (e) {
            await store.resetJobToWaiting(db, claimed.id, now()).catch(() => null);
            log.warn(`[Run] checks: could not queue ${plan.repo} ${claimed.display_name} (${e.code || e.message})`);
            return null;
        }
    }

    /**
     * Advance one plan: skip what a failed/skipped need blocks, queue every whose needs succeeded (respecting
     * matrix max-parallel), and settle the plan when every job is complete.
     */
    async function queueReady(planId) {
        const plan = await store.getPlan(db, planId);
        if (!plan || plan.state !== 'active') return { queued: 0, skipped: 0 };
        let jobs = await store.getJobs(db, planId);
        // A check run whose creation failed at planning is retried here before the job is queued (live repositories;
        // a quiet shadow one has no check run until it finishes).
        if (isLive(plan.repo) && jobs.some((j) => !j.check_run_id && j.state !== 'completed')) {
            const { token } = await planContext(plan);
            if (token) {
                await ensureCheckRuns(plan, jobs, token);
                jobs = await store.getJobs(db, planId);
            }
        }
        const byKey = new Map(jobs.map((j) => [j.job_key, j]));
        const activeCounts = new Map();
        for (const j of jobs) if (j.matrix_group && (j.state === 'queued' || j.state === 'running')) activeCounts.set(j.matrix_group, (activeCounts.get(j.matrix_group) || 0) + 1);
        let queued = 0;
        let skipped = 0;
        for (const job of jobs) {
            if (job.state === 'completed' || job.run_job_id) continue;
            const needs = (Array.isArray(job.needs) ? job.needs : []).map((k) => byKey.get(k));
            if (needs.some((n) => !n)) {
                if (await skipJob(plan, job, 'a job it needs is not in the plan')) {
                    byKey.set(job.job_key, { ...job, state: 'completed', conclusion: 'skipped' });
                    skipped++;
                }
                continue;
            }
            if (needs.some((n) => n.state === 'completed' && n.conclusion !== 'success')) {
                if (await skipJob(plan, job, 'a job it needs did not succeed')) {
                    byKey.set(job.job_key, { ...job, state: 'completed', conclusion: 'skipped' });
                    skipped++;
                }
                continue;
            }
            if (needs.some((n) => n.state !== 'completed')) continue;
            if (job.matrix_group && job.max_parallel) {
                const active = activeCounts.get(job.matrix_group) || 0;
                if (active >= Number(job.max_parallel)) continue;
                activeCounts.set(job.matrix_group, active + 1);
            }
            const row = await queueJob(plan, job);
            if (row) queued++;
        }
        jobs = await store.getJobs(db, planId);
        if (jobs.length && jobs.every((j) => j.state === 'completed')) {
            const failed = jobs.some((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
            await store.setPlanState(db, planId, failed ? 'failed' : 'succeeded', now());
        }
        return { queued, skipped };
    }

    /** Follow every Run job of a plan: start, retry a lost node once, finish with the result's conclusion. */
    async function syncRuns() {
        const rows = await store.unsettledRuns(db);
        let started = 0;
        let finished = 0;
        let retried = 0;
        for (const row of rows) {
            const plan = await store.getPlan(db, row.plan_id);
            if (!plan) continue;
            if (row.run_state === 'queued' || row.run_state === 'placed') continue;
            if (row.run_state === 'running') {
                if (row.check_state !== 'in_progress') {
                    const { token } = await planContext(plan);
                    if (token && row.check_run_id) {
                        try {
                            await github.updateCheckRun(token, {
                                owner: plan.owner, repo: plan.repo.split('/')[1], checkRunId: row.check_run_id,
                                status: 'in_progress', startedAt: new Date(row.run_started_ms || now()).toISOString(),
                                detailsUrl: detailsUrlOf(row.run_job_id),
                            });
                        } catch (e) {
                            log.warn(`[Run] checks: check run ${row.check_run_id} not marked in progress (${e.code || e.message})`);
                            continue;
                        }
                    }
                    await store.markRunning(db, row.id, now(), row.run_node_id);
                    started++;
                }
                continue;
            }
            const result = parseJson(row.run_result);
            // A node that went away mid-job leaves no check result: retry once elsewhere before failing.
            const lostNode = !result.conclusion && result.ok === undefined && !Array.isArray(result.steps);
            if (lostNode && Number(row.attempts) < 2) {
                const reset = await store.resetJobToWaiting(db, row.id, now());
                if (reset && await queueJob(plan, reset)) retried++;
                continue;
            }
            const finishedAt = Number(row.run_finished_ms) || now();
            const startedAt = Number(row.run_started_ms) || (row.started_at != null ? Number(row.started_at) : null);
            const conclusion = conclusionOf(row, result);
            const ok = await finishJob(plan, row, {
                conclusion, summary: summaryOf(row, result, row),
                error: row.run_error_code || null,
                queueMs: startedAt ? Math.max(0, startedAt - Number(row.created_at)) : null,
                runMs: startedAt ? Math.max(0, finishedAt - startedAt) : null,
                startedAt, finishedAt, nodeId: row.run_node_id,
            });
            if (ok) finished++;
        }
        return { started, finished, retried };
    }

    /** One scheduler pass: sweep old deliveries, follow the Run jobs, advance every active plan. */
    async function tick(at = now()) {
        if (!enabled) return { enabled: false, started: 0, finished: 0, retried: 0, queued: 0, skipped: 0, plans: 0 };
        await store.sweepDeliveries(db, at).catch(() => null);
        await store.sweepTokens(db, at).catch(() => null);
        await store.resetStaleQueuing(db, at).catch(() => null);
        const runs = await syncRuns();
        const plans = await store.listActivePlans(db);
        let queued = 0;
        let skipped = 0;
        for (const plan of plans) {
            try {
                const out = await queueReady(plan.id);
                queued += out.queued;
                skipped += out.skipped;
            } catch (e) {
                log.warn(`[Run] checks: plan ${plan.id} could not advance (${e.code || e.message})`);
            }
        }
        return { enabled: true, ...runs, queued, skipped, plans: plans.length };
    }

    // ── webhook ────────────────────────────────────────────────────────────────

    const allowedRepo = (payload) => {
        const full = payload && payload.repository && payload.repository.full_name;
        if (typeof full !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(full)) return false;
        const owner = full.split('/')[0].toLowerCase();
        if (!owners.includes(owner)) return false;
        const account = payload.installation && payload.installation.account && payload.installation.account.login;
        if (account && !owners.includes(String(account).toLowerCase())) return false;
        return true;
    };

    async function rememberInstallation(payload, at) {
        const inst = payload && payload.installation;
        if (!inst || !inst.id) return;
        const account = inst.account || {};
        if (!owners.includes(String(account.login || '').toLowerCase())) return;
        await store.upsertInstallation(db, {
            installationId: Number(inst.id), login: account.login, accountId: account.id == null ? null : Number(account.id),
            accountType: account.type || null, suspendedAt: inst.suspended_at ? Date.parse(inst.suspended_at) : null,
        }, at);
    }

    async function handleEvent(eventName, payload, deliveryId) {
        if (eventName === 'installation') {
            if (payload.action === 'deleted') {
                const inst = payload.installation;
                if (inst && inst.id) await db.maybe('DELETE FROM run_checks_installations WHERE installation_id = $1', [Number(inst.id)]);
                if (inst && inst.id) await store.deleteToken(db, Number(inst.id)).catch(() => null);
            } else {
                await rememberInstallation(payload, now());
            }
            return { installation: true };
        }
        if (eventName === 'workflow_job') {
            if (payload.action !== 'completed' || !allowedRepo(payload)) return {};
            const job = obj(payload.workflow_job);
            if (!SHA_RE.test(String(job.head_sha || '')) || !job.name || !job.conclusion) return {};
            await store.shadowActions(db, {
                repo: payload.repository.full_name, sha: job.head_sha,
                workflowName: job.workflow_name || '', jobName: String(job.name),
                conclusion: MAP_CONCLUSION[String(job.conclusion).toLowerCase()] || (CHECK_CONCLUSIONS.has(job.conclusion) ? job.conclusion : 'failure'),
                startedAt: job.started_at ? Date.parse(job.started_at) : null,
                finishedAt: job.completed_at ? Date.parse(job.completed_at) : null, at: now(),
            });
            return { shadow: true };
        }
        if (eventName === 'push') {
            if (!allowedRepo(payload)) return {};
            const branch = payload.repository.default_branch;
            if (payload.ref !== `refs/heads/${branch}`) return {};
            if (!SHA_RE.test(String(payload.after || ''))) return {};
            await rememberInstallation(payload, now());
            const [repoOwner, repoName] = payload.repository.full_name.split('/');
            return planForEvent({
                repo: payload.repository.full_name, owner: repoOwner, name: repoName,
                sha: payload.after, event: 'push', ref: payload.ref, branch,
                installationId: payload.installation && payload.installation.id, deliveryId,
            });
        }
        if (eventName === 'pull_request') {
            const action = payload.action;
            if (!['opened', 'synchronize', 'reopened'].includes(action) || !allowedRepo(payload)) return {};
            const pr = obj(payload.pull_request);
            const head = obj(pr.head);
            const headRepo = obj(head.repo);
            // A fork's workflow must never be read or run for a base repo (a stranger's commit is not our code).
            if (!headRepo.full_name || !allowedRepo({ repository: headRepo, installation: payload.installation })) return {};
            if (!SHA_RE.test(String(head.sha || ''))) return {};
            const branch = obj(pr.base).ref;
            await rememberInstallation(payload, now());
            const [repoOwner, repoName] = payload.repository.full_name.split('/');
            return planForEvent({
                repo: payload.repository.full_name, owner: repoOwner, name: repoName,
                sha: head.sha, event: 'pull_request', ref: `refs/pull/${pr.number}/merge`, branch, action,
                installationId: payload.installation && payload.installation.id, deliveryId,
            });
        }
        return {};
    }

    async function webhook(req, res) {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
        const app = await appRow();
        if (!app || app.unreadable || !app.webhook_secret) return res.status(503).json({ error: 'checks.not_configured' });
        const signature = String(req.get('x-hub-signature-256') || '');
        const expected = `sha256=${crypto.createHmac('sha256', app.webhook_secret).update(raw).digest('hex')}`;
        if (!safeEqual(signature, expected)) return res.status(401).json({ error: 'invalid signature' });
        const deliveryId = String(req.get('x-github-delivery') || '').trim();
        if (!deliveryId) return res.status(400).json({ error: 'missing X-GitHub-Delivery' });
        const eventName = String(req.get('x-github-event') || '');
        let payload;
        try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'invalid JSON' }); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ error: 'invalid payload' });
        const at = now();
        const fresh = await store.claimDelivery(db, { deliveryId, event: eventName, at, expiresAt: at + DELIVERY_TTL_MS });
        if (!fresh) return res.status(204).end();
        try {
            await handleEvent(eventName, payload, deliveryId);
            await store.sweepDeliveries(db, at).catch(() => null);
            return res.status(204).end();
        } catch (e) {
            log.warn(`[Run] checks: webhook ${eventName} failed (${e.code || e.message})`);
            await store.releaseDelivery(db, deliveryId).catch(() => null);
            return res.status(500).json({ error: 'checks.webhook_failed' });
        }
    }

    // ── the owner page ─────────────────────────────────────────────────────────

    function stateCookie(req) {
        const value = String((req.cookies && req.cookies.ov_checks_state) || '');
        const at = value.indexOf('.');
        if (at < 1) return { state: null, subject: null };
        return { state: value.slice(0, at), subject: value.slice(at + 1) };
    }

    const admin = express.Router();
    admin.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    admin.get('/', ownerPage, async (req, res, next) => {
        try {
            const app = await appRow();
            const state = crypto.randomBytes(24).toString('base64url');
            const subject = String((req.user && (req.user.subject_id || req.user.sub)) || '');
            res.cookie('ov_checks_state', `${state}.${subject}`, {
                httpOnly: true, sameSite: 'lax', secure: Boolean(config.isProduction), path: '/admin/checks', maxAge: 10 * 60_000,
            });
            let installations = await store.listInstallations(db).catch(() => []);
            // Refresh the account list from GitHub when the App is readable; a failed read leaves the stored list.
            if (app && !app.unreadable && config.jobs.enabled) {
                try {
                    const list = await github.listInstallations(app);
                    for (const inst of list) {
                        const account = obj(inst.account);
                        if (!owners.includes(String(account.login || '').toLowerCase())) continue;
                        await store.upsertInstallation(db, {
                            installationId: Number(inst.id), login: account.login, accountId: account.id == null ? null : Number(account.id),
                            accountType: account.type || null, suspendedAt: inst.suspended_at ? Date.parse(inst.suspended_at) : null,
                        }, now());
                    }
                    installations = await store.listInstallations(db);
                } catch (e) { log.warn(`[Run] checks: installations could not be read (${e.code || e.message})`); }
            }
            const manifest = manifestFor({ baseUrl: config.baseUrl });
            const action = `${githubWeb}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
            const warnings = [];
            if (!key) warnings.push('RUN_SECRETS_KEY is not set: the App cannot be stored.');
            if (!project) warnings.push('RUN_CHECKS_PROJECT is not set: no check is planned until it is.');
            if (app && app.unreadable) warnings.push('The stored App secrets cannot be opened with this RUN_SECRETS_KEY. Create the App again.');
            res.type('html').send(views.adminPage({
                app, installations, action, manifest: JSON.stringify(manifest), created: req.query.created === '1',
                warnings, org, keyConfigured: Boolean(key), projectConfigured: Boolean(project),
                installUrl: app && app.slug ? `${githubWeb}/apps/${encodeURIComponent(app.slug)}/installations/new` : null,
            }));
        } catch (e) { next(e); }
    });

    admin.get('/created', ownerPage, async (req, res, next) => {
        try {
            if (!key) return res.status(503).type('html').send(views.errorPage({ title: 'Encryption is not installed', text: 'Set RUN_SECRETS_KEY and try again.' }));
            const cookie = stateCookie(req);
            const state = typeof req.query.state === 'string' ? req.query.state : '';
            const subject = String((req.user && (req.user.subject_id || req.user.sub)) || '');
            res.clearCookie('ov_checks_state', { path: '/admin/checks' });
            if (!cookie.state || !safeEqual(cookie.state, state) || cookie.subject !== subject) {
                return res.status(400).type('html').send(views.errorPage({ title: 'The state did not match', text: 'Start again from the checks page.' }));
            }
            if (req.query.error) {
                return res.status(400).type('html').send(views.errorPage({ title: 'GitHub did not create the App', text: String(req.query.error_description || req.query.error).slice(0, 300) }));
            }
            const code = typeof req.query.code === 'string' ? req.query.code : '';
            if (!code) return res.status(400).type('html').send(views.errorPage({ title: 'No code', text: 'GitHub returned no manifest code.' }));
            let converted;
            try { converted = await github.convertManifest(code); } catch (e) {
                log.warn(`[Run] checks: manifest conversion failed (${e.code || e.message})`);
                return res.status(502).type('html').send(views.errorPage({ title: 'GitHub did not return the App', text: 'The manifest code was not exchanged. Try creating the App again.' }));
            }
            const at = now();
            const appId = Number(converted.id);
            await store.putApp(db, {
                app_id: appId, slug: String(converted.slug || ''), name: String(converted.name || 'OpenVibe Checks'),
                html_url: converted.html_url || null,
                pem_enc: seal(key, converted.pem, `app:${appId}:pem`),
                webhook_secret_enc: seal(key, converted.webhook_secret, `app:${appId}:webhook_secret`),
                client_id: converted.client_id || null,
                client_secret_enc: converted.client_secret ? seal(key, converted.client_secret, `app:${appId}:client_secret`) : null,
            }, at);
            // A replacement App invalidates every token and account row of the old registration.
            await store.clearTokens(db).catch(() => null);
            await store.clearInstallations(db).catch(() => null);
            tokenCache.clear();
            res.redirect(303, '/admin/checks?created=1');
        } catch (e) { next(e); }
    });

    // ── the owner's agreement query ────────────────────────────────────────────

    async function agreementQuery(req, res) {
        const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
        if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) return res.status(400).json({ error: 'repo must be owner/name' });
        const repos = await store.agreement(db, repo || null);
        res.json({ repos });
    }

    /** GET /api/v1/checks/agreement: owner session only, like the page that shows it. */
    function agreement(req, res, next) {
        ownerApi(req, res, () => { agreementQuery(req, res).catch(next); });
    }

    function start() {
        if (!enabled || !config.jobs.enabled || timer) return false;
        timer = setInterval(() => { tick().catch((e) => log.warn(`[Run] checks: tick failed (${e.code || e.message})`)); }, tickMs);
        timer.unref?.();
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return {
        admin, webhook, agreement, tick, start, stop, planForEvent, queueReady, manifestFor,
        isOwner, detailsUrlOf, keyConfigured: Boolean(key), projectConfigured: Boolean(project),
        status: () => ({
            enabled, note: !key ? 'off: RUN_SECRETS_KEY is not set' : cfg.enabled === false ? 'off: RUN_CHECKS=off' : !project ? 'on, but RUN_CHECKS_PROJECT is not set so nothing is planned' : 'on',
            org, owners, tick_ms: tickMs, project_set: Boolean(project), running: Boolean(timer),
            runs_as: checksRequester === 'service:checks' ? 'service (first-party nodes only)' : "the checks owner (their own machines too)",
            reporting: live.has('*') ? 'live everywhere' : live.size ? `live: ${[...live].join(', ')}; quiet shadow elsewhere` : 'quiet shadow everywhere',
        }),
        deps: { config, db, github, store, owners, project, enabled },
    };
}

module.exports = { createChecks, manifestFor, safeEqual };
