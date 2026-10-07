'use strict';
/**
 * A migrated database for one test run (ADR-035).
 *
 *   store 'pglite' (the default): real PostgreSQL in-process, migrated.
 *   store 'pg': the production-shaped containers (openvibe-sdk scripts/test-services.sh up), when
 *     OV_TEST_PG_URL and OV_TEST_PG_DIRECT_URL are set. The run gets its own roles and schema.
 *
 *   TIPS-style: RUN_TEST_STORE=pg runs every test file on the containers instead of PGlite.
 */
const crypto = require('crypto');
const { createDb } = require('openvibe-sdk/db');
const { MIGRATIONS } = require('../../server/db');

const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const pgAvailable = () => !!(process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL);

async function testDb({ store = process.env.RUN_TEST_STORE || 'pglite', max = 4 } = {}) {
    if (store !== 'pg') {
        const db = createDb({ pglite: true, service: 'run-test', log: quiet });
        await db.migrate({ dir: MIGRATIONS, log: quiet, windowDays: 0 });
        return { db, store: 'pglite', close: () => db.close().catch(() => {}) };
    }
    if (!pgAvailable()) throw new Error('store pg needs OV_TEST_PG_URL and OV_TEST_PG_DIRECT_URL (openvibe-sdk scripts/test-services.sh up)');
    const name = `run_t${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    const owner = `${name}_owner`;
    const pw = crypto.randomBytes(16).toString('hex');
    const su = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'run-test-admin', max: 1, log: quiet });
    const database = await su.value('SELECT current_database()');
    for (const stmt of [
        `CREATE ROLE ${owner} LOGIN PASSWORD '${pw}'`,
        `CREATE ROLE ${name} LOGIN PASSWORD '${pw}'`,
        `GRANT CONNECT ON DATABASE ${database} TO ${owner}, ${name}`,
        `CREATE SCHEMA ${name} AUTHORIZATION ${owner}`,
        `ALTER ROLE ${owner} SET search_path = ${name}`,
        `ALTER ROLE ${name} SET search_path = ${name}`,
        `ALTER ROLE ${name} SET statement_timeout = '15s'`,
        `ALTER ROLE ${name} SET lock_timeout = '5s'`,
        `GRANT USAGE ON SCHEMA ${name} TO ${name}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${name} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${name} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${name}`,
    ]) await su.query(stmt);
    const as = (url, user) => { const u = new URL(url); u.username = user; u.password = pw; return u.toString(); };
    async function drop() {
        try {
            await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1)', [[name, owner]]);
            for (let i = 0; i < 100; i++) {
                const left = await su.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = ANY($1)', [[name, owner]]);
                if (!Number(left.rows[0].n)) break;
                await new Promise((ok) => setTimeout(ok, 50));
            }
            const ddl = async (stmt) => {
                for (let i = 0; ; i++) {
                    try { return await su.query(stmt); } catch (err) { if (err.code !== 'XX000' || i >= 5) throw err; await new Promise((ok) => setTimeout(ok, 100 * (i + 1))); }
                }
            };
            await ddl(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            for (const r of [name, owner]) { await ddl(`DROP OWNED BY ${r}`); await ddl(`DROP ROLE ${r}`); }
        } finally { await su.close(); }
    }
    let db;
    try {
        const ownerDb = createDb({ url: as(process.env.OV_TEST_PG_DIRECT_URL, owner), service: 'run-test-migrate', max: 1, log: quiet });
        try { await ownerDb.migrate({ dir: MIGRATIONS, log: quiet, windowDays: 0 }); } finally { await ownerDb.close(); }
        db = createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: 'run-test', max, log: quiet });
    } catch (e) { await drop().catch(() => {}); throw e; }
    return {
        db, store: 'postgresql', schema: name,
        open: (o = {}) => createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: 'run-test', max, log: quiet, ...o }),
        async close() { await db.close().catch(() => {}); await drop(); },
    };
}

module.exports = { testDb, pgAvailable };
