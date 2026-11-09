'use strict';

/**
 * Run sessions' API (contracts 0.223.0, the Desks plan's D6), under /api/v1 behind api/auth.js:
 *
 *   POST /api/v1/sessions                    run.session.create   run.session-create-request@1 → 201 run.session@1 (200 for
 *                                                                 an idempotent repeat)
 *   GET  /api/v1/sessions                    run.session.read     ?state=running|ended|all&limit=&cursor= → run.session-list-result@1
 *   GET  /api/v1/sessions/:id                run.session.read     → run.session@1
 *   POST /api/v1/sessions/:id/commands       run.session.control  run.session-control-request@1 → run.session-control-result@1
 *   POST /api/v1/sessions/:id/end            run.session.control  → run.session@1, ended
 *   GET  /api/v1/sessions/:id/still          run.session.read     the newest frame (JPEG, at most 640 px, at most 1/s);
 *                                                                 the curtain picture while "Curtain now" is up
 *   POST /api/v1/sessions/:id/curtain        run.session.control  { up } → run.session@1
 *
 * The still is the one exception to this API's "401 for a signed-out caller": anyone who is not the session's person,
 * or a first-party service holding run.session.read and naming them, gets the same 404 as a session that does not
 * exist. A picture of someone's desk must never confirm that it is there.
 *
 * A session is its person's: their own Network token, or a first-party service (svc:) holding the capability and
 * naming the person in X-OV-Subject (recorded as via). Anyone else's session is 404, never confirmed to exist. An app,
 * mod or agent token never opens a session for a person here.
 */
const express = require('express');
const { capabilities, http, ids } = require('openvibe-contracts');

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_RE = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

function sessionsRouter({ sessions, verifyFillToken = async () => null }) {
    const r = express.Router();
    const problem = (res, req, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });

    /** The person a call acts for, and the service it came through. → { owner: 'user:usr_…', via } or a sent problem (null). */
    function who(req, res, cap) {
        const p = req.principal || { kind: 'anonymous' };
        if (p.kind === 'anonymous') { problem(res, req, 401, 'token.required', `${cap} needs your OpenVibe sign-in, or a first-party service acting for you`); return null; }
        if (p.kind === 'user') return { owner: `user:${p.subject}`, via: null, actor: { kind: 'person', subject: p.subject } };
        const sub = String(p.sub || '');
        if (!sub.startsWith('svc:')) { problem(res, req, 403, 'capability.denied', 'a session is opened by its person, or by a first-party service acting for them'); return null; }
        const decision = capabilities.check(p.claims, cap);
        if (!decision.allowed) { problem(res, req, 403, decision.code || 'capability.denied', decision.reason || `${cap} not granted`); return null; }
        const subject = String(req.get('X-OV-Subject') || '').trim();
        if (!USER_SUBJECT.test(subject) || !ids.isSubjectId('user', subject)) { problem(res, req, 422, 'run.session.subject_required', 'a service opens a session for a person: X-OV-Subject usr_…'); return null; }
        return { owner: `user:${subject}`, via: `service:${sub.slice(4)}`, actor: { kind: 'ai', subject: sub } };
    }
    async function mine(req, res, cap, allowGuest = false) {
        const w = who(req, res, cap);
        if (!w) return null;
        const id = String(req.params.id || '');
        const row = SESSION_RE.test(id) ? await sessions.get(id) : null;
        if (!row || (row.owner !== w.owner && !(allowGuest && w.actor.kind === 'person' && await sessions.isGuest(row, w.actor.subject)))) { problem(res, req, 404, 'run.session.not_found', 'no such session of yours'); return null; }
        return row;
    }
    /**
     * The still's own guard: the session's person, or a first-party service holding run.session.read and naming them.
     * Anyone else — including a signed-out visitor — gets 404, never 401/403: a still must not confirm a session exists.
     */
    async function mineStill(req, res) {
        const p = req.principal || { kind: 'anonymous' };
        const missing = () => { problem(res, req, 404, 'run.session.not_found', 'no such session'); return null; };
        let owner = null;
        if (p.kind === 'user') owner = `user:${p.subject}`;
        else if (p.kind === 'service') {
            const sub = String(p.sub || '');
            const subject = String(req.get('X-OV-Subject') || '').trim();
            if (sub.startsWith('svc:') && capabilities.check(p.claims, 'run.session.read').allowed && USER_SUBJECT.test(subject) && ids.isSubjectId('user', subject)) owner = `user:${subject}`;
        }
        if (!owner) return missing();
        const id = String(req.params.id || '');
        const row = SESSION_RE.test(id) ? await sessions.get(id) : null;
        if (!row || row.owner !== owner) return missing();
        return row;
    }
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err && err.status && err.code) return problem(res, req, err.status, err.code, err.detail || err.message);
        return next(err);
    });

    r.post('/sessions', wrap(async (req, res) => {
        const w = who(req, res, 'run.session.create');
        if (!w) return;
        const { row, created } = await sessions.create(w.owner, w.via, req.body && typeof req.body === 'object' ? req.body : {}, { pool: req.query.pool, strategy: req.query.strategy, template: req.query.template });
        res.status(created ? 201 : 200).json(sessions.present(row));
    }));
    r.get('/sessions', wrap(async (req, res) => {
        const w = who(req, res, 'run.session.read');
        if (!w) return;
        const state = ['running', 'ended', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'running';
        const cursor = SESSION_RE.test(String(req.query.cursor || '')) ? String(req.query.cursor) : null;
        const page = await sessions.list(w.owner, { state, limit: req.query.limit, cursor });
        res.json({ sessions: page.rows.map(sessions.present), next_cursor: page.next });
    }));
    r.get('/sessions/:id', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.read');
        if (row) res.json(req.query.explain === '1' ? { ...sessions.present(row), compute: row.compute_decision || null } : sessions.present(row));
    }));
    r.post('/sessions/:id/commands', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control', true);
        if (!row) return;
        const w = who(req, res, 'run.session.control');
        if (!w) return;
        res.json(await sessions.act(row, req.body && typeof req.body === 'object' ? req.body : {}, w.actor));
    }));
    r.post('/sessions/:id/fill-requests', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control', true);
        if (!row) return;
        const w = who(req, res, 'run.session.control');
        if (!w) return;
        res.status(201).json(await sessions.createFillRequest(row, req.body && req.body.origin, w.actor));
    }));
    r.get('/sessions/:id/fill-requests/:requestId', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control', true);
        if (!row) return;
        const w = who(req, res, 'run.session.control');
        if (!w) return;
        res.json(await sessions.getFillRequest(req.params.requestId, row.id, w.owner));
    }));
    r.post('/sessions/:id/control/request', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control', true);
        if (!row) return;
        const w = who(req, res, 'run.session.control');
        if (!w) return;
        res.json({ lease: await sessions.requestControl(row, w.actor) });
    }));
    r.get('/sessions/:id/control', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.read', true);
        if (row) res.json({ lease: await sessions.controlLease(row) });
    }));
    r.get('/sessions/:id/timeline', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.read');
        if (row) res.json(await sessions.timeline(row, req.query.limit, req.query.before));
    }));
    r.get('/sessions/:id/snapshot', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.read');
        if (row) res.json(sessions.snapshot(row));
    }));
    r.post('/sessions/:id/control/grant', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control');
        if (!row) return;
        const target = req.body && req.body.holder;
        res.json({ lease: await sessions.grantControl(row, target) });
    }));
    r.post('/sessions/:id/control/take', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control');
        if (!row) return;
        res.json({ lease: await sessions.takeControl(row) });
    }));
    r.post('/sessions/:id/end', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control');
        if (!row) return;
        const ended = await sessions.finish(row, 'ended', 'ended by its person');
        res.json(sessions.present(ended || row));
    }));
    // The newest frame of the session's desk (plan 2026-11-07: the live still). The bytes come from the desk's own
    // capture, through the session's lease, at most once a second and at most 640 px wide.
    r.get('/sessions/:id/still', wrap(async (req, res) => {
        const row = await mineStill(req, res);
        if (!row) return;
        const shot = await sessions.still(row);
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Type', shot.type);
        res.set('Content-Length', String(shot.bytes.length));
        res.status(200).end(shot.bytes);
    }));
    // Curtain now: the privacy screen, so the next still is the curtain picture and never the desk.
    r.post('/sessions/:id/curtain', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control');
        if (!row) return;
        const up = req.body && typeof req.body === 'object' && typeof req.body.up === 'boolean' ? req.body.up : null;
        if (up === null) return problem(res, req, 422, 'run.session.invalid', 'up is true (raise the curtain) or false (lift it)');
        const saved = await sessions.setCurtain(row, up);
        res.json(sessions.present(saved));
    }));
    return r;
}

/** Dock auth is deliberately isolated to Companion approval endpoints and runs before general user auth. */
function fillApprovalRouter({ sessions, verifyFillToken }) {
    const r = express.Router();
    const problem = (res, req, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err && err.status && err.code) return problem(res, req, err.status, err.code, err.detail || err.message);
        return next(err);
    });
    async function whoFill(req, res) {
        const token = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        const claims = await verifyFillToken(token);
        if (!claims) { problem(res, req, 401, 'capability.denied', 'Companion sign-in with run.fill.approve is required'); return null; }
        return { owner: `user:${claims.subject_id}` };
    }
    r.get('/fill-requests', wrap(async (req, res) => {
        const w = await whoFill(req, res); if (!w) return;
        res.json({ requests: await sessions.listFillRequests(w.owner) });
    }));
    r.post('/fill-requests/:id/grant', wrap(async (req, res) => {
        const w = await whoFill(req, res); if (!w) return;
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (body.request_id !== req.params.id) return problem(res, req, 422, 'run.fill.request_id', 'request_id must match the route');
        res.json(await sessions.approveFill(req.params.id, body.envelope, w.owner));
    }));
    r.post('/fill-requests/:id/decline', wrap(async (req, res) => {
        const w = await whoFill(req, res); if (!w) return;
        res.json(await sessions.decideFill(req.params.id, 'declined', w.owner));
    }));
    return r;
}

module.exports = { sessionsRouter, fillApprovalRouter };
