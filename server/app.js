'use strict';

/**
 * OpenVibe.Run — the job API (plan T14, ADR-034). Express app factory; server/index.js listens, tests
 * build their own instance. Run serves no page: every route is a machine route.
 *
 *   GET  /api/health, /api/ready, /release.json    liveness, truthful readiness, the release manifest
 *   GET  /metrics                                  direct loopback callers only (never proxied)
 *   /api/v1/*                                      the job API (api/v1.js: one capability per route)
 *
 * createApp({ config, db, valkey, keys, outbox, stream, tickets, events, dispatch, now, fetchImpl, log })
 * — everything injectable. `db` is an openvibe-sdk/db handle with the schema migrated. Nothing starts at
 * module load: the events relay, the key refresher and the stream heartbeat are started by server/index.js
 * (the heartbeat lives on each stream's own response).
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { http } = require('openvibe-contracts');
const { isLoopbackDirect } = require('openvibe-shared/metrics');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createKeyProvider, createUserAuth, createProjectMembership } = require('./network');
const { createRunOutbox } = require('./events/outbox');
const { createStreamTickets } = require('./jobs/ticket');
const { createJobStream } = require('./jobs/stream');
const { createRunEvents } = require('./jobs/events');
const { createDispatcher } = require('./dispatch');
const { createApiAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { sessionsRouter } = require('./api/sessions');
const { createDeskClient } = require('./sessions/desks');
const { createSessions } = require('./sessions/service');
const { inputError } = require('./util');
const { createRunReadiness, registerRunGauges } = require('./observability');

const VERSION = require('../package.json').version;
// A create request may carry 512 KiB of args (run.job-create-request@1) on top of its inputs and limits,
// so the JSON body cap is above that and args are checked against their own limit (413 run.args_too_large).
const JSON_LIMIT = '768kb';

function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || openDb(config);
    const valkey = opts.valkey || null;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const userAuth = createUserAuth(config, keys);
    const outbox = opts.outbox || createRunOutbox({ db, config, fetchImpl: opts.eventsFetch, now, log });
    const events = opts.events || createRunEvents({ outbox, now, log });
    const stream = opts.stream || createJobStream({ config, now, log });
    const tickets = opts.tickets || createStreamTickets({ config, now, log });
    // The dispatcher bridge to Bot (plan T14 step 6, server/dispatch/index.js): placement from the Fabric
    // offers and the job loop that sends, mirrors and cancels. It is off without OV_OAUTH_CLIENT_SECRET —
    // Run cannot mint the Bot token — and nothing runs until server/index.js calls its start().
    const dispatch = opts.dispatch || createDispatcher({ config, db, store: require('./jobs/store'), events, stream, log, now, fetchImpl });
    const membership = opts.membership || createProjectMembership(config, { fetchImpl, now });
    const apiAuth = createApiAuth({ config, keys, userAuth, membership, log });
    // Run sessions (contracts 0.223.0): browser desks Bot leases per session; the tick starts in server/index.js.
    const desks = opts.desks || createDeskClient({ config, fetchImpl, now });
    const sessions = opts.sessions || createSessions({ config, db, desks, outbox, now, log });
    const release = require('openvibe-shared/release').createRelease({ service: 'run', root: path.join(__dirname, '..') });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // Run answers JSON and server-sent events only: no page, no form, no script — so helmet's defaults
    // carry everything that matters here and there is no CSP to widen.
    app.use(helmet({ contentSecurityPolicy: false }));

    const registry = opts.registry || require('openvibe-shared/metrics').createRegistry();
    const gauges = registerRunGauges(registry, { db, stream, now, log });
    app.get('/metrics', (req, res, next) => (isLoopbackDirect(req) ? gauges.refresh().then(() => next(), () => next()) : next()));
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'run', release: release.release, registry });
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()

    app.use(http.middleware());
    app.use(cookieParser());

    // Liveness: the process answers. What it can and cannot do is /api/ready's job, and the counts are
    // /metrics' and /api/ready's — this route says nothing it cannot back with a value it just read.
    app.get('/api/health', (req, res, next) => outbox.status().then((queuedEvents) => res.json({
        ok: true, service: 'run', version: VERSION, streams: stream.status().streams, events: queuedEvents, dispatcher: dispatch.status(),
    }), next));
    const readiness = createRunReadiness({ db, valkey, keys, config, outbox, stream, dispatch, release: release.release, fetchImpl });
    app.get('/api/ready', readiness.handler);
    release.mount(app, { registry: metrics.registry });

    app.use('/api/v1',
        // A per-address cap on the API (the per-project quotas are the project caps on a job's limits); a
        // refusal is an RFC 9457 problem like every other answer here, never a plain-text 429.
        rateLimit({
            windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false,
            handler: (req, res) => http.sendProblem(res, 429, 'run.rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }),
        }),
        express.json({ limit: JSON_LIMIT }),
        (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); },
        apiAuth.middleware,
        sessionsRouter({ sessions }),
        v1Router({ config, db, apiAuth, stream, tickets, events, dispatch, now, log }));

    // ── The public site (openvibe.run): the front page, the legal pages and the Frame's shared assets. ──
    const home = require('./web/home');
    const appIcon = require('openvibe-shared/app-icon');
    app.use('/shared', require('openvibe-shared/serve').handler());
    // IndexNow (openvibe-shared/indexnow): on only with INDEXNOW_KEY, which also mounts GET /<key>.txt. A malformed
    // key (8–128 alphanumerics) turns it off instead of stopping the service.
    const discovery = require('./web/discovery');
    let indexnow = opts.indexnow;
    if (!indexnow) {
        const { createIndexNow } = require('openvibe-shared/indexnow');
        try { indexnow = createIndexNow({ host: config.baseUrl, key: config.indexnow.key, fetch: fetchImpl }); }
        catch (err) { log.warn(`[Run] IndexNow disabled: ${err.message}`); indexnow = createIndexNow({ host: config.baseUrl, key: '' }); }
    }
    if (indexnow.enabled) app.use(indexnow.keyFile);
    // The public page names its Markdown twin in a Link header (the twin is served by the agent layer below); a
    // request that asks for the twin itself (?format=markdown, Accept: text/markdown) falls through to it.
    const agentLinks = (path) => require('openvibe-shared/agent-layer').linkHeaderTags(`${config.baseUrl}${path}`, `${config.baseUrl}/llms.txt`).header;
    const wantsTwin = (req) => req.query.format === 'markdown' || req.accepts(['html', 'text/markdown']) === 'text/markdown';
    app.get('/', (req, res, next) => {
        if (wantsTwin(req)) return next();
        res.setHeader('Content-Security-Policy', home.HOME_CSP);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Link', agentLinks('/'));
        res.type('html').send(home.renderHome({ config }));
    });
    // What shipped on this site: the shared update log, as on every OpenVibe site.
    app.get('/updates', (req, res, next) => {
        if (wantsTwin(req)) return next();
        res.setHeader('Content-Security-Policy', home.HOME_CSP);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Link', agentLinks('/updates'));
        res.type('html').send(home.renderUpdates({ config }));
    });
    { const legal = require('openvibe-shared/legal');
      app.get(legal.PATHS, (req, res, next) => { res.setHeader('Content-Security-Policy', home.HOME_CSP); next(); }, legal.handler({ id: 'run', service: 'run', host: 'openvibe.run', name: home.SITE_NAME, profile: 'hosting' })); }
    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json, and the Markdown twins of the home
    // and the update log. Mounted after the page routes, so a browser keeps this site's own page (which names the
    // twin) and only a twin request reaches this renderer; before the fallback, so an unknown .md is a 404.
    require('openvibe-shared/agent-layer').mount(app, {
        descriptor: require('./agent-descriptor'),
        render: require('./agent-pages').createAgentPages({ config }).renderPublicPage,
    });
    app.get('/llms.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(discovery.llmsTxt(config)));
    app.get('/llms-full.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(discovery.llmsFull(config)));
    app.get('/robots.txt', (req, res) => res.type('text/plain').send(['User-agent: *', 'Allow: /$', 'Disallow: /api/', 'Disallow: /internal/', `# Agent manifest: ${config.baseUrl}/.well-known/agent.json`, `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n')));
    app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(require('openvibe-shared/seo').sitemapXml(discovery.PAGES.map((p) => ({ loc: `${config.baseUrl}${p}` })))));
    app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(appIcon.favicon({ site: 'run' })));
    // The web app manifest. Its icons are the shared set (openvibe-shared/app-icons, under /shared/icons): it named
    // /assets/logo-*.png, which this site never served (every install icon was a 404 until 2026-10-17).
    app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify({
        ...appIcon.manifest({ site: 'run', name: home.SITE_NAME, shortName: 'Run', description: home.DESCRIPTION, startUrl: '/' }),
        icons: [192, 512].flatMap((s) => [false, true].map((maskable) => ({ src: require('openvibe-shared/app-icons').url('run', s, { maskable }), sizes: `${s}x${s}`, type: 'image/png', purpose: maskable ? 'maskable' : 'any' }))),
    })));

    app.use((req, res) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return http.sendProblem(res, 404, 'not_found', { ctx: req.ov });
        return res.status(404).type('text/plain').send('Not found\n');
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        const refused = inputError(err);
        if (refused && !res.headersSent && req.path.startsWith('/api/')) return http.sendProblem(res, 422, refused.code, { detail: refused.detail, ctx: req.ov });
        if (err && err.status && err.code && !res.headersSent && req.path.startsWith('/api/')) return http.sendProblem(res, err.status, err.code, { detail: err.detail, ctx: req.ov, extra: err.extra });
        log.error('[Run] unhandled error:', err);
        if (res.headersSent) return undefined;
        if (req.path.startsWith('/api/')) return http.sendProblem(res, 500, 'run.internal', { ctx: req.ov });
        return res.status(500).type('text/plain').send('Something went wrong\n');
    });

    Object.assign(app.locals, { config, db, indexnow, valkey, keys, outbox, events, stream, tickets, dispatch, apiAuth, metrics, desks, sessions });
    return app;
}

module.exports = { createApp, VERSION, JSON_LIMIT };
