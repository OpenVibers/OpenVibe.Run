'use strict';
const assert=require('node:assert/strict');
const {testDb}=require('./helpers/db');
const {createBroker}=require('../server/compute/broker');
(async()=>{
 const t=await testDb();let now=Date.UTC(2026,10,11);
 const pc={managed:true,enabled:false,key:'fake',monthly_cap:'1',currency:'USD',image:'prepared',costs_bounded:true,extra_hourly:'0',max_concurrent:1,allowed_kinds:['browser']};
 const config={compute:{enabled:true,dry_run:false,owner:'alice',inventory:{},pools:{p:{kind:'browser',max_runtime_ms:3600000}},providers:{baseten:pc}}};
 const q={id:'q',provider:'baseten',currency:'USD',hourly:.8,expires_at:now+60000,billing_seconds:1};
 const b=createBroker({db:t.db,config,desks:{enabled:false},adapters:{},now:()=>now});
 try {
  assert.match((await b.reserve('p',q)).reason,/disabled/);
  pc.enabled=true;pc.allowed_kinds=['agent'];assert.match((await b.reserve('p',q)).reason,/kind/);
  pc.allowed_kinds=['browser'];pc.promotion_expires='2026-11-10T00:00:00Z';assert.match((await b.reserve('p',q)).reason,/expired/);
  pc.promotion_expires='';assert.ok((await b.reserve('p',q)).rental);
  assert.match((await b.reserve('p',q)).reason,/concurrency/);
  assert.equal((await t.db.many("SELECT * FROM run_compute_journal WHERE event='budget.near_cap'")).length,1);
  assert.equal((await b.status()).budgets[0].near_cap,true);
  pc.max_concurrent=2;assert.match((await b.reserve('p',q)).reason,/monthly cap/);
  console.log('provider off/kind/expiry checks, concurrent reservation limit, hard cap and 80% alert: passed');
 } finally {await t.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
