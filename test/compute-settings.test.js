'use strict';
const assert=require('node:assert/strict');
const {boot}=require('./helpers/app');
const {ids}=require('openvibe-contracts');
(async()=>{
 const t=await boot();
 try {
  await t.app.locals.initComputeSettings();
  const headers={'x-ov-subject':ids.newId('user'),'x-ov-fresh':'1'};
  const options={sub:'svc:network',cap:['run.config.manage'],headers};
  assert.equal((await t.call('GET','/internal/config',{...options,sub:'svc:actor'})).status,403);
  assert.equal((await t.call('GET','/internal/config',{...options,cap:['run.job.submit']})).status,403);
  const r=await t.call('GET','/internal/config',options);assert.equal(r.status,200,r.text);assert.equal(r.json.namespaces.length,5);
  const status=await t.call('GET','/internal/config/compute-status',options);assert.equal(status.status,200,status.text);assert.equal(status.json.budgets.length,8);
  const write=await t.call('POST','/internal/config/run.compute_daytona',{...options,body:{values:{max_concurrent:2},merge:true,reason:'test policy'}});
  assert.equal(write.status,200,write.text);assert.equal(t.config.compute.providers.daytona.max_concurrent,2);
  assert.equal(t.config.compute.providers.daytona.enabled,false);
  const secret=await t.call('PUT','/internal/config/run.compute_daytona/secrets/api_key',{...options,body:{value:'fake-only',reason:'test encryption refusal'}});
  assert.equal(secret.status,503,secret.text);
  assert.ok(!JSON.stringify((await t.call('GET','/internal/config',options)).json).includes('fake-only'));
  console.log('compute settings: Network-only scope, defaults off, live updates and no unencrypted secret writes passed');
 }finally{await t.close();}
 const sealed=await boot({appOpts:{env:{OV_CONFIG_KEKS:'test:'+require('node:crypto').randomBytes(32).toString('base64'),OV_CONFIG_KEK_CURRENT:'test'}}});
 try {
  await sealed.app.locals.initComputeSettings();
  const options={sub:'svc:network',cap:['run.config.manage'],headers:{'x-ov-subject':ids.newId('user'),'x-ov-fresh':'1'}};
  const secret='fake-provider-credential-for-test';
  const saved=await sealed.call('PUT','/internal/config/run.compute_daytona/secrets/api_key',{...options,body:{value:secret,reason:'test sealed key'}});
  assert.equal(saved.status,200,saved.text);assert.ok(!saved.text.includes(secret));
  assert.equal(sealed.config.compute.providers.daytona.key,secret);
  assert.ok(!JSON.stringify(await sealed.db.many('SELECT values_json FROM config_snapshots')).includes(secret),'database holds ciphertext only');
  const read=await sealed.call('GET','/internal/config/run.compute_daytona',options);assert.ok(!read.text.includes(secret));
  assert.equal((await sealed.call('PUT','/internal/config/run.compute_daytona/secrets/api_key',{...options,headers:{...options.headers,'x-ov-fresh':'0'},body:{value:'different-fake',reason:'stale sign-in'}})).status,403);
  console.log('provider secrets: sealed at rest, write-only responses and fresh sign-in required passed');
 }finally{await sealed.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
