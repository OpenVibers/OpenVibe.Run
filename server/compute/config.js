'use strict';
const { STRATEGIES, micros } = require('openvibe-sdk/compute');
function loadCompute(env) {
    let pools = {}, inventory = {};
    for (const [name, put] of [['RUN_COMPUTE_POOLS', v => { pools=v; }],['RUN_COMPUTE_INVENTORY', v => { inventory=v; }]]) {
        if (!env[name]) continue;
        const v=JSON.parse(env[name]);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`);
        put(v);
    }
    for (const [id,p] of Object.entries(pools)) {
        if (!/^[a-z0-9-]{1,40}$/.test(id) || !STRATEGIES.includes(p.strategy || 'automatic')) throw new Error('invalid compute pool');
        if (p.kind && !['function','code','browser','linux','desktop','gpu'].includes(p.kind)) throw new Error('invalid pool kind');
    }
    const providers={};
    for (const name of ['hetzner','ovh','vast','runpod']) {
        const prefix='RUN_COMPUTE_'+name.toUpperCase()+'_';
        const cap=env[prefix+'MONTHLY_CAP'] || '0'; micros(cap);
        providers[name]={ key:env[prefix+'KEY'] || '', monthly_cap:cap, currency:env[prefix+'CURRENCY'] || (['hetzner','ovh'].includes(name)?'EUR':'USD'),
            image:env[prefix+'IMAGE'] || '', extra_hourly:env[prefix+'EXTRA_HOURLY'] || null,
            costs_bounded:env[prefix+'COSTS_BOUNDED']==='1',
            project:env[prefix+'PROJECT'] || '', application_secret:env[prefix+'APPLICATION_SECRET'] || '', consumer_key:env[prefix+'CONSUMER_KEY'] || '' };
    }
    return { enabled:env.RUN_COMPUTE_ENABLED==='1', dry_run:env.RUN_COMPUTE_DRY_RUN!=='0', pools, inventory, providers,
        operators:(env.RUN_COMPUTE_OPERATORS || '').split(',').map(s=>s.trim()).filter(Boolean),
        owner:env.RUN_COMPUTE_OWNER || '', job_pool:env.RUN_COMPUTE_JOB_POOL || '', tick_ms:30000 };
}
module.exports={loadCompute};
