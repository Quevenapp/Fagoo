import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {ITAU_LEGACY_BASE as BASE} from '../src/itau-legacy-readiness.mjs';
import {itauLegacyResponse} from './helpers/itau-legacy-readiness-response.mjs';
const ACTOR='10000000-0000-4000-8000-000000000084';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-itau-084-service',ALLOWED_ORIGINS:'https://erp.synthetic.test'};
const req=(path='',extra={})=>new Request('https://api.synthetic.test'+BASE+path,{headers:{Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'},...extra});
test('084 authenticates the real actor before the fixed read RPC; bank scope remains absent',async()=>{
 const filters={status:'all',bank_reference:'present',limit:25,after:null},calls=[];
 const handle=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR,user_metadata:{role:'admin',p_user_id:'FORGED'}}:itauLegacyResponse(filters));}});
 const r=await handle(req('?status=all&bank_reference=present'),env);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(calls.length,2);
 assert.ok(calls[0].url.endsWith('/auth/v1/user'));assert.ok(calls[1].url.endsWith('/rpc/erp_itau_legacy_readiness'));assert.equal(calls[1].o.method,'POST');assert.equal(calls[1].o.redirect,'manual');
 assert.deepEqual(JSON.parse(calls[1].o.body),{p_user_id:ACTOR,p_status:'all',p_bank_reference:'present',p_limit:25,p_after:null});
 const p=await r.json();assert.equal(p.read_only,true);assert.equal(p.can_bind,false);assert.equal(p.can_settle,false);assert.equal(p.can_generate,false);assert.equal(p.items[0].references.account_scope,null);assert.equal(p.items[0].references.control,null);
});
test('084 admits only GET and refuses CORS, anonymous or absent sessions before a data RPC',async()=>{
 let calls=0;const never=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD'])assert.equal((await never(req('',{method}),env)).status,405);
 assert.equal((await never(req('',{headers:{Origin:'https://other.invalid'}}),env)).status,403);
 assert.equal((await never(req('',{headers:{Origin:'https://erp.synthetic.test'}}),env)).status,401);
 const pre=await never(req('',{method:'OPTIONS',headers:{Origin:'https://erp.synthetic.test','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization'}}),env);assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Methods'),'GET');assert.equal(calls,0);
 for(const user of [{id:ACTOR,is_anonymous:true},null,{id:'wrong'}]){let auth=0;const handle=createHandler({fetchImpl:async()=>{auth++;return Response.json(user);}}),r=await handle(req(),env);assert.ok([401,403].includes(r.status));assert.equal(auth,1);}
});
test('084 SQL current-admin ACL overrides browser metadata and all private errors are sanitized',async()=>{
 for(const[code,status]of [['42501',403],['22023',400],['P0002',404],['XX000',502]]){
  const calls=[],handle=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return url.endsWith('/auth/v1/user')?Response.json({id:ACTOR,user_metadata:{role:'admin'}}):Response.json({code,message:'PRIVATE_BANK_DATA',hint:env.SUPABASE_SERVICE_ROLE_KEY},{status:500});}});
  const r=await handle(req(),env);assert.equal(r.status,status);assert.equal(calls.length,2);assert.doesNotMatch(await r.text(),/PRIVATE|synthetic-itau|synthetic-token/);
 }
});
test('084 rejects unknown, repeated or malformed filters and any declared GET body',async()=>{
 for(const suffix of ['?p_user_id='+ACTOR,'?limit=26','?limit=0','?status=all&status=open_partial','?bank_reference=exact','?after=','?after=%00','?limit=1e1']){
  let calls=0;const handle=createHandler({fetchImpl:async url=>{calls++;assert.ok(url.endsWith('/auth/v1/user'));return Response.json({id:ACTOR});}});assert.equal((await handle(req(suffix),env)).status,400);assert.equal(calls,1);
 }
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:ACTOR});}});
 assert.equal((await handle(req('',{headers:{...Object.fromEntries(req().headers),'Content-Length':'1'}}),env)).status,400);assert.equal(calls,1);
 assert.equal((await handle(req('/capture'),env)).status,404);assert.equal(calls,1);
});
test('084 enforces its own256KiB success/error budget and closed DTO; legacy list keeps its budget',async()=>{
 const run=(value,length,status=200)=>createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...(length?{'Content-Length':String(length)}:{})}})})(req(),env);
 assert.equal((await run(itauLegacyResponse(),262144)).status,200);assert.equal((await run(itauLegacyResponse(),262145)).status,502);
 for(const value of [{...itauLegacyResponse(),can_bind:true},{...itauLegacyResponse(),private:'PRIVATE'}, {...itauLegacyResponse(),extra:'x'.repeat(262145)}]){const r=await run(value);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/PRIVATE|extra|synthetic/);}
 assert.equal((await run({code:'42501',message:'PRIVATE'},262145,500)).status,502);
 const calls=[],legacy=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify({entity:'receivables',data_mode:'staging_readonly',items:[],limit:25,offset:0,total:0,has_more:false,next_offset:null}),{headers:{'Content-Type':'application/json','Content-Length':'262145'}});}});
 const r=await legacy(new Request('https://api.synthetic.test/v1/records/receivables',{headers:req().headers}),env);assert.equal(r.status,200);assert.ok(calls[1].url.endsWith('/rpc/erp_read_records'));
});
test('084 cancellation before/during Auth or RPC prevents later reads and cancels stalled response body',async()=>{
 const stop=new AbortController();stop.abort();let calls=0;const never=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});assert.equal((await never(req('',{signal:stop.signal}),env)).status,400);assert.equal(calls,0);
 for(const phase of ['auth','rpc']){
  let started,upstreamSignal;const entered=new Promise(r=>started=r),controller=new AbortController();calls=0;
  const handle=createHandler({fetchImpl:async(url,o)=>{calls++;if(phase==='rpc'&&url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});upstreamSignal=o.signal;started();return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('PRIVATE')),{once:true}));}});
  const pending=handle(req('',{signal:controller.signal}),env);await entered;controller.abort();const r=await pending;assert.ok([408,503].includes(r.status));assert.equal(calls,phase==='auth'?1:2);assert.equal(upstreamSignal.aborted,true);assert.doesNotMatch(await r.text(),/PRIVATE/);
 }
 let reading,cancelled=false;const entered=new Promise(r=>reading=r),controller=new AbortController();
 const handle=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(new ReadableStream({pull(){reading();return new Promise(()=>{});},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}})});
 const pending=handle(req('',{signal:controller.signal}),env);await entered;controller.abort();const r=await pending;assert.equal(r.status,408);await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);
});
test('084 keeps the15s request deadline across Auth and refuses a late authenticated response before RPC',async()=>{
 const original=Date.now,at=original();let now=at,calls=0;Date.now=()=>now;
 try{const handle=createHandler({fetchImpl:async url=>{calls++;assert.ok(url.endsWith('/auth/v1/user'));now=at+15001;return Response.json({id:ACTOR});}}),r=await handle(req(),env);assert.equal(r.status,408);assert.equal(calls,1);}finally{Date.now=original;}
});
test('084 refuses empty upstream chunks without waiting for a stalled cancel promise',async()=>{
 let reads=0,cancels=0;const handle=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array());},cancel(){cancels++;return new Promise(()=>{});}},{highWaterMark:0}),{headers:{'Content-Type':'application/json'}})});
 let timer;try{const r=await Promise.race([handle(req(),env),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('HUNG_EMPTY_BODY')),500);})]);assert.equal(r.status,502);assert.equal(reads,1);assert.equal(cancels,1);}finally{clearTimeout(timer);}
});
test('084 Auth errors do not wait for an upstream cancel promise or reach the read RPC',async()=>{
 for(const code of [401,403,500]){
  let calls=0,cancels=0,timer;
  const handle=createHandler({timeoutMs:5,fetchImpl:async url=>{calls++;assert.ok(url.endsWith('/auth/v1/user'));return new Response(new ReadableStream({cancel(){cancels++;return new Promise(()=>{});}},{highWaterMark:0}),{status:code});}});
  try{const r=await Promise.race([handle(req(),env),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('HUNG_AUTH_CANCEL')),200);})]);assert.equal(r.status,code===500?502:401);assert.equal(calls,1);assert.equal(cancels,1);assert.doesNotMatch(await r.text(),/synthetic|PRIVATE/);}finally{clearTimeout(timer);}
 }
});
