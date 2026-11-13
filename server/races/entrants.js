'use strict';

/**
 * bench.entrant@1 ids and their model families, for a matchmaker that must not pair two of one family
 * (bench.entrant@1: "the model family, so the matchmaker can avoid pairing two of one family").
 *
 * The id is the only thing Run is given by the race API, so the family is read from it: a model id is the
 * model itself; an agent id is agent:<harness>+<model>#<config>; a harness or a product has no model and
 * falls back to its own name. The family is the first segment of the model (gpt-5-mini → gpt,
 * deepseek-flash → deepseek, meta-llama/… → meta), which is coarse on purpose: it keeps two variants of
 * one maker's model out of a pair.
 */

/** bench.entrant@1's own id pattern (contracts/bench/entrant.v1.json). */
const ENTRANT_RE = /^(model:[A-Za-z0-9._/:-]{1,200}|harness:[a-z0-9][a-z0-9._-]{0,60}@[A-Za-z0-9._-]{1,40}|agent:[a-z0-9][a-z0-9._-]{0,60}\+[A-Za-z0-9._/:-]{1,200}#[a-f0-9]{8,64}|product:[a-z0-9][a-z0-9-]{0,60})$/;

const isEntrantId = (v) => typeof v === 'string' && ENTRANT_RE.test(v);

/** The model (or, for a harness/product, the thing itself) an entrant id names. */
function modelOf(id) {
    const s = String(id || '');
    if (s.startsWith('model:')) return s.slice(6);
    if (s.startsWith('agent:')) {
        const plus = s.indexOf('+');
        const hash = s.indexOf('#');
        return plus >= 0 ? s.slice(plus + 1, hash > plus ? hash : undefined) : s.slice(6);
    }
    if (s.startsWith('harness:')) return s.slice(8).split('@')[0];
    if (s.startsWith('product:')) return s.slice(8);
    return s;
}

/** The coarser family the matchmaker keeps apart (gpt, deepseek, glm, claude, llama …). */
function familyOf(id) {
    const model = modelOf(id).toLowerCase();
    return model.split(/[-/.:]/)[0] || model;
}

module.exports = { ENTRANT_RE, isEntrantId, modelOf, familyOf };
