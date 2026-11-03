import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runSync,syncPage} from '../src/sync.mjs';
import {collectXml} from '../src/xml-sync.mjs';
import {OriginClient,OriginApiError} from '../src/client.mjs';
import {Repository} from '../src/repository.mjs';
import {getResource} from '../src/resources.mjs';
import {keyFor,invoice,encoded} from './xml-fixtures.mjs';
const candidate=(id,model='55')=>({entity:model==='55'?'nfe':'nfce',source_id:String(id),key:keyFor(model),fingerprint:'a'.repeat(64)});
const env={ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',XML_SYNC_ENABLED:'true',XML_RESIDUAL_ENABLED:'true',SYNC_START_DATE:'2024-01-01',MAX_API_REQUESTS:'120',FINANCE_REFRESH_ENABLED:'true'};
const empty=()=>({status:'completed',attempted:0,stored:0,unchanged:0,conflicts:0,unavailable_balance:0,requests:0,errors:[],stop_json:false});
const originTime=Date.now();
function harness({remaining=8,retries=false,primaryStatus,tailStatus,failRpc,slowJson=false,repeated=false,jsonStatus}={}){
 let clock=originTime,pages=0,candidateReads=0,xmlRequests=0,tailRequests=0;
 const start=clock,trace=[],commits=[],releases=[],rpcs=[],heartbeats=[],signals=[];
 const first=[candidate(1),candidate(2,'65')],tail=[candidate(3),candidate(4,'65'),candidate(5),candidate(6,'65')];
 const repo={async claim(resource,_owner,_ttl,options){trace.push(['claim',resource]);return{acquired:true,lease_token:randomUUID(),checkpoint_version:0,checkpoint:{}};},async renew(){},
  async apply(...args){commits.push(args);trace.push(['apply',args[0]]);return{checkpoint_version:1};},async release(...args){releases.push(args);},
  async rpc(name,args,options){rpcs.push({name,args,options});
   if(name==='origin_sync_renew')return{renewed:true};
   if(name==='origin_sync_xml_candidates'){candidateReads++;return{items:candidateReads===1?first:repeated?[first[0],...tail.slice(0,3)]:tail};}
   if(name===failRpc)throw new Error('DATABASE_UNAVAILABLE');
   if(name==='origin_sync_xml_begin')return{attempt_id:randomUUID(),entity:args.p_entity,source_id:args.p_source_id,key:args.p_key,fingerprint:args.p_fingerprint};
   if(name==='origin_sync_xml_finish')return{stored:true,files:args.p_documents.length,unchanged:false};
   if(name==='origin_sync_xml_fail')return{recorded:true};
   throw new Error('UNEXPECTED_RPC');
  }};
 class Client extends OriginClient{
  constructor(token,options){super(token,{...options,now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
   signals.push(init.signal);const path=new URL(url).pathname;trace.push(['get',path,clock]);
   if(path.includes('/documento/')){
    xmlRequests++;const isTail=candidateReads>1;if(isTail)tailRequests++;
    const status=isTail?tailStatus:primaryStatus;
    if(status)return new Response('',{status,headers:{'retry-after':'0'}});
    if(isTail&&retries&&tailRequests%3!==0)return new Response('',{status:503});
    return Response.json({data:[encoded(invoice(path.endsWith(keyFor('65'))?'65':'55'))]});
   }
   if(/\/contatos$/.test(path)){
    if(jsonStatus)return new Response('',{status:jsonStatus,headers:{'retry-after':'0'}});
    pages++;if(slowJson)clock=start+159000;
    return Response.json({data:Array.from({length:remaining===12&&pages===10?6:10},(_,i)=>({id:i+1}))});
   }
   return Response.json({data:{id:Number(path.split('/').at(-1))}});
  }});}
 }
 const collector=(r,c,o)=>collectXml(r,c,{...o,storage:{async ensure(){trace.push(['storage']);}},heartbeat:async deadline=>{heartbeats.push(deadline);await o.heartbeat(deadline);}});
 const run=(extra={})=>runSync(repo,{...env,...extra},{Client,getToken:async()=>'synthetic-token',clock:()=>clock,now:()=>new Date(clock),resources:Array(6).fill(getResource('contacts')),xmlCollector:collector,financeRefresher:async()=>{trace.push(['finance']);return empty();}});
 return{run,repo,trace,commits,releases,rpcs,heartbeats,signals,start,get clock(){return clock;},get xmlRequests(){return xmlRequests;},get candidateReads(){return candidateReads;}};
}

test('flag off preserves initial 2/6 collection and JSON/finance sequence; residual uses only leftover calls',async()=>{
 const off=harness(),base=await off.run({XML_RESIDUAL_ENABLED:'false'});
 assert.equal(off.candidateReads,1);assert.equal(base.requests,112);assert.equal(base.xml.keys,2);assert.equal(base.xml_residual,undefined);
 const on=harness(),result=await on.run();
 assert.equal(on.candidateReads,2);assert.equal(result.requests,116);assert.equal(result.xml.keys,6);assert.equal(result.xml.requests,6);assert.equal(result.xml_residual.keys,4);
 const json=h=>h.trace.filter(x=>x[0]==='get'&&!x[1].includes('/documento/')).map(x=>x[1]);assert.deepEqual(json(on),json(off));
 const checkpoints=h=>h.commits.filter(x=>x[0]!=='__scheduler__').map(x=>({resource:x[0],records:x[4],checkpoint:x[5]}));assert.deepEqual(checkpoints(on),checkpoints(off));
 assert.equal(on.commits.at(-1)[5].nextIndex,off.commits.at(-1)[5].nextIndex);assert.equal(result.pages,base.pages);assert.equal(result.finance_refresh.attempted,base.finance_refresh.attempted);
 const gets=on.trace.filter(x=>x[0]==='get');for(let i=1;i<gets.length;i++)assert.ok(gets[i][2]-gets[i-1][2]>=700);
 assert.ok(on.trace.findIndex(x=>x[0]==='finance')>on.trace.findIndex(x=>x[0]==='storage'));
 assert.ok(on.trace.findIndex(x=>x[0]==='finance')<on.trace.findIndex(x=>x[0]==='claim'&&x[1]==='contacts'));
 assert.deepEqual(on.rpcs.filter(x=>x.name==='origin_sync_xml_candidates').map(x=>x.args.p_limit),[2,4]);
 assert.equal(on.commits.at(-1)[6].deadline,on.start+175000);assert.equal(on.releases.at(-1)[3].deadline,on.start+180000);
 assert.ok(on.commits.slice(0,-1).every(x=>x[6].deadline===on.start+160000));assert.ok(on.heartbeats.every(Number.isFinite));
 assert.doesNotMatch(JSON.stringify(result),/source_id|fingerprint|synthetic-token|access_key/);
});
for(const status of [401,403,429])test(`residual HTTP ${status} stops before a second candidate`,async()=>{
 const h=harness({tailStatus:status}),r=await h.run();assert.equal(h.candidateReads,2);assert.equal(r.pages,10);
 assert.equal(h.rpcs.filter(x=>x.name==='origin_sync_xml_begin').length,3);assert.equal(r.xml_residual.stop_json,status!==403);
 assert.equal(r.xml_residual.requests,status===429?3:1);
});
for(const status of [401,403,429])test(`JSON HTTP ${status} cannot start the optional XML pass`,async()=>{
 const h=harness({jsonStatus:status}),r=await h.run();assert.equal(h.candidateReads,1);assert.equal(r.xml_residual.status,'skipped_stopped');assert.equal(r.pages,0);
});
for(const remaining of [8,12])test(`residual budget ${remaining} reserves all three retries and never exceeds 120 requests`,async()=>{
 const h=harness({remaining,retries:true}),r=await h.run();
 assert.equal(r.xml_residual.requests,remaining===8?6:12);assert.equal(r.xml_residual.keys,remaining===8?2:4);
 assert.equal(r.requests,remaining===8?118:120);assert.equal(r.pages,10);
 const gets=h.trace.filter(x=>x[0]==='get');for(let i=1;i<gets.length;i++)assert.ok(gets[i][2]-gets[i-1][2]>=700);
});
test('shared examination set skips a repeated source/key even after its primary success',async()=>{
 const h=harness({repeated:true}),r=await h.run();assert.equal(r.xml_residual.keys,3);assert.equal(h.xmlRequests,5);
 const starts=h.rpcs.filter(x=>x.name==='origin_sync_xml_begin').map(x=>x.args.p_entity+'/'+x.args.p_source_id);assert.equal(new Set(starts).size,starts.length);
});
for(const status of [401,403,429])test(`primary HTTP ${status} suppresses residual; only 403 preserves legacy JSON work`,async()=>{
 const h=harness({primaryStatus:status}),r=await h.run();assert.equal(h.candidateReads,1);assert.equal(r.xml_residual.status,'skipped_stopped');assert.equal(r.pages,status===403?10:0);
 assert.equal(h.trace.filter(x=>x[0]==='finance').length,status===403?1:0);
});
for(const rpc of ['origin_sync_xml_begin','origin_sync_xml_finish','origin_sync_xml_fail'])test(`unconfirmed ${rpc} prevents a second examination and residual pass`,async()=>{
 const h=harness({failRpc:rpc,...(rpc.endsWith('_fail')?{primaryStatus:400}:{})}),r=await h.run();assert.equal(h.candidateReads,1);assert.equal(r.xml_residual.status,'skipped_stopped');
 assert.equal(h.rpcs.filter(x=>x.name==='origin_sync_xml_begin').length,1);assert.equal(h.xmlRequests,rpc.endsWith('_begin')?0:1);assert.ok(r.pages>0);
});
test('known document 400 records backoff, permits JSON, and never repeats a visited source',async()=>{
 const h=harness({primaryStatus:400,repeated:true}),r=await h.run();assert.equal(h.candidateReads,2);assert.equal(r.pages,10);assert.equal(r.xml_residual.keys,3);
 assert.ok(h.rpcs.filter(x=>x.name==='origin_sync_xml_fail').every(x=>x.args.p_retry_seconds===3600));
});
test('slow JSON consumes no residual time or calls; every page finalization uses the working deadline',async()=>{
 const h=harness({slowJson:true}),r=await h.run();assert.equal(h.candidateReads,1);assert.equal(r.xml_residual.status,'skipped_time');assert.ok(h.clock<h.start+180000);
 assert.ok(h.releases.filter(x=>x[0]!=='__scheduler__').every(x=>x[3].deadline===h.start+160000));
});
test('late begin/heartbeat/Storage never starts an expired GET or finish',async()=>{
 for(const at of ['begin','heartbeat','storage']){
  let clock=1000,gets=0,finishes=0;const c=candidate(1),calls=[];
  const repo={async rpc(name,args){calls.push(name);if(name.endsWith('_candidates'))return{items:[c]};if(name.endsWith('_begin')){if(at==='begin')clock=22000;return{attempt_id:randomUUID(),entity:c.entity,source_id:c.source_id,key:c.key,fingerprint:c.fingerprint};}if(name.endsWith('_finish')){finishes++;return{stored:true,files:1,unchanged:false};}return{recorded:true};}};
  const client={requestsMade:0,remainingRequests:120,async get(){gets++;this.requestsMade++;return[encoded(invoice())];}};
  await collectXml(repo,client,{owner:randomUUID(),lease:{lease_token:randomUUID()},deadline:100000,now:()=>clock,heartbeat:async()=>{if(at==='heartbeat')clock=22000;},storage:{async ensure(){clock=22000;}}});
  assert.equal(gets,at==='storage'?1:0);assert.equal(finishes,0);
 }
});
test('stock JSON checkpoint also forwards the working deadline',async()=>{
 const calls=[],repo={async claim(){return{acquired:true,lease_token:randomUUID(),checkpoint:{},checkpoint_version:0};},async rpc(){return{items:[],has_more:false,next_cursor:null,coverage_complete:false};},async apply(...args){calls.push(args);return{};},async release(...args){calls.push(args);}};
 const deadline=Date.now()+1000;
 await syncPage(repo,{},getResource('stock_balances'),'owner',env,new Date(),{deadline,boundDatabase:true});
 assert.equal(calls[0][6].deadline,deadline);assert.equal(calls[1][3].deadline,deadline);
});
test('Repository apply/release stop at their real deadlines, cancel stalled readers and retain exact retry UUID/body',async()=>{
 const bodies=[],signals=[];let cancellations=0;
 const repo=new Repository({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'}, {sleep:async()=>{},fetchImpl:async(_u,init)=>{
  signals.push(init.signal);bodies.push(init.body);return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancellations++;return new Promise(()=>{});}}));
 }});
 const started=Date.now();await assert.rejects(repo.apply('__scheduler__','control','owner',{lease_token:'fence',checkpoint_version:0},[],{nextIndex:0},{deadline:Date.now()+20}),/DATABASE_(?:TIMEOUT|TIME_BUDGET)/);
 assert.ok(Date.now()-started<1000);assert.ok(signals.every(s=>s.aborted));assert.equal(cancellations,1);
 await assert.rejects(repo.release('__scheduler__','owner','fence',{deadline:Date.now()-1}),/DATABASE_TIME_BUDGET/);assert.equal(bodies.length,1);
 const retryBodies=[];const retry=new Repository({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{sleep:async()=>{},fetchImpl:async(_u,init)=>{retryBodies.push(init.body);return retryBodies.length<3?new Response('',{status:503}):Response.json({checkpoint_version:1});}});
 await retry.apply('__scheduler__','control','owner',{lease_token:'fence',checkpoint_version:0},[],{nextIndex:0},{deadline:Date.now()+1000});assert.equal(retryBodies.length,3);assert.equal(new Set(retryBodies).size,1);
});
test('Repository refuses empty chunks and cancels a response received after timeout without parsing it',async()=>{
 let calls=0,cancelled=0;
 const config={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
 const empty=new Repository(config,{fetchImpl:async()=>{calls++;return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;}}));}});
 await assert.rejects(empty.rpc('origin_sync_status'),/DATABASE_INVALID_RESPONSE/);assert.equal(calls,1);assert.equal(cancelled,1);
 const late=new Repository(config,{fetchImpl:async()=>{await new Promise(r=>setTimeout(r,30));return new Response(new ReadableStream({cancel(){cancelled++;}}));}});
 await assert.rejects(late.release('x','owner','fence',{deadline:Date.now()+5}),/DATABASE_TIME_BUDGET/);await new Promise(r=>setTimeout(r,40));assert.equal(cancelled,2);
});
test('a delayed rate-limit timer cannot start a new request after the XML phase deadline',async()=>{
 let clock=1000,calls=0;const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',now:()=>clock,sleep:async()=>{clock=5000;},fetchImpl:async()=>{calls++;return Response.json({data:[]});}});
 await client.get('/contatos',{}, {deadline:4000});await assert.rejects(client.get('/contatos',{}, {deadline:4000}),/ORIGIN_TIME_BUDGET_EXHAUSTED/);
 assert.equal(calls,1);assert.equal(client.requestsMade,1);
});
test('residual mode cannot raise the shared 120-call limit through configuration',async()=>{
 const h=harness({remaining:12,retries:true}),r=await h.run({MAX_API_REQUESTS:'240'});assert.equal(r.requests,120);assert.equal(r.xml_residual.requests,12);
});
test('a failed page release cannot mask HTTP401 and trigger another upstream call',async()=>{
 const h=harness({jsonStatus:401}),release=h.repo.release;
 h.repo.release=async(...args)=>{if(args[0]==='contacts')throw new Error('DATABASE_UNAVAILABLE');return release(...args);};
 const r=await h.run();assert.equal(r.xml_residual.status,'skipped_stopped');assert.equal(r.requests,3);assert.equal(r.pages,0);
 assert.equal(h.trace.filter(x=>x[0]==='get'&&!x[1].includes('/documento/')).length,1);
});
test('global checkpoint failure still calls release with its independent final deadline',async()=>{
 const h=harness(),apply=h.repo.apply;
 h.repo.apply=async(...args)=>{if(args[0]==='__scheduler__')throw new Error('DATABASE_TIME_BUDGET');return apply(...args);};
 await assert.rejects(h.run(),/DATABASE_TIME_BUDGET/);assert.equal(h.releases.at(-1)[0],'__scheduler__');assert.equal(h.releases.at(-1)[3].deadline,h.start+180000);
});

test('HTTP429 survives delayed cadence and Retry-After sleep: real collector starts no second candidate',async()=>{
 for(const mode of ['cadence','retry_after']){
  let clock=1000,gets=0,begins=0;const candidates=[candidate(1),candidate(2,'65')];
  const repo={async rpc(name,args){if(name.endsWith('_candidates'))return{items:candidates};if(name.endsWith('_begin')){begins++;return{attempt_id:randomUUID(),entity:args.p_entity,source_id:args.p_source_id,key:args.p_key,fingerprint:args.p_fingerprint};}if(name.endsWith('_fail'))return{recorded:true};throw new Error('UNEXPECTED_RPC');}};
  const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',now:()=>clock,sleep:async ms=>{if(mode==='retry_after'||ms===700)clock=22000;},fetchImpl:async()=>{gets++;return new Response('',{status:429,headers:{'retry-after':mode==='cadence'?'0':'1'}});}});
  const examinations={visited:new Set(),stopped:false};const options={owner:randomUUID(),lease:{lease_token:randomUUID()},deadline:100000,now:()=>clock,storage:{async ensure(){throw new Error('UNEXPECTED_STORAGE');}},examinations};
  const result=await collectXml(repo,client,options);assert.equal(result.stop_json,true);assert.equal(examinations.stopped,true);assert.equal(begins,1);assert.equal(gets,1);assert.equal(result.errors[0].code,'ORIGIN_TIME_BUDGET_EXHAUSTED');
  assert.equal((await collectXml(repo,client,{...options,maxCandidates:4,maxRequests:12})).status,'skipped_stopped');assert.equal(gets,1);
 }
});
test('retry request exhaustion and an overlong Retry-After preserve the last HTTP429 status',async()=>{
 for(const mode of ['budget','retry_after']){
  let clock=1000,calls=0;const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',now:()=>clock,maxRequests:mode==='budget'?1:120,sleep:async ms=>{clock+=ms;},fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':mode==='budget'?'0':'30'}});}});
  await assert.rejects(client.get('/nfe/documento/'+keyFor('55'),{formato:'xml'},{deadline:21000}),error=>error.status===429&&error.code===(mode==='budget'?'ORIGIN_REQUEST_BUDGET_EXHAUSTED':'ORIGIN_TIME_BUDGET_EXHAUSTED'));
  assert.equal(calls,1);
 }
});
