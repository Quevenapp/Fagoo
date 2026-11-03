import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
const uid='a0000000-0000-4000-8000-000000000001',documentId='b0000000-0000-4000-8000-000000000001',eventId='c0000000-0000-4000-8000-000000000001',command='d0000000-0000-4000-8000-000000000001';
const base='/v1/ordens-servico/'+documentId+'/eventos',token='synthetic-token',env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const data={type:'reception',occurred_on:'2026-10-16',declarant_name:'Declarante fictício',declarant_role:'customer',details:{accessories:null,apparent_condition:'Condição declarada'},notes:null,attachment_id:null,corrects_event_id:null,correction_reason:null,confirm_record:true};
const payload={command_id:command,expected_document_version:1,data};
const context={scope:'service_order_events',data_mode:'erp_native',signature_verified:false,consent_verified:false,changes_document_status:false,financial_mutation_performed:false,stock_mutation_performed:false,document:{id:documentId,kind:'service_orders',number:'1',version:1,status:'open',total:'12.50',commercial_hash:'a'.repeat(64)},can_record:true,allowed_event_types:['reception']};
const record={id:eventId,document_id:documentId,sequence:'1',type:'reception',document_version:1,document_status:'open',commercial_hash:'a'.repeat(64),total:'12.50',snapshot:{number:'1',contact:{id:uid,name:'Contato fictício'},equipment:null,serial_number:null,technician:null},occurred_on:data.occurred_on,declarant_name:data.declarant_name,declarant_role:data.declarant_role,details:data.details,notes:null,attachment:null,corrects_event_id:null,correction_reason:null,actor_id:uid,recorded_at:'2026-10-16T12:00:00Z'};
const current={document_version:1,document_status:'open',document_version_changed:false,commercial_content_changed:false,total_changed:false,corrected_by_event_id:null,approval_basis_matches_current:false};
const empty={...context,read_only:true,items:[],limit:25,has_more:false,next_before:null},saved={...context,record,current,replayed:false},detail={...context,record,current,read_only:true};
const request=(path=base,options={})=>new Request('https://api.example.test'+path,options);
const auth=(path=base,value,options={})=>request(path,{method:value===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},...(value===undefined?{}:{body:JSON.stringify(value)}),...Object.fromEntries(Object.entries(options).filter(([k])=>k!=='headers'))});
const safe=async response=>{assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');const text=await response.text();assert.doesNotMatch(text,/PRIVATE|synthetic-service-key|synthetic-token/);return JSON.parse(text);};
const cases=[[base,'GET',undefined,'erp_service_event_list',empty],[base+'/'+eventId,'GET',undefined,'erp_service_event_get',detail],[base,'POST',payload,'erp_service_event_append',saved]];

test('049 methods/CORS/auth are checked before body parsing and events never dispatch to journal028',async()=>{
 let calls=0;const api=createHandler({fetchImpl:async()=>{calls++;throw Error('NO_NETWORK');}});
 for(const[path,method,value]of cases){
  const noAuth=request(path,{method,body:value?'not json':undefined});assert.equal((await api(noAuth,env)).status,401);assert.equal(noAuth.bodyUsed,false);
  for(const requested of['GET','POST','PATCH','DELETE']){
   const r=await api(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':requested,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(r.status,(path===base?['GET','POST']:['GET']).includes(requested)?204:403);
  }
 }
 assert.equal((await api(auth(base,payload,{method:'PATCH'}),env)).status,405);
 assert.equal((await api(auth(base,payload,{headers:{Origin:'https://evil.invalid'}}),env)).status,403);assert.equal(calls,0);
 for(const session of[{id:'bad'},{id:uid,is_anonymous:true}]){
  const calls=[],handle=createHandler({fetchImpl:async url=>{calls.push(url);return Response.json(session);}}),r=await handle(auth(base,{}),env);assert.equal(r.status,session.is_anonymous?403:401);assert.equal(calls.length,1);await safe(r);
 }
});

test('049 actor and RPC are imposed by the verified session; only whitelisted historical/current data is returned',async()=>{
 for(const[path,method,value,name,answer]of cases){
  const calls=[],api=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:uid.toUpperCase()}:{...answer,raw:{secret:'PRIVATE'}});}});
  const r=await api(auth(path,value,{method,headers:{Origin:env.ALLOWED_ORIGINS}}),env);assert.equal(r.status,200);assert.deepEqual(await safe(r),answer);assert.equal(calls.length,2);
  const business=calls[1];assert.ok(business.url.endsWith('/rpc/'+name));assert.equal(business.options.redirect,'manual');assert.equal(business.options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
  const args=JSON.parse(business.options.body);assert.equal(args.p_user_id,uid);assert.equal(args.p_document_id,documentId);if(value){assert.equal(args.p_command_id,command);assert.deepEqual(args.p_data,data);}assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
 }
});

test('049 malformed query/body, identity overrides and64KiB limits are rejected after Auth but before RPC',async()=>{
 let count=0;const api=createHandler({fetchImpl:async()=>{count++;return Response.json({id:uid});}});
 for(const[path,value,extra,status]of[
  [base+'?limit=26',undefined,{},400],[base+'?before=01',undefined,{},400],[base+'?actor='+uid,undefined,{},400],
  [base,{...payload,p_user_id:uid},{},400],[base,{...payload,data:{...data,total:'0.01'}},{},400],
  [base,payload,{headers:{'Content-Encoding':'gzip'}},400],[base,payload,{body:'x'.repeat(65537)},413],
  [base,payload,{headers:{'Content-Length':'65537'}},413],[base+'/download',undefined,{},404],
 ]){const before=count,r=await api(auth(path,value,extra),env);assert.equal(r.status,status,path);assert.equal(count-before,1);await safe(r);}
});

test('049 SQL rejections remain definitive but lost/malformed append responses remain502/503 without retry',async()=>{
 for(const[code,status]of[['42501',403],['22023',400],['P0002',404],['40001',409],['23505',409],['54000',409],['XX000',503]]){
  let writes=0;const api=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):(writes++,Response.json({code,message:'PRIVATE_SQL',details:env.SUPABASE_SERVICE_ROLE_KEY},{status:400}))});
  const response=await api(auth(base,payload),env);assert.equal(response.status,status,code);assert.equal(writes,1);const out=await safe(response);if(code==='54000')assert.equal(out.error.code,'ERP_SERVICE_EVENT_LIMIT');
 }
 for(const upstream of[()=>{throw Error('PRIVATE-ACK-LOST');},()=>new Response('{broken',{status:200}),()=>Response.json({...saved,consent_verified:true}),()=>new Response(null,{status:307,headers:{Location:'https://never-follow.invalid/'}})]){
  let writes=0;const api=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):(writes++,upstream())}),r=await api(auth(base,payload),env);assert.ok([502,503].includes(r.status));assert.equal(writes,1);await safe(r);
 }
});

test('049 list response is bounded to1MiB and ignores unrelated payloads within the limit',async()=>{
 for(const[size,status]of[[500000,200],[1048577,502]]){
  const api=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...empty,unrelated:'x'.repeat(size)})}),r=await api(auth(),env);assert.equal(r.status,status);const answer=await safe(r);assert.equal(answer.unrelated,undefined);
 }
});

test('049 cancellation before dispatch prevents a write; cancellation after dispatch is uncertain and aborts upstream',async()=>{
 const stopped=new AbortController();stopped.abort();let calls=0;
 const immediate=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});assert.equal((await immediate(auth(base,payload,{signal:stopped.signal}),env)).status,400);assert.equal(calls,0);
 let entered;const reached=new Promise(r=>entered=r),abort=new AbortController();let writes=0,signal;
 const api=createHandler({fetchImpl:async(url,options)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});writes++;signal=options.signal;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 }}),running=api(auth(base,payload,{signal:abort.signal}),env);await reached;abort.abort();const r=await running;assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(signal.aborted,true);assert.equal(writes,1);
});

test('049 wiring preserves existing journal028 dispatch and gives event errors sanitized responses',async()=>{
 const calls=[],api=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'42501',message:'PRIVATE'},{status:403});}});
 const r=await api(auth('/v1/ordens-servico/'+documentId+'/diario'),env);assert.equal(r.status,403);assert.ok(calls[1].url.endsWith('/rpc/erp_service_journal_list'));await safe(r);
});
