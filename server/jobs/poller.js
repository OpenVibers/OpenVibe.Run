'use strict';

/**
 * The job loop (plan T14 step 6, R1c; RUN_POLL_MS, default 1000). One tick does four things, and nothing
 * here runs at module load — server/index.js starts it (server/dispatch/index.js owns the instance):
 *
 *   sweep   a non-terminal job whose ttl_ms ran out reaches `expired` (run.job.ttl when a node may hold it,
 *           run.job.unplaceable when it never left `queued`), and Bot is asked to stop it
 *   place   a `queued` job is placed — the node comes from OpenVibe.Network's offers through
 *           openvibe-sdk/placement (server/dispatch/placement.js) — and sent to Bot once (server/dispatch/
 *           bot.js; Bot's dispatch is idempotent by job id, so a retry after a crash is safe). No eligible
 *           offer fails the job run.job.unplaceable; a class the chosen node does not advertise fails it
 *           run.job.worker_failed (Bot 409 bot.class_unadvertised)
 *   mirror  every `placed` or `running` job is mirrored from Bot: state, placement, timings, exit, result
 *           and the metered wall clock. A state that moves emits its run.job.* event once (the outbox row
 *           key run:<id>:<state> is what makes a replay one row) and updates the job's SSE stream
 *   cancel  a job whose cancel_requested marker is set gets one job_cancel to Bot (Bot repeats it on every
 *           reconnect until the job ends); the job reaches `cancelled` when Bot's answer says so
 *
 * What is deliberately not trusted: Bot's answer never names the node, the project or the job id Run keeps
 * (a mismatch is refused, not adopted), and a state Bot reports behind the one Run already holds is
 * ignored. A job Bot answers 404 for after Run sent it fails after RUN_DISPATCH_UNKNOWN_POLLS polls — it
 * is never mirrored forever.
 *
 * stdout: Bot holds the last 1 MiB of a job's output as `{ text, first_seq, last_seq, truncated }`, so each
 * tick streams only what Run has not streamed yet into the job's ring as `output` events with the ring's
 * own monotonic seq. Output is best effort by contract (a chunk lost with the node's link is never resent):
 * a ring Bot dropped past Run's cursor is a gap Run drops rather than a duplicate Run invents.
 */
const contracts = require('openvibe-contracts');
const { workerCapability } = require('../dispatch/placement');

/** Where a state sits in the job's life, so a Bot answer can never move a job backwards. */
const RANK = { queued: 0, placed: 1, running: 2, succeeded: 3, failed: 3, cancelled: 3, expired: 3 };
const END_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const STATES = ['queued', 'placed', 'running', 'succeeded', 'failed', 'cancelled', 'expired'];

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const cancelling = (row) => obj(row.job).cancel_requested === true;

/**
 * createPoller({ config, db, store, events, stream, bot, placement, now, log }) → { tick, sweep, placeOne,
 * cancelNow, start, stop, status }. Every dependency is injected; nothing here starts at module load.
 */
function createPoller({ config, db, store, events, stream, bot, placement, now = () => Date.now(), log = console } = {}) {
    const cancelSent = new Set();   // job ids whose job_cancel reached Bot in this process
    const unknown = new Map();      // job id → consecutive polls Bot answered 404 for
    const cursors = new Map();      // job id → how much of Bot's stdout ring Run has streamed
    const warned = new Map();       // job id → when its placement problem was last logged
    let noOfferWarnedAt = 0;
    // Jobs whose last placement attempt found no eligible offer (process memory: after a restart a waiting
    // job is simply re-tried; at its ttl it then ends with the plain ttl outcome).
    const noOffer = new Set();
    let offersWarnedAt = 0;
    const stat = { ticks: 0, swept: 0, placed: 0, sent: 0, mirrored: 0, cancels_sent: 0, failed: 0, expired: 0, errors: 0, last_tick_at: null, last_error: null };
    let timer = null;
    let busy = false;

    const note = (id, state, extra = {}) => ({ job_id: id, state, ...extra });

    /**
     * A placement problem repeats every tick for as long as it lasts (a Network or a Bot that is down with
     * queued jobs waiting), so it is logged once a minute per job rather than once a second per job. What is
     * skipped on the log is still in the answer's `reason` and in status().last_error.
     */
    function warnSlowly(row, at, message) {
        if (at - (warned.get(row.id) || 0) < 60_000) return;
        warned.set(row.id, at);
        log.warn(message);
    }

    /** Take one job to its end state with the run.job.* event of that state, in one transaction. */
    async function end(row, at, { state, exit = null, code = null, result = null, wallMs = null, errorCode = null, errorDetail = null }) {
        const settled = await db.tx(async (t) => {
            const s = await store.settle(t, row.id, { state, exit, code, result, wallMs, errorCode, errorDetail, at });
            // run.job.<state> exists if and only if the state change committed; a replay is the row already
            // there (event_id run:<job id>:<state>), so emitting again is one row, never a second event.
            if (s.changed) await events.ofState(t, s.row);
            return s;
        });
        if (settled.changed) {
            if (state === 'failed') stat.failed++;
            if (state === 'expired') stat.expired++;
            forget(row.id);
            stream.state(row.id, state, at);
        }
        return settled;
    }

    const fail = (row, at, errorCode, detail) => end(row, at, { state: 'failed', errorCode, errorDetail: detail ? String(detail).slice(0, 1024) : null })
        .then((s) => note(row.id, 'failed', { changed: s.changed, error: errorCode }));

    /** Time to forget everything this process held about a job: it has ended. */
    function forget(jobId) { cancelSent.delete(jobId); unknown.delete(jobId); cursors.delete(jobId); }

    /**
     * One job's stdout, appended to Run's stream ring. Bot's ring is a suffix of the job's chunks, so the
     * cursor remembers (the last chunk_seq streamed, how many characters of that ring's text they were, and
     * which first_seq that count belongs to); a slide that no longer lines up is re-anchored on the tail Run
     * last sent, and a gap Bot dropped is dropped here too — never streamed twice.
     */
    function stdoutOf(row, ring, at) {
        if (!ring || typeof ring.text !== 'string' || ring.last_seq == null) return;
        const cur = cursors.get(row.id) || { seq: 0, chars: 0, first: null, tail: '' };
        if (ring.last_seq <= cur.seq) return;
        let chunk;
        if (!cur.seq) chunk = ring.text;                                            // first look: all Bot holds
        else if (ring.first_seq === cur.first) chunk = ring.text.slice(cur.chars);  // the window did not move
        else if (ring.first_seq == null || ring.first_seq > cur.seq) chunk = ring.text;   // all of it is new
        else {
            const i = cur.tail ? ring.text.lastIndexOf(cur.tail) : -1;
            if (i < 0) {
                log.warn(`[Run] job ${row.id}: Bot dropped the stdout Run had not streamed yet; the gap is dropped`);
                chunk = '';
            } else chunk = ring.text.slice(i + cur.tail.length);
        }
        cursors.set(row.id, { seq: ring.last_seq, chars: ring.text.length, first: ring.first_seq ?? null, tail: ring.text.slice(-256) });
        if (chunk) stream.output(row.id, chunk, at);
    }

    /**
     * Bot's answer's job record, checked against Run's own row: the id, the class and (when Bot names one)
     * the project must be Run's. Anything else is refused — a job id is Run's, and Bot never names the
     * project a job is billed to. → the record, or null.
     */
    function botRowOf(row, raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (raw.id !== row.id) return null;
        if (typeof raw.class === 'string' && raw.class !== row.class) return null;
        if (raw.project_id != null && raw.project_id !== row.project_id) return null;
        if (!STATES.includes(raw.state)) return null;
        return raw;
    }

    /** The node Bot reports must be the node Run placed on; a different one is refused, never adopted. */
    function nodeAgrees(row, raw) {
        if (raw.node_id == null || row.node_id == null || raw.node_id === row.node_id) return true;
        log.error(`[Run] job ${row.id}: Bot reports node ${raw.node_id}, Run placed it on ${row.node_id}: the answer is refused`);
        return false;
    }

    // ── The three steps a tick takes ───────────────────────────────────────────

    /**
     * TTL: a job whose lifetime ran out ends `expired` (exit reason ttl → run.job.ttl; a job that never ran
     * carries code null, which exit allows), and a node that may hold it is told to stop.
     */
    async function expireOne(row, at) {
        if (row.node_id) {
            try { await bot.cancel(row.id); } catch (e) { log.warn(`[Run] job ${row.id}: job_cancel did not reach Bot (${e.code || e.message})`); }
        }
        // A job no node ever took ends with run.job.unplaceable (ADR-036 section 2): it waited for an offer of
        // worker:<class> until its ttl. A placed job that ran out carries no error code (exit reason ttl).
        // Only a job whose last placement attempt found no eligible offer is unplaceable; one that simply ran out
        // of time (Bot or Network unreachable, a very short ttl) keeps the plain ttl outcome.
        const settled = row.node_id
            ? await end(row, at, { state: 'expired', exit: 'ttl', errorDetail: `ttl_ms ran out with the job placed on ${row.node_id}` })
            : noOffer.has(row.id)
                ? await end(row, at, { state: 'expired', exit: 'ttl', errorCode: 'run.job.unplaceable', errorDetail: `ttl_ms ran out before any node offering ${workerCapability(row.class)} took the job` })
                : await end(row, at, { state: 'expired', exit: 'ttl', errorDetail: 'ttl_ms ran out before a node was placed' });
        noOffer.delete(row.id);
        return note(row.id, 'expired', { changed: settled.changed });
    }

    /** Placement: a queued job is placed on a node advertising worker:<class> and sent to Bot once. */
    async function placeOne(row, at) {
        let chosen;
        try { chosen = await placement.choose(row); }
        catch (e) {
            // Network unreachable: nothing is decided, the job stays queued and the next tick tries again.
            // The message is the same for every queued job (the read is one call per tick), so it is logged
            // slowly rather than once per job per second.
            if (at - offersWarnedAt >= 60_000) { offersWarnedAt = at; log.warn(`[Run] placement could not read the offers (${e.code || e.message})`); }
            stat.last_error = e.message;
            return note(row.id, 'queued', { reason: e.code || 'no_offers' });
        }
        if (!chosen) {
            // No eligible offer right now: the job waits for capacity (a node may be briefly offline) and every
            // tick tries again; the ttl sweep ends it `expired` with run.job.unplaceable when ttl_ms runs out
            // first (ADR-036 section 2), so a waiting job never fails on a transient absence.
            if (at - noOfferWarnedAt >= 60_000) { noOfferWarnedAt = at; log.warn(`[Run] no node offers ${workerCapability(row.class)} yet; queued jobs wait until their ttl`); }
            noOffer.add(row.id);
            return note(row.id, 'queued', { reason: 'unplaceable' });
        }
        let frame;
        try {
            frame = store.frameOf(row.job);
            contracts.assertValid('platform.job@1', frame);
        } catch (e) {
            return fail(row, at, 'run.job.worker_failed', `Run's own job record is not a valid platform.job@1: ${e.message}`);
        }
        let sent;
        try {
            sent = await bot.send({ nodeId: chosen.node_id, job: frame, project: row.project_id, subject: row.requester, provider: chosen.provider });
        } catch (e) {
            if (e.code === 'bot.job_id_reused') return adopt(row, at, e);
            if (e.retryable) {
                stat.last_error = e.message;
                warnSlowly(row, at, `[Run] job ${row.id}: Bot did not take the job (${e.code || e.message}); the next poll tries again`);
                return note(row.id, 'queued', { reason: e.code || 'unavailable' });
            }
            // Bot refused the frame itself (a class the node does not advertise, an unknown device, a body
            // it will not accept): the job cannot run as asked and fails rather than waiting forever.
            return fail(row, at, 'run.job.worker_failed', `${e.code || 'bot refused the job'}: ${e.detail || ''}`.trim());
        }
        // Run's own record of where the job went: Bot's answer is not where the placement comes from. The row
        // is re-read inside the transaction, because a cancel (or the ttl sweep) may have landed while the
        // frame was in flight: an end state never changes, so such a job is not placed — and Bot, which just
        // took the frame, is told to stop it rather than left running work its payer cancelled.
        const placed = await db.tx(async (t) => {
            const fresh = await store.get(t, row.id);
            if (!fresh || fresh.state !== 'queued') return null;
            return store.mirror(t, row.id, { state: 'placed', node_id: chosen.node_id, provider: chosen.provider, region: chosen.region }, at);
        });
        if (!placed) {
            let stopped = false;
            try { stopped = (await bot.cancel(row.id)) !== undefined; } catch { stopped = false; }
            log.warn(`[Run] job ${row.id}: it left queued while Run was sending it to ${chosen.node_id}; ${stopped ? 'Bot was asked to stop it' : 'Bot could NOT be asked to stop it'}`);
            // No node_id in the answer: the job is not placed (its end state was reached first) even though
            // Bot briefly held the frame.
            return note(row.id, 'cancelled', { raced: true, stopped, node: chosen.node_id });
        }
        stat.placed++;
        if (sent.sent) stat.sent++;
        stream.state(row.id, 'placed', at);
        return note(row.id, 'placed', { node_id: chosen.node_id, sent: sent.sent });
    }

    /**
     * Bot already holds this job id on a node Run has no record of (Run crashed between the send and its own
     * mirror, or another Run process placed it). Run's row has no placement, so Bot's own is adopted rather
     * than the job being killed and its work orphaned; a record that names no usable node fails the job.
     */
    async function adopt(row, at, err) {
        let answer = null;
        try { answer = await bot.state(row.id); } catch { /* the failure below names the conflict */ }
        const b = answer && botRowOf(row, answer.job);
        const nodeId = b && typeof b.node_id === 'string' ? b.node_id : null;
        if (!nodeId || nodeId.length > 128) return fail(row, at, 'run.job.worker_failed', `Bot already holds this job id (${err.detail})`);
        const updated = await db.tx((t) => store.mirror(t, row.id, {
            state: null, node_id: nodeId, provider: b.provider ?? null, region: b.region ?? null,
            started_ms: b.started_ms ?? null, wall_ms: b.wall_ms ?? null, usage_read: b.usage_read ?? null,
        }, at));
        log.warn(`[Run] job ${row.id}: Bot already held it on ${nodeId} (${err.detail}); Run adopted Bot's placement instead of failing the job`);
        return note(row.id, updated.state, { node_id: nodeId, adopted: true });
    }

    /** Bot has no such job (404). Run sent it, so it is counted and the job fails after a bounded number. */
    async function unknownJob(row, at) {
        const n = (unknown.get(row.id) || 0) + 1;
        unknown.set(row.id, n);
        if (n < config.dispatch.unknownPolls) return note(row.id, row.state, { bot_404: n });
        return fail(row, at, 'run.job.worker_failed', `Bot has no job ${row.id} (it was sent to ${row.node_id || 'no node'}): giving up after ${n} polls`);
    }

    /** Mirror: what Bot answers about a job Run placed. */
    async function mirrorOne(row, at) {
        let answer;
        try { answer = await bot.state(row.id); }
        catch (e) {
            stat.last_error = e.message;
            if (!e.retryable) warnSlowly(row, at, `[Run] job ${row.id}: Bot's state was refused (${e.code || e.message})`);
            return note(row.id, row.state, { reason: e.code || 'unavailable' });
        }
        if (!answer) return unknownJob(row, at);
        unknown.delete(row.id);
        const b = botRowOf(row, answer.job);
        if (!b || !nodeAgrees(row, b)) return note(row.id, row.state, { refused: true });

        // A state Bot reports behind the one Run holds is not a change (Bot's row is behind, e.g. Run placed
        // the job before the device acked it): the meter is mirrored, the state is not.
        const moved = RANK[b.state] > RANK[row.state] ? b.state : null;

        if (moved && END_STATES.has(moved)) {
            // The last output is streamed before the job's end: `end` closes the ring, so anything after it
            // would never reach a subscriber.
            stdoutOf(row, answer.stdout, at);
            const settled = await db.tx(async (t) => {
                // Placement, timings and the meter first, then the end state with its event; the error code is
                // derived from the job_exit reason (store.settle: limit, stopped, ttl, exit_nonzero, …).
                await store.mirror(t, row.id, {
                    state: null, node_id: row.node_id, provider: null, region: null,
                    started_ms: b.started_ms ?? null, wall_ms: b.wall_ms ?? null, usage_read: b.usage_read ?? null,
                }, at);
                const s = await store.settle(t, row.id, {
                    state: moved, exit: b.exit_reason ?? null, code: b.exit_code ?? null,
                    result: b.result ?? null, wallMs: b.wall_ms ?? null,
                    errorDetail: b.fault_code ? `bot:${String(b.fault_code).slice(0, 64)}` : null, at,
                });
                if (s.changed) await events.ofState(t, s.row);
                return s;
            });
            if (settled.changed) {
                stat.mirrored++;
                if (moved === 'failed') stat.failed++;
                forget(row.id);
                stream.state(row.id, moved, at);
            }
            return note(row.id, moved, { changed: settled.changed, exit: b.exit_reason ?? null });
        }

        const updated = await db.tx(async (t) => {
            const r = await store.mirror(t, row.id, {
                state: moved, node_id: row.node_id, provider: null, region: null,
                started_ms: b.started_ms ?? null, wall_ms: b.wall_ms ?? null, usage_read: b.usage_read ?? null,
            }, at);
            // store.mirror refuses a state the row cannot back (running without a started_ms), so the event
            // follows the row, never Bot's word: an event whose payload contradicts the row is unpublishable.
            if (moved === 'running' && r.state === 'running') await events.started(t, r);
            return r;
        });
        if (updated.state !== row.state) {
            stat.mirrored++;
            stream.state(row.id, updated.state, at);
        }
        // The job's output follows its state in the stream: running, then what it printed.
        stdoutOf(row, answer.stdout, at);
        // A cancel Run recorded but has not delivered yet: Bot gets it once per job and repeats it on every
        // reconnect until the job ends (bot.job.dispatch), so one call is enough.
        if (cancelling(row) && !cancelSent.has(row.id)) {
            try {
                const out = await bot.cancel(row.id);
                cancelSent.add(row.id);
                stat.cancels_sent++;
                if (out === null) log.warn(`[Run] job ${row.id}: Bot has no such job to cancel`);
            } catch (e) {
                stat.last_error = e.message;
                log.warn(`[Run] job ${row.id}: job_cancel did not reach Bot (${e.code || e.message})`);
            }
        }
        return note(row.id, updated.state, { moved, sent: b.sent_at ? true : undefined });
    }

    /** The cancel route's own call (POST /jobs/:id/cancel): the same once-per-job job_cancel the tick sends. */
    async function cancelNow(row) {
        if (!bot.enabled || !row || !row.id) return { cancelled: false, reason: 'dispatch.disabled' };
        if (cancelSent.has(row.id)) return { cancelled: true, reason: 'already_sent' };
        try {
            await bot.cancel(row.id);
            cancelSent.add(row.id);
            stat.cancels_sent++;
            return { cancelled: true, reason: 'sent' };
        } catch (e) {
            stat.last_error = e.message;
            // The marker stays on the row, so the next tick retries; the caller answers what it knows.
            return { cancelled: false, reason: e.code || 'unavailable' };
        }
    }

    /** One step of the loop, per job: one job's failure never stops the tick. */
    async function one(row, fn) {
        try { return await fn(); }
        catch (e) {
            stat.errors++;
            stat.last_error = `${e.code || e.name}: ${e.message}`;
            log.warn(`[Run] job ${row.id}: ${e.message}`);
            return null;
        }
    }

    /** The ttl sweep alone (the runner calls it inside tick(); exported for the dispatcher's seam). */
    async function sweep() {
        const at = now();
        const out = [];
        for (const row of await store.dueTtl(db, at)) {
            stat.swept++;
            out.push(await one(row, () => expireOne(row, at)));
        }
        return out.filter(Boolean);
    }

    /** One poll: the sweep, then placement, then the mirror. Never two ticks at once. */
    async function tick() {
        if (!bot.enabled || busy) return [];
        busy = true;
        const answers = [];
        try {
            stat.ticks++;
            answers.push(...await sweep());
            const at = now();
            const waitingRows = await store.waiting(db, config.dispatch.maxPerTick);
            for (const row of waitingRows) answers.push(await one(row, () => placeOne(row, at)));
            const activeRows = await store.active(db, config.dispatch.maxPerTick);
            const stillCancelling = new Set();
            for (const row of activeRows) {
                if (cancelling(row)) stillCancelling.add(row.id);
                answers.push(await one(row, () => mirrorOne(row, at)));
            }
            // What this process remembers is only about the jobs in flight: a job that ended (or left both
            // sets) is forgotten here, so the maps stay bounded by the work that is actually open.
            const live = new Set([...waitingRows, ...activeRows].map((r) => r.id));
            for (const id of [...cancelSent]) if (!stillCancelling.has(id)) cancelSent.delete(id);
            for (const key of [...unknown.keys()]) if (!live.has(key)) unknown.delete(key);
            for (const key of [...cursors.keys()]) if (!live.has(key)) cursors.delete(key);
            for (const key of [...warned.keys()]) if (!live.has(key)) warned.delete(key);
        } catch (e) {
            stat.errors++;
            stat.last_error = e.message;
            log.warn(`[Run] poller: ${e.message}`);
        } finally {
            busy = false;
            stat.last_tick_at = now();
        }
        stream.prune();
        return answers.filter(Boolean);
    }

    function start() {
        if (timer || !bot.enabled) return status();
        // Nothing runs at module load: server/index.js starts this, and stop() clears it.
        timer = setInterval(() => { tick().catch((e) => log.warn(`[Run] poller: ${e.message}`)); }, config.dispatch.pollMs);
        timer.unref?.();
        return status();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    function status() {
        return {
            running: Boolean(timer), interval_ms: config.dispatch.pollMs, ...stat,
            cancel_pending: cancelSent.size, unknown_jobs: unknown.size, stdout_cursors: cursors.size,
        };
    }

    return { tick, sweep, placeOne, cancelNow, start, stop, status };
}

module.exports = { createPoller, RANK, STATES };
