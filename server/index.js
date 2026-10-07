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
 * Run cannot mint its Bot token and every job stays queued.
 */
const { loadConfig } = require('./config');
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');
const { createValkey } = require('openvibe-sdk/valkey');
const { gracefulStop } = require('openvibe-sdk/service');
const { createRegistry } = require('openvibe-shared/metrics');

async function main() {
    const config = loadConfig();
    const registry = createRegistry();
    const db = openDb(config, { registry });
    const m = await migrate(config, { serving: db });
    if (m.held.length) console.warn(`[Run] migrations held: ${m.held.map((h) => `${h.id} (${h.reason})`).join('; ')}`);
    const valkey = createValkey({ url: config.valkey.url, prefix: config.valkey.prefix });

    const app = createApp({ config, db, valkey, registry });
    const { keys, outbox, stream, tickets, dispatch } = app.locals;
    keys.start();
    const ticketKey = tickets.start();

    if (config.jobs.enabled) {
        // The dispatcher's poller owns its own interval (RUN_POLL_MS): one tick sweeps the ttl, places the
        // queued jobs and mirrors every placed or running one (server/jobs/poller.js). Off without Bot
        // credentials: start() then does nothing and every job stays queued.
        outbox.start();
        dispatch.start();
    }

    const server = app.listen(config.port, config.host, () => {
        console.log(`[Run] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (store ${db.store}; valkey ${valkey ? 'on' : 'off: this process only'})`);
        console.log(`[Run] jobs ${config.jobs.enabled ? 'on' : 'off (RUN_JOBS=off)'}; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (run.job.* events wait in the outbox)'}; stream tickets ${ticketKey.enabled ? `on (${config.stream.keyId}${ticketKey.ephemeral ? ', ephemeral key' : ''})` : 'off (no stream key)'}; dispatcher ${dispatch.enabled ? `on → ${config.dispatch.botUrl} (poll ${config.dispatch.pollMs} ms)` : 'off: no OV_OAUTH_CLIENT_SECRET, jobs stay queued'}`);
    });
    server.keepAliveTimeout = 65_000;

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
            () => stream.close(),
            () => outbox.stop(),
        ],
        close: [
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
