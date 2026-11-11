'use strict';
const assert=require('node:assert/strict');
const {testDb}=require('./helpers/db');
const {createBroker}=require('../server/compute/broker');
(async()=>{
 for(const scenario of ['credit','expired','expires during job','exhausted','promotion','own','partial credit','promo extras','memory','region','latency','job ceiling']) {
  const t=await testDb(), now=Date.UTC(2026,10,11), created=[];
  const config={compute:{enabled:true,dry_run:false,owner:'alice',inventory:{own:{pool:'p',ram_mb:4096}},
   pools:{p:{kind:'browser',strategy:'cheapest',currency:'USD',providers:['daytona','fly'],min_warm:1,max_machines:2}},providers:{}}};
  const adapters={};
  for(const [name,hourly] of [['daytona',.2],['fly',.02]]) {
   config.compute.providers[name]={managed:true,enabled:true,key:'fake',currency:'USD',monthly_cap:'10',image:'prepared',costs_bounded:true,extra_hourly:'0',allowed_kinds:['browser'],max_concurrent:2,
    credit_amount:name==='daytona'?(scenario==='credit'?'1':scenario==='partial credit'?'0.21':'0'):'0',credit_expires:scenario==='expired'?'2026-11-10T00:00:00Z':'2026-12-01T00:00:00Z',promotion_expires:['promotion','promo extras'].includes(scenario)&&name==='daytona'?'2026-11-16T00:00:00Z':''};
   adapters[name]={quote:async()=>[{provider:name,id:name,hourly,cpu:2,ram_mb:scenario==='memory'&&name==='daytona'?8192:4096,gpu_mb:0,currency:'USD',region:'us',tier:'partner',billing_seconds:1,expires_at:now+60000,promotion_expires:['promotion','promo extras'].includes(scenario)?'2026-11-16T00:00:00Z':''}],provision:async()=>{created.push(name);return {id:name};}};
  }
  if(scenario==='promo extras')config.compute.providers.daytona.extra_hourly='0.1';
  if(scenario==='expired')config.compute.providers.daytona.credit_amount='1';
  if(scenario==='expires during job'){config.compute.providers.daytona.credit_amount='1';config.compute.providers.daytona.credit_expires=new Date(now+60000).toISOString();}
  if(['memory','region','latency','job ceiling'].includes(scenario)) {
   const requirements={memory:{resources:{memory_mb:5000}},region:{region:'eu'},latency:{max_latency_ms:10},'job ceiling':{max_cost_usd:.001}}[scenario];
   await t.db.query("INSERT INTO run_sessions (id,owner,kind,state,width,height,ttl_s,idle_s,request_digest,created_at,updated_at,compute_pool,requirements) VALUES ('ses_need','user:alice','browser','placing',1280,720,900,60,'need',$1,$1,'p',$2)",[now-60000,JSON.stringify(requirements)]);
  }
  const desks={enabled:true,hosts:async()=>scenario==='own'?[{machine_id:'own',trust:'user-owned',online:true,max_browser_desks:2,free:2}]:[]};
  try {await createBroker({db:t.db,config,adapters,desks,now:()=>now}).tick();assert.deepEqual(created,['own','region','latency','job ceiling'].includes(scenario)?[]:[['credit','promotion','partial credit','memory'].includes(scenario)?'daytona':'fly'],scenario);}
  finally{await t.close();}
 }
 console.log('placement: own capacity, confirmed credit, promotion expiry and paid-price fallback passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
