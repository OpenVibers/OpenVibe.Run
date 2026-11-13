'use strict';

/**
 * The Arena's race routes on the Run API (compare-arena-ecosystem.md §3):
 *
 * | Method & path                         | Capability       | Request → answer                                      |
 * |---------------------------------------|------------------|-------------------------------------------------------|
 * | GET  /plays                           | run.job.list     | common.no-body@1 → { plays: agents.play@1[] }          |
 * | POST /races                           | run.job.submit   | { prompt, kind, entrants | matchmaker, budget } → 201 race |
 * | GET  /races/:id                       | run.job.read     | sides' live output, receipts; names only after a judgement |
 * | POST /races/:id/judgement             | run.job.submit   | { winner } → 201 race with the names revealed          |
 *
 * Contracts 0.422.0 has no run.race@1 yet, so the race request and answer are validated by
 * server/races/service.js by hand (and the bench.match@1 it records is validated against its released
 * contract). The capabilities are the job ones on purpose — Run has six, and a race is a group submit and
 * a group read; inventing run.race.* here would be a capability no manifest grants.
 *
 * A race belongs to the person who started it and the first-party service they started it through: a
 * delegated token (X-OV-Subject + X-OV-Project) is required. Another person, service or project gets the
 * same 404 a missing race does, and only that person may judge.
 */
const express = require('express');
const { fail } = require('../util');

function racesRouter({ races, apiAuth }) {
    const r = express.Router();
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const guard = apiAuth.requireCapability;

    // ── GET /plays — run.job.list ───────────────────────────────────────────────
    // The race play is data (agents.play@1), so the same document lists here and drives a race.
    r.get('/plays', guard('run.job.list'), wrap(async (_req, res) => {
        res.json({ plays: races.plays() });
    }));

    // ── POST /races — run.job.submit ────────────────────────────────────────────
    r.post('/races', guard('run.job.submit'), wrap(async (req, res) => {
        const scope = apiAuth.requireProject(req, { delegated: true });
        const race = await races.start({
            projectId: scope.project, requester: scope.requester, via: scope.via,
            body: req.body, traceparent: req.ov && req.ov.traceparent,
        });
        res.status(201).json(race);
    }));

    // ── GET /races/:id — run.job.read ───────────────────────────────────────────
    r.get('/races/:id', guard('run.job.read'), wrap(async (req, res) => {
        const scope = apiAuth.requireProject(req, { delegated: true });
        const race = await races.get({ projectId: scope.project, requester: scope.requester, via: scope.via, id: req.params.id });
        if (!race) fail(404, 'run.race_not_found', 'no such race');
        res.json(race);
    }));

    // ── POST /races/:id/judgement — run.job.submit ──────────────────────────────
    r.post('/races/:id/judgement', guard('run.job.submit'), wrap(async (req, res) => {
        const scope = apiAuth.requireProject(req, { delegated: true });
        const race = await races.judge({
            projectId: scope.project, requester: scope.requester, via: scope.via,
            id: req.params.id, body: req.body,
        });
        if (!race) fail(404, 'run.race_not_found', 'no such race');
        res.status(201).json(race);
    }));

    return r;
}

module.exports = { racesRouter };
