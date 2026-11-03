import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OriginClient} from '../src/client.mjs';
import {fetchMissingReferences} from '../src/reference-fetch.mjs';
const owner=randomUUID(),lease={lease_token:randomUUID()};
const candidate=(n,entity=n%2?'contacts':'products')=>({entity,source_id:String(100+n),proposal_id:'1',proposal_hash:'a'.repeat(64),proposal_version:'1'});
function fixture({count=10,budget=120,status=200,advance,failFinish=false}={}){
 const calls=[],urls=[],sleeps=[],resourceToken=randomUUID();let time=Date.now();
 const repo={async rpc(name,args,options){calls.push({name,args,options});
  if(name==='origin_sync_claim')return{acquired:true,lease_token:resourceToken};
  if(name.endsWith('_candidates'))return{items:Array.from({length:count},(_,i)=>candidate(i+1))};
  if(name.endsWith('_begin'))return{attempt_id:args.p_attempt_id,state:'pending',replayed:false};
  if(name.endsWith('_finish')){if(failFinish)throw new Error('PRIVATE NAME body');return{stored:true,conflict:false,replayed:false};}
  if(name.endsWith('_fail'))return{recorded:!failFinish,already_finished:failFinish};
  return{released:true};
 }};
 const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',maxRequests:budget,intervalMs:0,now:()=>time,sleep:async ms=>sleeps.push(ms),fetchImpl:async url=>{
  urls.push(url);if(advance)time+=advance;
  const responseStatus=typeof status==='function'?status(url):status;
  return responseStatus===200?Response.json({data:{id:url.split('/').at(-1)}}):Response.json({private:'NOT LOGGED'},{status:responseStatus});
 }});
 const run=()=>fetchMissingReferences(repo,client,{owner,lease,deadline:time+180000,now:()=>time});
 return{calls,urls,sleeps,client,repo,run};
}
test('directed phase uses at most ten HTTP requests and leaves fourteen for JSON',async()=>{
 for(const [budget,expected] of [[120,10],[20,6],[15,1],[14,0]]){
  const f=fixture({budget}),r=await f.run();assert.equal(r.requests,expected);assert.equal(f.urls.length,expected);assert.equal(r.stored,expected);assert.ok(f.client.remainingRequests>=14);
  assert.ok(f.urls.every(x=>/^https:\/\/api.provider.example\/Api\/v3\/(contatos|produtos)\/[1-9][0-9]*$/.test(x)));
  assert.ok(!f.calls.some(x=>x.name==='origin_sync_apply_batch'));
 }
});
test('429/401 stop immediately without client retry; 403 suspends only that entity',async()=>{
 for(const status of [401,429,503]){
  const f=fixture({status,count:2}),r=await f.run();assert.equal(f.sleeps.length,0);
  assert.equal(f.urls.length,status===503?2:1);assert.equal(r.stop_json,status!==503);
  assert.equal(f.calls.filter(x=>x.name.endsWith('_fail')).length,status===503?2:1);
 }
 const f=fixture({status:url=>url.includes('/contatos/')?403:200}),r=await f.run();
 assert.equal(f.urls.filter(x=>x.includes('/contatos/')).length,1);assert.equal(r.stored,5);assert.equal(r.stop_json,false);
 assert.doesNotMatch(JSON.stringify(r),/NOT LOGGED|synthetic-token|http/);
});
test('maxAttempts is validated while default client still retries 503',async()=>{
 let calls=0;const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,sleep:async()=>{},fetchImpl:async()=>{calls++;return Response.json({},{status:503});}});
 for(const value of [0,4,1.1,'1',null])await assert.rejects(client.get('/contatos/1',{}, {maxAttempts:value}),{code:'ORIGIN_INVALID_CLIENT_CONFIG'});
 assert.equal(calls,0);await assert.rejects(client.get('/contatos/1'),{status:503});assert.equal(calls,3);
 await assert.rejects(client.get('/contatos/1',{}, {maxAttempts:1}),{status:503});assert.equal(calls,4);
});
test('phase deadline prevents extra requests and lost finish does not resend GET',async()=>{
 const timed=fixture({advance:16000});const r=await timed.run();assert.equal(timed.urls.length,3);assert.equal(r.status,'skipped_time');
 const lost=fixture({count:1,failFinish:true}),out=await lost.run();assert.equal(lost.urls.length,1);assert.equal(out.status,'partial');
 assert.equal(lost.calls.filter(x=>x.name.endsWith('_finish')).length,1);assert.equal(lost.calls.filter(x=>x.name.endsWith('_fail')).length,1);
 assert.doesNotMatch(JSON.stringify(out),/PRIVATE|NAME|body/);
});
test('duplicate/malformed candidates and detail mismatch never store; exact resource fence released',async()=>{
 const f=fixture({count:1});const original=f.repo.rpc;
 f.repo.rpc=async(name,args,options)=>name.endsWith('_candidates')?{items:[candidate(1),candidate(1)]}:original(name,args,options);
 await assert.rejects(f.run(),/REFERENCE_CANDIDATES_INVALID/);assert.equal(f.urls.length,0);assert.equal(f.calls.at(-1).name,'origin_sync_release');
 const g=fixture({count:1});const client={requestsMade:0,remainingRequests:100,async get(){this.requestsMade++;return{id:'999'};}};
 const out=await fetchMissingReferences(g.repo,client,{owner,lease,deadline:Date.now()+60000});
 assert.equal(out.stored,0);assert.ok(!g.calls.some(x=>x.name.endsWith('_finish')));assert.equal(g.calls.filter(x=>x.name.endsWith('_fail')).length,1);
});

test('reference phase leaves twenty seconds of total runtime for ordinary JSON',async()=>{
 const f=fixture();const now=Date.now();
 const r=await fetchMissingReferences(f.repo,f.client,{owner,lease,deadline:now+24000,now:()=>now});
 assert.equal(r.status,'skipped_time');assert.equal(f.calls.length,0);assert.equal(f.urls.length,0);
});
