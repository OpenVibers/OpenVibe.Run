'use strict';

/**
 * The race rows (migrations/0006_races.sql). Row access only: the service creates a race and its child
 * jobs in one transaction, and every read is scoped to the person who started it and the service they
 * started it through — another person's race is null, which the API answers as 404.
 */
const { ids } = require('openvibe-contracts');

const RACE_RE = /^rac_[0-9A-HJKMNP-TV-Z]{26}$/;
const MATCH_RE = /^mat_[0-9A-HJKMNP-TV-Z]{26}$/;
const SLOT_RE = /^[a-d]$/;

const isRaceId = (v) => typeof v === 'string' && RACE_RE.test(v);
const isMatchId = (v) => typeof v === 'string' && MATCH_RE.test(v);
const isSlot = (v) => typeof v === 'string' && SLOT_RE.test(v);

/** A new race id: rac_<ULID> (the id pattern the race API answers; contracts has no race kind yet). */
const newRaceId = () => `rac_${ids.ulid()}`;
/** The bench.match@1 id minted with the race: a retry records the same match rather than a second one. */
const newMatchId = () => `mat_${ids.ulid()}`;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v) => (v == null ? null : Number(v));

/** One row as the store reads it: jsonb parsed, the bigints as numbers. */
function fromDb(row) {
    if (!row) return null;
    return {
        ...row,
        sides: Array.isArray(row.sides) ? row.sides.map((s) => ({ slot: s.slot, entrant: s.entrant, job_id: s.job_id })) : [],
        budget: obj(row.budget) || {},
        play: obj(row.play) || {},
        judgement: obj(row.judgement),
        blind: Boolean(row.blind),
        judged_at: num(row.judged_at),
        created_at: num(row.created_at),
        updated_at: num(row.updated_at),
    };
}

/** Insert the parent race and its sides (the child job rows are already in this transaction). */
async function insert(t, row) {
    const made = await t.maybe(
        `INSERT INTO run_races (id, project_id, requester, via, kind, prompt, prompt_hash, sides, budget, play, match_id, blind, judgement, judged_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [row.id, row.project_id, row.requester, row.via, row.kind, row.prompt, row.prompt_hash, JSON.stringify(row.sides),
            JSON.stringify(row.budget), JSON.stringify(row.play), row.match_id, row.blind, row.judgement == null ? null : JSON.stringify(row.judgement),
            row.judged_at, row.created_at, row.updated_at]);
    return fromDb(made);
}

/** The starter's race: project, person and the service they used all have to match, else null (→ 404). */
async function get(db, id, { projectId, requester, via }) {
    if (!isRaceId(id)) return null;
    return fromDb(await db.maybe(
        'SELECT * FROM run_races WHERE id = $1 AND project_id = $2 AND requester = $3 AND via = $4',
        [id, projectId, requester, via]));
}

/** The conditional write that ends a race: one judgement, the first writer wins. → the row, or null. */
async function markJudged(t, id, { projectId, requester, via, judgement, at }) {
    return fromDb(await t.maybe(
        `UPDATE run_races SET judgement = $1, judged_at = $2, updated_at = $2
         WHERE id = $3 AND project_id = $4 AND requester = $5 AND via = $6 AND judged_at IS NULL RETURNING *`,
        [JSON.stringify(judgement), at, id, projectId, requester, via]));
}

module.exports = { RACE_RE, MATCH_RE, SLOT_RE, isRaceId, isMatchId, isSlot, newRaceId, newMatchId, fromDb, insert, get, markJudged };
