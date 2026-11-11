'use strict';
const { NAMES } = require('./settings');
// Public prices come from Exchange. No caller-supplied URL or credential reaches a provider.
function createSandboxProviders({ config, fetchImpl = globalThis.fetch, now = Date.now, prices }) {
    return Object.fromEntries(NAMES.map(name => {
        const pc = () => config.providers[name] || {};
        const base = () => ({ baseten: 'https://api.baseten.co/v1/sandboxes/instances', daytona: 'https://app.daytona.io/api/sandbox',
            e2b: 'https://api.e2b.app/sandboxes', fly: `https://api.machines.dev/v1/apps/${encodeURIComponent(pc().project)}/machines` })[name];
        async function call(method, suffix = '', body, resource = 'sandboxes') {
            if (!pc().key) throw new Error('provider key missing');
            const headers = { 'content-type': 'application/json', ...(name === 'e2b' ? { 'X-API-Key': pc().key } : { authorization: `Bearer ${pc().key}` }) };
            if (name === 'baseten' && pc().project) headers['X-Team-Id'] = pc().project;
            const response = await fetchImpl((name === 'e2b' && resource === 'templates' ? 'https://api.e2b.app/templates' : base()) + suffix, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30000), ...(body ? { body: JSON.stringify(body) } : {}) });
            if (method === 'GET' && response.status === 404) return { deleted: true };
            if (method === 'DELETE' && response.status === 404) return {};
            if (!response.ok) throw new Error(`provider ${method} failed (${response.status})`);
            return response.status === 204 ? {} : response.json();
        }
        return [name, {
            async quote({ gpu_mb = 0 } = {}) {
                if (gpu_mb > 0) return []; // These four adapters provision CPU shapes only.
                const quotes = (await prices()).filter(p => p.provider === name && p.id === pc().price_id && p.region === pc().region
                    && p.expires_at > now() && p.hourly > 0 && Number.isFinite(p.hourly) && p.ram_mb >= 1024 && p.cpu >= 1)
                    .map(p => ({ ...p, tier: 'partner', billing_seconds: 1, provisionable: true, gpu_mb: 0 }));
                if (name === 'e2b' && pc().key && pc().image) {
                    const template = await call('GET', '/' + encodeURIComponent(pc().image), undefined, 'templates');
                    return quotes.filter(q => template.cpuCount === q.cpu && template.memoryMB === q.ram_mb);
                }
                return quotes;
            },
            async provision(q, { label, image, runtime_ms = 3600000 }) {
                const seconds = Math.ceil(runtime_ms / 1000);
                let body;
                if (name === 'baseten') body = { name: label, image, memory: q.ram_mb, cpu: q.cpu, region: q.region,
                    lifecycle: { expiration_policies: [{ action: 'DELETE', type: 'TTL_MAX_AGE', value: `${seconds}s` }] } };
                if (name === 'daytona') body = { name: label, snapshot: image, target: q.region, public: false,
                    ttlMinutes: Math.ceil(seconds / 60), autoStopInterval: Math.ceil(seconds / 60), autoDeleteInterval: 0, cpu: q.cpu, memory: q.ram_mb / 1024, disk: q.disk_gb || 5 };
                if (name === 'e2b') {
                    const template = await call('GET', '/' + encodeURIComponent(image), undefined, 'templates');
                    if (template.cpuCount !== q.cpu || template.memoryMB !== q.ram_mb) throw new Error('template resources differ from the quoted shape');
                }
                if (name === 'e2b') body = { templateID: image, timeout: seconds, cpuCount: q.cpu, autoPause: false, metadata: { name: label } };
                if (name === 'fly') body = { name: label, region: q.region, config: { image, auto_destroy: true,
                    restart: { policy: 'no' }, guest: { cpu_kind: 'shared', cpus: q.cpu, memory_mb: q.ram_mb }, metadata: { rental: label } } };
                const r = await call('POST', '', body);
                return { id: name === 'baseten' ? r.name : name === 'e2b' ? r.sandboxID : r.id };
            },
            async release(id) { await call('DELETE', '/' + encodeURIComponent(id) + (name === 'fly' ? '?force=true' : '')); },
            async health(id) {
                const r = await call('GET', '/' + encodeURIComponent(id));
                return { deleted: r.deleted === true || (name === 'baseten' && r.status === 'TERMINATED') || (name === 'fly' && r.state === 'destroyed'), state: r.state || r.status };
            },
        }];
    }));
}
function createPriceReader({ fetchImpl = globalThis.fetch, now = Date.now }) {
    let cached = [], until = 0;
    return async () => {
        if (now() < until) return cached;
        try {
            const r = await fetchImpl('https://openvibe.exchange/api/compute/prices', { redirect: 'error', signal: AbortSignal.timeout(5000) });
            if (!r.ok) return [];
            const data = await r.json();
            cached = Array.isArray(data.prices) ? data.prices : []; until = now() + 60000;
            return cached;
        } catch { return []; }
    };
}
module.exports = { createSandboxProviders, createPriceReader };
