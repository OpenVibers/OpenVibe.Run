'use strict';

/**
 * The managed-browser provider adapter — Run → an external managed-browser provider's job API (plan T14 R4a,
 * ADR-034; Run's own outbound capability browser_provider.job.dispatch, contracts/manifests/capabilities). A
 * class `browser` job placed on a kind=provider offer named `browser-provider` goes here instead of Bot: the
 * provider is not a paired Node, so there is no Bot in between and Run meters the job itself.
 *
 *   send({ job })   POST {url}/jobs              browser-provider.job-create-request@1 → job-create-result@1
 *   state(jobId)    GET  {url}/jobs/{id}         → browser-provider.job-state@1 | null
 *   cancel(jobId)   POST {url}/jobs/{id}/cancel  → browser-provider.job-state@1 | null
 *   meter({ jobId, claimedMs, observedMs })      → the wall clock Run bills: the provider's claim, clamped
 *
 * The request is built from the platform.job@1 frame alone (id, class, args, inputs, limits, egress) and
 * validated before it is sent: it never carries the project, the subject, the requester or any credential, so
 * the provider never learns who pays. The job id is the Idempotency-Key, so a resend after a crash answers
 * the first job (200, created false) and never starts a second.
 *
 * The key: RUN_BROWSER_PROVIDER_API_KEY from Run's own environment, sent as `Authorization: Bearer <key>` and
 * nowhere else — never read from an offer (platform.resource-offer@1 has no field for it), never logged,
 * never in an error, never in status(). Provider text that ends up in an error is scrubbed of it, and a
 * redirect is refused rather than followed with the header. Outside development the URL must be https (or
 * loopback), else the adapter stays off.
 *
 * Nothing the provider answers is adopted unchecked: every 2xx body is validated against its contract, its
 * `id` must be the job's, a result over 256 KiB is refused, and a body over MAX_BODY is not read. Such an
 * answer is a DispatchError with retryable false (code run.dispatch.malformed): the poller treats it like a
 * Bot answer botRowOf() refuses — the job stays as Run last saw it. A 404 on state or cancel is null (the
 * provider does not know the job); a 5xx, a 401/403/408/429, a timeout or a transport failure is retryable
 * (the next tick tries again); any other 4xx is a refusal (the job cannot run as asked).
 *
 * meter(): the provider's wall_ms is a claim (browser-provider.job-state@1). Run bills at most its own
 * observed duration plus 5 s (decision B of plan T14 R4a): a larger claim is clamped and logged, never
 * billed above the cap.
 */
const contracts = require('openvibe-contracts');
const { DispatchError } = require('./bot');

/** The offer `provider` name that routes a job to this adapter (the job row stores it as its provider). */
const PROVIDER = 'browser-provider';
/** Run's own outbound capability (planned in Contracts; no token grants it). */
const CAPABILITY = 'browser_provider.job.dispatch';
const REQUEST = 'browser-provider.job-create-request@1';
const RESULT = 'browser-provider.job-create-result@1';
const STATE = 'browser-provider.job-state@1';
/** What Run bills above its own observed duration at most. */
const METER_SLACK_MS = 5000;
/** The largest answer read: 1 MiB of stdout (up to 4 bytes a character) and a 256 KiB result, with room. */
const MAX_BODY = 6 * 1024 * 1024;
const MAX_RESULT = 256 * 1024;
/** Answers that say nothing about the job: a key, a grant or a rate the operator fixes. Retried. */
const RETRY_4XX = new Set([401, 403, 408, 429]);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The URL Run may send its key to: https, or loopback in any environment, or anything in development. */
function urlProblem(url, isProduction) {
    let u;
    try { u = new URL(url); } catch { return 'RUN_BROWSER_PROVIDER_URL is not a URL'; }
    if (u.username || u.password) return 'RUN_BROWSER_PROVIDER_URL carries credentials (the key belongs in RUN_BROWSER_PROVIDER_API_KEY)';
    if (u.protocol === 'https:' || LOOPBACK.has(u.hostname) || (!isProduction && u.protocol === 'http:')) return null;
    return 'RUN_BROWSER_PROVIDER_URL must be https (the key travels in a header)';
}

/** A body read with a ceiling, so a provider cannot make Run buffer without bound. → parsed JSON or undefined. */
async function readJson(res) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text().catch(() => '');
        if (Buffer.byteLength(text) > MAX_BODY) return undefined;
        try { return text ? JSON.parse(text) : null; } catch { return undefined; }
    }
    const reader = res.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { await reader.cancel().catch(() => {}); return undefined; }
        parts.push(value);
    }
    const text = Buffer.concat(parts).toString('utf8');
    try { return text ? JSON.parse(text) : null; } catch { return undefined; }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * createBrowserProviderAdapter({ config, fetchImpl, now, log }) → { enabled, note, send, state, cancel, meter,
 * status }. enabled is false without RUN_BROWSER_PROVIDER_URL or RUN_BROWSER_PROVIDER_API_KEY.
 */
function createBrowserProviderAdapter({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const { url, apiKey, timeoutMs } = (config && config.browserProvider) || {};
    const problem = url ? urlProblem(url, Boolean(config && config.isProduction)) : null;
    const enabled = Boolean(url && apiKey && !problem);
    // Where the jobs go, for status and logs: the origin only (a path or query is the provider's business).
    const origin = (() => { try { return new URL(url).origin; } catch { return null; } })();
    const note = enabled
        ? `the managed-browser provider: ${origin}, capability ${CAPABILITY}`
        : !url ? 'the managed-browser provider is off: RUN_BROWSER_PROVIDER_URL is unset'
            : !apiKey ? 'the managed-browser provider is off: RUN_BROWSER_PROVIDER_API_KEY is unset'
                : `the managed-browser provider is off: ${problem}`;
    const stat = { sent: 0, refused: 0, malformed: 0, clamped: 0 };

    /** Provider text is never trusted to be free of what Run sent it. */
    const scrub = (s) => (apiKey ? String(s).split(apiKey).join('[redacted]') : String(s));
    const malformed = (why) => {
        stat.malformed++;
        return new DispatchError(502, 'run.dispatch.malformed', scrub(`the browser provider's answer was not adopted: ${why}`).slice(0, 500));
    };

    /** One call → the parsed 2xx body ({ status, doc }), null for a 404, or a DispatchError. */
    async function call(method, path, { body, idempotencyKey } = {}) {
        if (!enabled) throw new DispatchError(503, 'run.dispatch.disabled', note, { retryable: true });
        const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        let res;
        try {
            res = await fetchImpl(`${url}${path}`, {
                method, headers, redirect: 'error',
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
            throw new DispatchError(503, 'run.dispatch.unavailable', `the browser provider did not answer (${why})`, { retryable: true });
        }
        if (res.status === 404) { await res.body?.cancel?.().catch(() => {}); return null; }
        const doc = await readJson(res);
        if (res.ok) {
            if (doc === undefined) throw malformed('the body is not JSON, or larger than Run reads');
            return { status: res.status, doc };
        }
        const problemDoc = obj(doc) || {};
        const code = typeof problemDoc.code === 'string' ? problemDoc.code.slice(0, 64) : null;
        const detail = typeof problemDoc.detail === 'string' ? problemDoc.detail.slice(0, 300) : null;
        const why = scrub(`the browser provider answered HTTP ${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);
        if (res.status >= 500 || RETRY_4XX.has(res.status)) throw new DispatchError(503, 'run.dispatch.unavailable', why, { retryable: true });
        stat.refused++;
        throw new DispatchError(502, 'run.dispatch.refused', why, { retryable: false });
    }

    /** A job-state the provider answered, checked: the contract, the job's own id, the result's size. */
    function stateOf(jobId, doc) {
        const v = contracts.validate(STATE, doc);
        if (!v.valid) throw malformed(`not a valid ${STATE}`);
        if (doc.id !== jobId) throw malformed(`it names job ${String(doc.id).slice(0, 40)}, not ${jobId}`);
        if (doc.result != null && Buffer.byteLength(JSON.stringify(doc.result)) > MAX_RESULT) throw malformed('its result is over 256 KiB');
        return doc;
    }

    /** The provider's request, from the platform.job@1 frame's own keys only. */
    function requestOf(job) {
        const limits = obj(job.limits) || {};
        const out = {
            id: job.id,
            class: job.class,
            args: obj(job.args) || {},
            inputs: Array.isArray(job.inputs) ? job.inputs : [],
            limits: {
                wall_ms: limits.wall_ms,
                ...(limits.cpu_ms != null ? { cpu_ms: limits.cpu_ms } : {}),
                ...(limits.mem_bytes != null ? { mem_bytes: limits.mem_bytes } : {}),
            },
            // platform.job@1 spells "no network" deny as well as none; the provider's contract only knows none.
            egress: !job.net || job.net === 'deny' ? 'none' : job.net,
        };
        const v = contracts.validate(REQUEST, out);
        if (!v.valid) throw new DispatchError(422, 'run.dispatch.invalid_job', `the job is not a valid ${REQUEST}`);
        return out;
    }

    return {
        enabled,
        note,
        provider: PROVIDER,
        /** Hand one job to the provider. → { job: job-state@1, created }. Idempotent by job id at the provider. */
        async send({ job }) {
            const body = requestOf(obj(job) || {});
            const out = await call('POST', '/jobs', { body, idempotencyKey: body.id });
            if (!out) throw new DispatchError(502, 'run.dispatch.refused', 'the browser provider answered 404 to the job POST (is RUN_BROWSER_PROVIDER_URL its API base?)');
            if (!contracts.validate(RESULT, out.doc).valid) throw malformed(`not a valid ${RESULT}`);
            const state = stateOf(body.id, out.doc.job);
            stat.sent++;
            return { job: state, created: out.doc.created === true };
        },
        /** The provider's state of a job; null when it does not know the job. */
        async state(jobId) {
            const out = await call('GET', `/jobs/${encodeURIComponent(jobId)}`);
            return out ? stateOf(jobId, out.doc) : null;
        },
        /** Ask the provider to stop a job; null when it does not know the job (nothing to stop). */
        async cancel(jobId) {
            const out = await call('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, { idempotencyKey: `${jobId}:cancel` });
            return out ? stateOf(jobId, out.doc) : null;
        },
        /**
         * The wall clock Run bills for a provider job: the provider's claim, never above Run's own observed
         * duration plus 5 s. → { wallMs, claimedMs, capMs, clamped }
         */
        meter({ jobId = null, claimedMs, observedMs }) {
            const claimed = Number.isInteger(claimedMs) && claimedMs > 0 ? claimedMs : 0;
            const capMs = Math.max(0, Math.floor(Number(observedMs) || 0)) + METER_SLACK_MS;
            const clamped = claimed > capMs;
            if (clamped) {
                stat.clamped++;
                log.warn(`[Run] job ${jobId || '?'}: the browser provider claims ${claimed} ms, Run observed ${capMs - METER_SLACK_MS} ms: billed ${capMs} ms (clamped to observed + ${METER_SLACK_MS} ms)`);
            }
            return { wallMs: clamped ? capMs : claimed, claimedMs: claimed, capMs, clamped };
        },
        status: () => ({
            enabled, note, provider: PROVIDER, capability: CAPABILITY, url: origin, timeout_ms: timeoutMs ?? null,
            key_set: Boolean(apiKey), ...stat,
        }),
    };
}

module.exports = { createBrowserProviderAdapter, PROVIDER, CAPABILITY, METER_SLACK_MS, MAX_RESULT };
