import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {COMPLETION_FLAGS,resolveBusinessCompletion} from '../../../packages/fiscal-core/src/business-completion.mjs';
import {businessFixture,businessIds} from '../../../packages/fiscal-core/test/business-fixtures.mjs';

const uid='f0000000-0000-4000-8000-000000000001',command='f0000000-0000-4000-8000-000000000002',did=businessIds.draft;
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base='/v1/complemento-fiscal/'+did,token='synthetic-user-token';
const fixture=businessFixture({count:2}),{identity,...completion}=fixture.completion;
const item_basis=fixture.taxPreparation.record.items.map(i=>({item_id:i.item_id,position:i.position,cest:i.identifiers.cest,csosn:i.decisions.icms.csosn}));
const body={expected_draft_version:1,snapshot_hash:'a'.repeat(64),item_preparation_version:1,tax_preparation_version:1,expected_identity_version:1,expected_fiscal_version:1,expected_completion_version:0,completion};
const rec={draft_id:did,version:1,draft_version:1,snapshot_hash:body.snapshot_hash,item_preparation_version:1,tax_preparation_version:1,item_preparation_hash:'b'.repeat(64),tax_preparation_hash:'c'.repeat(64),model:'55',environment:'2',company_identity_version:1,company_fiscal_version:1,source_document_id:businessIds.order,source_document_version:1,created_at:'2026-10-16T12:00:00Z',item_basis,...resolveBusinessCompletion(completion,{model:'55',items:item_basis})};
const now={completion_version:1,draft_version:1,draft_status:'draft',source_document_version:1,source_status:'open',source_changed:false,company_changed:false,identity_version:1,fiscal_version:1,item_preparation_version:1,tax_preparation_version:1,matches_current_draft:true,matches_current_item_preparation:true,matches_current_tax_preparation:true,matches_current_company:true};
const saved={...COMPLETION_FLAGS,record:rec,current:now,replayed:false};
const preview={...COMPLETION_FLAGS,record:{...rec,created_at:null},current:{...now,completion_version:0},persisted:false,expected_completion_version:0};
const empty={...COMPLETION_FLAGS,record:null,current:{...now,completion_version:0,matches_current_draft:false,matches_current_item_preparation:false,matches_current_tax_preparation:false,matches_current_company:false}};
const history={...COMPLETION_FLAGS,draft_id:did,items:[],limit:25,has_more:false,next_cursor:null};
const cases=[[base,'GET','erp_fiscal_completion_get',undefined,empty],[base+'/history','GET','erp_fiscal_completion_history',undefined,history],[base+'/preview','POST','erp_fiscal_completion_preview',body,preview],[base+'/save','POST','erp_fiscal_completion_save',{...body,command_id:command},saved]];
const req=(path,options={})=>new Request('https://api.example.test'+path,options);
const authenticated=(path,method='GET',value,options={})=>req(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},...(value===undefined?{}:{body:JSON.stringify(value)}),...Object.fromEntries(Object.entries(options).filter(([k])=>k!=='headers'))});
const noSecrets=async response=>{const text=await response.text();assert.doesNotMatch(text,/PRIVATE|synthetic-service-key|synthetic-user-token/);assert.doesNotMatch(JSON.stringify([...response.headers]),/synthetic-service-key|synthetic-user-token/);return text;};

test('047 authenticates before mutation parsing and RPC; invalid/anonymous sessions cannot reach preparation',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('MUST_NOT_CALL');}});
 for(const[path,method]of cases){assert.equal((await handler(req(path,{method}),env)).status,401);assert.equal((await handler(req(path,{method,headers:{Authorization:'Bearer invalid token'}}),env)).status,401);}
 assert.equal(calls,0);
 for(const[auth,status]of [[Response.json({message:'PRIVATE_AUTH'},{status:401}),401],[Response.json({id:'wrong'}),401],[Response.json({id:uid,is_anonymous:true}),403]]){
  const calls=[],api=createHandler({fetchImpl:async url=>{calls.push(url);return auth;}}),response=await api(authenticated(base+'/save','POST',{}),env);assert.equal(response.status,status);assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/auth/v1/user'));await noSecrets(response);
 }
});

test('047 CORS and preflight allow only exact origins, route methods and public headers without upstream calls',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('MUST_NOT_CALL');}});
 for(const[path,method]of cases)for(const requested of['GET','POST','PUT','PATCH','DELETE']){
  const response=await handler(req(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':requested,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);assert.equal(response.status,method===requested?204:403);
  if(response.status===204){assert.equal(response.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);assert.equal(response.headers.get('Access-Control-Allow-Methods'),method);assert.equal(await response.text(),'');}
 }
 for(const headers of [{Origin:'https://evil.example.test','Access-Control-Request-Method':'GET'},{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-service-key'},{'Access-Control-Request-Method':'GET'}])assert.equal((await handler(req(base,{method:'OPTIONS',headers}),env)).status,403);
 assert.equal((await handler(authenticated(base,'GET',undefined,{headers:{Origin:'https://evil.example.test'}}),env)).status,403);assert.equal((await handler(authenticated(base,'GET',undefined,{headers:{Origin:env.ALLOWED_ORIGINS}}),{...env,ALLOWED_ORIGINS:''})).status,403);assert.equal(calls,0);
});

test('047 rejects wrong methods before upstream and offers no XML, emission, numbering or secret endpoint',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 for(const[path,method]of cases)for(const wrong of['GET','POST','PUT','PATCH','DELETE'].filter(v=>v!==method)){
  const response=await handler(authenticated(path,wrong),env);assert.equal(response.status,405);assert.equal(response.headers.get('Allow'),method+', OPTIONS');
 }
 assert.equal(calls,0);
 for(const tail of['/xml','/emit','/number','/certificate','/save/']){const before=calls;assert.equal((await handler(authenticated(base+tail),env)).status,404);assert.equal(calls-before,1);}
});

test('047 uses the verified session actor and service-only RPC headers, projecting only supported historical/current DTOs',async()=>{
 for(const[path,method,rpc,input,value]of cases){
  const calls=[],api=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:uid.toUpperCase()}:{...value,private_data:{key:env.SUPABASE_SERVICE_ROLE_KEY}});}});
  const response=await api(authenticated(path,method,input,{headers:{Origin:env.ALLOWED_ORIGINS}}),env);assert.equal(response.status,200);assert.deepEqual(JSON.parse(await noSecrets(response)),value);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/'+rpc));
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);assert.equal(calls[0].options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(calls[1].options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(calls[1].options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(calls[1].options.redirect,'manual');assert.ok(calls[1].options.signal instanceof AbortSignal);
  const args=JSON.parse(calls[1].options.body);assert.equal(args.p_user_id,uid);assert.equal(args.p_draft_id,did);if(input)assert.deepEqual(args.p_completion,input.completion);
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
 }
});

test('047 rejects actor overrides, unsupported flags, malformed query and body limits before business RPC',async()=>{
 let calls=0;const api=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:uid});}});
 const invalid=[[base+'?user_id='+uid,'GET'],[base+'?version=1&version=2','GET'],[base+'/history?limit=26','GET'],[base+'/save','POST',{...body,command_id:command,p_user_id:uid}],[base+'/save','POST',{...body,command_id:command,can_emit:true}],[base+'/preview','POST',{...body,completion:{...completion,identity:{number:'1'}}}]];
 for(const[path,method,value]of invalid){const before=calls;assert.equal((await api(authenticated(path,method,value),env)).status,400);assert.equal(calls-before,1);}
 for(const[headers,text,status]of [[{'Content-Encoding':'gzip'},'{}',400],[{'Content-Type':'text/plain'},'{}',400],[{'Content-Length':'524289'},'{}',413],[{},' '.repeat(524289),413],[{},'{broken',400]]){
  const before=calls,response=await api(authenticated(base+'/save','POST',undefined,{headers,body:text}),env);assert.equal(response.status,status);assert.equal(calls-before,1);await noSecrets(response);
 }
});

test('047 preserves SQL status semantics and never returns database messages or credentials',async()=>{
 for(const[path,method,_rpc,input]of cases)for(const[code,status]of [['22023',400],['42501',403],['P0002',404],['40001',409],['23505',409],['55000',503],['P0001',502]]){
  let count=0;const api=createHandler({fetchImpl:async url=>{count++;return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code,message:'PRIVATE_SQL_DETAIL',details:env.SUPABASE_SERVICE_ROLE_KEY},{status:400});}}),response=await api(authenticated(path,method,input),env);assert.equal(response.status,status,code);assert.equal(count,2);await noSecrets(response);
 }
});

test('047 raw RPC response limit is 2 MiB and unknown fields or readiness claims cannot escape projection',async()=>{
 for(const[bytes,status]of [[1500000,200],[2097153,502]]){
  const api=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...empty,unrelated:'x'.repeat(bytes)})}),response=await api(authenticated(base),env);assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/unrelated|xxxxx/);
 }
 const api=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...saved,can_emit:true})});assert.equal((await api(authenticated(base+'/save','POST',{...body,command_id:command}),env)).status,502);
});

test('047 cancellation before/within authentication prevents all business RPCs',async()=>{
 let count=0;const stopped=new AbortController();stopped.abort();const api=createHandler({fetchImpl:async()=>{count++;throw Error('MUST_NOT_CALL');}});assert.equal((await api(authenticated(base,'GET',undefined,{signal:stopped.signal}),env)).status,400);assert.equal(count,0);
 let ready;const reached=new Promise(r=>ready=r),controller=new AbortController(),calls=[];
 const delayed=createHandler({fetchImpl:async(url,{signal})=>{calls.push(url);ready();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}});
 const pending=delayed(authenticated(base+'/save','POST',{...body,command_id:command},{signal:controller.signal}),env);await reached;controller.abort();const response=await pending;assert.equal(response.status,503);assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/auth/v1/user'));await noSecrets(response);
});

test('047 cancellation while reading request/RPC body propagates without a repeated write or late success',async()=>{
 let authReady;const authenticatedReady=new Promise(r=>authReady=r),control=new AbortController();let inputCancelled=false,calls=0;
 const api=createHandler({fetchImpl:async()=>{calls++;authReady();return Response.json({id:uid});}});
 const request=authenticated(base+'/save','POST',undefined,{signal:control.signal,body:new ReadableStream({cancel(){inputCancelled=true;}}),duplex:'half'}),responsePromise=api(request,env);await authenticatedReady;await new Promise(r=>setImmediate(r));control.abort();assert.equal((await responsePromise).status,400);assert.equal(calls,1);assert.equal(inputCancelled,true);
 for(const phase of['headers','body']){
  let ready,signalSeen;const reached=new Promise(r=>ready=r),controller=new AbortController(),calls=[];
  const delayed=createHandler({fetchImpl:async(url,options)=>{calls.push(url);if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});signalSeen=options.signal;
   if(phase==='headers'){ready();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}
   return new Response(new ReadableStream({start(stream){options.signal.addEventListener('abort',()=>stream.error(new DOMException('Aborted','AbortError')),{once:true});ready();}}),{headers:{'Content-Type':'application/json'}});
  }});
  const pending=delayed(authenticated(base+'/save','POST',{...body,command_id:command},{signal:controller.signal}),env);await reached;controller.abort();const response=await pending;assert.equal(response.status,503);assert.equal(signalSeen.aborted,true);assert.equal(calls.length,2);assert.equal(JSON.parse(await noSecrets(response)).error.code,'ERP_RESULT_UNCONFIRMED');
 }
});

test('047 upstream timeout also covers an incomplete RPC response and never retries the command',async()=>{
 const calls=[];let signalSeen;
 const api=createHandler({timeoutMs:10,fetchImpl:async(url,{signal})=>{calls.push(url);if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});signalSeen=signal;return new Response(new ReadableStream({start(stream){signal.addEventListener('abort',()=>stream.error(new DOMException('Aborted','AbortError')),{once:true});}}),{headers:{'Content-Type':'application/json'}});}});
 const response=await api(authenticated(base+'/save','POST',{...body,command_id:command}),env);assert.equal(response.status,502);assert.equal(signalSeen.aborted,true);assert.equal(calls.length,2);await noSecrets(response);
});
