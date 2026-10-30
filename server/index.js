'use strict';

/**
 * OpenVibe.Run — process entry. `node server/index.js`
 * Listens on PORT (4920) behind nginx (openvibe.run); see deploy/.
 *
 * Boot (ADR-035): apply migrations/ with the owner role (DATABASE_DIRECT_URL, one direct connection,
 * closed afterwards), then serve on the pooled runtime role (DATABASE_URL). Several processes may start
 * together: the migration run is serialised by an advisory lock. Nothing starts at module load — the key
 * refresher, the stream key, the events outbox relay and the dispatcher poller all start here, and the
 * signal handlers stop them in order.
 *
 * Background jobs (RUN_JOBS=off disables them): the events outbox relay and the dispatcher's poller
 * (plan T14 step 6, server/jobs/poller.js; one tick every RUN_POLL_MS), which places queued jobs on a node
 * from the Fabric offers, sends them to Bot and mirrors what Bot answers. Without OV_OAUTH_CLIENT_SECRET
 * Run cannot mint its Bot token and every job stays queued. With RUN_BROWSER_PROVIDER_URL and its key, browser
 * jobs may go to the managed-browser provider instead (plan T14 R4a); the dispatcher also runs Run's usage relay
 * for those jobs (RUN_BILLING_URL; unset, their readings wait in run_usage_outbox).
 */
const { loadConfig } = require('./config');
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');
const { createValkey } = require('openvibe-sdk/valkey');
const { gracefulStop, telemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink, startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { createRegistry } = require('openvibe-shared/metrics');
const accountDataLib = require('./account-data');
const { createNetworkSender, startSubscriptions } = require('openvibe-sdk/account-data');

async function main() {
    const config = loadConfig();
    const registry = createRegistry();
    const db = openDb(config, { registry });
    const m = await migrate(config, { serving: db });
    if (m.held.length) console.warn(`[Run] migrations held: ${m.held.map((h) => `${h.id} (${h.reason})`).join('; ')}`);
    const valkey = createValkey({ url: config.valkey.url, prefix: config.valkey.prefix });

    const accountData = accountDataLib.create({ db, log: console });
    const accountSend = config.oauth.clientSecret ? createNetworkSender({ networkInternalUrl: config.network.internalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret }) : null;
    const app = createApp({ config, db, valkey, registry, accountData, accountSend });
    const { keys, outbox, stream, tickets, dispatch, indexnow, sessions } = app.locals;
    keys.start();
    const ticketKey = tickets.start();

    if (config.jobs.enabled) {
        // The dispatcher's poller owns its own interval (RUN_POLL_MS): one tick sweeps the ttl, places the
        // queued jobs and mirrors every placed or running one (server/jobs/poller.js). Off without Bot
        // credentials: start() then does nothing and every job stays queued.
        outbox.start();
        dispatch.start();
        // Run sessions (server/sessions/): place, watch and meter the open ones. Off without the Bot token.
        sessions.start();
    }

    let accountSubscription = null;
    const server = app.listen(config.port, config.host, () => {
        console.log(`[Run] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (store ${db.store}; valkey ${valkey ? 'on' : 'off: this process only'})`);
        if (config.events.secret.length >= 32 && config.events.url) {
            accountSubscription = startSubscriptions({
                eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: config.events.secret,
                networkInternalUrl: config.network.internalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            });
        }
        console.log(`[Run] jobs ${config.jobs.enabled ? 'on' : 'off (RUN_JOBS=off)'}; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (run.job.* events wait in the outbox)'}; stream tickets ${ticketKey.enabled ? `on (${config.stream.keyId}${ticketKey.ephemeral ? ', ephemeral key' : ''})` : 'off (no stream key)'}; dispatcher ${dispatch.enabled ? `on (poll ${config.dispatch.pollMs} ms): ${dispatch.note}` : `off: ${dispatch.note}`}; ${dispatch.status().usage_relay.note}; ${sessions.status().note}`);
    });
    server.keepAliveTimeout = 65_000;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each minute, stored in this service's telemetry_samples table; rows older than 14 days go daily.
    telemetry.init({ service: 'run', sink: createPgTelemetrySink({ db: db, log: console }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    const telemetryRetention = startTelemetryRetention({ db: db, log: console, olderThanDays: 14 });
    // The public pages change with a deploy: tell the engines once, and only with INDEXNOW_KEY set.
    require('./web/discovery').notify(indexnow, config);

    // systemd sends SIGTERM (SIGINT by hand); openvibe-sdk/service's gracefulStop takes the signal, runs the
    // stop steps in order (nothing new starts), drains the HTTP server — event streams are destroyed, so a
    // client reconnects — then the close steps and exits. Run's manifest declares no lifecycle.shutdown
    // deadline, so the kit's 5000 ms default is the right value.
    const { stop: shutdown } = gracefulStop({
        name: 'Run',
        server,
        drainMs: 4000,
        deadlineMs: 5000,
        deadlineExitCode: 0,
        stop: [
            () => keys.stop(),
            () => tickets.stop(),
            () => dispatch.stop(),
            () => sessions.stop(),
            () => stream.close(),
            () => outbox.stop(),
            () => { if (accountSubscription) accountSubscription.stop(); },
        ],
        close: [
            async () => { if (telemetryRetention) await telemetryRetention.stop(); await telemetry.stop(); },
            () => db.close().catch(() => {}),
            () => valkey && valkey.close().catch(() => {}),
        ],
    });
    return { app, server, shutdown };
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[Run] could not start: ${e.message}`);
        process.exit(1);
    });
}

module.exports = { main };
