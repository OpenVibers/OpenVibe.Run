'use strict';
const { randomUUID }=require('node:crypto');
const {choose,scale,micros,charge,createProviders,STRATEGIES}=require('openvibe-sdk/compute');
const obj=v=>typeof v==='string'?JSON.parse(v):v;
const bare=v=>String(v || '').replace(/^user:/,'');
function createBroker({db,config,desks,now=Date.now,fetchImpl=globalThis.fetch,adapters,log=console}) {
 const cfg=config.compute || {pools:{},inventory:{},providers:{},operators:[],dry_run:true};
 const providers=adapters || createProviders({fetch:fetchImpl,config:cfg.providers,now});
 let timer=null,running=null,finish=null,finishJobs=null;
 const month=()=>new Date(now()).toISOString().slice(0,7);
 const journal=(event,detail={},r={})=>db.query('INSERT INTO run_compute_journal (at,event,rental,pool,detail) VALUES ($1,$2,$3,$4,$5)',[now(),event,r.id || null,r.pool || null,JSON.stringify(detail)]);
 const live=()=>db.many("SELECT * FROM run_compute_rentals WHERE state <> 'released'");
 async function poolConfig(id) {
  const p=Object.hasOwn(cfg.pools,id)?cfg.pools[id]:null; if(!p) throw Object.assign(new Error('unknown compute pool'),{status:422,code:'run.compute.pool'});
  const saved=await db.maybe('SELECT * FROM run_compute_pools WHERE id=$1',[id]);
  return {...p,strategy:saved?.strategy || p.strategy || 'automatic',last_machine:saved?.last_machine};
 }
 async function inventory(hosts,owner) {
  const rentals=await live();
  const counts=await db.many("SELECT machine, count(*)::int AS n FROM run_sessions WHERE state IN ('running','starting') AND machine IS NOT NULL GROUP BY machine");
  const jobs=await db.many("SELECT node_id,count(*)::int AS n FROM run_jobs WHERE state IN ('placed','running') GROUP BY node_id");
  return hosts.map(h=>{
   const rental=rentals.find(r=>r.machine===h.machine_id);
   const rented=rental?obj(rental.quote):{};
   const v={...(rental?{pool:rental.pool,ram_mb:rented.ram_mb,region:rented.region,tier:rented.tier}:{}),...(cfg.inventory[h.machine_id] || {})};
   const sessions=Math.max(counts.find(c=>c.machine===h.machine_id)?.n || 0,(h.max_browser_desks || 0)-(h.free || 0))+(jobs.find(j=>j.node_id===h.machine_id)?.n || 0);
   return {...v,id:h.machine_id,owner:h.trust==='user-owned'?bare(owner):null,
    tier:rental?(rented.tier || 'partner'):h.trust==='user-owned'?'own':h.trust==='community'?'community':h.trust==='first-party'?(v.tier || 'dedicated'):'partner',
    hourly:rental?Number(rental.hourly_micros)/1e6:(h.trust==='user-owned'?0:v.hourly ?? null),currency:rental?.currency || v.currency || 'USD',
    health:h.online?'up':'down',free_slots:Number(h.free) || 0,
    free_ram_mb:Number(h.free_ram_mb ?? (v.ram_mb!=null?Math.max(0,v.ram_mb-1024-sessions*Math.max(300,v.measured_peak_ram_mb || 300)):0)),
    sessions,draining:rental?['draining','releasing','uncertain'].includes(rental.state):Boolean(v.draining),managed:Boolean(rental),
    state:rental?.state || 'running',idle_since:rental?.idle_since==null?undefined:Number(rental.idle_since)};
  });
 }
 async function decide(row,hosts) {
  const pool=await poolConfig(row.compute_pool);
  const rentalMachines=await inventory(hosts,row.owner);
  const allowed=row.requirements?.trust;
  const filtered=hosts.filter(h=>!allowed || allowed.includes(h.trust)).map(h=>h.machine_id);
  const candidates=rentalMachines.filter(m=>filtered.includes(m.id) && (!m.pool || m.pool===row.compute_pool));
  const d=choose({strategy:row.compute_strategy || pool.strategy,owner:bare(row.owner),kind:row.kind,machine:row.machine_asked || undefined,
   region:row.requirements?.region==='nearest'?undefined:row.requirements?.region,max_hourly:row.requirements?.max_cost_usd == null ? undefined : row.requirements.max_cost_usd / Math.max(1,row.ttl_s || 3600) * 3600,public_egress:pool.public_egress!==false,ram_mb:pool.measured_peak_ram_mb},candidates,pool,{now:now(),current:null});
  if(d.selected) {
   const prev=await db.maybe('SELECT * FROM run_compute_pools WHERE id=$1',[row.compute_pool]);
   if(prev?.last_tier && prev.last_tier!==d.tier) await journal('strategy.switch',{from:prev.last_tier,to:d.tier,strategy:d.strategy,reasons:d.reasons},{pool:row.compute_pool});
   await db.query('INSERT INTO run_compute_pools (id,strategy,last_machine,last_tier) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET last_machine=EXCLUDED.last_machine,last_tier=EXCLUDED.last_tier',[row.compute_pool,pool.strategy,d.selected,d.tier]);
  }
  return d;
 }
 async function quotes(poolId) {
  const p=await poolConfig(poolId);
  const results=await Promise.all((p.providers || []).map(async name=>{
   if(!providers[name]) return {provider:name,quotes:[],error:'unsupported provider'};
   try {return {provider:name,quotes:await providers[name].quote({gpu_mb:p.gpu_mb || 0})};}
   catch {return {provider:name,quotes:[],error:'catalogue unavailable or credentials required'};}
  }));
  return results;
 }
 async function reserve(pool,q) {
  const pc=cfg.providers[q.provider] || {};
  if(!pc.key || micros(pc.monthly_cap || '0')===0n) return {reason:'quote only: key and positive monthly cap required'};
  if(q.provisionable===false || !pc.image || !pc.costs_bounded || pc.extra_hourly==null) return {reason:'quote only: prepared image and bounded disk/egress costs required'};
  if(q.currency!==pc.currency || q.expires_at<now() || !Number.isFinite(q.hourly) || q.hourly<=0) return {reason:'invalid or expired quote'};
  const p=await poolConfig(pool);
  const hourly=BigInt(Math.ceil(q.hourly*1e6))+micros(pc.extra_hourly);
  if(p.max_hourly!=null && hourly>micros(p.max_hourly)) return {reason:'total price exceeds pool ceiling'};
  const runtime=Math.min(3600000,Math.max(60000,p.max_runtime_ms || 3600000));
  // Reserve one extra billing quantum for asynchronous deletion. Stop before the reservation's deadline.
  const reserved=charge(hourly,runtime+300000,q.billing_seconds)+micros(q.setup || 0);
  const cap=micros(pc.monthly_cap);
  return db.tx(async t=>{
   await t.query('INSERT INTO run_compute_budget_locks (provider) VALUES ($1) ON CONFLICT DO NOTHING',['pool:'+pool]);
   await t.maybe('SELECT provider FROM run_compute_budget_locks WHERE provider=$1 FOR UPDATE',['pool:'+pool]);
   await t.query('INSERT INTO run_compute_budget_locks (provider) VALUES ($1) ON CONFLICT DO NOTHING',[q.provider]);
   await t.maybe('SELECT provider FROM run_compute_budget_locks WHERE provider=$1 FOR UPDATE',[q.provider]);
   const poolRows=await t.many("SELECT id FROM run_compute_rentals WHERE pool=$1 AND state <> 'released'",[pool]);
   if(poolRows.length >= (p.max_machines ?? 10)) return {reason:'pool machine limit reached'};
   const rows=await t.many("SELECT * FROM run_compute_rentals WHERE provider=$1 AND (month=$2 OR state <> 'released')",[q.provider,month()]);
   if(rows.some(r=>['uncertain','releasing'].includes(r.state))) return {reason:'an unresolved provider call blocks new rentals'};
   const settled=await t.value('SELECT COALESCE(SUM(c.amount_micros),0) FROM run_compute_charges c JOIN run_compute_rentals r ON r.id=c.rental WHERE r.provider=$1 AND c.month=$2',[q.provider,month()]);
   const committed=BigInt(settled)+rows.filter(r=>r.state!=='released').reduce((sum,r)=>sum+BigInt(r.reserved_micros),0n);
   if(committed+reserved>cap) return {reason:'monthly cap reached'};
   const r={id:'ov-'+randomUUID(),pool,provider:q.provider,month:month(),currency:q.currency,created_at:now(),deadline:now()+runtime,quote:q};
   await t.query("INSERT INTO run_compute_rentals (id,pool,provider,state,month,currency,hourly_micros,reserved_micros,quote,created_at,deadline) VALUES ($1,$2,$3,'provisioning',$4,$5,$6,$7,$8,$9,$10)",[r.id,pool,r.provider,r.month,r.currency,hourly.toString(),reserved.toString(),JSON.stringify(q),r.created_at,r.deadline]);
   await t.query('INSERT INTO run_compute_journal (at,event,rental,pool,detail) VALUES ($1,$2,$3,$4,$5)',[now(),'provision.reserved',r.id,pool,JSON.stringify({reserved_micros:reserved.toString(),hourly_micros:hourly.toString(),quote:q.id})]);
   return {rental:r};
  });
 }
 async function provision(pool,q) {
  if(cfg.dry_run || !cfg.enabled) return {dry_run:true,provider:q.provider,quote:q.id,hourly:q.hourly,currency:q.currency};
  const result=await reserve(pool,q); if(!result.rental) return result;
  const r=result.rental;
  try {
   const remote=await providers[q.provider].provision(q,{label:r.id,image:cfg.providers[q.provider].image});
   if(!remote?.id) throw new Error('no remote id');
   await db.query("UPDATE run_compute_rentals SET remote_id=$2,state='starting' WHERE id=$1",[r.id,String(remote.id)]);
   await journal('provision.accepted',{remote_id:String(remote.id)},r);
   return {rental:r.id};
  } catch {
   await db.query("UPDATE run_compute_rentals SET state='uncertain',last_error='provision outcome unknown; reservation retained' WHERE id=$1",[r.id]);
   await journal('provision.uncertain',{},r); return {reason:'provider outcome unknown; reservation retained'};
  }
 }
 async function release(r) {
  if(!r.remote_id) return;
  await db.query("UPDATE run_compute_rentals SET state='releasing' WHERE id=$1",[r.id]);
  await journal('release.requested',{},r);
  try {
   await providers[r.provider].release(r.remote_id);
   const h=await providers[r.provider].health(r.remote_id);
   if(!h.deleted) return; // A stop or accepted DELETE is not proof that billing ended.
   const q=obj(r.quote);
   const spent=charge(BigInt(r.hourly_micros),now()-Number(r.created_at),q.billing_seconds)+micros(q.setup || 0);
   await db.tx(async t=>{
    const locked=await t.maybe('SELECT state FROM run_compute_rentals WHERE id=$1 FOR UPDATE',[r.id]);
    if(locked.state==='released')return;
    const begin=Number(r.created_at),end=now();
    const setup=micros(q.setup || 0),runtime=spent-setup;
    let allocated=0n;
    for(let start=begin;start<end;) {
     const d=new Date(start),boundary=Math.min(end,Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));
     const share=boundary===end?runtime-allocated:runtime*BigInt(boundary-start)/BigInt(end-begin);
     const value=share+(start===begin?setup:0n);allocated+=share;
     await t.query('INSERT INTO run_compute_charges (rental,month,amount_micros) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[r.id,new Date(start).toISOString().slice(0,7),value.toString()]);
     start=boundary;
    }
    await t.query("UPDATE run_compute_rentals SET state='released',spent_micros=$2,released_at=$3,last_error=NULL WHERE id=$1",[r.id,spent.toString(),now()]);
   });
   await journal('release.confirmed',{spent_micros:spent.toString(),over_reservation:spent>BigInt(r.reserved_micros)},r);
  } catch {await db.query("UPDATE run_compute_rentals SET last_error='release unconfirmed; billing reservation retained' WHERE id=$1",[r.id]);}
 }
 async function tickOnce() {
  const rentals=await live();
  for(const r of rentals) {
   const pc=cfg.providers[r.provider] || {};
   if(r.state==='provisioning') { // another process may still be completing the call; do not retry it
    if(now()-Number(r.created_at)>60000) await db.query("UPDATE run_compute_rentals SET state='uncertain' WHERE id=$1 AND state='provisioning'",[r.id]);
    continue;
   }
   if(r.state==='releasing') {await release(r); continue;}
   const settled=BigInt(await db.value('SELECT COALESCE(SUM(c.amount_micros),0) FROM run_compute_charges c JOIN run_compute_rentals p ON p.id=c.rental WHERE p.provider=$1 AND c.month=$2',[r.provider,month()]));
   const committed=rentals.filter(x=>x.provider===r.provider).reduce((sum,x)=>sum+BigInt(x.reserved_micros),settled);
   let unhealthy=false;
   if(r.remote_id) { try { const h=await providers[r.provider].health(r.remote_id); unhealthy=h.deleted || ['error','stopped','off','dead'].includes(String(h.state).toLowerCase()); } catch { /* unknown health keeps the reservation and deadline */ } }
   const stop=!cfg.enabled || now()>=Number(r.deadline) || committed>micros(pc.monthly_cap || '0') || unhealthy;
   if(stop && r.remote_id) {
    await db.query("UPDATE run_compute_rentals SET state='draining' WHERE id=$1",[r.id]);
    if(r.machine && finish) for(const s of await db.many("SELECT id FROM run_sessions WHERE machine=$1 AND state <> 'ended'",[r.machine])) await finish(s.id);
    if(r.machine && finishJobs) await finishJobs(r.machine);
    const jobs=r.machine ? await db.value("SELECT count(*)::int FROM run_jobs WHERE node_id=$1 AND state IN ('placed','running')",[r.machine]):0;
    const count= r.machine ? await db.value("SELECT count(*)::int FROM run_sessions WHERE machine=$1 AND state <> 'ended'",[r.machine]):0;
    if(!count && !jobs) await release(r);
   }
  }
  if(!cfg.enabled || !cfg.owner || !desks.enabled) return;
  let hosts; try {hosts=await desks.hosts(cfg.owner);} catch {return;}
  // Bot returns a name only for this authenticated owner's own machines. A community seller cannot
  // claim a paid rental by copying its label. The prepared image must enroll a fresh Link identity.
  for(const r of await live()) {
   if(r.state!=='starting' || r.machine || !r.remote_id)continue;
   const matches=hosts.filter(h=>h.trust==='user-owned' && h.name===r.id && h.online);
   if(matches.length!==1)continue;
   const updated=await db.maybe("UPDATE run_compute_rentals SET machine=$2,state='running' WHERE id=$1 AND machine IS NULL AND state='starting' RETURNING id",[r.id,matches[0].machine_id]);
   if(updated)await journal('machine.bound',{machine:matches[0].machine_id,source:'authenticated owner host label'},r);
  }

  for(const id of Object.keys(cfg.pools)) {
   const p=await poolConfig(id);
   const all=await inventory(hosts,cfg.owner);
   const rows=(await live()).filter(r=>r.pool===id);
   const ms=all.filter(m=>m.pool===id || rows.some(r=>r.machine===m.id));
   for(const r of rows) {
    const m=ms.find(m=>m.id===r.machine);
    if(m) {
     if(m.sessions===0 && r.idle_since==null) await db.query('UPDATE run_compute_rentals SET idle_since=$2 WHERE id=$1',[r.id,now()]);
     if(m.sessions>0 && r.idle_since!=null) await db.query('UPDATE run_compute_rentals SET idle_since=NULL WHERE id=$1',[r.id]);
    } else ms.push({id:r.id,state:'provisioning',health:'starting',sessions:null});
   }
   const waiting=await db.many("SELECT created_at,compute_strategy FROM run_sessions WHERE compute_pool=$1 AND state='placing' AND machine_asked IS NULL AND (compute_strategy IS NULL OR compute_strategy <> 'own') ORDER BY created_at",[id]);
   const desired=scale(p,ms,waiting.map(s=>({created_at:Number(s.created_at)})),{now:now()});
   for(const a of desired.actions) {
    const r=rows.find(r=>r.machine===a.id || r.id===a.id);
    if(a.action==='drain' && r && !cfg.dry_run) {await db.query("UPDATE run_compute_rentals SET state='draining' WHERE id=$1",[r.id]);await journal('drain.started',{reason:a.reason},r);}
    if(a.action==='release' && r && !cfg.dry_run) await release(r);
    if(a.action==='provision') {
     const qs=(await quotes(id)).flatMap(x=>x.quotes).filter(q=>q.provisionable!==false && q.hourly!=null && q.currency===(p.currency || 'USD') && q.ram_mb>=((p.kind==='desktop'?2048:300)+1024));
     let candidates=qs.flatMap(q=>{
      const pc=cfg.providers[q.provider] || {};
      if(!cfg.dry_run && (!pc.key || micros(pc.monthly_cap || '0')===0n || !pc.image || !pc.costs_bounded || pc.extra_hourly==null))return [];
      const extra=pc.extra_hourly==null?0:Number(micros(pc.extra_hourly))/1e6;
      return [{...q,hourly:q.hourly+extra,id:q.provider+':'+q.id,health:'up',free_ram_mb:q.ram_mb-1024,free_slots:p.slots_per_machine || 1}];
     });
     while(true) {
      const d=choose({kind:p.kind,strategy:waiting[0]?.compute_strategy || p.strategy,region:p.region,gpu_mb:p.gpu_mb},candidates,p,{now:now()});
      const q=qs.find(q=>q.provider+':'+q.id===d.selected);
      if(!q){await journal('scale.decision',{reason:a.reason,decision:d,result:{reason:'no eligible rental quote'}},{pool:id});break;}
      const result=await provision(id,q);
      await journal('scale.decision',{reason:a.reason,decision:d,result},{pool:id});
      if(result.rental || result.dry_run || /unknown/.test(result.reason || ''))break;
      // A provider's exhausted cap or pending release must not hide eligible alternatives.
      candidates=candidates.filter(c=>c.provider!==q.provider);
     }
     break; // one fresh quote/reservation per pool/pass, observes previous launches on next pass
    }
   }
  }
 }
 function tick(){if(running)return running;running=tickOnce().finally(()=>{running=null;});return running;}
 async function status() {
  const rentals=await db.many('SELECT * FROM run_compute_rentals ORDER BY created_at DESC LIMIT 200');
  const budgets=[];
  for(const [provider,pc] of Object.entries(cfg.providers || {})) {
   const rs=await db.many("SELECT * FROM run_compute_rentals WHERE provider=$1 AND (month=$2 OR state <> 'released')",[provider,month()]);
   const settled=BigInt(await db.value('SELECT COALESCE(SUM(c.amount_micros),0) FROM run_compute_charges c JOIN run_compute_rentals r ON r.id=c.rental WHERE r.provider=$1 AND c.month=$2',[provider,month()]));
   let spent=settled,committed=settled,hourly=0n;
   for(const r of rs.filter(r=>r.state!=='released')){const h=BigInt(r.hourly_micros);spent+=charge(h,now()-Math.max(Number(r.created_at),Date.parse(month()+'-01T00:00:00Z')),obj(r.quote).billing_seconds);committed+=BigInt(r.reserved_micros);hourly+=h;}
   budgets.push({provider,currency:pc.currency,cap:pc.monthly_cap,configured:Boolean(pc.key),spent_micros:spent.toString(),committed_micros:committed.toString(),hourly_micros:hourly.toString()});
  }
  let machines=[];
  if(cfg.owner && desks.enabled) {try {machines=await inventory(await desks.hosts(cfg.owner),cfg.owner);} catch {machines=Object.entries(cfg.inventory).map(([id,v])=>({...v,id,health:'unknown'}));}}
  return {enabled:cfg.enabled,dry_run:cfg.dry_run,machines,pools:await Promise.all(Object.keys(cfg.pools).map(async id=>({id,...await poolConfig(id)}))),budgets,rentals,
   sessions:await db.many("SELECT machine,compute_pool,count(*)::int AS sessions FROM run_sessions WHERE state IN ('starting','running') GROUP BY machine,compute_pool"),
   journal:await db.many('SELECT * FROM run_compute_journal ORDER BY id DESC LIMIT 100')};
 }
 return {decide,inventory,quotes,reserve,provision,release,tick,status,poolConfig,
  async available(hosts){const blocked=new Set((await live()).filter(r=>['draining','releasing','uncertain'].includes(r.state)).map(r=>r.machine));return hosts.filter(h=>!blocked.has(h.machine_id));},
  async setStrategy(id,strategy){await poolConfig(id);if(!STRATEGIES.includes(strategy))throw Object.assign(new Error('invalid strategy'),{status:422});await db.query('INSERT INTO run_compute_pools (id,strategy) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET strategy=EXCLUDED.strategy',[id,strategy]);await journal('strategy.changed',{strategy},{pool:id});},
  async bind(id,machine){const r=await db.maybe("SELECT * FROM run_compute_rentals WHERE id=$1 AND state='starting'",[id]);if(!r)throw new Error('rental not starting');if(!cfg.inventory[machine] || cfg.inventory[machine].pool!==r.pool)throw new Error('machine must be in configured pool inventory');await db.query("UPDATE run_compute_rentals SET machine=$2,state='running' WHERE id=$1",[id,machine]);await journal('machine.bound',{machine},r);},
  attachSessions(fn){finish=fn;},
  attachJobs(fn){finishJobs=fn;},
  start(){if(!timer){timer=setInterval(()=>tick().catch(()=>log.warn('[Run] compute reconcile failed')),cfg.tick_ms || 30000);timer.unref?.();}},
  async stop(){if(timer)clearInterval(timer);timer=null;if(running)await running;},
 };
}
module.exports={createBroker};
