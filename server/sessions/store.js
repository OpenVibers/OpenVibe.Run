'use strict';

/**
 * Run sessions' rows (migrations/0005_sessions.sql) and their run.session@1 shape (contracts 0.223.0).
 *
 *   present(row, now)              → run.session@1 (desk_seconds counted to now while running)
 *   insert(db, row)                → the row, or the earlier one with the same (owner, idempotency_key)
 *   get(db, id) / listOf(db, owner, { state, limit, cursor })
 *   open(db, limit)                → sessions not ended, oldest first (the tick's work)
 *   update(t, id, fields)          → the row after the change
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const COLUMNS = ['id', 'owner', 'via', 'kind', 'state', 'width', 'height', 'ttl_s', 'idle_s', 'machine_asked', 'requirements', 'idempotency_key',
    'request_digest', 'machine', 'desk', 'trust', 'offer_id', 'reasons', 'created_at', 'started_at', 'last_used_at', 'ended_at', 'end_reason',
    'end_detail', 'metered_minutes', 'lease_checked_at', 'updated_at'];
const JSON_COLUMNS = new Set(['requirements', 'reasons']);

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const json = (v, dflt) => { if (v == null) return dflt; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return dflt; } };

/** A new session id: ses_<ULID>. */
const newSessionId = () => `ses_${ids.ulid()}`;
/** The desk a session holds on its machine: desk-s + the id's last 16 characters (unique, within the desk pattern). */
const deskOf = (id) => `desk-s${String(id).slice(-16).toLowerCase()}`;

/** The digest of a create request, for its idempotency key: a repeat with another body is a conflict. */
function digestOf(body) {
    const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
        : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined && k !== 'idempotency_key').map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
            : JSON.stringify(v));
    return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

/** Seconds the desk ran: from its start to its end, or to now while it runs. */
function deskSeconds(row, now) {
    if (row.started_at == null) return 0;
    const end = row.ended_at != null ? Number(row.ended_at) : now;
    return Math.max(0, Math.round((end - Number(row.started_at)) / 100) / 10);
}

/** The row as run.session@1. */
function present(row, now = Date.now()) {
    const placed = row.machine && row.desk;
    return {
        id: row.id,
        owner: ids.parseSubject(row.owner),
        via: row.via || null,
        kind: row.kind,
        state: row.state,
        size: { width: Number(row.width), height: Number(row.height) },
        ttl_s: Number(row.ttl_s),
        idle_s: Number(row.idle_s),
        placement: placed ? {
            machine: row.machine, desk: row.desk, trust: row.trust, offer_id: row.offer_id || null, region: null,
            reasons: json(row.reasons, []).slice(0, 8).map((r) => String(r).slice(0, 200)),
        } : null,
        timings: { created_at: iso(row.created_at), started_at: iso(row.started_at), last_used_at: iso(row.last_used_at), ended_at: iso(row.ended_at) },
        end: row.state === 'ended' ? { reason: row.end_reason || 'ended', detail: row.end_detail ? String(row.end_detail).slice(0, 500) : null } : null,
        usage: { desk_seconds: deskSeconds(row, now) },
        idempotency_key: row.idempotency_key || null,
    };
}

const fromDb = (row) => {
    if (!row) return null;
    const out = { ...row };
    for (const k of JSON_COLUMNS) out[k] = json(row[k], k === 'reasons' ? [] : null);
    for (const k of ['created_at', 'started_at', 'last_used_at', 'ended_at', 'lease_checked_at', 'updated_at']) if (out[k] != null) out[k] = Number(out[k]);
    return out;
};

async function insert(db, row) {
    const cols = COLUMNS.filter((c) => row[c] !== undefined);
    const vals = cols.map((c) => (JSON_COLUMNS.has(c) && row[c] != null ? JSON.stringify(row[c]) : row[c]));
    const made = await db.maybe(
        `INSERT INTO run_sessions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT DO NOTHING RETURNING *`, vals);
    if (made) return { row: fromDb(made), created: true };
    const earlier = await db.maybe('SELECT * FROM run_sessions WHERE owner = $1 AND idempotency_key = $2', [row.owner, row.idempotency_key]);
    return { row: fromDb(earlier), created: false };
}

const get = async (db, id) => fromDb(await db.maybe('SELECT * FROM run_sessions WHERE id = $1', [id]));

/** The owner's sessions, newest first: state running (placing, starting or running; the default), ended, or all. */
async function listOf(db, owner, { state = 'running', limit = 20, cursor = null } = {}) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    const where = ['owner = $1'];
    const args = [owner];
    if (state === 'ended') where.push("state = 'ended'");
    else if (state !== 'all') where.push("state <> 'ended'");
    if (cursor) { args.push(String(cursor)); where.push(`id < $${args.length}`); }
    args.push(n + 1);
    const rows = (await db.many(`SELECT * FROM run_sessions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${args.length}`, args)).map(fromDb);
    const more = rows.length > n;
    const page = rows.slice(0, n);
    return { rows: page, next: more ? page[page.length - 1].id : null };
}

const open = async (db, limit = 200) => (await db.many("SELECT * FROM run_sessions WHERE state <> 'ended' ORDER BY created_at LIMIT $1", [limit])).map(fromDb);

/** How many sessions a person holds open now (the per-person cap). */
const openCount = async (db, owner) => Number((await db.one("SELECT count(*)::int AS n FROM run_sessions WHERE owner = $1 AND state <> 'ended'", [owner])).n);

async function update(t, id, fields) {
    const cols = Object.keys(fields).filter((k) => COLUMNS.includes(k) && k !== 'id');
    if (!cols.length) return get(t, id);
    const vals = cols.map((c) => (JSON_COLUMNS.has(c) && fields[c] != null ? JSON.stringify(fields[c]) : fields[c]));
    const row = await t.maybe(`UPDATE run_sessions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
    return fromDb(row);
}

module.exports = { present, insert, get, listOf, open, openCount, update, newSessionId, deskOf, digestOf, deskSeconds };
