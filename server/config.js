'use strict';

/**
 * OpenVibe.Run configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/run.env in production). loadConfig(env) is pure so tests build their own.
 *
 * Run is the job service of the network (plan T14, ADR-034): it owns the API, the project scope and the
 * placement, on its own PostgreSQL (ADR-035). Bot owns the node link and the per-second metering, so Run
 * holds no Billing token at all — Run never moves money (plan T14 L1).
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
        cookies: { secure: env.COOKIE_SECURE != null ? bool(env.COOKIE_SECURE) : isProduction },

        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
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
    };
}

module.exports = { loadConfig };
