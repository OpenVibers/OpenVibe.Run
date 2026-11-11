'use strict';
const express=require('express');
const {STRATEGIES}=require('openvibe-sdk/compute');
const esc=s=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function computeRouter({broker,config}) {
 const r=express.Router();
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 r.use('/compute',(req,res,next)=>{
  if(req.principal?.kind!=='user' || ![...(config.compute?.operators || []),config.compute?.owner].includes(req.principal.subject))return res.status(403).json({error:'operator access required'});
  if(req.method!=='GET' && req.get('origin')!==config.baseUrl)return res.status(403).json({error:'same-origin write required'});
  next();
 });
 r.get('/compute',wrap(async(req,res)=>{
  const s=await broker.status();
  if(req.query.format==='json')return res.json(s);
  const money=v=>(Number(v)/1e6).toFixed(4);
  const machines=[...s.machines.map(m=>({...m,machine:m.id,provider:s.rentals.find(r=>r.machine===m.id)?.provider || 'existing',hourly_micros:m.hourly==null?null:m.hourly*1e6})),...s.rentals.filter(r=>!s.machines.some(m=>m.id===r.machine)).map(r=>({...r,tier:(typeof r.quote==='string'?JSON.parse(r.quote):r.quote).tier}))];
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Compute pools · OpenVibe Run</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui}body{margin:0;background:light-dark(#f6f8fa,#101519);color:light-dark(#16232c,#e6edf2)}main{max-width:1100px;margin:auto;padding:24px}h1{font-size:2rem;line-height:1.2}h2{margin-top:2rem}section{padding:20px;margin:16px 0;border:1px solid #70809060;border-radius:12px}button,select{font:inherit;min-height:44px;padding:8px 12px;border-radius:6px;border:1px solid #70809080}form{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}a{color:light-dark(#075a85,#87d6ff)}table{display:block;overflow-x:auto;border-collapse:collapse;max-width:100%;text-align:left}th,td{padding:10px;border-bottom:1px solid #70809060;white-space:nowrap}ol{padding-left:24px}li{overflow-wrap:anywhere;margin:12px 0}@media(max-width:600px){main{padding:16px}h1{font-size:1.7rem}}</style><body><main><h1>Compute pools</h1><p>${s.dry_run?'Dry run — rentals disabled':'Live rentals within configured caps'} · ${s.enabled?'Reconciler enabled':'Reconciler disabled'}</p><h2>Pools</h2>${s.pools.map(p=>`<section><h3>${esc(p.id)}</h3><p>Strategy: ${esc(p.strategy)} · Warm minimum: ${esc(p.min_warm || 0)} · Queue target: ${esc(p.target_wait_ms ?? 30000)} ms</p><form method="post" action="/api/v1/compute/pools/${esc(p.id)}/strategy"><select name="strategy">${STRATEGIES.map(v=>`<option${v===p.strategy?' selected':''}>${v}</option>`).join('')}</select><button>Apply strategy</button></form><a href="/api/v1/compute/pools/${esc(p.id)}/quotes">Quotes and dry-run prices</a></section>`).join('')}<h2>Money</h2>${s.budgets.filter(b=>b.near_cap).map(b=>`<p role="alert">${esc(b.provider)} has committed at least 80% of its monthly cap.</p>`).join('')}<table><tr><th>Provider</th><th>Currency</th><th>Per hour</th><th>This month</th><th>Committed</th><th>Cap</th></tr>${s.budgets.map(b=>`<tr><td>${esc(b.provider)}</td><td>${esc(b.currency)}</td><td>${money(b.hourly_micros)}</td><td>${money(b.spent_micros)}</td><td>${money(b.committed_micros)}</td><td>${esc(b.cap)}</td></tr>`).join('')}</table><h2>Machines</h2><table><tr><th>Pool</th><th>Machine / rental</th><th>Tier / provider</th><th>State</th><th>Sessions</th><th>Per hour</th></tr>${machines.map(m=>`<tr><td>${esc(m.pool)}</td><td>${esc(m.machine || m.id)}</td><td>${esc(m.tier)} / ${esc(m.provider)}</td><td>${esc(m.state || m.health)}</td><td>${s.sessions.find(x=>x.machine && x.machine===m.machine)?.sessions || 0}</td><td>${m.hourly_micros==null?'unknown':money(m.hourly_micros)} ${esc(m.currency)}</td></tr>`).join('')}</table><h2>Last decisions and switches</h2><ol>${s.journal.map(j=>`<li>${esc(new Date(Number(j.at)).toISOString())} ${esc(j.event)} ${esc(JSON.stringify(j.detail))}</li>`).join('')}</ol></main></body></html>`);
 }));
 r.get('/compute/pools/:pool/quotes',wrap(async(req,res)=>res.json({dry_run:true,providers:await broker.quotes(req.params.pool)})));
 r.post('/compute/pools/:pool/strategy',express.urlencoded({extended:false,limit:'2kb'}),wrap(async(req,res)=>{await broker.setStrategy(req.params.pool,req.body.strategy);res.redirect(303,'/api/v1/compute');}));
 r.post('/compute/rentals/:id/bind',wrap(async(req,res)=>{await broker.bind(req.params.id,String(req.body.machine || ''));res.json({ok:true});}));
 return r;
}
module.exports={computeRouter};
