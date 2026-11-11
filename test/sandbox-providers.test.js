'use strict';
const assert=require('node:assert/strict');
const {createSandboxProviders,createPriceReader}=require('../server/compute/sandbox-providers');
(async()=>{
 const now=Date.UTC(2026,10,11), config={providers:{}}, calls=[];
 for(const name of ['baseten','daytona','e2b','fly']) config.providers[name]={key:'fake-key',project:'app',price_id:name,region:'us'};
 const prices=async()=>Object.keys(config.providers).map(provider=>({id:provider,provider,region:'us',hourly:.1,ram_mb:4096,cpu:2,expires_at:now+60000}));
 let deleted=false;
 const adapters=createSandboxProviders({config,now:()=>now,prices,fetchImpl:async(url,opts)=>{
  calls.push({url,...opts}); return {ok:!deleted,status:deleted?404:200,json:async()=>({id:'remote',name:'remote',sandboxID:'remote',state:'running',cpuCount:2,memoryMB:4096})};
 }});
 for(const [name,a] of Object.entries(adapters)) {
  deleted=false; const [q]=await a.quote(); assert.ok(q);assert.deepEqual(await a.quote({gpu_mb:1}),[]);
  assert.deepEqual(await a.provision(q,{label:'ov-test',image:'prepared',runtime_ms:120000}),{id:'remote'});
  const request=calls.at(-1);assert.equal(request.redirect,'error');assert.ok(!request.body.includes('fake-key'));
  if(name==='baseten')assert.equal(JSON.parse(request.body).lifecycle.expiration_policies[0].value,'120s');
  if(name==='daytona'){assert.equal(JSON.parse(request.body).ttlMinutes,2);assert.equal(JSON.parse(request.body).cpu,2);assert.equal(JSON.parse(request.body).memory,4);}
  if(name==='e2b')assert.equal(JSON.parse(request.body).timeout,120);
  assert.equal((await a.health('remote')).deleted,false);
  await a.release('remote'); deleted=true; assert.equal((await a.health('remote')).deleted,true);
  config.providers[name].region='elsewhere';assert.deepEqual(await a.quote(),[]);
 }
 let attempts=0;
 const read=createPriceReader({now:()=>now,fetchImpl:async()=>{attempts++;throw Error('offline');}});
 assert.deepEqual(await read(),[]);assert.equal(attempts,1);
 console.log('four sandbox adapters: lifecycle, bounded timeouts, GPU/region refusal, credential isolation and price outage passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
