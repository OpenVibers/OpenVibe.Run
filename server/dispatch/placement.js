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
 * External providers (plan T14 R4a): when an adapter is on (server/dispatch/browser-provider.js), the offers of
 * kind=provider (GET …/api/v1/offers?kind=provider) whose `provider` names it and that advertise worker:<class>
 * for a class the adapter runs are candidates beside the nodes, and plan() chooses among both. Such an offer has
 * no device, so the placement's node is its node_id when it names one and its offer_id otherwise; the chosen
 * `provider` is what the poller routes on (the job row stores it). A node offer cannot borrow that name: a kind
 * node offer naming an external provider is dropped, so a job Bot carries is never mirrored from a provider.
 * The provider's API key is Run's own environment's and never an offer's (platform.resource-offer@1 has no field
 * for one).
 *
 * Every offer is validated against platform.resource-offer@1 before it reaches plan(); the offers answer is
 * cached for RUN_OFFERS_TTL_MS, so one tick places many jobs off one read. A Network that does not answer
 * throws PlacementError(retryable) — the poller tries again next tick and never fails a job for it. An
 * answer with no eligible candidate is null, which the poller settles run.job.unplaceable.
 */
const contracts = require('openvibe-contracts');
const { place, optionKey } = require('openvibe-sdk/placement');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { requirementsDefault } = require('../util');
const { PROVIDER: BROWSER_PROVIDER } = require('./browser-provider');

/** The offer `provider` names that route to an external adapter, never to Bot. */
const EXTERNAL_PROVIDERS = new Set([BROWSER_PROVIDER]);

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

/**
 * The reasons place() gives for excluding a user-owned machine that is not this job's person. Run's public answer
 * never lists other people's machines, so those entries are dropped and only a count says they existed.
 */
const OTHER_MACHINE_REASONS = new Set([
    "another person's machine",
    'a user-owned machine has no owner',
    'a user-owned machine needs its owner',
]);

/** The explanation safe to store and answer: no other person's machine in `rejected`; a count instead. */
function publicExplain(explain) {
    if (!explain || typeof explain !== 'object') return null;
    const rejected = [];
    let others = 0;
    for (const entry of (Array.isArray(explain.rejected) ? explain.rejected : [])) {
        if (OTHER_MACHINE_REASONS.has(String(entry && entry.why))) { others++; continue; }
        rejected.push(entry);
    }
    return {
        line: explain.line,
        ranked: Array.isArray(explain.ranked) ? explain.ranked : [],
        rejected,
        others_hidden: others,
    };
}

/** A candidate's human name for the line: the machine's or provider's name Run has, else a plain fallback. */
function displayNameOf(offer, person) {
    const named = (offer.detail && typeof offer.detail.name === 'string' && offer.detail.name)
        || (typeof offer.name === 'string' && offer.name)
        || (typeof offer.machine_name === 'string' && offer.machine_name)
        || null;
    if (offer.trust === 'user-owned' && offer.owner === person) return named || 'your machine';
    return named || offer.provider || (offer.detail && offer.detail.provider) || 'the cloud pool';
}

/** The person a job was requested by (`user:usr_…`, as Run stores the requester), or null for a service or an app. */
const personOf = (requester) => (/^user:(usr_[0-9A-HJKMNP-TV-Z]{26})$/.exec(String(requester || '')) || [])[1] || null;

/**
 * createPlacement({ config, fetchImpl, now, log, providers }) → { choose, offers, status }. `providers` maps
 * the name of each external adapter that is on to the classes it runs ({ 'browser-provider': ['browser'] }).
 */
function createPlacement({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, providers = {}, outcomes = null, priors = null } = {}) {
    const { url } = config.network;
    const offersUrlOf = (kind) => `${url}/api/v1/offers?kind=${kind}`;
    const offersUrl = offersUrlOf('node');
    const { offersTtlMs, timeoutMs } = config.dispatch;
    const caches = new Map();   // kind → { at, offers, fetched }
    const external = Object.entries(providers).filter(([name, classes]) => EXTERNAL_PROVIDERS.has(name) && Array.isArray(classes) && classes.length);
    // A person's own machines (contracts 0.161.0): never on the public list, read from Network's internal one with
    // network.registry.read, owner included. Without Run's client secret there are none to place on.
    const { clientId, clientSecret } = obj(config.oauth);
    const registryTokens = clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId, clientSecret, audience: 'openvibe.network', scope: 'network.registry.read', fetch: fetchImpl, now })
        : null;
    let owned = { at: 0, offers: [] };
    /** Every live user-owned node offer that names its owner, from the internal list, cached like the public ones. */
    async function ownedOffers({ maxAgeMs = offersTtlMs } = {}) {
        if (!registryTokens) return [];
        if (owned.at && now() - owned.at < maxAgeMs) return owned.offers;
        const href = `${config.network.internalUrl}/internal/resources?kind=node&trust=user-owned`;
        let res;
        try {
            res = await fetchImpl(href, { headers: { Accept: 'application/json', ...(await registryTokens.authHeaders()) }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
            throw new PlacementError('run.dispatch.no_offers', `Network did not answer for the people's own machines (${why})`);
        }
        if (!res.ok) throw new PlacementError('run.dispatch.no_offers', `Network answered HTTP ${res.status} for the people's own machines`);
        const doc = await res.json().catch(() => null);
        const list = doc && Array.isArray(doc.offers) ? doc.offers : null;
        if (!list) throw new PlacementError('run.dispatch.no_offers', 'the internal offers answer carries no offers array');
        const good = list.filter((o) => {
            if (!contracts.validate('platform.resource-offer@1', o).valid) {
                log.warn(`[Run] offer ${obj(o).offer_id || '?'} does not match platform.resource-offer@1: dropped`);
                return false;
            }
            return o.trust === 'user-owned' && typeof o.owner === 'string' && o.kind === 'node' && typeof o.node_id === 'string' && o.node_id.length > 0;
        });
        owned = { at: now(), offers: good };
        return good;
    }

    /** The published offers of one kind, cached briefly. A Network that does not answer is a retryable error. */
    async function offers(kind = 'node', { maxAgeMs = offersTtlMs } = {}) {
        const cache = caches.get(kind) || { at: 0, offers: [], fetched: 0 };
        if (cache.at && now() - cache.at < maxAgeMs) return cache.offers;
        const href = offersUrlOf(kind);
        let res;
        try {
            res = await fetchImpl(href, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
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
        caches.set(kind, { at: now(), offers: good, fetched: good.length });
        return good;
    }

    /**
     * Whether a job may be pinned to this machine now (Codes C9c): a machine of the requester's own (a user-owned
     * offer names them), advertising the class, and up. Run refuses a pinned job when it is not — never places it
     * somewhere else. A caller at submit asks with fresh: true (one read, not the poller's cached one); the
     * placement loop asks from its cache, and a machine that went offline between the two simply keeps the job
     * queued here until it is back or the job's ttl runs out.
     *
     * @returns {Promise<{ok: boolean, offer?: object, code?: string, detail?: string}>}
     */
    async function pinStatus(nodeId, runtimeClass, requester = null, { fresh = false } = {}) {
        const want = workerCapability(runtimeClass);
        if (!/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(nodeId || ''))) {
            return { ok: false, code: 'run.job.node_offline', detail: 'node must be a machine id (dev_…)' };
        }
        const age = fresh ? 0 : offersTtlMs;
        const offer = [...(await offers('node', { maxAgeMs: age })), ...(await ownedOffers({ maxAgeMs: age }))]
            .find((o) => o && o.kind === 'node' && o.node_id === nodeId);
        if (!offer) return { ok: false, code: 'run.job.node_offline', detail: `machine ${nodeId} is not connected to Run` };
        if (offer.trust === 'user-owned') {
            const person = personOf(requester);
            if (!person || offer.owner !== person) return { ok: false, code: 'run.job.node_offline', detail: `machine ${nodeId} is not one of yours` };
        }
        if (!(offer.capabilities || []).includes(want)) return { ok: false, code: 'run.job.worker_failed', detail: `machine ${nodeId} does not run ${runtimeClass} jobs` };
        if (!offer.health || offer.health.status !== 'up') return { ok: false, code: 'run.job.node_offline', detail: `machine ${nodeId} is not connected` };
        return { ok: true, offer };
    }

    /**
     * The node to run this job on, or null when no offer is eligible. The requirements are the job's own
     * (the contract's default was filled in at submit), plus the class it runs. A job that names a machine
     * (Codes C9c) is placed only there: the placer is not asked, and a machine that is not usable is an error,
     * never a quieter placement somewhere else.
     */
    async function choose(row) {
        const want = workerCapability(row.class);
        const pinned = typeof obj(row.job).node === 'string' ? obj(row.job).node : null;
        if (pinned) {
            const status = await pinStatus(pinned, row.class, row.requester);
            if (!status.ok) throw new PlacementError(status.code, status.detail, { retryable: status.code === 'run.job.node_offline' });
            const o = status.offer;
            return {
                node_id: o.node_id, provider: o.provider ?? null, region: o.region ?? null, kind: o.kind,
                offer_id: o.offer_id, trust: o.trust, reasons: [`pinned to ${o.node_id}`],
                option_key: optionKey(o), step_kind: row.class,
                explain: publicExplain({ line: `On ${displayNameOf(o, personOf(row.requester))}: this job was pinned there.`, ranked: [], rejected: [] }),
            };
        }
        const requirements = { ...obj(row.job).requirements || requirementsDefault(row.class) };
        const userOwnedNamed = Array.isArray(requirements.trust) && requirements.trust.includes('user-owned');
        // A user-owned offer is a person's own machine: eligible only for that person's own job, and only when the job
        // names user-owned (contracts 0.161.0). The public list carries none; one that slipped in is never used, since
        // only the internal read states the owner this rule needs.
        const trusted = (o) => (o.capabilities || []).includes(want) && o.trust !== 'user-owned';
        const candidates = (await offers('node')).filter((o) => o.kind === 'node'
            && typeof o.node_id === 'string' && o.node_id.length > 0
            && !EXTERNAL_PROVIDERS.has(o.provider)
            && trusted(o));
        const person = personOf(row.requester);
        if (userOwnedNamed && person) {
            candidates.push(...(await ownedOffers()).filter((o) => o.owner === person && (o.capabilities || []).includes(want)
                && !EXTERNAL_PROVIDERS.has(o.provider)));
        }
        // An external provider that runs this class: its kind=provider offers are candidates too.
        const names = new Set(external.filter(([, classes]) => classes.includes(row.class)).map(([name]) => name));
        if (names.size) {
            candidates.push(...(await offers('provider')).filter((o) => o.kind === 'provider' && names.has(o.provider)
                && typeof o.offer_id === 'string' && o.offer_id.length > 0 && o.offer_id.length <= 128
                && trusted(o)));
        }
        if (!candidates.length) return null;
        const req = { ...requirements, capabilities: [...new Set([...(requirements.capabilities || []), want])] };
        contracts.assertValid('platform.workload-requirements@1', req);
        // Placement A1: Bench's priors per option key (an hour's cache), the person's learned counts (one read) and the
        // job's class as the step kind. An unreadable table or a quiet Bench leaves the defaults, never a failed placement.
        const learned = outcomes && person ? await outcomes.forPerson(person) : [];
        const scores = priors ? await priors.forStep(row.class) : {};
        const priorMap = {};
        const displayNames = {};
        for (const o of candidates) {
            const model = (o.detail && o.detail.model) || o.model;
            if (model && scores[model] != null) priorMap[optionKey(o)] = scores[model];
            displayNames[o.offer_id] = displayNameOf(o, person);
        }
        const placed = place(req, candidates, {
            now: now(), person, step: { kind: row.class }, priors: priorMap, outcomes: learned,
            names: displayNames, current: requirements.authority || null,
        });
        const result = placed.result;
        const chosen = result.selected ? candidates.find((o) => o.offer_id === result.selected) : null;
        if (!chosen) {
            if (log && log.debug) log.debug(`[Run] job ${row.id}: no eligible offer for ${want} (${result.reasons.join('; ')})`);
            return null;
        }
        return {
            // A provider offer has no device: its own id stands for where the job went (the read result's node).
            node_id: chosen.kind === 'provider' ? (chosen.node_id || chosen.offer_id) : chosen.node_id,
            provider: chosen.provider ?? null, region: chosen.region ?? null, kind: chosen.kind,
            offer_id: chosen.offer_id, trust: chosen.trust, reasons: result.reasons,
            option_key: optionKey(chosen), step_kind: row.class,
            explain: publicExplain({ line: placed.line, ranked: placed.ranked, rejected: placed.rejected }),
        };
    }

    return {
        choose,
        pinStatus,
        offers,
        workerCapability,
        status: () => {
            const cache = caches.get('node') || { at: 0, fetched: 0 };
            return {
                offers_url: offersUrl, cached: cache.fetched, fetched_at: cache.at ? new Date(cache.at).toISOString() : null, ttl_ms: offersTtlMs,
                providers: external.map(([name, classes]) => ({ provider: name, classes, cached: (caches.get('provider') || { fetched: 0 }).fetched })),
            };
        },
    };
}

module.exports = { createPlacement, PlacementError, workerCapability, EXTERNAL_PROVIDERS, personOf, publicExplain, displayNameOf, OTHER_MACHINE_REASONS };
