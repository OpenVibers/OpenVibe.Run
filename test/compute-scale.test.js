'use strict';
const assert=require('node:assert/strict');
const {testDb}=require('./helpers/db');
const {createBroker}=require('../server/compute/broker');
(async()=>{
 for(const scenario of ['total price','cap fallback','GPU fit','missing key']) {
  const t=await testDb();const now=Date.UTC(2026,10,8);const created=[];
  const config={compute:{enabled:true,dry_run:false,owner:'alice',inventory:{},pools:{workers:{kind:'browser',strategy:'cheapest',currency:'EUR',providers:['hetzner','ovh'],min_warm:1,max_machines:2,gpu_mb:scenario==='GPU fit'?8192:0}},providers:{}}};
  const adapters={};
  for(const [name,hourly,gpu_mb] of [['hetzner',0.1,0],['ovh',0.2,8192]]) {
   config.compute.providers[name]={key:'stub',monthly_cap:'10',currency:'EUR',image:'prepared',costs_bounded:true,extra_hourly:'0'};
   adapters[name]={quote:async()=>[{provider:name,id:name,hourly,gpu_mb,ram_mb:8192,currency:'EUR',region:'eu',tier:'dedicated',setup:0,billing_seconds:3600,expires_at:now+60000}],provision:async()=>{created.push(name);return {id:name};},health:async()=>({state:'running'}),release:async()=>{}};
  }
  if(scenario==='total price')config.compute.providers.hetzner.extra_hourly='0.5';
  if(scenario==='cap fallback')config.compute.providers.hetzner.monthly_cap='0.01';
  if(scenario==='missing key')config.compute.providers.hetzner.key='';
  const broker=createBroker({db:t.db,config,adapters,desks:{enabled:true,hosts:async()=>[]},now:()=>now});
  try {await broker.tick();assert.deepEqual(created,['ovh'],scenario);}
  finally {await t.close();}
 }
 console.log('autoscaler selects total cost, falls back on capped or unconfigured providers, and enforces GPU fit: passed');
})().catch(e=>{console.error(e);process.exit(1);});
