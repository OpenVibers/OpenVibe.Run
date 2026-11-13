'use strict';

/**
 * The race service (compare-arena-ecosystem.md §3, agent-engine.md §4): one parent race, one child job per
 * side, the same share of the budget each, no entrant named until a person judges.
 *
 * A race is started by a first-party service acting for a person (the Arena's front door in Compare): the
 * person is the requester and the only one who may judge, through the same service. The child jobs are
 * ordinary run_jobs rows — class linux, args carrying the side, the race and the entrant the node must run
 * — so placement, metering, events and the job stream are the engine's own, unchanged. Each side's output
 * is read from the job stream's ring on every GET (best effort, as run.job-stream-event@1 says).
 *
 * The judgement is a bench.match@1 recorded on Bench BEFORE the names are revealed: source arena, the
 * shown order, blind true, each side's receipts, one human_pairwise judgement with a keyed hash of the
 * person, the play and its parent race. If Bench cannot record it, the race stays unjudged and the names
 * hidden; a retry sends the same match id, so Bench records one match rather than two.
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { fail, iso } = require('../util');
const { checkLimits } = require('../api/v1');
const { SLOTS, PLAY_ID, MACHINE_CLASS, racePlay } = require('../plays/race');
const raceStore = require('./store');
const matchmaker = require('./matchmaker');
const { isEntrantId } = require('./entrants');

const END_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const KINDS = ['chat', 'code', 'design'];
const WINNERS = new Set([...SLOTS, 'tie', 'both_bad']);
const START_KEYS = new Set(['prompt', 'kind', 'entrants', 'matchmaker', 'budget']);
const JUDGEMENT_KEYS = new Set(['winner']);
const DEFAULT_LIMITS = { wall_ms: 300_000, cpu_ms: 300_000, mem_bytes: 512 * 1024 * 1024 };
const OUTCOME = { succeeded: 'succeeded', failed: 'failed', expired: 'timed_out', cancelled: 'cancelled' };
const RECEIPT_INTS = ['tokens_in', 'tokens_out', 'tool_calls', 'length_chars', 'markdown_items'];
const RECEIPT_NUMS = ['cost_usd', 'ttft_ms', 'tps'];

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const isCount = (v) => Number.isInteger(v) && v >= 1;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** A keyed hash of the person who judged: stable for rate limits, never the person's id (bench.match@1). */
function personHash(requester, key) {
    const subject = String(requester || '').replace(/^user:/, '');
    return crypto.createHmac('sha256', key).update(`run.race.person.v1\n${subject}`).digest('hex');
}

/** The body of POST /api/v1/races, validated by hand (Contracts 0.422.0 has no run.race@1 yet). */
function validStart(body) {
    if (!obj(body)) fail(400, 'run.invalid_request', 'the body must be a JSON object { prompt, kind, entrants | matchmaker, budget }');
    const extra = Object.keys(body).filter((k) => !START_KEYS.has(k));
    if (extra.length) fail(400, 'run.invalid_request', `unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) fail(400, 'run.invalid_request', 'prompt is required and must be a non-empty string');
    if (prompt.length > 20000) fail(400, 'run.invalid_request', 'prompt is at most 20000 characters');
    if (!KINDS.includes(body.kind)) fail(400, 'run.invalid_request', `kind must be one of ${KINDS.join(', ')}`);
    if (!obj(body.budget)) fail(400, 'run.invalid_request', 'budget is required and must be an object');
    const budget = validBudget(body.budget);
    const wantsMatchmaker = body.matchmaker === true;
    if (body.matchmaker !== undefined && typeof body.matchmaker !== 'boolean') fail(400, 'run.invalid_request', 'matchmaker must be true or false');
    if (wantsMatchmaker && body.entrants !== undefined) fail(400, 'run.invalid_request', 'name entrants or ask matchmaker: true, not both');
    if (!wantsMatchmaker) {
        if (!Array.isArray(body.entrants)) fail(400, 'run.invalid_request', 'entrants must be an array of 2 to 4 bench.entrant ids, or matchmaker: true');
        if (body.entrants.length < 2 || body.entrants.length > 4) fail(400, 'run.invalid_request', 'a race has 2 to 4 entrants');
        for (const id of body.entrants) if (!isEntrantId(id)) fail(400, 'run.invalid_request', `${JSON.stringify(id)} is not a bench.entrant@1 id`);
        if (new Set(body.entrants).size !== body.entrants.length) fail(400, 'run.invalid_request', 'entrants must be unique');
    }
    return { prompt, kind: body.kind, budget, matchmaker: wantsMatchmaker, entrants: wantsMatchmaker ? null : body.entrants };
}

/** The total budget a race asks for; an absent cap takes the default. */
function validBudget(b) {
    const keys = new Set(['usd', 'wall_ms', 'cpu_ms', 'mem_bytes']);
    const extra = Object.keys(b).filter((k) => !keys.has(k));
    if (extra.length) fail(400, 'run.invalid_request', `unknown budget field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
    const out = { ...DEFAULT_LIMITS };
    for (const k of ['wall_ms', 'cpu_ms', 'mem_bytes']) {
        if (b[k] === undefined) continue;
        if (!isCount(b[k])) fail(400, 'run.invalid_request', `budget.${k} must be a positive integer`);
        out[k] = b[k];
    }
    if (b.usd !== undefined) {
        if (typeof b.usd !== 'number' || !Number.isFinite(b.usd) || b.usd < 0) fail(400, 'run.invalid_request', 'budget.usd must be a number of at least 0');
        out.usd = b.usd;
    }
    return out;
}

/** Split the total evenly: every side runs on the same share, never more than the parent named. */
function splitBudget(total, n) {
    const usd = total.usd == null ? null : Math.round((total.usd / n) * 1e6) / 1e6;
    const per = {
        usd,
        wall_ms: Math.floor(total.wall_ms / n),
        cpu_ms: Math.floor(total.cpu_ms / n),
        mem_bytes: Math.floor(total.mem_bytes / n),
        machine_class: MACHINE_CLASS,
    };
    if (per.wall_ms < 1000 || per.cpu_ms < 1000) fail(422, 'run.limits.exceeded', `budget is too small for ${n} sides: each side needs at least 1000 ms of wall and CPU time`);
    if (per.mem_bytes < 1024 * 1024) fail(422, 'run.limits.exceeded', `budget is too small for ${n} sides: each side needs at least 1 MiB of memory`);
    return { total: { ...total, machine_class: MACHINE_CLASS }, per_side: per };
}

/** Fisher–Yates: the sides are labelled a, b, … in a random order, so a position is not a name. */
function shuffled(list, random = Math.random) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor((Number(random()) || 0) * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** What a finished child sends Bench: its outcome and the receipts the stream/result can back. */
function receiptsOf(row) {
    const result = obj(row.result) || {};
    const src = obj(result.receipts) || result;
    const out = { outcome: OUTCOME[row.state] || 'failed' };
    for (const k of RECEIPT_NUMS) if (typeof src[k] === 'number' && Number.isFinite(src[k]) && src[k] >= 0) out[k] = src[k];
    for (const k of RECEIPT_INTS) if (Number.isInteger(src[k]) && src[k] >= 0) out[k] = src[k];
    if (row.wall_ms != null && Number(row.wall_ms) > 0) out.wall_ms = Number(row.wall_ms);
    const answer = typeof result.answer === 'string' ? result.answer : typeof result.text === 'string' ? result.text : null;
    if (out.length_chars == null && answer != null) out.length_chars = answer.length;
    return out;
}

/** The bench.match@1 a race's judgement records. Validated before it leaves Run. */
function matchOf(row, childRows, winner, at) {
    const jobs = new Map(childRows.map((j) => [j.id, j]));
    const match = {
        id: row.match_id,
        source: 'arena',
        task: { kind: row.kind, prompt_hash: row.prompt_hash },
        slots: row.sides.map((side) => {
            const job = jobs.get(side.job_id);
            const slot = { slot: side.slot, entrant: side.entrant, run_id: side.job_id };
            if (job && END_STATES.has(job.state)) slot.receipts = receiptsOf(job);
            return slot;
        }),
        shown: row.sides.map((side) => side.slot),
        blind: true,
        budget: {
            usd: row.budget.per_side.usd == null ? null : row.budget.per_side.usd,
            ms: row.budget.per_side.wall_ms,
            machine_class: row.budget.per_side.machine_class,
        },
        judgements: [{ judge: 'human_pairwise', winner, by: { type: 'person', id_hash: personHash(row.requester, row.hash_key) }, at: iso(at) }],
        play: { id: PLAY_ID, run_id: row.id },
        at: iso(row.created_at),
    };
    contracts.assertValid('bench.match@1', match);
    return match;
}

/** One race as the API answers it: names only once a judgement is on the row. */
function view(row, childRows, { config, stream }) {
    const jobs = new Map(childRows.map((j) => [j.id, j]));
    const revealed = row.judged_at != null;
    const sides = row.sides.map((side) => {
        const job = jobs.get(side.job_id);
        const shot = stream.snapshot(side.job_id);
        const ended = job && END_STATES.has(job.state);
        const out = {
            slot: side.slot,
            run_id: side.job_id,
            state: job ? job.state : 'missing',
            output: shot.output || null,
            receipts: ended ? receiptsOf(job) : null,
            stream_url: `${config.baseUrl}/api/v1/jobs/${side.job_id}/stream`,
        };
        // The entrant is the name: it is never in the body before the judgement. The child job's own
        // args name it for the node, and the race's sides are the only owner-scoped read that returns it.
        if (revealed) out.entrant = side.entrant;
        return out;
    });
    const allDone = sides.every((s) => END_STATES.has(s.state));
    return {
        id: row.id,
        kind: row.kind,
        prompt: row.prompt,
        state: revealed ? 'judged' : allDone ? 'done' : 'running',
        blind: true,
        revealed,
        play: row.play,
        budget: row.budget,
        shown: row.sides.map((side) => side.slot),
        sides,
        judgement: revealed ? {
            winner: row.judgement.winner,
            judge: 'human_pairwise',
            at: row.judgement.at,
            match_id: row.judgement.match_id,
            recorded_by: row.judgement.recorded_by || 'run',
        } : null,
        // The names as one mapping too, so a client does not have to walk the sides; null while blind.
        names: revealed ? Object.fromEntries(row.sides.map((side) => [side.slot, side.entrant])) : null,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

/**
 * createRaces({ config, db, jobs, events, stream, bench, now, log, random }) → { plays, start, get, judge }.
 * Every dependency is injected; the API is its only caller.
 */
function createRaces({ config, db, jobs, events, stream, bench, now = () => Date.now(), log = console, random = Math.random } = {}) {
    const hashKey = (config.races && config.races.hashKey) || 'run-race-unsafe-default';

    /** GET /api/v1/plays: the race play (with the most sides it supports) as agents.play@1. */
    function plays() {
        return require('../plays/race').plays();
    }

    /** POST /api/v1/races: one parent race and one child job per side, in one transaction. */
    async function start({ projectId, requester, via, body, traceparent }) {
        if (!/^user:/.test(String(requester || ''))) {
            fail(403, 'run.race_person_required', 'a race is started by a person: a first-party service acting for them (X-OV-Subject), never a service for itself');
        }
        const req = validStart(body);
        let entrants;
        if (req.matchmaker) {
            try {
                entrants = matchmaker.pair({ entrants: (config.races && config.races.entrants) || [], random });
            } catch (e) {
                fail(422, e.code || 'run.race_matchmaker_unavailable', e.message);
            }
        } else {
            entrants = req.entrants;
        }
        // The sides are labelled a, b, … in the shown order, which is randomised (position bias: the
        // design asks for it, and bench.match@1's SHOWN records what was shown).
        const sides = shuffled(entrants, random).map((entrant, i) => ({ slot: SLOTS[i], entrant, job_id: null }));
        const budget = splitBudget(req.budget, sides.length);
        const raceId = raceStore.newRaceId();
        const matchId = raceStore.newMatchId();
        const at = now();
        const promptHash = sha256(req.prompt);
        const ttl = budget.per_side.wall_ms + 600_000;
        const play = racePlay(sides.map((side) => side.slot));

        // Each child is an ordinary linux job: the same limits as every other side, the race and its side
        // in args for the node, and parent/race in the job record (never in the frame sent to Bot).
        const childBodies = sides.map((side) => ({
            class: MACHINE_CLASS,
            args: {
                play: PLAY_ID, role: side.slot, race: raceId, kind: req.kind, prompt: req.prompt,
                entrant: side.entrant, budget: budget.per_side,
            },
            limits: { wall_ms: budget.per_side.wall_ms, cpu_ms: budget.per_side.cpu_ms, mem_bytes: budget.per_side.mem_bytes },
            ttl_ms: ttl,
        }));
        for (const bodyOf of childBodies) {
            const checked = contracts.validate('run.job-create-request@1', bodyOf);
            if (!checked.valid) fail(422, 'run.invalid_input', `a race child is not a run.job-create-request@1: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
        }
        checkLimits({ ...childBodies[0], args: childBodies[0].args, inputs: [] }, config.limits);

        const out = await db.tx(async (t) => {
            const children = [];
            for (let i = 0; i < sides.length; i++) {
                const made = await jobs.mint(t, childBodies[i], {
                    projectId, requester, via, idempotencyKey: `race:${raceId}:${sides[i].slot}`, now: at,
                });
                if (made.created) await events.queued(t, made.row, { traceparent });
                // Run's own record of the child's place in the tree: platform.job@1 has no field for a
                // parent, and frameOf() drops these keys, so the node is never sent them.
                const marked = await t.maybe(
                    `UPDATE run_jobs SET job = job || $2::jsonb WHERE id = $1 RETURNING *`,
                    [made.row.id, JSON.stringify({ parent: { type: 'race', id: raceId }, race: { slot: sides[i].slot, play: PLAY_ID } })]);
                sides[i].job_id = made.row.id;
                children.push(marked || made.row);
            }
            const row = await raceStore.insert(t, {
                id: raceId, project_id: projectId, requester, via, kind: req.kind, prompt: req.prompt, prompt_hash: promptHash,
                sides, budget, play, match_id: matchId, blind: true, judgement: null, judged_at: null, created_at: at, updated_at: at,
            });
            return { row, children };
        });
        log.log(`[Run] race ${out.row.id}: ${sides.length} blind sides, each ${budget.per_side.wall_ms} ms`);
        return view(out.row, out.children, { config, stream });
    }

    /** GET /api/v1/races/:id: sides' live output and receipts; names only once judged. */
    async function get({ projectId, requester, via, id }) {
        const row = await raceStore.get(db, id, { projectId, requester, via });
        if (!row) return null;
        const children = await jobs.getMany(db, row.sides.map((side) => side.job_id));
        return view(row, children, { config, stream });
    }

    /** POST /api/v1/races/:id/judgement: record the match on Bench, then reveal the names. */
    async function judge({ projectId, requester, via, id, body }) {
        if (!obj(body)) fail(400, 'run.invalid_request', 'the body must be JSON { winner: a|b|tie|both_bad }');
        const extra = Object.keys(body).filter((k) => !JUDGEMENT_KEYS.has(k));
        if (extra.length) fail(400, 'run.invalid_request', `unknown field${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
        const winner = typeof body.winner === 'string' ? body.winner : '';
        if (!WINNERS.has(winner)) fail(400, 'run.invalid_request', 'winner must be a shown side (a, b, …), tie or both_bad');
        const row = await raceStore.get(db, id, { projectId, requester, via });
        if (!row) return null;                                        // another person, service or project: the same 404
        if (row.judged_at != null) fail(409, 'run.race_already_judged', 'this race has already been judged');
        if (winner !== 'tie' && winner !== 'both_bad' && !row.sides.some((side) => side.slot === winner)) {
            fail(422, 'run.invalid_input', `${winner} is not a side of this race (${row.sides.map((s) => s.slot).join(', ')})`);
        }
        const children = await jobs.getMany(db, row.sides.map((side) => side.job_id));
        const at = now();
        const match = matchOf({ ...row, hash_key: hashKey }, children, winner, at);
        // Only Bench recording it reveals the names: if it cannot, the race stays blind and can be judged again.
        const recorded = await bench.record(match);
        const judgement = {
            winner, judge: 'human_pairwise', at: iso(at), match_id: row.match_id,
            by_hash: personHash(row.requester, hashKey), recorded_by: 'run',
            bench: recorded && recorded.created === false ? 'recorded' : 'created',
        };
        const updated = await db.tx((t) => raceStore.markJudged(t, row.id, { projectId, requester, via, judgement, at }));
        if (!updated) fail(409, 'run.race_already_judged', 'this race has already been judged');
        log.log(`[Run] race ${row.id}: judged ${winner}, names revealed`);
        return view(updated, children, { config, stream });
    }

    return { plays, start, get, judge, personHash: (requester) => personHash(requester, hashKey) };
}

module.exports = {
    createRaces, validStart, validBudget, splitBudget, receiptsOf, matchOf, view, personHash,
    KINDS, WINNERS, DEFAULT_LIMITS, END_STATES, START_KEYS, JUDGEMENT_KEYS,
};
