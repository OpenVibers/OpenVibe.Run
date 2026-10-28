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
const usage = require('../jobs/usage');
const { TABLE: EVENTS_TABLE, ACTOR } = require('../events/outbox');

const TRUST_ORDER = ['user-owned', 'first-party', 'partner', 'community'];
const DEFAULT_TRUST = ['first-party', 'community'];
const STARTING_STALE_MS = 60_000;
const OPERATION = 'browser.desk';
const SOURCE = 'openvibe-run.session';

class SessionError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail; }
}

function createSessions({ config, db, desks, outbox, now = () => Date.now(), log = console }) {
    const cfg = config.sessions || {};
    const tickMs = cfg.tickMs || 2000;
    const leaseCheckMs = cfg.leaseCheckMs || 30_000;
    const maxOpen = cfg.maxOpen || 3;
    let timer = null;
    let running = null;
    const hostCache = new Map();   // subject → { at, hosts }

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
    async function create(owner, via, body) {
        const v = contracts.validate('run.session-create-request@1', body);
        if (!v.valid) throw new SessionError(422, 'run.session.invalid', `invalid session request: ${(v.errors && v.errors[0] && v.errors[0].message) || 'bad value'}`.slice(0, 300));
        const digest = store.digestOf(body);
        if (body.idempotency_key) {
            const earlier = await db.maybe('SELECT * FROM run_sessions WHERE owner = $1 AND idempotency_key = $2 AND created_at > $3', [owner, body.idempotency_key, now() - 86_400_000]);
            if (earlier) {
                if (earlier.request_digest !== digest) throw new SessionError(409, 'run.idempotency.conflict', 'that idempotency key was used with another request');
                return { row: await store.get(db, earlier.id), created: false };
            }
        }
        if ((await store.openCount(db, owner)) >= maxOpen) throw new SessionError(429, 'run.session.limit', `at most ${maxOpen} sessions at once: end one first`);
        const at = now();
        const row = {
            id: store.newSessionId(), owner, via: via || null, kind: 'browser', state: 'placing',
            width: body.width || 1280, height: body.height || 800, ttl_s: body.ttl_s || 3600, idle_s: body.idle_s || 900,
            machine_asked: body.machine || null, requirements: body.requirements || null, idempotency_key: body.idempotency_key || null,
            request_digest: digest, reasons: [], created_at: at, updated_at: at,
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
            await emit(t, saved, 'run.session.ended');
            return saved;
        });
    }

    const RESULTS = new Set(['ack', 'nack', 'refused', 'expired']);
    async function act(row, cmd) {
        const v = contracts.validate('run.session-control-request@1', cmd);
        if (!v.valid) throw new SessionError(422, 'run.session.invalid', `invalid command: ${(v.errors && v.errors[0] && v.errors[0].message) || 'bad value'}`.slice(0, 300));
        if (row.state !== 'running') throw new SessionError(409, 'run.session.not_running', row.state === 'ended' ? 'the session has ended' : 'the session\'s desk is not running yet');
        const id = cmd.id || `c-${now().toString(36)}`;
        const r = await desks.act(row.machine, row.desk, bare(row.owner), { id, kind: cmd.kind, value: cmd.value });
        if (r === null) {
            const ended = await finish(row, 'host_lost', 'its machine no longer holds the desk', { release: false });
            return { session_id: row.id, id, result: 'refused', code: 'run.session.host_lost', reason: 'the session\'s machine went away', state: ended ? ended.state : 'ended' };
        }
        await store.update(db, row.id, { last_used_at: now(), updated_at: now() });
        const out = { session_id: row.id, id: String(r.id || id).slice(0, 64), result: RESULTS.has(r.result) ? r.result : 'expired', state: 'running' };
        if (r.code != null) out.code = String(r.code).slice(0, 80);
        if (r.reason != null) out.reason = String(r.reason).slice(0, 1000);
        if (r.data && typeof r.data === 'object' && out.result === 'ack') out.data = r.data;
        return out;
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
        const list = candidates(row, hosts);
        if (!list.length) {
            if (row.machine_asked && !hosts.some((h) => h.machine_id === row.machine_asked)) return finish(row, 'unplaceable', 'that machine is not open to your agent (or it runs no browser desks)', { release: false });
            return row;
        }
        const desk = store.deskOf(row.id);
        for (const h of list) {
            await store.update(db, row.id, { state: 'starting', machine: h.machine_id, desk, trust: h.trust, offer_id: h.shared ? `desk:${h.machine_id}` : null, reasons: reasonsOf(row, h), updated_at: now() });
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
        create, act, finish, tick, SessionError,
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
