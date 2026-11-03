import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {FISCAL_DRAFT_STATUS_BASE as BASE} from '../src/fiscal-draft-status.mjs';
import {id,statusPage} from './helpers/fiscal-draft-status-response.mjs';
const ACTOR=id(10),env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-status-082-service',ALLOWED_ORIGINS:'https://erp.synthetic.test'};
const req=(path='',extra={})=>new Request('https://api.synthetic.test'+BASE+path,{headers:{Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'},...extra});
test('082 composition gives resumo GET precedence and authenticates the actor before its only RPC',async()=>{
 const calls=[],handle=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR,user_metadata:{role:'admin',p_user_id:id(99)}}:statusPage());}});
 const r=await handle(req('?model=55&status=draft&limit=25&source_document_id='+id(2)),env);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal(calls.length,2);assert.ok(calls[0].url.endsWith('/auth/v1/user'));assert.ok(calls[1].url.endsWith('/rpc/erp_fiscal_draft_status_list'));
 assert.deepEqual(JSON.parse(calls[1].o.body),{p_model:'55',p_status:'draft',p_source_document_id:id(2),p_limit:25,p_after:null,p_user_id:ACTOR});assert.equal(calls[1].o.method,'POST');assert.equal(calls[1].o.redirect,'manual');
 const out=await r.json();assert.equal(out.read_only,true);assert.equal(out.can_emit,false);assert.equal(out.items[0].draft.status,'draft');assert.equal(out.items[0].authorization.original.state,'authorized_homologation');
});
test('082 composition refuses mutation/CORS/anonymous/missing session without a fiscal call',async()=>{
 let calls=0;const never=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});
 for(const method of ['POST','PATCH','PUT','DELETE'])assert.equal((await never(req('',{method}),env)).status,405);
 assert.equal((await never(req('',{headers:{Origin:'https://other.invalid'}}),env)).status,403);
 assert.equal((await never(req('',{headers:{Origin:'https://erp.synthetic.test'}}),env)).status,401);
 const pre=await never(req('',{method:'OPTIONS',headers:{Origin:'https://erp.synthetic.test','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Authorization'}}),env);assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Methods'),'GET');assert.equal(calls,0);
 const denied=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:ACTOR,is_anonymous:true});}});assert.equal((await denied(req(),env)).status,403);assert.equal(calls,1);
});
test('082 current SQL ACL is authoritative and private upstream errors never leave the boundary',async()=>{
 for(const[code,status]of [['42501',403],['22023',400],['P0002',404],['XX000',502]]){
  const calls=[],handle=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return url.endsWith('/auth/v1/user')?Response.json({id:ACTOR,user_metadata:{role:'admin'}}):Response.json({code,message:'PRIVATE_LEDGER',hint:env.SUPABASE_SERVICE_ROLE_KEY},{status:500});}});
  const r=await handle(req(),env);assert.equal(r.status,status);assert.equal(calls.length,2);assert.doesNotMatch(await r.text(),/PRIVATE|synthetic-status|synthetic-token/);
 }
 for(const path of ['/unknown','?p_user_id='+ACTOR,'?limit=26','?model=55&model=65']){
  let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:ACTOR});}}),r=await handle(req(path),env);assert.ok([400,404].includes(r.status));assert.equal(calls,1);
 }
});
test('082 has a dedicated256KiB response budget and closed DTO without widening the legacy draft budget',async()=>{
 const run=async(value,length)=>createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json',...(length?{'Content-Length':String(length)}:{})}})})(req(),env);
 assert.equal((await run(statusPage(),262144)).status,200);assert.equal((await run(statusPage(),262145)).status,502);
 for(const value of [{...statusPage(),can_emit:true},{...statusPage(),secret:'PRIVATE'}, {...statusPage(),padding:'x'.repeat(262145)}]){const r=await run(value);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/PRIVATE|padding|synthetic/);}
 const calls=[],legacy=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return url.endsWith('/auth/v1/user')?Response.json({id:ACTOR}):new Response(JSON.stringify({data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false,items:[],limit:25,has_more:false,next_cursor:null}),{headers:{'Content-Type':'application/json','Content-Length':'1048577'}});}});
 const r=await legacy(new Request('https://api.synthetic.test/v1/rascunhos-fiscais',{headers:req().headers}),env);assert.equal(r.status,200);assert.ok(calls[1].url.endsWith('/rpc/erp_fiscal_draft_list'));
});
test('082 cancellation before Auth and during RPC cannot start another read or return late fiscal data',async()=>{
 const stop=new AbortController();stop.abort();let calls=0;const never=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});assert.equal((await never(req('',{signal:stop.signal}),env)).status,400);assert.equal(calls,0);
 const control=new AbortController();let entered,rpcSignal;const started=new Promise(r=>entered=r),handle=createHandler({fetchImpl:async(url,o)=>{calls++;if(url.endsWith('/auth/v1/user'))return Response.json({id:ACTOR});rpcSignal=o.signal;entered();return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('PRIVATE')),{once:true}));}});
 const pending=handle(req('',{signal:control.signal}),env);await started;control.abort();const r=await pending;assert.equal(r.status,408);assert.equal(rpcSignal.aborted,true);assert.equal(calls,2);assert.doesNotMatch(await r.text(),/PRIVATE|candidate|protocol_number/);
});
