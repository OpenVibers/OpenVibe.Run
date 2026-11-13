'use strict';

/**
 * The race play — the Arena's round on the one engine (compare-arena-ecosystem.md §3, agent-engine.md
 * §4): one child run per entrant, the same budget each, the sides blind until a person judges. The play
 * is data (agents.play@1), so the same shape lists on Run, drives the orchestrator and can be written by a
 * person or an agent.
 *
 * A race has 2 to 4 sides, so the play is built per race: one role per side (`a`, `b`, …), one parallel
 * phase that runs them at once, `blind: true`, and `stop.when: person` — the round is over when the person
 * votes, not when the last child ends. The budget split is an equal share each (the caller's total is
 * divided by the number of sides in server/races/service.js; the contract wants the shares as data).
 *
 * The roles say "Side A", never a model or harness name: a role name is visible to the person before the
 * judgement, so it must not carry the entrant.
 */
const contracts = require('openvibe-contracts');

/** The most sides a race may have (bench.match@1 slots a–h; the Arena's own limit is 4). */
const SLOTS = ['a', 'b', 'c', 'd'];
/** Every side runs on the same machine class, so a race compares entrants on one environment. */
const MACHINE_CLASS = 'linux';
const PLAY_ID = 'race';

/** The even share of a total budget, as the contracts' number (rounded, never a float surprise in a diff). */
const shareOf = (n) => Number((1 / n).toFixed(6));

/**
 * racePlay(['a', 'b']) → an agents.play@1 document. `slots` is the sides this race actually has (2–4),
 * so the roles and the split describe the race that ran, not a fixed example.
 */
function racePlay(slots = SLOTS) {
    const sides = [...new Set((Array.isArray(slots) ? slots : []).filter((s) => SLOTS.includes(s)))];
    if (sides.length < 2) throw new TypeError('a race play needs at least two sides (a, b)');
    const share = shareOf(sides.length);
    const play = {
        id: PLAY_ID,
        version: 1,
        name: 'Race',
        summary: 'Several entrants answer the same ask at once, blind side by side, each on the same budget; a person judges and the names are revealed.',
        roles: sides.map((slot) => ({
            id: slot,
            name: `Side ${slot.toUpperCase()}`,
            does: 'Answer the prompt in the run\'s args as the entrant the run names. Work alone: no other side\'s answer, no judging.',
            model: 'same',
        })),
        phases: [{ id: 'answer', name: 'Answer', roles: sides, parallel: true }],
        stop: { when: 'person' },
        budget: { split: Object.fromEntries(sides.map((slot) => [slot, share])) },
        blind: true,
        visibility: 'public',
        author: { type: 'service', id: 'run' },
    };
    contracts.assertValid('agents.play@1', play);
    return play;
}

/** The plays Run lists today: the race (the first play the engine runs) with the most sides it supports. */
function plays() {
    return [racePlay(SLOTS)];
}

module.exports = { SLOTS, PLAY_ID, MACHINE_CLASS, racePlay, plays, shareOf };
