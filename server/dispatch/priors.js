'use strict';

/**
 * Bench priors for Run's placement (agent plan A1): Bench's quality per model on the kind of step, cached for an
 * hour. A job's runtime class maps to a Bench kind when one exists (code → codes.patch), and an offer names its model
 * in detail.model; an offer with no model (a paired Node) simply has no prior and place() uses its 0.7 default.
 *
 * The board is public; a Bench that does not answer leaves the map empty rather than delaying the tick for long.
 */
const { createClient } = require('openvibe-sdk/core');
const { createBenchClient } = require('openvibe-sdk/bench');

const TTL_MS = 60 * 60_000;
const BENCH_KIND = { code: 'codes.patch', review: 'codes.review' };

function createPriors({ config = {}, fetchImpl = globalThis.fetch, now = Date.now, log = console, ttlMs = TTL_MS } = {}) {
    const bench = config.bench || {};
    const enabled = bench.priors !== false && !!bench.url;
    const client = enabled
        ? createBenchClient(createClient({ baseUrls: { bench: bench.url }, autoDiscover: false, fetch: fetchImpl, timeoutMs: 4000, retries: 0 }), { baseUrl: bench.url })
        : null;
    const cache = new Map();

    async function scoresOf(kind) {
        const hit = cache.get(kind);
        if (hit && now() - hit.at < ttlMs) return hit.scores;
        let scores = {};
        try {
            const { board } = await client.boards.get(kind, { type: 'pareto' });
            for (const row of (board && Array.isArray(board.rows) ? board.rows : [])) {
                const q = Number(row && row.quality);
                if (row && typeof row.subject === 'string' && Number.isFinite(q)) scores[row.subject] = Math.max(0, Math.min(1, q));
            }
        } catch (e) {
            log.warn(`[Run] Bench priors for ${kind} unavailable: ${String((e && e.message) || e).slice(0, 160)}`);
        }
        cache.set(kind, { at: now(), scores });
        return scores;
    }

    async function forStep(runtimeClass) {
        if (!enabled) return {};
        const kind = BENCH_KIND[runtimeClass];
        return kind ? await scoresOf(kind) : {};
    }

    return { enabled, forStep, BENCH_KIND };
}

module.exports = { createPriors, BENCH_KIND, TTL_MS };
