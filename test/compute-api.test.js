'use strict';
const assert=require('node:assert/strict');
const {boot}=require('./helpers/app');
const {ids}=require('openvibe-contracts');
(async()=>{
 const owner=ids.newId('user'), stranger=ids.newId('user');
 const machine=ids.newId('device');
 const desks={enabled:true,note:'stub',hosts:async()=>[{machine_id:machine,trust:'user-owned',online:true,free:2,max_browser_desks:2}],lease:async()=>({ok:true}),get:async()=>({ok:true})};
 const t=await boot({appOpts:{desks},env:{RUN_COMPUTE_OPERATORS:owner,RUN_COMPUTE_POOLS:JSON.stringify({browser:{strategy:'own',currency:'USD'}}),RUN_COMPUTE_INVENTORY:JSON.stringify({[machine]:{pool:'browser',ram_mb:4096,region:'us'}})}});
 try {
  const as=u=>({token:t.network.signUser({subject:u})});
  assert.equal((await t.call('GET','/api/v1/compute?format=json',as(stranger))).status,403);
  assert.equal((await t.call('GET','/api/v1/compute?format=json',as(owner))).status,200);
  const form=await t.call('GET','/api/v1/compute',as(owner));assert.equal(form.status,200);assert.match(form.text,/Compute pools/);
  const start=await t.call('POST','/api/v1/sessions?pool=browser&strategy=own',{...as(owner),body:{kind:'browser'}});
  assert.equal(start.status,201,start.text);await t.app.locals.sessions.tick();
  const s=await t.call('GET',`/api/v1/sessions/${start.json.id}?explain=1`,as(owner));
  assert.equal(s.json.compute.selected,machine);assert.equal(s.json.compute.strategy,'own');assert.equal(s.json.compute.hourly,0);
  assert.equal((await t.call('GET',`/api/v1/sessions/${start.json.id}?explain=1`,as(stranger))).status,404);
  assert.equal((await t.call('POST','/api/v1/compute/pools/browser/strategy',{...as(owner),body:{strategy:'cheapest'},headers:{origin:'https://evil.example'}})).status,403);
  console.log('operator auth, CSRF, session strategy and owner-only cost explanation: passed');
 } finally {await t.close();}
})().catch(e=>{console.error(e);process.exit(1);});
