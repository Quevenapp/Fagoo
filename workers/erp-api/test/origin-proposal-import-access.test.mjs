import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
import {ORIGIN_PROPOSAL_IMPORT_BASE as BASE} from '../src/origin-proposal-import.mjs';

const uid='a0000000-0000-4000-8000-000000000001',contact='b0000000-0000-4000-8000-000000000001',product='b0000000-0000-4000-8000-000000000002';
const documentId='c0000000-0000-4000-8000-000000000001',command='d0000000-0000-4000-8000-000000000001',line='e0000000-0000-4000-8000-000000000001',sourceId='9520000001';
const hash='a'.repeat(64),previewHash='b'.repeat(64),at='2026-10-16T17:00:00.123456+00:00',token='synthetic-token';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const flags={data_mode:'proposal_import_review',policy:'origin-open-proposal-v1',entity:'sales_proposals',creates_draft:true,stock_effects:false,financial_effects:false,fiscal_effects:false,coverage_certified:false,cutoff_at:null};
const source={source_id:sourceId,source_hash:hash,source_version:'1',source_seen_at:at,source_number:'52',source_status:'Pendente'};
const input={source_id:sourceId,preview_hash:previewHash,command_id:command,confirm_import:true,duplicate_reviewed:true};
const normalized=normalizeDocument('sales_proposals',{date:'2026-10-16',contact_id:contact,items:[{product_id:product,description:'Produto fictício',code:'QA',unit:'UN',quantity:'2',unit_price:'12.85'}]});
const binding=(entity,record_id,id,position)=>({entity,source_id:id,record_id,record_version:1,name:'Cadastro fictício',unit:entity==='products'?'UN':null,active:true,human_edited:false,origin_state:'synced',candidate_pending:false,applied_hash:hash,latest_hash:hash,source_hash:hash,source_version:'1',valid:true,...(position?{position}:{})});
const preview={...flags,...source,dry_run:true,persisted:false,source_changed_at:at,can_apply:true,issues:[],bindings:[binding('contacts',contact,'9521000001'),binding('products',product,'9521000002',1)],warnings:['SOURCE_FRESHNESS_NOT_CERTIFIED','MANUAL_DUPLICATES_NOT_DETECTABLE','NATIVE_NUMBER_ASSIGNED_ON_APPLY'],proposed:normalized,existing:null,preview_hash:previewHash};
const summary={id:documentId,kind:'sales_proposals',number:'1',status:'draft',version:1,date:'2026-10-16',total:'25.70',contact_id:contact,contact_name:'Contato fictício',created_at:at,updated_at:at};
const receipt={command_id:command,entity:'sales_proposals',...source,preview_hash:previewHash,duplicate_reviewed:true,document:summary,imported_at:at};
const current={...normalized,...summary,contact_snapshot:{id:contact,version:1,name:summary.contact_name},source_proposal_id:null,effect_flags:{finance_active:false,stock_active:false},items:normalized.items.map(item=>({...item,id:line,product_snapshot:{id:product,version:1,name:'Produto fictício',unit:'UN',price:'12.8500',kind:'P',format:'S'}}))};
const saved={...flags,dry_run:false,persisted:true,replayed:false,receipt},detail={...flags,read_only:true,receipt,current_document:current};
const listing={...flags,read_only:true,items:[{...source,document_id:null,requires_preview:true}],limit:25,has_more:false,next_cursor:null};
const origin={data_mode:'erp_native',read_only:true,document_id:documentId,kind:'sales_proposals',origin:{system:'origin',entity:'sales_proposals',source_id:sourceId,source_number:'52',source_hash:hash,source_version:'1',command_id:command,imported_at:at}};
const request=(path='',options={})=>new Request('https://api.example.test'+BASE+path,options);
const auth=(path='',data,options={})=>request(path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},...(data===undefined?{}:{body:JSON.stringify(data)}),...Object.fromEntries(Object.entries(options).filter(([k])=>k!=='headers'))});
async function safe(r){assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');const text=await r.text();assert.doesNotMatch(text,/PRIVATE|synthetic-service-key|synthetic-token/);return JSON.parse(text);}
const cases=[
 ['',undefined,'erp_origin_proposal_import_sources',listing,{p_limit:25,p_after:null,p_query:null}],
 ['/preview',{source_id:sourceId},'erp_origin_proposal_import_preview',preview,{p_source_id:sourceId}],
 ['/apply',input,'erp_origin_proposal_import_apply',saved,{p_source_id:sourceId,p_preview_hash:previewHash,p_command_id:command,p_confirm_import:true,p_duplicate_reviewed:true}],
 ['/commands/'+command,undefined,'erp_origin_proposal_import_command',detail,{p_command_id:command}],
 ['/origins/'+sourceId,undefined,'erp_origin_proposal_import_origin',detail,{p_source_id:sourceId}],
 ['/documents/'+documentId+'/origin',undefined,'erp_origin_proposal_document_origin',origin,{p_document_id:documentId}],
];

test('052 exact CORS and allowed methods; Auth is verified before any business body consumption',async()=>{
 let calls=0;const handle=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});
 for(const[path,data]of cases){
  const noAuth=request(path,{method:data?'POST':'GET',body:data?'invalid JSON':undefined});assert.equal((await handle(noAuth,env)).status,401);assert.equal(noAuth.bodyUsed,false);
  for(const method of ['GET','POST','PATCH','DELETE']){
   const r=await handle(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);assert.equal(r.status,method===(data?'POST':'GET')?204:403);
  }
 }
 for(const Origin of ['null','https://erp.example.test.evil.invalid'])assert.equal((await handle(auth('/apply',input,{headers:{Origin}}),env)).status,403);
 const denied=await handle(auth('/apply',input,{method:'PATCH'}),env);assert.equal(denied.status,405);assert.equal(denied.headers.get('Allow'),'POST, OPTIONS');assert.equal(calls,0);
 assert.equal((await handle(request('/apply',{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Actor'}}),env)).status,403);
 for(const answer of [{id:'invalid'},{id:uid,is_anonymous:true}]){let reads=0;const api=createHandler({fetchImpl:async()=>{reads++;return Response.json(answer);}}),req=auth('/apply',input,{body:'invalid JSON'});assert.equal((await api(req,env)).status,answer.is_anonymous?403:401);assert.equal(req.bodyUsed,false);assert.equal(reads,1);}
});
test('052 fixed six RPCs receive only the Auth actor, safe parameters and manual redirects',async()=>{
 for(const[path,data,name,answer,args]of cases){
  const calls=[],handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:uid.toUpperCase()}:{...answer,raw:'PRIVATE'});}});
  const r=await handle(auth(path,data,{headers:{Origin:env.ALLOWED_ORIGINS}}),env);assert.equal(r.status,200,path);const out=await safe(r);assert.equal(out.raw,undefined);assert.equal(out.data_mode,answer.data_mode);assert.equal(calls.length,2);
  assert.equal(calls[0].url,env.SUPABASE_URL+'/auth/v1/user');assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
  assert.equal(calls[1].url,env.SUPABASE_URL+'/rest/v1/rpc/'+name);assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.redirect,'manual');assert.equal(calls[1].options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.deepEqual(JSON.parse(calls[1].options.body),{...args,p_user_id:uid});assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
 }
});
test('052 unconfirmed, spoofed, oversized and unsupported inputs stop after Auth without RPC',async()=>{
 let count=0;const handle=createHandler({fetchImpl:async()=>{count++;return Response.json({id:uid});}});
 for(const[path,data,options,status]of[
  ['?limit=26',undefined,{},400],['?q=a&q=b',undefined,{},400],['?after=01',undefined,{},400],['?q='+encodeURIComponent('\x01'),undefined,{},400],
  ['/commands/'+command+'?raw=1',undefined,{},400],['/origins/01',undefined,{},404],['/invalid',undefined,{},404],
  ['/apply',{...input,p_user_id:uid},{},400],['/apply',{...input,source_id:9520000001},{},400],['/apply',{...input,confirm_import:false},{},400],['/apply',{...input,duplicate_reviewed:false},{},400],['/apply',{...input,total:'25.70'},{},400],
  ['/preview',{source_id:sourceId,command_id:command},{},400],['/apply',input,{headers:{'Content-Encoding':'gzip'}},400],['/apply',input,{headers:{'Content-Type':'text/plain'}},400],['/apply',input,{body:'x'.repeat(4097)},413],['/apply',input,{headers:{'Content-Length':'4097'}},413],
 ]){const before=count,r=await handle(auth(path,data,options),env);assert.equal(r.status,status,path);assert.equal(count-before,1);await safe(r);}
});
test('052 safe SQLSTATE mapping preserves 409 and family-specific 422 without modifying existing routes',async()=>{
 for(const[code,status,message]of [['22023',422,'ERP_VALIDATION_FAILED'],['42501',403,'ERP_FORBIDDEN'],['40001',409,'ERP_CONFLICT'],['23505',409,'ERP_CONFLICT'],['P0002',404,'ERP_NOT_FOUND'],['XX000',503,'ERP_RESULT_UNCONFIRMED']]){
  let writes=0;const handle=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):(writes++,Response.json({code,message:'PRIVATE SQL',hint:env.SUPABASE_SERVICE_ROLE_KEY},{status:400}))});
  const r=await handle(auth('/apply',input),env);assert.equal(r.status,status,code);assert.equal((await safe(r)).error.code,message);assert.equal(writes,1);
 }
 const calls=[],handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'22023',message:'PRIVATE'},{status:400});}});
 const old=await handle(new Request('https://api.example.test/v1/financeiro/accounts',{headers:{Authorization:'Bearer '+token}}),env);assert.equal(old.status,400);assert.equal((await safe(old)).error.code,'ERP_INVALID_QUERY');assert.ok(calls[1].url.endsWith('/erp_finance_list'));
 const missing=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'P0002',message:'PRIVATE'},{status:404})});assert.equal((await missing(auth('/commands/'+command),env)).status,404);
});
test('052 response budget is 1MiB for reads and apply; invalid or oversized apply stays uncertain',async()=>{
 for(const[path,data,answer]of [['',undefined,listing],['/apply',input,saved]])for(const[size,ok]of [[262145,true],[1048577,false]]){
  let rpcCalls=0;const handle=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):(rpcCalls++,Response.json({...answer,ignored:'x'.repeat(size)}))});
  const r=await handle(auth(path,data),env);assert.equal(r.status,ok?200:data?503:502);const out=await safe(r);assert.equal(out.ignored,undefined);assert.equal(rpcCalls,1);if(!ok&&data)assert.equal(out.error.code,'ERP_RESULT_UNCONFIRMED');
 }
});
test('052 lost ACK, redirect and malformed response never trigger an automatic apply retry',async()=>{
 for(const reply of [()=>{throw Error('PRIVATE lost ACK');},()=>new Response(null,{status:307,headers:{Location:'https://never-follow.invalid'}}),()=>new Response('{bad'),()=>new Response(Uint8Array.of(255)),()=>Response.json({...saved,financial_effects:true}),()=>Response.json({...saved,receipt:{...receipt,command_id:documentId}})]){
  const calls=[],handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):reply();}});
  const r=await handle(auth('/apply',input),env);assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(calls.length,2);assert.equal(calls[1].options.redirect,'manual');
 }
});
test('052 recovery read keeps the original receipt beside a later edited document, never reapplying',async()=>{
 const later={...detail,current_document:{...current,version:2,notes:'Texto posterior',status:'cancelled',updated_at:'2026-10-17T00:00:00Z'}},calls=[];
 const handle=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:uid}:later);}}),r=await handle(auth('/commands/'+command),env);
 assert.equal(r.status,200);const out=await safe(r);assert.equal(out.receipt.document.version,1);assert.equal(out.receipt.document.status,'draft');assert.equal(out.current_document.version,2);assert.equal(out.current_document.status,'cancelled');assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/erp_origin_proposal_import_command'));
});
test('052 abort before Auth prevents calls; abort after dispatch aborts upstream and preserves uncertainty',async()=>{
 const stop=new AbortController();stop.abort();let calls=0;const unused=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});assert.equal((await unused(auth('/apply',input,{signal:stop.signal}),env)).status,400);assert.equal(calls,0);
 let entered,signal;const began=new Promise(resolve=>entered=resolve),active=new AbortController();let writes=0;
 const running=createHandler({fetchImpl:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});writes++;signal=options.signal;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}})(auth('/apply',input,{signal:active.signal}),env);
 await began;active.abort();const r=await running;assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(signal.aborted,true);assert.equal(writes,1);
});
test('052 single upstream timeout returns a recoverable result, without leaking request or diagnostics',async()=>{
 let writes=0,signal;const handle=createHandler({timeoutMs:20,fetchImpl:async(url,options)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});writes++;signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('PRIVATE')),{once:true}));}});
 const r=await handle(auth('/apply',input),env);assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(writes,1);assert.equal(signal.aborted,true);
});
