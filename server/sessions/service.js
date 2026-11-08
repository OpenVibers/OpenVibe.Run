'use strict';

/**
 * Run sessions (contracts 0.223.0, the Desks plan's D6): a browser desk Run places for one person and OpenVibe.Bot
 * leases to it (server/sessions/desks.js).
 *
 *   create(owner, via, body)        a validated run.session-create-request@1 → { row, created } (state placing)
 *   act(row, cmd)                   one run.session-control-request@1 on its desk → run.session-control-result@1
 *   finish(row, reason, detail)     end it: the desk stopped, the lease given back, the last desk time metered
 *   tick()                          one pass over the open sessions: place the ones placing, end the ones past their
 *                                   ttl_s or idle_s or whose desk went away, meter running desk time a minute at a time
 *   start() / stop()                the tick on its interval (server/index.js; nothing runs at module load)
 *
 * PLACEMENT. The request's own machine (one of the person's, where they let agents work) or nowhere. Otherwise the
 * hosts Bot lists for the person that are online with room, in the trust classes the requirements allow (default
 * first-party then community; user-owned only when the requirements name it): user-owned first, then first-party,
 * partner, community, and the most free desks first within a class. A host that turns out to be full is skipped and
 * the next one tried; with none the session waits placing until its ttl_s, then ends unplaceable.
 *
 * METERING. One platform.usage-sample@1 per minute of desk time (run:<session>:<minute>, quantity 60; the last one
 * the remainder), service run, operation browser.desk, unit s, written in the transaction that records it, into
 * run_usage_outbox (Run's usage relay posts it to Billing, server/jobs/usage.js). EVENTS: run.session.started when
 * the desk answered, run.session.ended when it ended, in run_events_outbox, in the same transaction.
 */
const contracts = require('openvibe-contracts');
const store = require('./store');
const curtain = require('./curtain');
const usage = require('../jobs/usage');
const { TABLE: EVENTS_TABLE, ACTOR } = require('../events/outbox');

const TRUST_ORDER = ['user-owned', 'first-party', 'partner', 'community'];
const DEFAULT_TRUST = ['first-party', 'community'];
const STARTING_STALE_MS = 60_000;
const OPERATION = 'browser.desk';
const SOURCE = 'openvibe-run.session';
// The still (plan 2026-11-07): one frame a second at most, never wider than 640 px. The desk's own capture is
// reused — the same screen command Actor's computer tools and the agent stream's frames come from — and the answer
// is cached for the second, so a page refreshing every two seconds asks the desk at most once per second.
const STILL_MIN_MS = 1000;
const STILL_WIDTH = 640;

class SessionError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail; }
}

function createSessions({ config, db, desks, outbox, now = () => Date.now(), log = console, broker = null }) {
    const cfg = config.sessions || {};
    const tickMs = cfg.tickMs || 2000;
    const leaseCheckMs = cfg.leaseCheckMs || 30_000;
    const maxOpen = cfg.maxOpen || 3;
    let timer = null;
    let running = null;
    const hostCache = new Map();   // subject → { at, hosts }
    const stills = new Map();      // session id → { at, bytes, type, width, height } (one second)
    const pending = new Map();     // session id → Promise of the frame being captured

    const bare = (owner) => String(owner).replace(/^user:/, '');

    // ── events and usage, inside the caller's transaction ─────────────────────────────────────────────────────
    async function emit(t, row, event) {
        const payload = store.present(row, now());
        contracts.assertValid(`${event}@1`, payload);
        const prepared = outbox.events.prepare({
            event_type: event, version: 1, source: 'run', actor: ACTOR, timestamp: new Date(now()).toISOString(),
            subject: { type: 'session', id: row.id }, visibility: 'internal', priority: 'low', payload,
        }, { now: now() });
        contracts.assertValid('events.event-envelope@1', prepared);
        await t.maybe(`INSERT INTO ${EVENTS_TABLE} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
            [`run:${row.id}:${event}`, JSON.stringify(prepared), now()]);
    }
    /** Queue the desk time not yet metered: whole minutes, and with `final` the remainder too. → minutes now metered */
    async function meter(t, row, { final = false } = {}) {
        if (row.started_at == null || !row.machine) return row.metered_minutes || 0;
        const secs = store.deskSeconds(row, now());
        const whole = Math.floor(secs / 60);
        const readings = [];
        const one = (n, quantity) => {
            const key = `run:${row.id}:${n}`;
            return { id: key, idempotency_key: key, service: usage.SERVICE, operation: OPERATION, unit: 's', quantity,
                at: new Date(row.started_at + n * 60_000).toISOString(), source: SOURCE, subject: row.owner, node: row.machine };
        };
        for (let n = row.metered_minutes || 0; n < whole; n++) readings.push(one(n, 60));
        let metered = Math.max(row.metered_minutes || 0, whole);
        const rest = Math.round((secs - whole * 60) * 10) / 10;
        if (final && rest > 0 && metered === whole) { readings.push(one(whole, rest)); metered = whole + 1; }
        if (readings.length) await usage.enqueue(t, readings, now());
        return metered;
    }

    // ── create, act, finish ───────────────────────────────────────────────────────────────────────────────────
    async function create(owner, via, body, compute = {}) {
        if (compute.pool && (typeof compute.pool !== 'string' || !/^[a-z0-9-]{1,40}$/.test(compute.pool))) throw new SessionError(422, 'run.compute.pool', 'invalid compute pool');
        const pool = compute.pool || null;
        const strategy = compute.strategy || null;
        const template = compute.template || 'browser';
        if (!['browser', 'kept-browser', 'throwaway'].includes(template)) throw new SessionError(422, 'run.session.template', 'template must be browser, kept-browser or throwaway');
        if (template === 'kept-browser') throw new SessionError(501, 'run.session.template_unavailable', 'Kept browser profiles are not available on this machine.');
        if (strategy && !require('openvibe-sdk/compute').STRATEGIES.includes(strategy)) throw new SessionError(422, 'run.compute.strategy', 'unknown compute strategy');
        if (strategy && !pool) throw new SessionError(422, 'run.compute.pool', 'a strategy requires a compute pool');
        if (pool) { if (!broker) throw new SessionError(503, 'run.compute.off'); await broker.poolConfig(pool); }
        const v = contracts.validate('run.session-create-request@1', body);
        if (!v.valid) throw new SessionError(422, 'run.session.invalid', `invalid session request: ${(v.errors && v.errors[0] && v.errors[0].message) || 'bad value'}`.slice(0, 300));
        const digest = store.digestOf(pool ? { ...body, compute_pool: pool, compute_strategy: strategy } : body);
        if (body.idempotency_key) {
            const earlier = await db.maybe('SELECT * FROM run_sessions WHERE owner = $1 AND idempotency_key = $2 AND created_at > $3', [owner, body.idempotency_key, now() - 86_400_000]);
            if (earlier) {
                if (earlier.request_digest !== digest) throw new SessionError(409, 'run.idempotency.conflict', 'that idempotency key was used with another request');
                return { row: await store.get(db, earlier.id), created: false };
            }
        }
        if ((await store.openCount(db, owner)) >= maxOpen) throw new SessionError(429, 'run.session.limit', `at most ${maxOpen} sessions at once: end one first`);
        const at = now();
        const id = store.newSessionId();
        const row = {
            id, owner, via: via || null, kind: 'browser', state: 'placing',
            width: body.width || 1280, height: body.height || 800, ttl_s: body.ttl_s || 3600, idle_s: body.idle_s || 900,
            compute_pool: pool, compute_strategy: strategy, compute_decision: null, template, machine_asked: body.machine || null, requirements: body.requirements || null, idempotency_key: body.idempotency_key || null,
            request_digest: digest, reasons: [], task_id: body.task_id || null, curtain: false,
            control_lease: { thing: `run.session:${id}`, holder: { kind: 'person', subject: bare(owner) }, since_ms: at, expires_ms: at + 60_000, watchers: [], seq: 1 },
            created_at: at, updated_at: at,
        };
        const out = await store.insert(db, row);
        if (out.created) setImmediate(() => { tick().catch((e) => log.warn(`[Run] session tick: ${e.message}`)); });
        return out;
    }

    async function finish(row, reason, detail = null, { release = true } = {}) {
        if (!row || row.state === 'ended') return row;
        if (release && row.machine && row.desk && desks.enabled) {
            try { await desks.end(row.machine, row.desk, bare(row.owner)); } catch (e) { log.warn(`[Run] session ${row.id}: the desk did not end cleanly (${e.code || e.message})`); }
        }
        return db.tx(async (t) => {
            const fresh = await store.get(t, row.id);
            if (!fresh || fresh.state === 'ended') return fresh;
            const ended = { ...fresh, state: 'ended', ended_at: now(), end_reason: reason, end_detail: detail ? String(detail).slice(0, 500) : null };
            const metered = await meter(t, ended, { final: true });
            const saved = await store.update(t, row.id, { state: 'ended', ended_at: ended.ended_at, end_reason: reason, end_detail: ended.end_detail, metered_minutes: metered, updated_at: now() });
            stills.delete(row.id);
            await emit(t, saved, 'run.session.ended');
            return saved;
        });
    }

    const HOLDER_MS = 60_000;
    const ownerHolder = (row) => ({ kind: 'person', subject: bare(row.owner) });
    const sameHolder = (a, b) => Boolean(a && b && a.kind === b.kind && a.subject === b.subject);
    function actorHolder(actor, row) {
        if (!actor) return ownerHolder(row);
        if (actor.kind === 'person') return { kind: 'person', subject: String(actor.subject || bare(row.owner)) };
        const kind = actor.kind === 'ai' ? 'ai' : null;
        const subject = String(actor.subject || '').trim().slice(0, 200);
        if (!kind || !subject) throw new SessionError(403, 'run.session.control_holder', 'the caller is not a named controller');
        return { kind, subject };
    }
    async function saveLease(row, lease, reason) {
        contracts.assertValid('common.control-lease@1', lease);
        return db.tx(async (t) => {
            const fresh = await store.get(t, row.id);
            if (!fresh || fresh.state === 'ended') throw new SessionError(409, 'run.session.not_running', 'the session has ended');
            const saved = await store.update(t, row.id, { control_lease: lease, updated_at: now() });
            const prepared = outbox.events.prepare({
                event_type: 'run.session.control_lease_changed', version: 1, source: 'run', actor: ACTOR,
                timestamp: new Date(now()).toISOString(), subject: { type: 'session', id: row.id },
                visibility: 'internal', priority: 'low', payload: { session_id: row.id, reason, lease },
            }, { now: now() });
            contracts.assertValid('events.event-envelope@1', prepared);
            await t.maybe(`INSERT INTO ${EVENTS_TABLE} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
                [`run:${row.id}:control-lease:${lease.seq}`, JSON.stringify(prepared), now()]);
            return saved;
        });
    }
    async function controlLease(row) {
        let lease = row.control_lease || { thing: `run.session:${row.id}`, holder: ownerHolder(row), since_ms: Number(row.created_at), expires_ms: Number(row.created_at) + HOLDER_MS, watchers: [], seq: 1 };
        contracts.assertValid('common.control-lease@1', lease);
        if (lease.expires_ms != null && lease.expires_ms <= now()) {
            lease = { ...lease, holder: { kind: 'nobody', subject: null }, since_ms: now(), expires_ms: null, seq: lease.seq + 1 };
            row = await saveLease(row, lease, 'expired');
        }
        return row.control_lease || lease;
    }
    async function requestControl(row, actor) {
        const current = await controlLease(row);
        const target = actorHolder(actor, row);
        if (sameHolder(current.holder, target)) return current;
        if (current.holder.kind !== 'nobody') {
            const prepared = outbox.events.prepare({ event_type: 'run.session.control_requested', version: 1, source: 'run', actor: ACTOR,
                timestamp: new Date(now()).toISOString(), subject: { type: 'session', id: row.id }, visibility: 'internal', priority: 'low',
                payload: { session_id: row.id, requester: target } }, { now: now() });
            await db.maybe(`INSERT INTO ${EVENTS_TABLE} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
                [`run:${row.id}:control-request:${target.kind}:${target.subject}:${Math.floor(now() / 1000)}`, JSON.stringify(prepared), now()]);
            return current;
        }
        const next = { ...current, holder: target, since_ms: now(), expires_ms: now() + HOLDER_MS, seq: current.seq + 1 };
        const saved = await saveLease(row, next, 'requested');
        return saved.control_lease;
    }
    async function grantControl(row, target, reason = 'granted') {
        const current = await controlLease(row);
        if (!target || !['person', 'ai', 'nobody'].includes(target.kind)) throw new SessionError(422, 'run.session.control_target', 'target kind is person, ai or nobody');
        const subject = target.kind === 'nobody' ? null : String(target.subject || '').trim().slice(0, 200);
        if (target.kind !== 'nobody' && !subject) throw new SessionError(422, 'run.session.control_target', 'a person or AI controller needs a subject');
        if (target.kind === 'person' && !require('openvibe-contracts').ids.isSubjectId('user', subject)) throw new SessionError(422, 'run.session.control_target', 'a person controller needs a Network usr_ subject');
        const holder = { kind: target.kind, subject };
        if (sameHolder(holder, current.holder)) return current;
        const next = { ...current, holder, since_ms: now(), expires_ms: holder.kind === 'nobody' ? null : now() + HOLDER_MS, seq: current.seq + 1 };
        const saved = await saveLease(row, next, reason);
        if (holder.kind === 'person' && holder.subject !== bare(row.owner)) {
            await db.maybe('INSERT INTO run_session_control_guests (session_id, subject, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING session_id', [row.id, holder.subject, now()]);
        }
        return saved.control_lease;
    }
    async function takeControl(row) { return grantControl(row, ownerHolder(row), 'owner_take_back'); }

    const RESULTS = new Set(['ack', 'nack', 'refused', 'expired']);
    async function act(row, cmd, actor = null) {
        const v = contracts.validate('run.session-control-request@1', cmd);
        if (!v.valid) throw new SessionError(422, 'run.session.invalid', `invalid command: ${(v.errors && v.errors[0] && v.errors[0].message) || 'bad value'}`.slice(0, 300));
        const id = cmd.id || `c-${now().toString(36)}`;
        if (row.state !== 'running') throw new SessionError(409, 'run.session.not_running', row.state === 'ended' ? 'the session has ended' : 'the session\'s desk is not running yet');
        const lease = await controlLease(row);
        const caller = actorHolder(actor, row);
        if (!sameHolder(lease.holder, caller)) {
            await logAction(row, id, cmd, caller, 'refused', 'run.session.control_held');
            throw new SessionError(403, 'run.session.control_held', 'only the current control holder may send commands');
        }
        const r = await desks.act(row.machine, row.desk, bare(row.owner), { id, kind: cmd.kind, value: cmd.value });
        if (r === null) {
            const ended = await finish(row, 'host_lost', 'its machine no longer holds the desk', { release: false });
            return { session_id: row.id, id, result: 'refused', code: 'run.session.host_lost', reason: 'the session\'s machine went away', state: ended ? ended.state : 'ended' };
        }
        const renewed = { ...lease, expires_ms: now() + HOLDER_MS };
        if (renewed.expires_ms !== lease.expires_ms) await store.update(db, row.id, { control_lease: renewed, last_used_at: now(), updated_at: now() });
        else await store.update(db, row.id, { last_used_at: now(), updated_at: now() });
        const out = { session_id: row.id, id: String(r.id || id).slice(0, 64), result: RESULTS.has(r.result) ? r.result : 'expired', state: 'running' };
        if (r.code != null) out.code = String(r.code).slice(0, 80);
        if (r.reason != null) out.reason = String(r.reason).slice(0, 1000);
        if (r.data && typeof r.data === 'object' && out.result === 'ack') out.data = r.data;
        await logAction(row, out.id, cmd, caller, out.result, out.code || null);
        return out;
    }

    async function logAction(row, id, cmd, actor, result, code) {
        const kind = String(cmd.kind || 'unknown').slice(0, 40);
        const action = kind === 'browser' && cmd.value && typeof cmd.value.action === 'string' ? cmd.value.action.slice(0, 48) : null;
        await db.maybe(`INSERT INTO run_session_actions (session_id, command_id, kind, action, actor_kind, actor_subject, result, code, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [row.id, String(id).slice(0, 64), kind, action, actor.kind,
            String(actor.subject || '').slice(0, 200), String(result).slice(0, 24), code ? String(code).slice(0, 80) : null, now()]);
    }
    async function timeline(row, limit = 50, before = null) {
        const n = Math.min(100, Math.max(1, Number(limit) || 50));
        const args = [row.id];
        const cursor = Number(before);
        const where = before && Number.isInteger(cursor) ? ` AND id < $${args.push(cursor)}` : '';
        args.push(n + 1);
        const rows = await db.many(`SELECT id, command_id, kind, action, actor_kind, actor_subject, result, code, created_at
            FROM run_session_actions WHERE session_id = $1${where} ORDER BY id DESC LIMIT $${args.length}`, args);
        const more = rows.length > n;
        const actions = rows.slice(0, n).map((a) => ({ id: Number(a.id), command_id: a.command_id, kind: a.kind, action: a.action,
            actor: { kind: a.actor_kind, subject: a.actor_subject }, result: a.result, code: a.code, at: new Date(Number(a.created_at)).toISOString() }));
        return { actions, next_cursor: more ? String(actions.at(-1).id) : null };
    }
    async function isGuest(row, subject) {
        if (!row || !subject || String(subject) === bare(row.owner)) return false;
        return Boolean(await db.maybe('SELECT 1 FROM run_session_control_guests WHERE session_id = $1 AND subject = $2', [row.id, String(subject)]));
    }
    function snapshot() { return { available: false, message: 'Snapshots are not available on this machine.' }; }

    /**
     * The session's newest frame, as a small JPEG (plan 2026-11-07: the live still Surf's card shows and the Dock
     * links to). It reuses the desk's own capture — the `screen` command on the session's lease, the same one Actor's
     * computer tools read — at most STILL_WIDTH wide, and at most once a second: a caller asking again inside the
     * second gets the frame already captured.
     *
     * Curtain now: while the session's curtain is up the answer is the curtain picture, never a call to the desk.
     * A session that is not running has no frame (404): the caller never learns whether a machine is there.
     * → { bytes, type, width, height, curtain } or throws SessionError.
     */
    async function still(row) {
        if (!row) throw new SessionError(404, 'run.session.not_found', 'no such session');
        if (row.state !== 'running' || !row.machine || !row.desk) throw new SessionError(404, 'run.session.no_still', 'this session has no picture');
        if (row.curtain) return { bytes: curtain.BYTES, type: curtain.TYPE, width: curtain.WIDTH, height: curtain.HEIGHT, curtain: true };
        const fresh = stills.get(row.id);
        if (fresh && now() - fresh.at < STILL_MIN_MS) return fresh;
        if (pending.has(row.id)) return pending.get(row.id);
        const shot = (async () => {
            const r = await desks.act(row.machine, row.desk, bare(row.owner), { id: `still-${Math.floor(now() / 1000)}`, kind: 'screen', value: { max_width: STILL_WIDTH } });
            if (r === null) {
                await finish(row, 'host_lost', 'its machine no longer holds the desk', { release: false });
                throw new SessionError(404, 'run.session.no_still', 'this session has no picture');
            }
            const d = r && r.result === 'ack' && r.data ? r.data : null;
            if (!d || !d.content_b64 || !/^(jpeg|png)$/.test(String(d.format || ''))) throw new SessionError(404, 'run.session.no_still', 'the desk has not sent a frame yet');
            const bytes = Buffer.from(String(d.content_b64), 'base64');
            if (!bytes.length) throw new SessionError(404, 'run.session.no_still', 'the desk sent no picture');
            const out = { at: now(), bytes, type: d.format === 'png' ? 'image/png' : 'image/jpeg', width: Number(d.width) || null, height: Number(d.height) || null, curtain: false };
            stills.set(row.id, out);
            if (stills.size > 500) stills.delete(stills.keys().next().value);
            return out;
        })().finally(() => pending.delete(row.id));
        pending.set(row.id, shot);
        return shot;
    }

    /** Curtain now: raise or lift the session's privacy screen. The next still is the curtain picture, never the desk. */
    async function setCurtain(row, up) {
        if (!row || row.state === 'ended') throw new SessionError(409, 'run.session.not_running', 'the session has ended');
        const saved = await store.update(db, row.id, { curtain: Boolean(up), updated_at: now() });
        stills.delete(row.id);
        return saved;
    }

    // ── placement ─────────────────────────────────────────────────────────────────────────────────────────────
    async function hostsFor(subject) {
        const c = hostCache.get(subject);
        if (c && now() - c.at < 5000) return c.hosts;
        const hosts = await desks.hosts(subject);
        hostCache.set(subject, { at: now(), hosts });
        if (hostCache.size > 500) hostCache.clear();
        return hosts;
    }
    function candidates(row, hosts) {
        const live = hosts.filter((h) => h && h.online && Number(h.free) > 0 && typeof h.machine_id === 'string');
        if (row.machine_asked) return live.filter((h) => h.machine_id === row.machine_asked && h.trust === 'user-owned');
        const allowed = row.requirements && Array.isArray(row.requirements.trust) ? row.requirements.trust : DEFAULT_TRUST;
        return live.filter((h) => allowed.includes(h.trust))
            .sort((a, b) => (TRUST_ORDER.indexOf(a.trust) - TRUST_ORDER.indexOf(b.trust)) || (Number(b.free) - Number(a.free)));
    }
    const reasonsOf = (row, h) => [
        row.machine_asked ? 'your own machine, as asked' : h.trust === 'user-owned' ? 'your own machine, with room'
            : h.trust === 'first-party' ? 'an OpenVibe desk host with room' : 'a community desk host with room',
        `${Number(h.free)} of ${Number(h.max_browser_desks) || Number(h.free)} desks free there`,
        ...(h.shared ? ['each desk there runs in its own sandbox'] : []),
    ];

    async function place(row) {
        if (now() - row.created_at >= row.ttl_s * 1000) return finish(row, 'unplaceable', 'no machine had room before the session\'s time ran out', { release: false });
        let hosts;
        try { hosts = await hostsFor(bare(row.owner)); } catch (e) { if (!e.retryable) log.warn(`[Run] session ${row.id}: desk hosts: ${e.code}`); return row; }
        if (broker) hosts = await broker.available(hosts);
        let list = candidates(row, hosts);
        let decision = null;
        if (row.compute_pool && broker) {
            decision = await broker.decide(row, hosts);
            list = decision.selected ? hosts.filter(h => h.machine_id === decision.selected) : [];
        }
        if (!list.length) {
            if (row.machine_asked && !hosts.some((h) => h.machine_id === row.machine_asked)) return finish(row, 'unplaceable', 'that machine is not open to your agent (or it runs no browser desks)', { release: false });
            return row;
        }
        const desk = store.deskOf(row.id);
        for (const h of list) {
            await store.update(db, row.id, { state: 'starting', machine: h.machine_id, desk, trust: h.trust, offer_id: h.shared ? `desk:${h.machine_id}` : null, reasons: [...reasonsOf(row, h), ...(decision ? [...decision.reasons, `estimated ${decision.hourly} ${decision.currency}/hour`] : [])], compute_decision: decision, updated_at: now() });
            let lease;
            try {
                lease = await desks.lease(h.machine_id, bare(row.owner), { session: row.id, desk, kind: 'browser', width: row.width, height: row.height });
            } catch (e) {
                await store.update(db, row.id, { state: 'placing', machine: null, desk: null, trust: null, offer_id: null, reasons: [], updated_at: now() });
                hostCache.delete(bare(row.owner));
                if (e.code === 'bot.machine_busy' || e.code === 'bot.desk_busy' || e.retryable) continue;
                if (e.code === 'bot.desk_failed') continue;
                log.warn(`[Run] session ${row.id}: lease on ${h.machine_id} refused: ${e.code}`);
                continue;
            }
            if (!lease) { await store.update(db, row.id, { state: 'placing', machine: null, desk: null, trust: null, offer_id: null, reasons: [], updated_at: now() }); continue; }
            return db.tx(async (t) => {
                const saved = await store.update(t, row.id, { state: 'running', started_at: now(), last_used_at: now(), lease_checked_at: now(), updated_at: now() });
                await emit(t, saved, 'run.session.started');
                return saved;
            });
        }
        return store.get(db, row.id);
    }

    // ── the tick ──────────────────────────────────────────────────────────────────────────────────────────────
    async function tickOnce() {
        for (const row of await store.open(db)) {
            try {
                if (row.state === 'placing') { await place(row); continue; }
                if (row.state === 'starting') {
                    if (now() - row.updated_at < STARTING_STALE_MS) continue;
                    const lease = row.machine && row.desk ? await desks.get(row.machine, row.desk, bare(row.owner)).catch(() => undefined) : null;
                    if (lease === undefined) continue;
                    if (lease) await db.tx(async (t) => { const s = await store.update(t, row.id, { state: 'running', started_at: row.started_at || now(), last_used_at: now(), lease_checked_at: now(), updated_at: now() }); await emit(t, s, 'run.session.started'); });
                    else await store.update(db, row.id, { state: 'placing', machine: null, desk: null, trust: null, offer_id: null, reasons: [], updated_at: now() });
                    continue;
                }
                // running
                await controlLease(row);
                if (now() - row.created_at >= row.ttl_s * 1000) { await finish(row, 'ttl', `its ${row.ttl_s} s ran out`); continue; }
                if (now() - (row.last_used_at || row.started_at) >= row.idle_s * 1000) { await finish(row, 'idle', `no command for ${row.idle_s} s`); continue; }
                if (now() - (row.lease_checked_at || 0) >= leaseCheckMs) {
                    const lease = await desks.get(row.machine, row.desk, bare(row.owner)).catch(() => undefined);
                    if (lease === null) { await finish(row, 'host_lost', 'its machine no longer holds the desk', { release: false }); continue; }
                    if (lease) await store.update(db, row.id, { lease_checked_at: now() });
                }
                await db.tx(async (t) => {
                    const fresh = await store.get(t, row.id);
                    if (!fresh || fresh.state !== 'running') return;
                    const metered = await meter(t, fresh);
                    if (metered !== fresh.metered_minutes) await store.update(t, row.id, { metered_minutes: metered });
                });
            } catch (e) {
                log.warn(`[Run] session ${row.id}: ${e.code || e.message}`);
            }
        }
    }
    /** One pass at a time: a pass asked for while one runs waits for it. */
    function tick() {
        if (running) return running;
        running = tickOnce().finally(() => { running = null; });
        return running;
    }

    return {
        create, act, finish, still, setCurtain, requestControl, grantControl, takeControl, controlLease, timeline, isGuest, snapshot, tick, SessionError,
        get: (id) => store.get(db, id),
        list: (owner, opts) => store.listOf(db, owner, opts),
        present: (row) => store.present(row, now()),
        start() {
            if (timer || !desks.enabled) return;
            timer = setInterval(() => { tick().catch((e) => log.warn(`[Run] session tick: ${e.message}`)); }, tickMs);
            if (timer.unref) timer.unref();
        },
        async stop() { if (timer) clearInterval(timer); timer = null; if (running) await running.catch(() => {}); },
        status: () => ({ enabled: desks.enabled, note: desks.note, tick_ms: tickMs, max_open: maxOpen }),
    };
}

module.exports = { createSessions, SessionError, OPERATION, SOURCE };
