import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OriginClient} from '../src/client.mjs';
import {refreshProposalPrices} from '../src/price-refresh.mjs';
import {runSync} from '../src/sync.mjs';
import {getResource} from '../src/resources.mjs';
const owner=randomUUID(),lease={lease_token:randomUUID()};
const candidate=n=>({source_id:String(100+n),proposal_id:'1',product_hash:'a'.repeat(64),proposal_hash:'b'.repeat(64),product_version:'1',proposal_version:'1',product_seen_at:'2026-10-16T00:00:00.123456+00:00'});
function fixture({budget=120,count=8,status=200,advance=0,precise=true,lost=false}={}){
 const calls=[],urls=[],sleeps=[];let time=Date.now();const token=randomUUID();
 const repo={async rpc(name,args,options){calls.push({name,args,options});if(name==='origin_sync_claim')return{acquired:true,lease_token:token};
  if(name.endsWith('_candidates'))return{items:Array.from({length:count},(_,i)=>candidate(i+1))};
  if(name.endsWith('_begin'))return{attempt_id:args.p_attempt_id,state:'pending',replayed:false};
  if(name.endsWith('_finish')){if(lost)throw new Error('private body NOT LOGGED');return{stored:true,conflict:false,replayed:false};}
  if(name.endsWith('_fail'))return{recorded:!lost,already_finished:lost};return{released:true};}};
 const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',priceCaptureEnabled:precise,maxRequests:budget,now:()=>time,intervalMs:0,sleep:async ms=>sleeps.push(ms),fetchImpl:async url=>{
  urls.push(url);time+=advance;return status===200?new Response(`{"data":{"id":"${url.split('/').at(-1)}","preco":0.1234567891}}`):Response.json({private:'NOT LOGGED'},{status});}});
 const opts=()=>({owner,lease,deadline:time+180000,now:()=>time,enabled:true,priceCaptureEnabled:true});
 return{repo,client,calls,urls,sleeps,opts,run:()=>refreshProposalPrices(repo,client,opts())};
}
test('060 opt-in requires both flags and never touches ports while disabled',async()=>{
 for(const opts of [{},{enabled:true},{priceCaptureEnabled:true},{enabled:'true',priceCaptureEnabled:true}]){
  const r=await refreshProposalPrices({}, {},opts);assert.equal(r.status,'disabled');assert.equal(r.requests,0);
 }
});
test('060 at most8 GETs, no HTTP retry, fixed product path and14 requests left for ordinary JSON',async()=>{
 for(const [budget,expected] of [[120,8],[20,6],[15,1],[14,0]]){const f=fixture({budget}),r=await f.run();assert.equal(r.requests,expected);assert.equal(f.urls.length,expected);assert.equal(r.stored,expected);assert.ok(f.client.remainingRequests>=14);assert.ok(f.urls.every(x=>/^https:\/\/api.provider.example\/Api\/v3\/produtos\/[1-9][0-9]*$/.test(x)));assert.equal(f.calls.filter(x=>x.name.endsWith('_finish')).length,expected);}
 for(const status of [401,429,403,503]){const f=fixture({status,count:2}),r=await f.run();assert.equal(f.urls.length,status===503?2:1);assert.equal(f.sleeps.length,0);assert.equal(r.stop_json,[401,429].includes(status));assert.doesNotMatch(JSON.stringify(r),/NOT LOGGED|synthetic-token|https/);}
});
test('06030s phase cap and20s JSON reservation apply before claim and throughout the loop',async()=>{
 const f=fixture({advance:16000}),r=await f.run();assert.equal(f.urls.length,2);assert.equal(r.status,'skipped_time');
 const g=fixture(),opts=g.opts();opts.deadline=opts.now()+24000;assert.equal((await refreshProposalPrices(g.repo,g.client,opts)).status,'skipped_time');assert.equal(g.calls.length,0);
 const h=fixture({count:1});await h.run();const begin=h.calls.find(x=>x.name.endsWith('_begin'));assert.ok(begin.options.deadline<=Date.now()+30000);assert.equal(h.calls.at(-1).name,'origin_sync_release');
});
test('060 unavailable release cannot spend the twenty-second JSON reserve',async()=>{
 const f=fixture({count:0}),opts=f.opts(),started=opts.now();opts.deadline=started+27000;let clock=started,releaseDeadline;
 opts.now=()=>clock;const original=f.repo.rpc;
 f.repo.rpc=async(n,a,o)=>{if(n==='origin_sync_release'){releaseDeadline=o.deadline;clock=o.deadline;throw new Error('DATABASE_TIME_BUDGET');}return original(n,a,o);};
 const result=await refreshProposalPrices(f.repo,f.client,opts);assert.equal(releaseDeadline,started+7000);assert.ok(opts.deadline-clock>=20000);assert.equal(result.status,'partial');assert.equal(result.errors.at(-1).code,'PRICE_LEASE_RELEASE_UNAVAILABLE');
});
test('060 uncertain finish only records failure conservatively; it never repeats the GET',async()=>{
 const f=fixture({count:1,lost:true}),r=await f.run();assert.equal(r.status,'partial');assert.equal(f.urls.length,1);assert.equal(f.calls.filter(x=>x.name.endsWith('_finish')).length,1);assert.equal(f.calls.filter(x=>x.name.endsWith('_fail')).length,1);assert.doesNotMatch(JSON.stringify(r),/private|NOT LOGGED/);
});
test('060 capture is mandatory and malformed/duplicate candidates cannot issue a request',async()=>{
 const f=fixture({count:1,precise:false}),r=await f.run();assert.equal(r.stored,0);assert.equal(f.calls.filter(x=>x.name.endsWith('_finish')).length,0);assert.equal(f.urls.length,1);
 const g=fixture({count:1}),original=g.repo.rpc;g.repo.rpc=(n,a,o)=>n.endsWith('_candidates')?{items:[candidate(1),candidate(1)]}:original(n,a,o);
 await assert.rejects(g.run(),/PRICE_CANDIDATES_INVALID/);assert.equal(g.urls.length,0);assert.equal(g.calls.at(-1).name,'origin_sync_release');
 const h=fixture({count:1});h.repo.rpc=(n,a,o)=>n.endsWith('_candidates')?{items:[{...candidate(1),product_version:'9223372036854775808'}]}:original(n,a,o);await assert.rejects(h.run(),/PRICE_CANDIDATES_INVALID/);
});
test('060 scheduler integrates only behind flag, propagates401/429 stop and preserves client precision flag',async()=>{
 for(const enabled of [false,true]){const calls=[],commits=[];let config,phases=0;
  class Client{constructor(_token,c){config=c;this.remainingRequests=120;this.requestsMade=0;}async get(){calls.push('json');this.requestsMade++;return[];}}
  const repo={async claim(){return{acquired:true,lease_token:randomUUID(),checkpoint_version:0,checkpoint:{}};},async apply(...a){commits.push(a);},async release(){}};
  const result=await runSync(repo,{ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2024-01-01',SYNC_TIME_ZONE:'America/Sao_Paulo',MAX_API_REQUESTS:'120',PRICE_CAPTURE_ENABLED:'true',PRICE_REFRESH_ENABLED:String(enabled)},
   {Client,getToken:async()=> 'synthetic',resources:[getResource('products_zero')],priceRefresher:async(_r,_c,o)=>{phases++;assert.equal(o.enabled,true);assert.equal(o.priceCaptureEnabled,true);return{status:'partial',attempted:1,stored:0,conflicts:0,requests:1,errors:[{code:'ORIGIN_HTTP_ERROR'}],stop_json:true};}});
  assert.equal(phases,Number(enabled));assert.equal(config.maxRequests,120);assert.equal(config.priceCaptureEnabled,true);assert.equal(calls.length,enabled?0:2);assert.equal(result.status,enabled?'partial':'completed');assert.equal(commits.at(-1)[0],'__scheduler__');
 }
});
