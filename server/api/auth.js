'use strict';

/**
 * Who is calling /api/v1 — resolved into req.principal:
 *
 *   { kind: 'service', sub: 'svc:live', cap: [...], claims, project_id, jti }   a Network client-credentials
 *                                                    token for audience openvibe.run; each route checks ONE
 *   { kind: 'user', subject: 'usr_…', username, name, avatar, role }             capability (see v1.js)
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded.
 * A node principal (nod_…) is not a Run principal and is refused like any other non-service token.
 *
 * The project a job belongs to comes from the token's own project_id claim (a developer app or agent
 * token names one), never from the request body or a query: the requester and the billed project are
 * the token's, always.
 */
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ANON = Object.freeze({ kind: 'anonymous' });

/** Run's six capabilities (contracts/manifests/capabilities/run.job.*.json). */
const CAPABILITIES = ['run.job.submit', 'run.job.read', 'run.job.list', 'run.job.cancel', 'run.job.stream', 'run.job.admin'];

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** A Network user token's claims → the user principal (null when it names no subject). */
function userPrincipal(claims) {
    if (!claims) return null;
    const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
    if (!subject) return null;
    return {
        kind: 'user', subject, username: claims.username || null, name: claims.display_name || claims.username || null,
        avatar: claims.avatar_url || null, role: claims.role || 'user', project_id: null, cap: [], claims,
    };
}

/** Verify a service token (audience openvibe.run). Returns { ok, claims } or { ok:false, code, reason }. */
function verifyService(token, { publicKey, issuer, audience }) {
    if (!publicKey) return { ok: false, code: 'identity.unavailable', reason: 'the Network signing key is not loaded yet' };
    const payload = decodePayload(token);
    if (!payload || typeof payload.sub !== 'string' || !PRINCIPAL_SUB.test(payload.sub)) return { ok: false, code: 'token.invalid', reason: 'not a service token' };
    const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer, audience });
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
    return { ok: true, claims: r.claims };
}

/** The project a principal acts for: its token's project_id claim, or null (no project named). */
function projectOf(principal) {
    const id = principal && principal.claims && principal.claims.project_id;
    return typeof id === 'string' && PROJECT_RE.test(id) ? id : null;
}

/**
 * The principal as an identity.subject-ref@1 (the run_jobs.requester column holds 'type:id'). A service
 * token's sub is `svc:<slug>` — the wire spelling of the SubjectRef `{ type: 'service', id: '<slug>' }`
 * (ids.principalSub is the other direction); app, mod and agent subs already carry their type.
 */
function requesterOf(principal) {
    if (!principal) return null;
    if (principal.kind === 'user') return { type: 'user', id: principal.subject };
    if (principal.kind !== 'service') return null;
    const sub = String((principal.claims && principal.claims.sub) || principal.sub || '');
    if (sub.startsWith('svc:')) return { type: 'service', id: sub.slice(4) };
    return ids.parseSubject(sub);
}

function createApiAuth({ config, keys, userAuth }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { principal: ANON };
        const token = header.slice(7).trim();
        const publicKey = keys.get();
        if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
        const payload = decodePayload(token);
        if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
            const r = verifyService(token, { publicKey, issuer: config.network.issuer, audience: config.audience });
            if (!r.ok) return { error: [401, r.code, r.reason] };
            return { principal: { kind: 'service', sub: r.claims.sub, cap: r.claims.cap || [], claims: r.claims, project_id: projectOf({ claims: r.claims }), jti: r.claims.jti } };
        }
        const claims = await userAuth.verify(token);
        if (!claims) return { error: [401, 'token.invalid', 'the user token is invalid or expired'] };
        const p = userPrincipal(claims);
        if (!p) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
        return { principal: p };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    /** A service principal holding `cap` (a trailing `.*` grant covers a family). */
    const granted = (p, cap) => p.kind === 'service' && capabilities.grants(p.cap, cap);

    /**
     * requireCapability('run.job.submit') — the Express middleware of ONE route of the map in v1.js: the
     * token's grant list is judged by openvibe-contracts capabilities.check (never a route's own list, and
     * never the body). No token → 401; a token without the grant → 403 capability.denied.
     */
    function requireCapability(id) {
        if (!CAPABILITIES.includes(id)) throw new Error(`requireCapability(${id}): not one of Run's capabilities`);
        return function capabilityGuard(req, res, next) {
            const p = req.principal;
            if (p.kind === 'anonymous') return http.sendProblem(res, 401, 'token.required', { detail: `${id} needs a Network service token for ${config.audience}`, ctx: req.ov });
            const decision = p.kind === 'service'
                ? capabilities.check(p.claims, id)
                : { allowed: false, code: 'capability.denied', reason: `${id} is granted to service principals only` };
            // run.job.admin is `internal` and, the manifest says, "never delegated and never in an app or mod
            // token": an app, mod or agent principal that somehow holds the grant is refused here too.
            const internalService = id !== 'run.job.admin' || String(p.sub || '').startsWith('svc:');
            if (decision.allowed && internalService) return next();
            return http.sendProblem(res, 403, decision.code || 'capability.denied', {
                detail: decision.allowed ? 'run.job.admin is internal: it is never an app, mod or agent token' : decision.reason || `${id} not granted`,
                ctx: req.ov,
            });
        };
    }

    /**
     * The project and the requester this call acts for, both from the token alone. 403 run.project_required
     * when the token names no project (a first-party service token without the project_id claim, or a user
     * token): jobs belong to a project, and the billed project is never taken from a request body.
     */
    function requireProject(req) {
        const project = projectOf(req.principal);
        const requester = requesterOf(req.principal);
        if (!project || !requester) {
            const err = new Error('this token names no project: jobs belong to the project a token names (project_id)');
            err.status = 403;
            err.code = 'run.project_required';
            throw err;
        }
        return { project, requester: ids.formatSubject(requester) };
    }

    return { middleware, resolve, granted, requireCapability, requireProject, projectOf, requesterOf };
}

module.exports = { createApiAuth, userPrincipal, verifyService, decodePayload, projectOf, requesterOf, CAPABILITIES, PRINCIPAL_SUB, PROJECT_RE };
