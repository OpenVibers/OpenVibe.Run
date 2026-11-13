'use strict';
/**
 * The checks planner (research-2026-11-13/shared-node-checks.md, piece 2): act's reading of a workflow, not
 * an evaluator of it. A workflow at the SHA is kept when its `on` names the event and its branch filters
 * match; its jobs are expanded into one flat play per workflow job, matrix combination included, with
 *
 *   - `needs` turned into stages (a later stage is queued only when every need succeeded),
 *   - `strategy.matrix` with include/exclude and max-parallel,
 *   - a reusable workflow (`uses: owner/repo/.github/workflows/x.yml@ref`) read at its ref and expanded as
 *     a sub-play (the caller job is not a Run job; its sub-jobs carry its needs).
 *
 * `if:` is never evaluated: an expression this planner cannot read runs the job, which is act's default.
 * The reading of files (GitHub contents, installation token) is a callback so this module is pure and a
 * fixture test needs no network.
 */
const YAML = require('yaml');

const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_REUSE_DEPTH = 4;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const listOf = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const baseName = (p) => String(p || '').split('/').pop().replace(/\.ya?ml$/i, '');

/** The `on` map of a workflow: a string, a list of strings, or the event → filters map. */
function onMap(on) {
    if (typeof on === 'string') return { [on]: null };
    if (Array.isArray(on)) return Object.fromEntries(on.filter((e) => typeof e === 'string').map((e) => [e, null]));
    const m = obj(on);
    return m ? { ...m } : {};
}

/** A GitHub branch glob (`*` one segment, `**` any) as a regular expression. */
function globOf(pattern) {
    let re = '';
    const text = String(pattern || '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '*') {
            if (text[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else re += c.replace(/[\\^$+.()|[\]{}]/g, '\\$&');
    }
    try { return new RegExp(`^${re}$`); } catch { return null; }
}

/** Does one branch match a GitHub `branches` list (positive globs and `!` negations)? */
function branchMatches(branch, patterns) {
    const list = listOf(patterns).filter((p) => typeof p === 'string');
    if (!list.length) return true;
    const negative = list.filter((p) => p.startsWith('!')).map((p) => globOf(p.slice(1))).filter(Boolean);
    const positive = list.filter((p) => !p.startsWith('!')).map(globOf).filter(Boolean);
    if (negative.some((re) => re.test(branch))) return false;
    if (positive.length && !positive.some((re) => re.test(branch))) return false;
    return true;
}

/**
 * Does a workflow's `on` match this event? `branch` is the branch the event acts on: the pushed branch,
 * or a pull request's base branch. `paths` filters are not evaluated (the job runs), as act does.
 */
function eventMatches(on, { event, branch = null, action = null } = {}) {
    const map = onMap(on);
    if (!Object.prototype.hasOwnProperty.call(map, event)) return false;
    const cfg = map[event];
    if (cfg == null) return true;
    const filters = obj(cfg);
    if (!filters) return true;
    const types = listOf(filters.types);
    if (types.length && action && !types.includes(action)) return false;
    if (filters['branches-ignore'] && branch && listOf(filters['branches-ignore']).some((p) => (globOf(p) || /$^/).test(branch))) return false;
    if (filters.branches && branch && !branchMatches(branch, filters.branches)) return false;
    // A push filter naming only tags does not run for a branch push.
    if (event === 'push' && filters.tags && !filters.branches && branch) return false;
    return true;
}

// ── strategy.matrix ────────────────────────────────────────────────────────────

/**
 * Every combination of `strategy.matrix`, or [null] when there is none. include entries are merged into
 * every combination whose original matrix keys they do not overwrite (a same value is not an overwrite);
 * an include that fits none becomes a combination of its own. exclude removes combinations matching all
 * of its pairs. This is GitHub's documented order.
 */
function matrixCombinations(strategy) {
    const s = obj(strategy);
    const matrix = s && obj(s.matrix);
    if (!matrix) return [null];
    const keys = Object.keys(matrix).filter((k) => k !== 'include' && k !== 'exclude');
    let combos = [{}];
    for (const key of keys) {
        const values = listOf(matrix[key]);
        const next = [];
        for (const combo of combos) for (const value of values) next.push({ ...combo, [key]: value });
        combos = next;
    }
    for (const include of listOf(matrix.include)) {
        const inc = obj(include);
        if (!inc) continue;
        let merged = false;
        for (let i = 0; i < combos.length; i++) {
            const combo = combos[i];
            const overwrites = Object.keys(inc).some((k) => keys.includes(k) && Object.prototype.hasOwnProperty.call(combo, k) && combo[k] !== inc[k]);
            if (overwrites) continue;
            combos[i] = { ...combo, ...inc };
            merged = true;
        }
        if (!merged) combos.push({ ...inc });
    }
    for (const exclude of listOf(matrix.exclude)) {
        const ex = obj(exclude);
        if (!ex) continue;
        const pairs = Object.entries(ex);
        combos = combos.filter((combo) => !pairs.every(([k, v]) => combo[k] === v));
    }
    return combos;
}

/** The `(18, ubuntu-latest)` part of a matrix job's Actions name; empty for no matrix. */
function matrixLabel(combo) {
    if (!combo) return '';
    const values = Object.values(combo);
    if (!values.length) return '';
    return ` (${values.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')})`;
}

const maxParallelOf = (strategy) => {
    const s = obj(strategy);
    const n = s ? Number(s['max-parallel']) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

const timeoutOf = (job) => {
    const n = Number(job && job['timeout-minutes']);
    return Number.isFinite(n) && n > 0 ? Math.min(24 * 60, Math.floor(n)) : DEFAULT_TIMEOUT_MINUTES;
};

// ── jobs, needs and reusable workflows ─────────────────────────────────────────

/** Parse a job's `uses`: a local path (read at the plan's SHA) or owner/repo/path@ref. */
function parseUses(uses) {
    const text = String(uses || '').trim();
    if (!text) return null;
    if (text.startsWith('./') || text.startsWith('.github/')) return { local: true, path: text.replace(/^\.\//, ''), ref: null };
    const m = /^([^/\s]+)\/([^/\s]+)\/(.+)@([^\s]+)$/.exec(text);
    if (!m) return null;
    return { local: false, owner: m[1], repo: m[2], path: m[3], ref: m[4] };
}

/**
 * Expand a workflow's jobs, recursively through reusable workflows. Returns entries with abstract needs
 * (keys in this play) and `provides`: a workflow job key → the entries that satisfy a `needs` on it (a
 * matrix job's variants, or every job of a reusable workflow).
 */
async function expandWorkflow({ doc, path, keyPrefix = '', displayPrefix = '', inheritedNeeds = [], callerMatrix = null,
    readWorkflow, depth = 0, errors = [] }) {
    const entries = [];
    const provides = new Map();
    const jobs = obj(doc && doc.jobs) || {};
    for (const [jobKey, jobValue] of Object.entries(jobs)) {
        const job = obj(jobValue) || {};
        const fullKey = `${keyPrefix}${jobKey}`;
        const jobName = typeof job.name === 'string' && job.name ? job.name : jobKey;
        const needsHere = listOf(job.needs).filter((n) => typeof n === 'string').map((n) => `${keyPrefix}${n}`);

        if (typeof job.uses === 'string' && job.uses) {
            const uses = parseUses(job.uses);
            if (!uses) { errors.push({ path, job: jobKey, message: `cannot read uses: ${job.uses}` }); continue; }
            if (depth >= MAX_REUSE_DEPTH) { errors.push({ path, job: jobKey, message: 'reusable workflows nest too deeply' }); continue; }
            let source = null;
            try { source = readWorkflow ? await readWorkflow(uses, path) : null; } catch (e) {
                errors.push({ path, job: jobKey, message: `reusable workflow ${job.uses} could not be read (${e.code || e.message})` });
            }
            let called = null;
            if (source) {
                try { called = YAML.parse(source); } catch (e) { errors.push({ path, job: jobKey, message: `reusable workflow ${job.uses} is not YAML` }); }
            }
            if (!called || !obj(called.jobs)) { provides.set(fullKey, []); continue; }
            const callerCombos = matrixCombinations(job.strategy);
            for (let ci = 0; ci < callerCombos.length; ci++) {
                const combo = callerCombos[ci];
                const callKey = callerCombos.length > 1 ? `${fullKey}#${ci}` : fullKey;
                const childPrefix = `${callKey}/`;
                const childDisplay = `${displayPrefix}${jobName}${matrixLabel(combo)} / `;
                const childInherited = needsHere.length ? needsHere : inheritedNeeds;
                const childMatrix = combo ? { ...(callerMatrix || {}), ...combo } : callerMatrix;
                const child = await expandWorkflow({
                    doc: called, path: uses.path, keyPrefix: childPrefix, displayPrefix: childDisplay,
                    inheritedNeeds: childInherited, callerMatrix: childMatrix, readWorkflow, depth: depth + 1, errors,
                });
                entries.push(...child.entries);
                // child.provides' keys already carry childPrefix: merge them as they are.
                for (const [k, v] of child.provides) provides.set(k, v);
                if (!provides.has(fullKey)) provides.set(fullKey, []);
                provides.get(fullKey).push(...child.entries.map((e) => e.key));
            }
            if (!provides.has(fullKey)) provides.set(fullKey, []);
            continue;
        }

        const combos = matrixCombinations(job.strategy);
        const maxParallel = maxParallelOf(job.strategy);
        const timeout = timeoutOf(job);
        const variants = [];
        for (let ci = 0; ci < combos.length; ci++) {
            const combo = combos[ci] ? { ...(callerMatrix || {}), ...combos[ci] } : callerMatrix;
            const key = combos.length > 1 ? `${fullKey}#${ci}` : fullKey;
            const displayName = `${displayPrefix}${jobName}${matrixLabel(combo)}`;
            entries.push({
                key, group: fullKey, job_key: jobKey, job_name: jobName, display_name: displayName,
                workflow_path: path, workflow_job_key: jobKey, needs: needsHere.length ? needsHere : inheritedNeeds, matrix: combo,
                max_parallel: combos.length > 1 ? maxParallel : null, timeout_minutes: timeout,
                name_prefix: displayPrefix,
            });
            variants.push(key);
        }
        provides.set(fullKey, variants);
    }
    return { entries, provides };
}

/** Resolve abstract needs to entry keys, then compute each entry's stage. Cycles and unknown needs are errors. */
function resolveStages(entries, provides, errors = []) {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const stageOf = new Map();
    const visiting = new Set();
    function stage(key) {
        if (stageOf.has(key)) return stageOf.get(key);
        const entry = byKey.get(key);
        if (!entry) return 0;
        if (visiting.has(key)) throw new Error(`a needs cycle passes through ${key}`);
        visiting.add(key);
        let n = 0;
        for (const need of entry.needs) n = Math.max(n, stage(need) + 1);
        visiting.delete(key);
        stageOf.set(key, n);
        return n;
    }
    const kept = [];
    for (const entry of entries) {
        const resolved = [];
        for (const need of entry.needs) {
            const supplied = provides.get(need);
            if (supplied) resolved.push(...supplied);
            else if (byKey.has(need)) resolved.push(need);
            else errors.push({ path: entry.workflow_path, job: entry.job_key, message: `needs ${need}, which the workflow does not define` });
        }
        entry.needs = [...new Set(resolved.filter((k) => k !== entry.key))];
        kept.push(entry);
    }
    for (const entry of kept) {
        try { entry.stage = stage(entry.key); } catch (e) {
            errors.push({ path: entry.workflow_path, job: entry.job_key, message: e.message });
            entry.error = true;
        }
    }
    return kept.filter((e) => !e.error).sort((a, b) => a.stage - b.stage || a.key.localeCompare(b.key));
}

/**
 * planWorkflows({ workflows: [{path, source}], event, branch, action, readWorkflow, log }) →
 * { workflows: [{ path, name, jobs }], errors }. Every job is flat: one matrix combination is one job;
 * `needs` is the list of flat keys it waits for; `stage` is its level.
 */
async function planWorkflows({ workflows = [], event, branch = null, action = null, readWorkflow = null, log = console } = {}) {
    const out = { workflows: [], errors: [] };
    for (const file of workflows) {
        let doc;
        try { doc = YAML.parse(file.source); } catch (e) {
            out.errors.push({ path: file.path, message: `not YAML: ${e.message}` });
            continue;
        }
        if (!obj(doc) || !obj(doc.jobs)) continue;
        if (!eventMatches(doc.on, { event, branch, action })) continue;
        const name = typeof doc.name === 'string' && doc.name ? doc.name : baseName(file.path);
        const expanded = await expandWorkflow({ doc, path: file.path, readWorkflow, errors: out.errors });
        const jobs = resolveStages(expanded.entries, expanded.provides, out.errors);
        if (jobs.length) out.workflows.push({ path: file.path, name, jobs });
        if (out.errors.length && log && log.warn) {
            for (const e of out.errors.slice(-3)) log.warn(`[Run] checks planner: ${e.path}${e.job ? ` ${e.job}` : ''}: ${e.message}`);
        }
    }
    return out;
}

module.exports = {
    planWorkflows, eventMatches, matrixCombinations, matrixLabel, parseUses, onMap, branchMatches, globOf,
    DEFAULT_TIMEOUT_MINUTES,
};
