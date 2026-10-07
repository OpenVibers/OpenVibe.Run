'use strict';

/**
 * The job stream's fan-out (run.job-stream-event@1; plan T14 R1). One ring buffer per open job plus the
 * subscribers on it:
 *
 *   state(jobId, state)   the job moved to a state; an end state is followed by one `end` event
 *   output(jobId, chunk)  a chunk of the job's stdout (platform.job-frame@1 job_stdout, step 6) — best
 *                         effort: a chunk lost on the node's link is never resent
 *   seed(row)             a stream opened on a job this process holds no ring for: one `state` event from
 *                         the row (and `end` when the job already ended), so a reconnect or a restart
 *                         never re-runs anything and still says where the job is
 *
 * The sequence is the job's own, from 1, monotonic, and it is the SSE `id`: a reconnect with Last-Event-ID
 * resumes after it. At most the last RUN_STREAM_RING_BYTES (1 MiB, the contract's replay window) is kept;
 * an event that fell out of the ring is simply not replayed (output is never resent anyway).
 *
 * A ring is memory, so it is reclaimed: `prune()` drops every ring that has no subscriber and either ended
 * or has been idle for IDLE_MS. Nothing is lost by dropping one — `seed(row)` rebuilds it from the job's own
 * row, so a stream opened later replays the state the job is in (and its `end`, when it ended). It also means
 * a seq is this process's (a restart or a second worker starts the job's stream counter again): a client
 * that resumes with an id from another process's ring gets the current state rather than a gap, and output
 * is best effort anyway. The dispatcher bridge (plan T14 step 6) is what would make replay durable.
 *
 * Nothing here touches the database or the network: the API and the dispatcher bridge are its only callers.
 */
const JOB_EVENT_TYPES = ['output', 'state', 'end'];
/** A ring with no subscriber and no traffic for this long is dropped (a reconnect re-seeds from the row). */
const IDLE_MS = 10 * 60 * 1000;

function createJobStream({ config, now = () => Date.now(), log = console }) {
    const ringBytes = config.stream.ringBytes;
    const maxPerJob = config.stream.maxPerJob;
    const jobs = new Map();   // jobId → { seq, events: [], bytes, ended, state, touched, subscribers: Set }

    function ringOf(jobId) {
        let ring = jobs.get(jobId);
        if (!ring) { ring = { seq: 0, events: [], bytes: 0, ended: false, state: null, touched: now(), subscribers: new Set() }; jobs.set(jobId, ring); }
        return ring;
    }

    /** Drop what nothing is watching: an ended ring, or one that has said nothing for IDLE_MS. */
    function prune() {
        const t = now();
        for (const [jobId, ring] of jobs) {
            if (ring.subscribers.size) continue;
            if (ring.ended || t - ring.touched > IDLE_MS) jobs.delete(jobId);
        }
    }

    /** Append one event to a job's ring and hand it to every subscriber. → the event, or null when the job already ended. */
    function emit(jobId, event, at = now()) {
        if (!JOB_EVENT_TYPES.includes(event.type)) throw new Error(`run.job-stream-event@1: ${event.type} is not an event type`);
        const ring = ringOf(jobId);
        if (ring.ended) return null;                       // an end state is final: nothing follows it
        const out = { ...event, job_id: jobId, seq: ++ring.seq, at: new Date(at).toISOString() };
        const size = JSON.stringify(out).length + 1;
        ring.events.push(out);
        ring.bytes += size;
        while (ring.bytes > ringBytes && ring.events.length > 1) ring.bytes -= JSON.stringify(ring.events.shift()).length + 1;
        if (out.type === 'state') ring.state = out.state;
        if (out.type === 'end') ring.ended = true;
        ring.touched = now();
        for (const sub of ring.subscribers) { try { sub(out); } catch (e) { log.warn(`[Run] stream subscriber failed: ${e && e.message}`); } }
        // The ring stays where it is: a subscriber may be replaying it, and a stream opened right after this
        // (a ticket minted while the job ended) must find it. prune() reclaims it once nothing watches it.
        return out;
    }

    /** The job moved to `state`; an end state also closes the stream with `end`. → the events appended. */
    function state(jobId, state, at = now()) {
        const first = emit(jobId, { type: 'state', state }, at);
        if (!first) return [];
        if (state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired') return [first, emit(jobId, { type: 'end', state }, at)].filter(Boolean);
        return [first];
    }

    const output = (jobId, chunk, at) => emit(jobId, { type: 'output', chunk: String(chunk).slice(0, 65536) }, at);

    /**
     * A stream opened on a job this process holds no ring for (a restart, another process created the job,
     * or the ring was pruned): one `state` event from the row, and the closing `end` when the job already
     * ended. A ring that has anything to say is left alone, so seeding never rewinds a live stream's seq.
     */
    function seed(row) {
        prune();
        const ring = ringOf(row.id);
        if (ring.events.length || ring.seq || ring.subscribers.size) return ring;
        state(row.id, row.state, Number(row.updated_at || row.created_at || now()));
        return ringOf(row.id);
    }

    /**
     * Replay what is kept from after lastEventId, then follow. → { ended, unsubscribe }. `ended` is true
     * when the job's stream already closed: the caller writes the replay and ends the response.
     */
    function subscribe(jobId, { lastEventId = 0, onEvent }) {
        // The ring is taken before anything is pruned: the ring we are about to replay (an ended job's, kept
        // for exactly this) must not be reclaimed under us. The prune below runs with the subscriber in
        // place, so nothing that is being followed can be dropped.
        const ring = ringOf(jobId);
        ring.touched = now();
        const sub = (e) => { try { onEvent(e); } catch (err) { log.warn(`[Run] stream subscriber failed: ${err && err.message}`); } };
        for (const e of ring.events) if (e.seq > lastEventId) sub(e);
        // An ended job: the replay above was the whole answer (the caller closes the response).
        if (ring.ended) return { ended: true, unsubscribe() {} };
        ring.subscribers.add(sub);
        prune();
        return { ended: false, unsubscribe: () => { ring.subscribers.delete(sub); ring.touched = now(); } };
    }

    const canAttach = (jobId) => ringOf(jobId).subscribers.size < maxPerJob;
    const status = () => ({ jobs: jobs.size, streams: [...jobs.values()].reduce((n, r) => n + r.subscribers.size, 0), events: [...jobs.values()].reduce((n, r) => n + r.events.length, 0) });

    /** Shutdown: every ring goes, so a stream in flight ends and its client reconnects (with a fresh ticket). */
    function close() {
        for (const [jobId, ring] of jobs) {
            ring.ended = true;
            ring.subscribers.clear();
            jobs.delete(jobId);
        }
    }

    return { state, output, seed, subscribe, canAttach, status, close, emit, prune, maxPerJob, ringOf };
}

module.exports = { createJobStream, JOB_EVENT_TYPES };
