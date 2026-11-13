'use strict';

/**
 * OpenVibe.Run configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/run.env in production). loadConfig(env) is pure so tests build their own.
 *
 * Run is the job service of the network (plan T14, ADR-034): it owns the API, the project scope and the
 * placement, on its own PostgreSQL (ADR-035). Bot owns the node link and the per-second metering of the jobs it
 * carries (plan T14 L1). The one exception is an external managed-browser provider (plan T14 R4a): it is not a
 * paired Link and writes no usage of its own, so Run meters those jobs itself and posts their readings with a
 * Billing token of its own (billing.usage.record, audience openvibe.billing), used for nothing else. The
 * provider's API key lives in Run's environment only: never in an offer, a job or a log.
 */
require('dotenv').config();

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
/** A PEM in an environment variable carries its newlines escaped. */
const pem = (v) => (v ? String(v).replace(/\\n/g, '\n') : null);

/** A byte size or a plain integer: RUN_LIMITS_MAX_MEM_BYTES=4gb or 4294967296. */
function bytes(v, d) {
    const m = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(String(v || '').trim());
    if (!m) return d;
    const n = Number(m[1]) * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase()] || 1);
    return Number.isFinite(n) && n > 0 ? n : d;
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4920);                 // 4920 is Run's; 4000-4910 are taken
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.run' : `http://localhost:${port}`));
    return {
        compute: require('./compute/config').loadCompute(env),
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,

        // PostgreSQL (ADR-035): DATABASE_URL is the pooled runtime role through PgBouncer (transaction
        // mode), DATABASE_DIRECT_URL the owner role on a direct connection, for migrations at boot.
        db: {
            url: env.DATABASE_URL || '',
            directUrl: env.DATABASE_DIRECT_URL || '',
        },
        // Valkey: shared, never authoritative. Unset: this process only.
        valkey: {
            url: env.VALKEY_URL || '',
            prefix: env.VALKEY_PREFIX || 'ov:run:',
        },
        // Identity: service tokens and user tokens are RS256 JWTs signed by OpenVibe.Network; Run answers
        // for the audience openvibe.run only.
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
            publicKey: pem(env.OV_NETWORK_PUBLIC_KEY),
        },
        audience: env.RUN_AUDIENCE || 'openvibe.run',
        // Run's client in the Network (client `run`): the events relay mints its service token with
        // events.event.publish through it. Unset: run.job.* events wait in the outbox.
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'run',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },
        // IndexNow (openvibe-shared/indexnow): unset, nothing is sent and the key file is not served.
        indexnow: { key: (env.INDEXNOW_KEY || '').trim() },
        cookies: { secure: env.COOKIE_SECURE != null ? bool(env.COOKIE_SECURE) : isProduction },

        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // The account-data consumer (POST /internal/events): the signing secret Network's deliveries use. Unset:
            // the route is off and Network's account export/deletion does not wait for Run.
            secret: String(env.RUN_EVENTS_SECRET || '').trim(),
        },

        // The background jobs (the events relay and the dispatcher poller); RUN_JOBS=off runs the API alone,
        // which is what tests do (they drive dispatch.poll() by hand).
        jobs: {
            enabled: env.RUN_JOBS !== 'off',
        },

        // What a project's token may ask for (run.job-create-request@1 $defs.limits): a request over one of
        // these is refused 422 run.limits.exceeded, never silently lowered (the contract's own ceiling for
        // ttl_ms is 24 h). The node merges its own, stricter caps on top.
        limits: {
            maxWallMs: Math.max(1, int(env.RUN_LIMITS_MAX_WALL_MS, 3600_000)),
            maxCpuMs: Math.max(1, int(env.RUN_LIMITS_MAX_CPU_MS, 3600_000)),
            maxMemBytes: bytes(env.RUN_LIMITS_MAX_MEM_BYTES, 4 * 1024 ** 3),
            maxTtlMs: Math.max(1000, int(env.RUN_LIMITS_MAX_TTL_MS, 86_400_000)),
            // The contract: args serialize to at most 512 KiB, else 413 (the JSON body cap is above it).
            maxArgsBytes: bytes(env.RUN_LIMITS_MAX_ARGS_BYTES, 512 * 1024),
        },

        // The job stream (run.job-stream-event@1). The ticket is a two-minute RS256 compact JWS Run signs
        // with a key of its own — never the Network signing key, and never a session token (audience
        // openvibe.run, typ run-stream). Unset in production: stream tickets answer 503 (the API still
        // serves); in development a key is generated in memory at boot.
        stream: {
            ttlS: Math.max(1, Math.min(300, int(env.RUN_STREAM_TTL_S, 120))),
            keyFile: env.RUN_STREAM_KEY_FILE != null ? String(env.RUN_STREAM_KEY_FILE) : 'data/keys/run-stream.pem',
            privateKey: pem(env.RUN_STREAM_PRIVATE_KEY),
            keyId: env.RUN_STREAM_KEY_ID || 'run-stream-1',
            ringBytes: Math.max(4096, bytes(env.RUN_STREAM_RING_BYTES, 1024 * 1024)),   // the contract: replay at most the last 1 MiB
            maxPerJob: Math.max(1, int(env.RUN_STREAM_MAX_PER_JOB, 64)),
            heartbeatMs: Math.max(1000, int(env.RUN_STREAM_HEARTBEAT_MS, 25_000)),
        },

        // The dispatcher bridge to Bot (plan T14 step 6, R1c): Bot holds the node link and the per-second
        // metering; Run calls it as the service principal `svc:run` for audience openvibe.bot. Without
        // OV_OAUTH_CLIENT_SECRET Run cannot mint that token and nothing is sent (jobs stay queued).
        // Run sessions (contracts 0.223.0, server/sessions/): one pass over the open ones every tickMs; a person holds at
        // most maxOpen at once; a running one's lease is checked on Bot every leaseCheckMs.
        sessions: {
            originsEnabled: env.RUN_SESSION_ORIGINS_ENABLED === '1',
            tickMs: Math.max(200, int(env.RUN_SESSION_TICK_MS, 2000)),
            maxOpen: Math.max(1, int(env.RUN_SESSIONS_PER_PERSON, 3)),
            leaseCheckMs: Math.max(1000, int(env.RUN_SESSION_LEASE_CHECK_MS, 30000)),
        },

        dispatch: {
            botUrl: trim(env.RUN_BOT_URL || 'http://127.0.0.1:4630'),
            botAudience: env.RUN_BOT_AUDIENCE || 'openvibe.bot',
            // One poll a second: place what is queued, mirror what is on a node (server/jobs/poller.js).
            pollMs: Math.max(100, int(env.RUN_POLL_MS, 1000)),
            timeoutMs: int(env.RUN_DISPATCH_TIMEOUT_MS, 8000),
            // The offers Run places from are cached this long, so one tick places many jobs off one read.
            offersTtlMs: Math.max(0, int(env.RUN_OFFERS_TTL_MS, 5000)),
            // Polls Bot answers 404 for a job Run sent before that job fails (never mirrored forever).
            unknownPolls: Math.max(1, int(env.RUN_DISPATCH_UNKNOWN_POLLS, 5)),
            // Jobs one tick places and mirrors; the next tick takes the rest.
            maxPerTick: Math.max(1, int(env.RUN_DISPATCH_MAX_PER_TICK, 200)),
        },

        // The checks scheduler (research-2026-11-13/shared-node-checks.md): the GitHub App made by the manifest
        // flow, the webhook and the workflow jobs Run plans from it. RUN_SECRETS_KEY seals the App's private key,
        // webhook secret and installation tokens at rest (server/checks/crypto.js); without it the page and the
        // webhook stay off. RUN_CHECKS_PROJECT is the project a check job belongs to. RUN_CHECKS=off turns the
        // scheduler off; the tick only runs when the background jobs are on (RUN_JOBS).
        checks: {
            enabled: env.RUN_CHECKS !== 'off',
            secretsKey: String(env.RUN_SECRETS_KEY || ''),
            project: String(env.RUN_CHECKS_PROJECT || '').trim(),
            owners: String(env.RUN_CHECKS_OWNERS || 'OpenVibers').split(',').map((s) => s.trim()).filter(Boolean),
            org: env.RUN_CHECKS_ORG || 'OpenVibers',
            // 'user' or 'organization'; empty asks GitHub once (OpenVibers is a user account: its App is created at
            // github.com/settings/apps/new while signed in as OpenVibers, not under /organizations/).
            orgType: String(env.RUN_CHECKS_ORG_TYPE || '').trim().toLowerCase(),
            // The network owner: their subject (RUN_CHECKS_OWNER, else the compute owner) or the Network owner's
            // username (the same OWNER_USERNAME Network's owner guard uses).
            owner: env.RUN_CHECKS_OWNER || env.RUN_COMPUTE_OWNER || '',
            ownerUsername: env.OWNER_USERNAME || 'goosely',
            githubApi: trim(env.RUN_CHECKS_GITHUB_API || 'https://api.github.com'),
            githubWeb: trim(env.RUN_CHECKS_GITHUB_WEB || 'https://github.com'),
            tickMs: Math.max(500, int(env.RUN_CHECKS_TICK_MS, 5000)),
            // The repositories whose checks report live on GitHub (owner/repo, comma-separated, or *). Every other
            // repository is in quiet shadow: no queued or in-progress check run, and a finished one that did not
            // succeed shows as neutral, so a shadow check never holds a merge (server/checks/service.js).
            live: String(env.RUN_CHECKS_LIVE || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
            requestTimeoutMs: Math.max(1000, int(env.RUN_CHECKS_TIMEOUT_MS, 8000)),
        },

        // Placement A1: Bench's quality priors, cached an hour, used by place() when the option is a model Bench has
        // seen. Off in tests unless asked for, so a unit test never reaches the real Bench. The race judgement
        // records a bench.match@1 on the same host (POST /api/v1/matches, capability bench.judgement.cast).
        bench: {
            url: trim(env.RUN_BENCH_URL || 'https://bench.openvibe.services'),
            audience: env.RUN_BENCH_AUDIENCE || 'openvibe.bench',
            timeoutMs: Math.max(100, int(env.RUN_BENCH_TIMEOUT_MS, 8000)),
            priors: env.RUN_BENCH_PRIORS != null ? bool(env.RUN_BENCH_PRIORS) : nodeEnv !== 'test',
            priorsTtlMs: Math.max(0, int(env.RUN_BENCH_PRIORS_TTL_MS, 60 * 60_000)),
        },

        // The Arena's race (compare-arena-ecosystem.md §3). Bench has no matchmaker endpoint yet, so
        // `matchmaker: true` picks two entrants of different families from this configured list. `hashKey`
        // keys the person's id hash in a bench.match@1 judgement: never the person's id, and stable across
        // restarts (it falls back to Run's Network client secret, which production always has).
        races: {
            entrants: String(env.RUN_RACE_ENTRANTS || '').split(',').map((s) => s.trim()).filter(Boolean),
            hashKey: env.RUN_RACE_HASH_KEY || env.OV_OAUTH_CLIENT_SECRET || 'run-race-development-key',
        },

        // The external managed-browser provider (plan T14 R4a, server/dispatch/browser-provider.js): class browser
        // jobs placed on a kind=provider offer named `browser-provider` go to its API instead of Bot. Off while
        // RUN_BROWSER_PROVIDER_URL or the key is unset: no provider offer is placed on, so a browser job waits.
        browserProvider: {
            url: trim(String(env.RUN_BROWSER_PROVIDER_URL || '').trim()),
            apiKey: String(env.RUN_BROWSER_PROVIDER_API_KEY || '').trim(),
            timeoutMs: Math.max(100, int(env.RUN_BROWSER_PROVIDER_TIMEOUT_MS, 8000)),
        },

        // Run's own usage relay to OpenVibe.Billing (billing.usage.record, POST <url>/api/v1/usage), for the
        // external provider's jobs only (Bot meters its own). The token is minted from Run's Network client for
        // audience openvibe.billing. Unset URL or no OV_OAUTH_CLIENT_SECRET: readings wait in run_usage_outbox,
        // nothing is sent, and the jobs still run.
        billing: {
            url: trim(String(env.RUN_BILLING_URL || '').trim()),
            audience: env.RUN_BILLING_AUDIENCE || 'openvibe.billing',
            intervalMs: Math.max(100, int(env.RUN_BILLING_INTERVAL_MS, 5000)),
            timeoutMs: Math.max(100, int(env.RUN_BILLING_TIMEOUT_MS, 8000)),
        },
    };
}

module.exports = { loadConfig };
