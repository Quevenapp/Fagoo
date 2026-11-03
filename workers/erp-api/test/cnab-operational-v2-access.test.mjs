import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler} from '../src/index.mjs';
const actor='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const base='/v1/cobranca-operacional-v2',encoding='itau109-origin-observed-v1',token='synthetic-session-token';
const flags={purpose:'operational',productionReady:false,bankTransmissionPerformed:false,financialMutationPerformed:false,originAuthenticated:false,contract:'itau109-operational-v2'};
const selection={command_id:id,profile_id:id,expected_version:1,expected_approval_version:1,generated_on:'2026-10-16',titles:[{title_id:id,expected_version:1,document_number:'SYNTH001'}],confirm_operational:false,encoding_profile:encoding,confirm_encoding_profile:false,zero_daily_title_ids:[]};
const approval={command_id:id,expected_approval_version:0,expected_profile_version:1,expected_identity_version:1,enabled:true,confirmed_on:'2026-10-16',reference:'SYNTHETIC CONFIRMATION',allowed_encoding_profiles:[encoding],compatibility_confirmed:true,permanent_instructions_acknowledged:true};
const cases=[
 ['/profiles','GET','erp_cnab_operational_profiles_v2'],['/remittances','GET','erp_cnab_operational_files_v2'],['/commands/'+id,'GET','erp_cnab_operational_command_v2'],['/files/remittance/'+id,'GET','erp_cnab_operational_file_v2'],
 ['/profiles/'+id+'/approval','POST','erp_cnab_operational_approve_v2',approval],['/remittances/preview','POST','erp_cnab_operational_reserve_v2',selection],
 ['/remittances','POST','erp_cnab_operational_reserve_v2',{...selection,confirm_operational:true,confirm_encoding_profile:true,preview_hash:'a'.repeat(64)}],
 ['/remittances/'+id+'/resume','POST','erp_cnab_operational_reservation_v2',{command_id:id,expected_approval_version:1,encoding_profile:encoding}],
];
const req=(path,body,options={})=>new Request('https://api.example.test'+base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)}),...Object.fromEntries(Object.entries(options).filter(([k])=>k!=='headers'))});
async function safe(r){assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');const text=await r.text();assert.doesNotMatch(text,/PRIVATE|synthetic-service-key|synthetic-session-token/);return JSON.parse(text);}

test('067 boundary enforces methods/CORS and authentication before reading business bodies',async()=>{
 let count=0;const h=createHandler({fetchImpl:async()=>{count++;throw Error('UNEXPECTED');}});
 for(const[path,method]of cases){
  const request=req(path,method==='POST'?{}:undefined,{headers:{Authorization:''},...(method==='POST'?{body:'invalid'}:{})}),response=await h(request,env);
  assert.equal(response.status,401);assert.equal(request.bodyUsed,false);
  for(const requested of['GET','POST','PATCH','DELETE']){
   const r=await h(req(path,undefined,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':requested,'Access-Control-Request-Headers':'authorization,content-type'}}),env);
   assert.equal(r.status,(path==='/remittances'?['GET','POST']:[method]).includes(requested)?204:403);
  }
 }
 assert.equal((await h(req('/profiles',undefined,{headers:{Origin:env.ALLOWED_ORIGINS+'.evil.invalid'}}),env)).status,403);
 const denied=await h(req('/profiles',{},{}),env);assert.equal(denied.status,405);assert.equal(denied.headers.get('Allow'),'GET, OPTIONS');assert.equal(count,0);
});
test('067 routes use exact RPC family and verified actor; SQL rejection remains definite before reservation ACK',async()=>{
 for(const[path,method,name,b]of cases)for(const[state,status,expected]of[['42501',403,'ERP_FORBIDDEN'],['22023',400,'ERP_CNAB_OPERATIONAL_V2_INVALID_INPUT'],['P0002',404,'ERP_NOT_FOUND'],['40001',409,'ERP_CONFLICT'],['55000',409,'ERP_CONFLICT']]){
  const calls=[],h=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:actor.toUpperCase()}):Response.json({code:state,message:'PRIVATE CONTEXT',hint:'PRIVATE'},{status:400});}});
  const r=await h(req(path,b),env);assert.equal(r.status,status,`${path} ${state}`);assert.equal((await safe(r)).error.code,expected);assert.equal(calls.length,2);assert.equal(calls[1].url,env.SUPABASE_URL+'/rest/v1/rpc/'+name);
  assert.equal(JSON.parse(calls[1].options.body).p_user_id,actor);assert.equal(calls[1].options.redirect,'manual');assert.equal(calls[1].options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.ok(calls[1].options.signal instanceof AbortSignal);
 }
});
test('067 denies anonymous sessions and actor/path/terms spoofing before RPC',async()=>{
 for(const session of[{id:'invalid'},{id:actor,is_anonymous:true}]){
  let count=0;const h=createHandler({fetchImpl:async()=>{count++;return Response.json(session);}}),r=await h(req('/profiles'),env);assert.equal(r.status,session.is_anonymous?403:401);assert.equal(count,1);
 }
 const calls=[],h=createHandler({fetchImpl:async(url)=>{calls.push(url);return Response.json({id:actor});}});
 for(const body of[{...selection,p_user_id:actor},{...selection,path:'PRIVATE/path'},{...selection,encoding_terms:{}},{...selection,encoding_profile:'inter112'}]){
  const before=calls.length,r=await h(req('/remittances/preview',body),env);assert.equal(r.status,400);assert.equal(calls.length-before,1);await safe(r);
 }
 const before=calls.length,r=await h(req('/remittances/preview',selection,{body:'x'.repeat(65537)}),env);assert.equal(r.status,413);assert.equal(calls.length-before,1);
});
test('067 profiles and lists keep closed public DTO and legacy/v2 discriminator',async()=>{
 for(const[path,answer]of[['/profiles',{...flags,items:[]}],['/remittances',{...flags,items:[],limit:25,has_more:false,next_cursor:null}]]){
  const h=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:actor}:answer)}),r=await h(req(path,undefined,{headers:{Origin:env.ALLOWED_ORIGINS}}),env);
  assert.equal(r.status,200);assert.deepEqual(await safe(r),answer);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
 }
 const h=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:actor}:{...flags,items:[],private:'PRIVATE'})});
 assert.equal((await h(req('/profiles'),env)).status,502);
});
test('067 unknown mutation outcome is 503 with no retry; following GET keeps command UUID',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/auth/v1/user'))return Response.json({id:actor});if(url.endsWith('/erp_cnab_operational_command_v2'))return Response.json({code:'P0002'},{status:404});throw Error('PRIVATE LOST ACK');}});
 const r=await h(req('/remittances',cases[6][3]),env);assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(calls.length,2);
 const read=await h(req('/commands/'+id),env);assert.equal(read.status,404);assert.equal(calls.length,4);assert.ok(calls[3].url.endsWith('/erp_cnab_operational_command_v2'));assert.equal(JSON.parse(calls[3].options.body).p_command_id,id);
});
test('067 redirect/invalid bytes/oversized upstream after dispatch remain uncertain and cancel bodies',async()=>{
 for(const make of[()=>new Response(null,{status:302,headers:{location:'https://never.invalid'}}),()=>new Response(Uint8Array.of(255)),()=>Response.json({private:'x'.repeat(1048577)})]){
  let writes=0;const h=createHandler({fetchImpl:async url=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:actor});writes++;return make();}}),r=await h(req('/remittances',cases[6][3]),env);
  assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(writes,1);
 }
});
test('067 download uses fixed Storage path, checks bytes, reauthorizes and sets attachment sandbox headers',async()=>{
 const bytes=new Uint8Array(1206).fill(32),hash=createHash('sha256').update(bytes).digest('hex'),path=`profiles/${id}/remittances/${hash}.rem`;
 const meta={...flags,id,profile_id:id,hash,size:bytes.length,path,filename:'ITAU_COBRANCA_0000001.REM',approval_version:1,encoding_profile:encoding},calls=[];
 const h=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:actor}):url.includes('/storage/v1/')?new Response(bytes):Response.json(meta);}});
 const r=await h(req('/files/remittance/'+id),env);assert.equal(r.status,200);assert.equal(r.headers.get('Content-Length'),'1206');assert.equal(r.headers.get('Content-Type'),'application/octet-stream');assert.match(r.headers.get('Content-Disposition'),/^attachment; filename="ITAU_COBRANCA_0000001.REM"$/);assert.equal(r.headers.get('Content-Security-Policy'),"sandbox; default-src 'none'; frame-ancestors 'none'");assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
 assert.equal(calls.length,4);assert.equal(calls[2].url,env.SUPABASE_URL+'/storage/v1/object/authenticated/brufap-cnab/'+path);assert.equal(calls[2].options.redirect,'manual');assert.equal(calls.filter(x=>x.url.endsWith('/erp_cnab_operational_file_v2')).length,2);
});
test('067 caller abort reaches authentication and mutation; no late retry is introduced',async()=>{
 const stopped=new AbortController();stopped.abort();let count=0;const inert=createHandler({fetchImpl:async()=>{count++;throw Error('UNEXPECTED');}});
 assert.equal((await inert(req('/profiles',undefined,{signal:stopped.signal}),env)).status,400);assert.equal(count,0);
 let entered;const ready=new Promise(r=>{entered=r;}),ac=new AbortController();let signal,writes=0;
 const h=createHandler({fetchImpl:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:actor});writes++;signal=options.signal;entered();return new Promise((_,no)=>signal.addEventListener('abort',()=>no(Error('PRIVATE ABORT')),{once:true}));}});
 const pending=h(req('/remittances',cases[6][3],{signal:ac.signal}),env);await ready;ac.abort();const r=await pending;assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(signal.aborted,true);assert.equal(writes,1);
});
test('067 wiring preserves legacy 042 family and errored SQL does not reach Storage',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:actor}):Response.json({code:'42501',message:'PRIVATE'},{status:403});}});
 const r=await h(new Request('https://api.example.test/v1/cobranca-operacional/profiles',{headers:{Authorization:'Bearer '+token}}),env);assert.equal(r.status,403);assert.ok(calls[1].url.endsWith('/erp_cnab_operational_profiles'));assert.equal(calls.length,2);
});
test('067 oversized declared RPC body is cancelled before consumption and never forwarded',async()=>{
 let cancelled=false;const h=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:actor}):new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'1048577'}})});
 const r=await h(req('/profiles'),env);assert.equal(r.status,502);assert.equal(cancelled,true);assert.equal((await safe(r)).error.code,'ERP_UPSTREAM_UNAVAILABLE');
});
