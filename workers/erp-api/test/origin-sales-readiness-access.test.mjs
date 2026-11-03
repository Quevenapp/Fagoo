import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {ACTOR,BASE,page,detail} from './helpers/sales-readiness-response-fixture.mjs';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key-081',ALLOWED_ORIGINS:'https://erp.synthetic.test'};
const req=(path='',extra={})=>new Request('https://api.synthetic.test'+BASE+path,{headers:{Authorization:'Bearer synthetic-user-token',Origin:'https://erp.synthetic.test'},...extra});
test('081 composition admits only GET and authenticates before a readiness RPC',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});
 for(const method of ['POST','PATCH','PUT','DELETE'])assert.equal((await handle(req('',{method}),env)).status,405);
 assert.equal((await handle(req('',{headers:{Origin:'https://other.invalid'}}),env)).status,403);
 assert.equal((await handle(req('',{headers:{Origin:'https://erp.synthetic.test'}}),env)).status,401);
 const preflight=await handle(req('',{method:'OPTIONS',headers:{Origin:'https://erp.synthetic.test','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization'}}),env);
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Methods'),'GET');assert.equal(calls,0);
});
test('081 composition binds verified actor, fixed read RPC, response flags and cache policy',async()=>{
 for(const[path,result,rpc,args]of [['?limit=25&q=QA',page(),'erp_origin_sales_readiness_sources',{p_limit:25,p_after:null,p_query:'QA'}],['/100000',detail(),'erp_origin_sales_readiness_detail',{p_source_id:'100000'}]]){
  const calls=[],handle=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:result);}});
  const r=await handle(req(path),env);assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/'+rpc));assert.deepEqual(JSON.parse(calls[1].o.body),{...args,p_user_id:ACTOR});assert.equal(calls[1].o.redirect,'manual');assert.equal(calls[1].o.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);
  const out=await r.json();assert.equal(out.can_import,false);assert.equal(out.native_effects,false);assert.equal(out.read_only,true);
 }
});
test('081 composition sanitizes SQL failures and rejects invalid or oversized results',async()=>{
 for(const[code,status]of [['42501',403],['22023',400],['P0002',404],['XX000',502]]){
  const handle=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):Response.json({code,message:'PRIVATE_RAW_SQL',hint:env.SUPABASE_SERVICE_ROLE_KEY},{status:400})});
  const r=await handle(req(),env);assert.equal(r.status,status);assert.doesNotMatch(await r.text(),/PRIVATE|synthetic-service|synthetic-user/);
 }
 for(const bad of [{...page(),can_import:true},{...page(),payload:'PRIVATE'}, {...page(),extra:'x'.repeat(1048577)}]){
  const handle=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:bad)}),r=await handle(req(),env);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/PRIVATE|synthetic/);
 }
});
test('081 composition aborts before Auth and propagates cancellation without another query',async()=>{
 const stop=new AbortController();stop.abort();let calls=0;const unused=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});assert.equal((await unused(req('',{signal:stop.signal}),env)).status,400);assert.equal(calls,0);
 let entered,signal;const active=new AbortController(),started=new Promise(r=>entered=r);
 const pending=createHandler({fetchImpl:async(url,o)=>{calls++;if(url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});signal=o.signal;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('PRIVATE')),{once:true}));}})(req('',{signal:active.signal}),env);
 await started;active.abort();const r=await pending;assert.ok([408,502,503].includes(r.status));assert.equal(signal.aborted,true);assert.equal(calls,2);assert.doesNotMatch(await r.text(),/PRIVATE/);
});
