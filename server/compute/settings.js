'use strict';
// The same encrypted, audited owner configuration store used by the other services.
const shared = require('openvibe-shared/config');
const { serviceAuth, capabilities, ids } = require('openvibe-contracts');
const NAMES = ['baseten', 'daytona', 'e2b', 'fly'];
const DEFAULTS = { enabled: false, api_key: '', monthly_cap: '0', max_concurrent: 0, allowed_kinds: [],
    image: '', region: '', project: '', extra_hourly: '0', costs_bounded: false,
    credit_amount: '0', credit_expires: '', promotion_expires: '', price_id: '' };
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$' };
const date = { type: 'string', pattern: '^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' };
const SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(DEFAULTS), properties: {
    enabled: { type: 'boolean', title: 'Allow rentals', 'x-danger': true },
    api_key: { type: 'string', title: 'Provider API key', 'x-group': 'Credentials' },
    monthly_cap: { ...decimal, title: 'Monthly USD cap (gross charges, before credits)' },
    max_concurrent: { type: 'integer', minimum: 0, maximum: 10000 },
    allowed_kinds: { type: 'array', uniqueItems: true, items: { enum: ['function', 'code', 'browser', 'linux', 'desktop', 'gpu'] } },
    image: { type: 'string', maxLength: 300, title: 'Prepared worker image or template' },
    region: { type: 'string', maxLength: 80 }, project: { type: 'string', maxLength: 80, title: 'Fly app / Baseten team' },
    extra_hourly: { ...decimal, title: 'Bounded disk and network USD per hour' },
    costs_bounded: { type: 'boolean', title: 'Image enforces disk and network limits', 'x-danger': true },
    credit_amount: { ...decimal, title: 'Confirmed one-time USD credit grant' },
    credit_expires: { ...date, title: 'Credit expiry (UTC)' },
    promotion_expires: { ...date, title: 'Disable new rentals after promotion (UTC)' },
    price_id: { type: 'string', maxLength: 100, title: 'Exchange compute price ID' },
} };
async function createSettings({ db, config, keys, broker, env = process.env, log = console }) {
    const stores = [];
    const masterKeys = ['enabled','dry_run','owner','job_pool','pools'];
    const master = await shared.createConfigStore({db, service:'run',namespace:'run.compute',env,log,
        defaults:Object.fromEntries(masterKeys.map(k=>[k,config.compute[k]])),
        schema:{type:'object',additionalProperties:false,properties:{
            enabled:{type:'boolean','x-danger':true},dry_run:{type:'boolean','x-danger':true},
            owner:{type:'string',pattern:'^$|^usr_[0-9A-HJKMNP-TV-Z]{26}$'},job_pool:{type:'string'},
            pools:{type:'object',additionalProperties:{type:'object',required:['kind','providers'],additionalProperties:true,properties:{
                kind:{enum:['function','code','browser','linux','desktop','gpu']},providers:{type:'array',items:{enum:[...NAMES,'hetzner','ovh','vast','runpod']}},
                strategy:{enum:['automatic','cheapest','fastest','private','own']},currency:{type:'string',pattern:'^[A-Z]{3}$'},
                region:{type:'string'},min_warm:{type:'integer',minimum:0,maximum:100},max_machines:{type:'integer',minimum:0,maximum:10000},
                slots_per_machine:{type:'integer',minimum:1,maximum:100},max_runtime_ms:{type:'integer',minimum:60000,maximum:3600000},
                target_wait_ms:{type:'integer',minimum:0},idle_grace_ms:{type:'integer',minimum:0},max_hourly:{type:'number',minimum:0},
                gpu_mb:{type:'integer',minimum:0},measured_peak_ram_mb:{type:'integer',minimum:0},public_egress:{type:'boolean'}
            }}}
        }}});
    stores.push(master);
    for(const key of masterKeys) Object.defineProperty(config.compute,key,{enumerable:true,configurable:true,get:()=>master.get(key)});
    for (const name of NAMES) {
        const store = await shared.createConfigStore({ db, service: 'run', namespace: `run.compute_${name}`,
            schema: SCHEMA, defaults: DEFAULTS, classify: { api_key: 'secret' }, env, log });
        stores.push(store);
        const pc = { currency: 'USD', managed: true };
        for (const key of Object.keys(DEFAULTS)) Object.defineProperty(pc, key, { enumerable: key !== 'api_key', get: () => store.get(key) });
        Object.defineProperty(pc, 'key', { get: () => { const value = store.get('api_key'); return typeof value === 'string' ? value : ''; } });
        config.compute.providers[name] = pc;
    }
    const guard = (req, res, next) => {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const publicKey = keys.get();
        const result = publicKey && serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.network.issuer, audience: config.audience });
        if (!result?.ok || result.claims.sub !== 'svc:network' || !capabilities.check(result.claims, 'run.config.manage').allowed || !ids.isSubjectId('user', req.headers['x-ov-subject']))
            return res.status(403).json({ error: 'Network owner configuration capability required' });
        // Never let shared/config fall back to plaintext storage without an encryption key.
        if (req.method === 'PUT' && !env.OV_CONFIG_KEKS) return res.status(503).json({ error: 'Configuration encryption is not installed' });
        next();
    };
    const router = shared.adminRoutes(stores, { basePath: '/internal/config', requireAdmin: guard,
        actor: req => ({ type: 'user', id: req.headers['x-ov-subject'] }),
        requireFresh: req => req.headers['x-ov-fresh'] === '1', log });
    return { stores, mount(app) {
        app.get('/internal/config/compute-status', guard, (req,res,next) => broker.status().then(status =>
            res.set('Cache-Control','no-store').json({enabled:status.enabled,dry_run:status.dry_run,budgets:status.budgets}),next));
        router.mount(app);
    } };
}
module.exports = { NAMES, DEFAULTS, SCHEMA, createSettings };
