'use strict';
const assert=require('node:assert/strict');
const {createPlacement}=require('../server/dispatch/placement');
(async()=>{
 const now=Date.now(), node='dev_01J8Z4M2Q0R7T9YV3K6N8P1W2X',pc={managed:true,enabled:true,allowed_kinds:['browser']};
 const config={network:{url:'https://network.invalid'},oauth:{},dispatch:{offersTtlMs:0,timeoutMs:1000},compute:{job_pool:'p',pools:{p:{strategy:'cheapest',currency:'USD'}},inventory:{[node]:{hourly:0,free_ram_mb:4096,free_slots:1}},providers:{daytona:pc}}};
 const rental={machine:node,state:'running',pool:'p',provider:'daytona',currency:'USD',hourly_micros:'200000',quote:{tier:'partner'}};
 const offer={offer_id:'off_node_01',node_id:node,kind:'node',region:'us',trust:'first-party',capabilities:['worker:browser'],health:{status:'up',checked_at:new Date(now).toISOString()},pricing:{model:'prepaid'},updated_at:new Date(now).toISOString()};
 const placer=createPlacement({config,now:()=>now,db:{many:async()=>[rental],maybe:async()=>null},fetchImpl:async()=>({ok:true,json:async()=>({offers:[offer]})})});
 const row={class:'browser',requester:'service:actor',job:{requirements:{...require('../server/util').requirementsDefault('browser'),objective:'cheapest'}}};
 const chosen=await placer.choose(row);assert.ok(chosen);assert.equal(chosen.trust,'partner');assert.ok(chosen.reasons.some(x=>x.includes('0.2 USD/hour')),'actual rental price overrides inventory zero');
 row.job.requirements.objective='private';assert.equal(await placer.choose(row),null,'enrollment cannot turn third-party rental into private compute');
 row.job.requirements.objective='cheapest';pc.allowed_kinds=['code'];assert.equal(await placer.choose(row),null);
 pc.allowed_kinds=['browser'];config.compute.job_pool='';assert.equal(await placer.choose(row),null,'rentals never escape the configured job pool');
 console.log('job rental trust: provider scope, privacy and gross rental price passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
