'use strict';

/** Small shared pieces: time, the error type, input checks, the keyset cursor. */
const { ids } = require('openvibe-contracts');

class RunError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
}

function fail(status, code, detail, extra) { throw new RunError(status, code, detail, extra); }

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const isJobId = (v) => typeof v === 'string' && /^job_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

/** A database refusal the caller caused (a value PostgreSQL cannot store) → the RunError to answer with, else null. */
function inputError(e) {
    const code = e && (e.code || (e.cause && e.cause.code));
    return ['22021', '22P05', '22P02', '22007', '22008'].includes(code)
        ? new RunError(422, 'run.invalid_input', 'the request carries a value that cannot be stored (such as a NUL character)') : null;
}

/**
 * The keyset cursor of run_jobs (created_at, id), newest first: base64url JSON [created_at, id] → the pair,
 * or 422 run.invalid_input. `cursorOf(row)` makes one; a page's next_cursor is the last row of the page.
 */
function readCursor(cursor) {
    let cur = null;
    try { cur = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* refused below */ }
    if (!Array.isArray(cur) || !Number.isInteger(cur[0]) || typeof cur[1] !== 'string' || !isJobId(cur[1])) {
        fail(422, 'run.invalid_input', 'bad cursor');
    }
    return { at: cur[0], id: cur[1] };
}
const cursorOf = (row) => Buffer.from(JSON.stringify([Number(row.created_at), row.id])).toString('base64url');

/**
 * The platform.workload-requirements@1 default the contract names for an absent requirements
 * (run.job-create-request@1: "absent means { kind: run.<class>, mobility: job, latency_class: background,
 * objective: balanced }"); it is validated against the contract wherever it is filled in.
 */
const requirementsDefault = (runtimeClass) => ({ kind: `run.${runtimeClass}`, mobility: 'job', latency_class: 'background', objective: 'balanced' });

module.exports = { RunError, fail, iso, isJobId, inputError, readCursor, cursorOf, requirementsDefault, newJobId: () => ids.newId('job') };
