'use strict';

/**
 * The learned placement counts (agent plan A1, section 3): one row per (person, option key, step kind) in
 * placement_outcomes. Plain weights and a time, never text and never a payload.
 *
 *   createOutcomes({ db, now }) →
 *     forPerson(person)                 the person's rows plus everyone else's, for place()
 *     record({ person, key, kind, ok, at })  learn() once and upsert the row
 *     global()                          everyone's rows, cached for five minutes
 *
 * The person's own rows are read once per placement; the global read is the five-minute cache. learn() decays at
 * write and successOf() decays again at read, so an old route fades without a job deleting anything.
 */
const { learn } = require('openvibe-sdk/placement');

const GLOBAL_TTL_MS = 5 * 60_000;
const toRow = (r) => ({
    person: r.person_id, key: r.option_key, kind: r.step_kind,
    ok_w: Number(r.ok_w) || 0, n_w: Number(r.n_w) || 0,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
});

function createOutcomes({ db, now = Date.now, log = console, globalTtlMs = GLOBAL_TTL_MS } = {}) {
    let cached = { at: 0, rows: [] };

    async function read(where, args) {
        return (await db.many(`SELECT person_id, option_key, step_kind, ok_w, n_w, updated_at FROM placement_outcomes ${where}`, args)).map(toRow);
    }

    async function global() {
        if (cached.at && now() - cached.at < globalTtlMs) return cached.rows;
        let rows = [];
        try { rows = await read('', []); } catch (e) {
            log.warn(`[Run] placement outcomes could not be read: ${String((e && e.message) || e).slice(0, 200)}`);
        }
        cached = { at: now(), rows };
        return rows;
    }

    async function forPerson(person) {
        if (!person) return await global();
        let mine = [];
        try { mine = await read('WHERE person_id = $1', [person]); } catch (e) {
            log.warn(`[Run] placement outcomes for ${person} could not be read: ${String((e && e.message) || e).slice(0, 200)}`);
        }
        return [...mine, ...(await global()).filter((r) => r.person !== person)];
    }

    async function upsert(row) {
        await db.exec(
            `INSERT INTO placement_outcomes (person_id, option_key, step_kind, ok_w, n_w, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
             ON CONFLICT (person_id, option_key, step_kind) DO UPDATE SET
                 ok_w = EXCLUDED.ok_w, n_w = EXCLUDED.n_w, updated_at = EXCLUDED.updated_at`,
            [row.person, row.key, row.kind, row.ok_w, row.n_w, row.updated_at],
        );
        cached.at = 0;
    }

    async function record({ person, key, kind, ok, at }) {
        if (!person || !key || !kind) return null;
        const before = await read('WHERE person_id = $1 AND option_key = $2 AND step_kind = $3', [person, key, kind]);
        const row = learn(before, { person, key, kind, ok: !!ok, at })
            .find((r) => r.person === person && r.key === key && r.kind === kind);
        if (!row) return null;
        await upsert(row);
        return row;
    }

    /** Persist what escalate() returned (it already learned the failure); never record that failure again. */
    async function recordAll(rows, person) {
        const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && r.person === person && r.key && r.kind);
        for (const row of mine) await upsert(row);
        return mine.length;
    }

    return { forPerson, global, record, recordAll, GLOBAL_TTL_MS };
}

module.exports = { createOutcomes, GLOBAL_TTL_MS };
