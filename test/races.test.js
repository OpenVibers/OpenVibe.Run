'use strict';
/**
 * The Arena's race on Run (compare-arena-ecosystem.md §3, Contracts 0.422.0): the race play as
 * agents.play@1, N blind child jobs with one budget split evenly, names hidden until a person's judgement,
 * the bench.match@1 that judgement records, and the starter-only rule.
 *
 *   node test/races.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { familyOf } = require('../server/races/entrants');

const { ids } = contracts;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A Bench that records what it is sent and validates it against bench.match@1, like Bench's route does. */
function fakeBench() {
    const calls = [];
    return {
        enabled: true,
        note: 'test bench',
        calls,
        async record(match) {
            calls.push(match);
            contracts.assertValid('bench.match@1', match);
            return { created: true, match };
        },
        status: () => ({ enabled: true, note: 'test bench' }),
    };
}

async function checks(t, bench) {
    const P = ids.newId('project');
    const Q = ids.newId('project');
    const ada = ids.newId('user');
    const bo = ids.newId('user');
    t.network.members.set(`${P} ${ada}`, { role: 'admin' });
    t.network.members.set(`${P} ${bo}`, { role: 'owner' });

    const CAPS = ['run.job.submit', 'run.job.read', 'run.job.list'];
    // A first-party service acting for a person: the only principal a race accepts as its starter.
    const as = (subject, project, { sub = 'svc:compare', cap = CAPS } = {}) => ({
        token: t.network.signService({ sub, cap }),
        headers: { 'X-OV-Subject': subject, 'X-OV-Project': project },
    });
    const raceRows = async (raceId) => t.db.many("SELECT * FROM run_jobs WHERE job->>'parent' IS NOT NULL AND job->'parent'->>'id' = $1 ORDER BY id", [raceId]);

    const prompt = 'Explain in two sentences why the sky is blue.';
    const entrants = ['model:gpt-5-mini', 'model:glm-5.3'];
    const body = { prompt, kind: 'chat', entrants, budget: { usd: 0.2, wall_ms: 60_000, cpu_ms: 60_000, mem_bytes: 268_435_456 } };

    let raceId;
    let sideEntrants;

    await check('the race play lists as agents.play@1: one role per side, one parallel phase, even split, blind, stop on person', async () => {
        const r = await t.call('GET', '/api/v1/plays', { token: t.network.signService({ sub: 'svc:compare', cap: ['run.job.list'] }) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.plays.length, 1);
        const play = r.json.plays[0];
        assert.ok(contracts.validate('agents.play@1', play).valid, JSON.stringify(play));
        assert.strictEqual(play.id, 'race');
        assert.strictEqual(play.blind, true);
        assert.deepStrictEqual(play.stop, { when: 'person' });
        assert.strictEqual(play.phases.length, 1);
        assert.strictEqual(play.phases[0].parallel, true);
        assert.deepStrictEqual(play.phases[0].roles, play.roles.map((role) => role.id));
        const split = Object.values(play.budget.split);
        assert.strictEqual(split.length, play.roles.length);
        assert.ok(Math.abs(split.reduce((a, b) => a + b, 0) - 1) < 1e-6, JSON.stringify(play.budget.split));
        for (const role of play.roles) assert.ok(!JSON.stringify(role).includes('gpt') && !JSON.stringify(role).includes('model:'), 'a role never names an entrant');
    });

    await check('POST /races starts N child jobs under one parent, each with the same share of the budget, and answers no names', async () => {
        const r = await t.call('POST', '/api/v1/races', { body, ...as(ada, P) });
        assert.strictEqual(r.status, 201, r.text);
        const race = r.json;
        raceId = race.id;
        assert.match(raceId, /^rac_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(race.kind, 'chat');
        assert.strictEqual(race.blind, true);
        assert.strictEqual(race.revealed, false);
        assert.strictEqual(race.names, null);
        assert.strictEqual(race.judgement, null);
        assert.deepStrictEqual(race.shown, ['a', 'b']);
        assert.deepStrictEqual(race.sides.map((s) => s.slot), ['a', 'b']);
        assert.ok(contracts.validate('agents.play@1', race.play).valid);
        assert.strictEqual(race.play.roles.length, 2);
        assert.strictEqual(race.budget.per_side.wall_ms, 30_000);
        assert.strictEqual(race.budget.per_side.cpu_ms, 30_000);
        assert.strictEqual(race.budget.per_side.usd, 0.1);
        assert.strictEqual(race.budget.per_side.machine_class, 'linux');
        const raw = JSON.stringify(race);
        for (const id of entrants) assert.ok(!raw.includes(id), `no entrant before the judgement: ${id} in ${raw}`);
        for (const side of race.sides) assert.ok(!('entrant' in side), 'a side carries no entrant while blind');

        const rows = await raceRows(raceId);
        assert.strictEqual(rows.length, 2);
        for (const row of rows) {
            assert.strictEqual(row.state, 'queued');
            assert.strictEqual(row.project_id, P);
            assert.strictEqual(row.requester, `user:${ada}`);
            assert.strictEqual(row.via, 'service:compare');
            assert.strictEqual(row.class, 'linux');
            assert.strictEqual(row.job.limits.wall_ms, 30_000);
            assert.strictEqual(row.job.limits.cpu_ms, 30_000);
            assert.strictEqual(row.job.limits.mem_bytes, 134_217_728);
            assert.strictEqual(Number(row.ttl_ms), 30_000 + 600_000);
            assert.strictEqual(row.job.args.race, raceId);
            assert.strictEqual(row.job.args.play, 'race');
            assert.strictEqual(row.job.args.kind, 'chat');
            assert.deepStrictEqual(row.job.parent, { type: 'race', id: raceId });
            assert.ok(entrants.includes(row.job.args.entrant));
            assert.ok(['a', 'b'].includes(row.job.args.role));
        }
        assert.deepStrictEqual(rows.map((row) => row.job.args.role).sort(), ['a', 'b']);
        sideEntrants = Object.fromEntries(rows.map((row) => [row.job.args.role, row.job.args.entrant]));
        assert.deepStrictEqual(new Set(rows.map((row) => row.job.args.entrant)), new Set(entrants));
        assert.strictEqual((await t.outboxRows('run.job.queued')).filter((e) => e.payload.job_id === rows[0].id || e.payload.job_id === rows[1].id).length, 2);
    });

    await check('GET /races/:id shows the sides\' output as it streams, with no names before the judgement; another person gets 404', async () => {
        const rows = await raceRows(raceId);
        t.stream.output(rows[0].id, 'The sky is blue because ');
        t.stream.output(rows[0].id, 'Rayleigh scattering favours short wavelengths.');
        t.stream.output(rows[1].id, 'Shorter wavelengths scatter more.');
        const mine = await t.call('GET', `/api/v1/races/${raceId}`, as(ada, P));
        assert.strictEqual(mine.status, 200, mine.text);
        assert.strictEqual(mine.json.state, 'running');
        assert.match(mine.json.sides.find((s) => s.run_id === rows[0].id).output, /Rayleigh scattering/);
        assert.match(mine.json.sides.find((s) => s.run_id === rows[1].id).output, /Shorter wavelengths/);
        assert.strictEqual(mine.json.revealed, false);
        assert.strictEqual(mine.json.names, null);
        assert.ok(!JSON.stringify(mine.json).includes('model:gpt-5-mini'));
        const other = await t.call('GET', `/api/v1/races/${raceId}`, as(bo, P));
        assert.strictEqual(other.status, 404, other.text);
        assert.strictEqual(other.json.code, 'run.race_not_found');
        const anotherService = await t.call('GET', `/api/v1/races/${raceId}`, as(ada, P, { sub: 'svc:actor' }));
        assert.strictEqual(anotherService.status, 404, anotherService.text);
    });

    await check('a judged side\'s receipts are the job\'s outcome and wall clock', async () => {
        const jobs = require('../server/jobs/store');
        const rows = await raceRows(raceId);
        for (const row of rows) {
            await t.db.tx(async (tx) => jobs.settle(tx, row.id, {
                state: 'succeeded', result: { answer: `answer ${row.job.args.role}` }, wallMs: 1234, at: Date.now(),
            }));
        }
        const r = await t.call('GET', `/api/v1/races/${raceId}`, as(ada, P));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.state, 'done');
        for (const side of r.json.sides) {
            assert.deepStrictEqual(side.receipts, { outcome: 'succeeded', wall_ms: 1234, length_chars: 8 });
        }
    });

    await check('only the person who started it, through the same service, may judge', async () => {
        const notMine = await t.call('POST', `/api/v1/races/${raceId}/judgement`, { body: { winner: 'a' }, ...as(bo, P) });
        assert.strictEqual(notMine.status, 404, notMine.text);
        assert.strictEqual(notMine.json.code, 'run.race_not_found');
        const otherService = await t.call('POST', `/api/v1/races/${raceId}/judgement`, { body: { winner: 'a' }, ...as(ada, P, { sub: 'svc:actor' }) });
        assert.strictEqual(otherService.status, 404, otherService.text);
        const service = await t.call('POST', `/api/v1/races/${raceId}/judgement`, {
            body: { winner: 'a' },
            token: t.network.signService({ sub: 'svc:compare', cap: ['run.job.submit'], project_id: P }),
        });
        assert.strictEqual(service.status, 404, service.text);
        const bad = await t.call('POST', `/api/v1/races/${raceId}/judgement`, { body: { winner: 'e' }, ...as(ada, P) });
        assert.strictEqual(bad.status, 400, bad.text);
        assert.strictEqual(bench.calls.length, 0, 'nothing reached Bench');
    });

    await check('the judgement records one valid bench.match@1 (arena, shown order, blind, receipts, keyed person) and reveals the names', async () => {
        const r = await t.call('POST', `/api/v1/races/${raceId}/judgement`, { body: { winner: 'a' }, ...as(ada, P) });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(bench.calls.length, 1);
        const match = bench.calls[0];
        assert.ok(contracts.validate('bench.match@1', match).valid, JSON.stringify(match));
        assert.match(match.id, /^mat_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(match.source, 'arena');
        assert.deepStrictEqual(match.task, { kind: 'chat', prompt_hash: sha256(prompt) });
        assert.deepStrictEqual(match.shown, ['a', 'b']);
        assert.strictEqual(match.blind, true);
        assert.deepStrictEqual(match.budget, { usd: 0.1, ms: 30_000, machine_class: 'linux' });
        assert.deepStrictEqual(match.slots.map((s) => s.slot), ['a', 'b']);
        assert.deepStrictEqual(new Set(match.slots.map((s) => s.entrant)), new Set(entrants));
        for (const slot of match.slots) {
            assert.match(slot.run_id, /^job_/);
            assert.deepStrictEqual(slot.receipts, { outcome: 'succeeded', wall_ms: 1234, length_chars: 8 });
        }
        assert.strictEqual(match.judgements.length, 1);
        assert.strictEqual(match.judgements[0].judge, 'human_pairwise');
        assert.strictEqual(match.judgements[0].winner, 'a');
        assert.deepStrictEqual(match.judgements[0].by, { type: 'person', id_hash: t.app.locals.races.personHash(`user:${ada}`) });
        assert.match(match.judgements[0].by.id_hash, /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(match).includes(ada), 'never the person id');
        assert.deepStrictEqual(match.play, { id: 'race', run_id: raceId });

        assert.strictEqual(r.json.revealed, true);
        assert.strictEqual(r.json.state, 'judged');
        assert.strictEqual(r.json.judgement.winner, 'a');
        assert.strictEqual(r.json.judgement.match_id, match.id);
        assert.deepStrictEqual(r.json.names, sideEntrants);
        for (const side of r.json.sides) assert.strictEqual(side.entrant, sideEntrants[side.slot]);
        const shown = await t.call('GET', `/api/v1/races/${raceId}`, as(ada, P));
        assert.strictEqual(shown.status, 200, shown.text);
        assert.ok(JSON.stringify(shown.json).includes('model:gpt-5-mini'));
        assert.strictEqual(shown.json.names.a, sideEntrants.a);
    });

    await check('a second judgement is refused and Bench is not called again', async () => {
        const again = await t.call('POST', `/api/v1/races/${raceId}/judgement`, { body: { winner: 'b' }, ...as(ada, P) });
        assert.strictEqual(again.status, 409, again.text);
        assert.strictEqual(again.json.code, 'run.race_already_judged');
        assert.strictEqual(bench.calls.length, 1);
    });

    await check('matchmaker: true picks two entrants of different families from the configured list', async () => {
        const r = await t.call('POST', '/api/v1/races', {
            body: { prompt: 'Write a haiku about the sea.', kind: 'code', matchmaker: true, budget: { wall_ms: 40_000, cpu_ms: 40_000, mem_bytes: 268_435_456 } },
            ...as(ada, P),
        });
        assert.strictEqual(r.status, 201, r.text);
        const made = r.json;
        assert.strictEqual(made.sides.length, 2);
        assert.strictEqual(made.revealed, false);
        assert.ok(!JSON.stringify(made).includes('model:'));
        const judged = await t.call('POST', `/api/v1/races/${made.id}/judgement`, { body: { winner: 'tie' }, ...as(ada, P) });
        assert.strictEqual(judged.status, 201, judged.text);
        const pair = Object.values(judged.json.names);
        assert.strictEqual(new Set(pair).size, 2);
        for (const id of pair) assert.ok(t.config.races.entrants.includes(id), `${id} came from RUN_RACE_ENTRANTS`);
        assert.notStrictEqual(familyOf(pair[0]), familyOf(pair[1]), `different families: ${pair.join(' vs ')}`);
        assert.strictEqual(bench.calls.length, 2);
        assert.strictEqual(bench.calls[1].judgements[0].winner, 'tie');
    });

    await check('a malformed race request is refused 400 and starts no child job, and a service for itself is refused', async () => {
        const before = (await t.db.many('SELECT count(*)::int AS n FROM run_jobs WHERE project_id = $1', [P]))[0].n;
        const cases = [
            { ...body, entrants: ['model:gpt-5-mini'] },
            { ...body, matchmaker: true },
            { ...body, entrants: ['not-an-entrant', 'model:glm-5.3'] },
            { prompt: '', kind: 'chat', entrants, budget: body.budget },
            { ...body, budget: undefined },
            { ...body, kind: 'poetry' },
            { ...body, extra: true },
        ];
        for (const bad of cases) {
            const r = await t.call('POST', '/api/v1/races', { body: bad, ...as(ada, P) });
            assert.strictEqual(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
            assert.strictEqual(r.json.code, 'run.invalid_request');
        }
        const after = (await t.db.many('SELECT count(*)::int AS n FROM run_jobs WHERE project_id = $1', [P]))[0].n;
        assert.strictEqual(after, before, 'no child job was made by a refused race');
        const self = await t.call('POST', '/api/v1/races', {
            body: { ...body, entrants: ['model:gpt-5-mini', 'model:glm-5.3'] },
            token: t.network.signService({ sub: 'svc:compare', cap: ['run.job.submit'], project_id: P }),
        });
        assert.strictEqual(self.status, 403, self.text);
        assert.strictEqual(self.json.code, 'run.race_person_required');
    });
}

async function main() {
    const bench = fakeBench();
    const t = await boot({
        env: {
            OV_OAUTH_CLIENT_SECRET: 'run-test-secret',
            RUN_RACE_ENTRANTS: 'model:gpt-5-mini,model:glm-5.3,model:deepseek-flash,agent:codex+gpt-5-mini#0123abcd',
        },
        appOpts: { bench },
    });
    try { await checks(t, bench); } finally { await t.close(); }
    done();
}

main().catch((e) => { console.error(e); process.exit(1); });
