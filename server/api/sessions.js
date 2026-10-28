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
 *
 * A session is its person's: their own Network token, or a first-party service (svc:) holding the capability and
 * naming the person in X-OV-Subject (recorded as via). Anyone else's session is 404, never confirmed to exist. An app,
 * mod or agent token never opens a session for a person here.
 */
const express = require('express');
const { capabilities, http, ids } = require('openvibe-contracts');

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_RE = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

function sessionsRouter({ sessions }) {
    const r = express.Router();
    const problem = (res, req, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });

    /** The person a call acts for, and the service it came through. → { owner: 'user:usr_…', via } or a sent problem (null). */
    function who(req, res, cap) {
        const p = req.principal || { kind: 'anonymous' };
        if (p.kind === 'anonymous') { problem(res, req, 401, 'token.required', `${cap} needs your OpenVibe sign-in, or a first-party service acting for you`); return null; }
        if (p.kind === 'user') return { owner: `user:${p.subject}`, via: null };
        const sub = String(p.sub || '');
        if (!sub.startsWith('svc:')) { problem(res, req, 403, 'capability.denied', 'a session is opened by its person, or by a first-party service acting for them'); return null; }
        const decision = capabilities.check(p.claims, cap);
        if (!decision.allowed) { problem(res, req, 403, decision.code || 'capability.denied', decision.reason || `${cap} not granted`); return null; }
        const subject = String(req.get('X-OV-Subject') || '').trim();
        if (!USER_SUBJECT.test(subject) || !ids.isSubjectId('user', subject)) { problem(res, req, 422, 'run.session.subject_required', 'a service opens a session for a person: X-OV-Subject usr_…'); return null; }
        return { owner: `user:${subject}`, via: `service:${sub.slice(4)}` };
    }
    async function mine(req, res, cap) {
        const w = who(req, res, cap);
        if (!w) return null;
        const id = String(req.params.id || '');
        const row = SESSION_RE.test(id) ? await sessions.get(id) : null;
        if (!row || row.owner !== w.owner) { problem(res, req, 404, 'run.session.not_found', 'no such session of yours'); return null; }
        return row;
    }
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
        if (err && err.status && err.code) return problem(res, req, err.status, err.code, err.detail || err.message);
        return next(err);
    });

    r.post('/sessions', wrap(async (req, res) => {
        const w = who(req, res, 'run.session.create');
        if (!w) return;
        const { row, created } = await sessions.create(w.owner, w.via, req.body && typeof req.body === 'object' ? req.body : {});
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
        if (row) res.json(sessions.present(row));
    }));
    r.post('/sessions/:id/commands', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control');
        if (!row) return;
        res.json(await sessions.act(row, req.body && typeof req.body === 'object' ? req.body : {}));
    }));
    r.post('/sessions/:id/end', wrap(async (req, res) => {
        const row = await mine(req, res, 'run.session.control');
        if (!row) return;
        const ended = await sessions.finish(row, 'ended', 'ended by its person');
        res.json(sessions.present(ended || row));
    }));
    return r;
}

module.exports = { sessionsRouter };
