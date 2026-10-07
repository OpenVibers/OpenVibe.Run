'use strict';

/**
 * Placement — which node runs a job (plan T14 step 7, R3): Run states the job's
 * platform.workload-requirements@1 and reads Fabric offers; openvibe-sdk/placement's plan() does the
 * choosing (ADR-036: "Run writes no placer of its own. A service states requirements and reads results; it
 * does not rank offers.").
 *
 *   choose(row) → { node_id, provider, region, offer_id, trust, reasons } | null
 *
 * The candidate offers come from OpenVibe.Network's public resource registry
 * (GET {OV_NETWORK_URL}/api/v1/offers?kind=node), where a paired Node's runtime classes are published as
 * platform.resource-offer@1 with the reserved `worker:<class>` capability (ADR-036 §3: "device node_id →
 * resource-offer.node_id"), so an offer's node_id is the device Bot dispatches to. The public projection
 * leaves `capacity` out (Network redacts it), so the `worker:<class>` free-slot check inside plan() cannot
 * fire here; Run holds no network.resource.report grant and must not invent one — see For Opus in the PR.
 *
 * The trust policy is the job's own: plan() filters on requirements.trust, kind, latency_class, objective,
 * residency and resources, and Run only adds the job's `worker:<class>` capability (a candidate must
 * advertise the class the job runs). One rule Run applies before the placer sees anything, because the
 * released contract states it and the SDK's current default does not: **user-owned is never a default**
 * (platform.workload-requirements@1: "when absent, first-party, partner, community and external"). plan()
 * falls back to its TRUST_ORDER, which lists user-owned, so a job that names no trust would otherwise be
 * placed on a stranger's personal Node; Run drops user-owned offers unless the requirements name
 * user-owned (see For Opus: the SDK's TRUST_ORDER and the contract disagree).
 *
 * Every offer is validated against platform.resource-offer@1 before it reaches plan(); the offers answer is
 * cached for RUN_OFFERS_TTL_MS, so one tick places many jobs off one read. A Network that does not answer
 * throws PlacementError(retryable) — the poller tries again next tick and never fails a job for it. An
 * answer with no eligible candidate is null, which the poller settles run.job.unplaceable.
 */
const contracts = require('openvibe-contracts');
const { plan } = require('openvibe-sdk/placement');
const { requirementsDefault } = require('../util');

/** The reserved Fabric capability of a runtime class (platform.runtime-class@1; ADR-046). */
const workerCapability = (runtimeClass) => `worker:${runtimeClass}`;

class PlacementError extends Error {
    constructor(code, detail, { retryable = true } = {}) {
        super(detail || code);
        this.name = 'PlacementError';
        this.code = code;
        this.detail = detail;
        this.retryable = retryable;
    }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function createPlacement({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const { url } = config.network;
    const offersUrl = `${url}/api/v1/offers?kind=node`;
    const { offersTtlMs, timeoutMs } = config.dispatch;
    let cache = { at: 0, offers: [], fetched: 0 };

    /** The published node offers, cached briefly. A Network that does not answer is a retryable error. */
    async function offers() {
        if (cache.at && now() - cache.at < offersTtlMs) return cache.offers;
        let res;
        try {
            res = await fetchImpl(offersUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
            throw new PlacementError('run.dispatch.no_offers', `Network did not answer for the resource offers (${why})`);
        }
        if (!res.ok) throw new PlacementError('run.dispatch.no_offers', `Network answered HTTP ${res.status} for the resource offers`);
        const doc = await res.json().catch(() => null);
        const list = doc && Array.isArray(doc.offers) ? doc.offers : null;
        if (!list) throw new PlacementError('run.dispatch.no_offers', 'the resource offers answer carries no offers array');
        const good = [];
        for (const offer of list) {
            // Validate what Network published against the released contract before plan() ever sees it; an
            // offer that does not match is dropped, never placed on.
            if (!contracts.validate('platform.resource-offer@1', offer).valid) {
                log.warn(`[Run] offer ${obj(offer).offer_id || '?'} does not match platform.resource-offer@1: dropped`);
                continue;
            }
            good.push(offer);
        }
        cache = { at: now(), offers: good, fetched: good.length };
        return good;
    }

    /**
     * The node to run this job on, or null when no offer is eligible. The requirements are the job's own
     * (the contract's default was filled in at submit), plus the class it runs.
     */
    async function choose(row) {
        const want = workerCapability(row.class);
        const requirements = { ...obj(row.job).requirements || requirementsDefault(row.class) };
        const userOwnedNamed = Array.isArray(requirements.trust) && requirements.trust.includes('user-owned');
        const candidates = (await offers()).filter((o) => o.kind === 'node'
            && typeof o.node_id === 'string' && o.node_id.length > 0
            && (o.capabilities || []).includes(want)
            && (o.trust !== 'user-owned' || userOwnedNamed));
        if (!candidates.length) return null;
        const req = { ...requirements, capabilities: [...new Set([...(requirements.capabilities || []), want])] };
        contracts.assertValid('platform.workload-requirements@1', req);
        const result = plan(req, candidates, { now: now() });
        const chosen = result.selected ? candidates.find((o) => o.offer_id === result.selected) : null;
        if (!chosen) {
            if (log && log.debug) log.debug(`[Run] job ${row.id}: no eligible offer for ${want} (${result.reasons.join('; ')})`);
            return null;
        }
        return {
            node_id: chosen.node_id, provider: chosen.provider ?? null, region: chosen.region ?? null,
            offer_id: chosen.offer_id, trust: chosen.trust, reasons: result.reasons,
        };
    }

    return {
        choose,
        offers,
        workerCapability,
        status: () => ({ offers_url: offersUrl, cached: cache.fetched, fetched_at: cache.at ? new Date(cache.at).toISOString() : null, ttl_ms: offersTtlMs }),
    };
}

module.exports = { createPlacement, PlacementError, workerCapability };
