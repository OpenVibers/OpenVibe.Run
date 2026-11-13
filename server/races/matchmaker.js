'use strict';

/**
 * The race matchmaker's fallback (compare-arena-ecosystem.md §3: "the matchmaker (Bench) picks the
 * entrants: pairs whose outcome is most uncertain and that the person's allowance can pay for, new
 * entrants explored, two of the same family avoided, position randomised").
 *
 * Bench has no matchmaker endpoint yet (checked against Bench's main on 2026-11-13: /api/v1/matches and
 * /api/v1/factors exist, no matchmaker). Until it does, Run picks two entrants at random from
 * RUN_RACE_ENTRANTS, never two of one model family, and the race service randomises their positions.
 * When Bench ships the matchmaker this module is the one place that changes: ask Bench first, keep the
 * configured list as the fallback when it cannot answer.
 */
const { isEntrantId, familyOf } = require('./entrants');

/** Every unordered pair from `list` (small lists only: a race has at most four sides). */
function pairs(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
    return out;
}

/**
 * pair({ entrants, random }) → [a, b] from two different families, at random.
 * `entrants` is the configured list (RUN_RACE_ENTRANTS); invalid ids are dropped. Throws a plain error
 * whose message the service turns into a 422, so an unconfigured deployment says what to set.
 */
function pair({ entrants = [], random = Math.random } = {}) {
    const list = [...new Set((Array.isArray(entrants) ? entrants : []).filter(isEntrantId))];
    if (list.length < 2) {
        throw Object.assign(new Error('the race matchmaker is not configured: set RUN_RACE_ENTRANTS to at least two bench.entrant ids (Bench has no matchmaker endpoint yet)'), { code: 'run.race_matchmaker_unavailable' });
    }
    const choices = pairs(list).filter(([a, b]) => familyOf(a) !== familyOf(b));
    if (!choices.length) {
        throw Object.assign(new Error('the configured race entrants are all of one model family; set RUN_RACE_ENTRANTS to entrants of at least two families'), { code: 'run.race_matchmaker_unavailable' });
    }
    const r = Number(random());
    const pick = choices[Math.min(choices.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * choices.length)))];
    return [...pick];
}

module.exports = { pair, pairs, familyOf };
