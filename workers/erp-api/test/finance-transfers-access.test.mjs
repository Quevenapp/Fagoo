import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/index.mjs';

const uid='a0000000-0000-4000-8000-000000000001',fromId='b0000000-0000-4000-8000-000000000001',toId='b0000000-0000-4000-8000-000000000002';
const transferId='c0000000-0000-4000-8000-000000000001',commandId='d0000000-0000-4000-8000-000000000001';
const base='/v1/transferencias-internas',token='synthetic-token';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const flags={scope:'finance_internal_transfer',data_mode:'erp_native',bank_operation_performed:false,title_mutation_performed:false,opening_mutation_performed:false};
const data={from_account_id:fromId,to_account_id:toId,expected_from_version:2,expected_to_version:3,amount_cents:'12571',posted_on:'2026-10-16',note:'Transferência interna fictícia',confirmed:true};
const payload={command_id:commandId,...data};
const from={id:fromId,name:'Banco fictício\nConta A',kind:'bank',version_before:2,version_after:3,balance_before_cents:'100000',balance_after_cents:'87429',opening_on:'2026-01-01'};
const to={id:toId,name:'Caixa fictício',kind:'cash',version_before:3,version_after:4,balance_before_cents:'0',balance_after_cents:'12571',opening_on:null};
const currentAccount=s=>({id:s.id,name:s.name,kind:s.kind,active:true,opening_recorded:s.opening_on!==null,version:s.version_after,balance_cents:s.balance_after_cents,opening_on:s.opening_on});
const receipt={id:transferId,command_id:commandId,amount_cents:data.amount_cents,posted_on:data.posted_on,note:data.note,created_at:'2026-10-16T12:00:00Z',from_account:from,to_account:to,movements:[
 {id:'e0000000-0000-4000-8000-000000000001',account_id:fromId,kind:'transfer_out',delta_cents:'-12571'},
 {id:'e0000000-0000-4000-8000-000000000002',account_id:toId,kind:'transfer_in',delta_cents:'12571'},
]};
const current={from_account:currentAccount(from),to_account:currentAccount(to)};
const saved={...flags,receipt,current,replayed:false},detail={...flags,receipt,current,read_only:true};
const empty={...flags,read_only:true,items:[],limit:25,has_more:false,next_cursor:null};
const request=(path=base,options={})=>new Request('https://api.example.test'+path,options);
const auth=(path=base,value,options={})=>request(path,{method:value===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},...(value===undefined?{}:{body:JSON.stringify(value)}),...Object.fromEntries(Object.entries(options).filter(([key])=>key!=='headers'))});
async function safe(response){
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 const text=await response.text();assert.doesNotMatch(text,/PRIVATE|synthetic-service-key|synthetic-token/);return JSON.parse(text);
}
const cases=[
 [base,undefined,'erp_finance_transfer_list',empty,{p_account_id:null,p_limit:25,p_after:null}],
 [base+'/'+transferId,undefined,'erp_finance_transfer_get',detail,{p_id:transferId}],
 [base+'/commands/'+commandId,undefined,'erp_finance_transfer_command',detail,{p_command_id:commandId}],
 [base,payload,'erp_finance_transfer_post',saved,{p_command_id:commandId,p_data:data}],
];

test('053 methods and exact CORS precede Auth; no business body is parsed without a verified session',async()=>{
 let calls=0;const api=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}});
 for(const[path,value]of cases){
  const noAuth=request(path,{method:value?'POST':'GET',body:value?'invalid JSON':undefined});
  assert.equal((await api(noAuth,env)).status,401);assert.equal(noAuth.bodyUsed,false);
  for(const method of['GET','POST','PATCH','DELETE']){
   const r=await api(request(path,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}}),env);
   assert.equal(r.status,(path===base?['GET','POST']:['GET']).includes(method)?204:403);
  }
 }
 for(const headers of[{Origin:'https://erp.example.test.evil.invalid'},{Origin:'null'}])assert.equal((await api(auth(base,payload,{headers}),env)).status,403);
 assert.equal((await api(request(base,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Actor'}}),env)).status,403);
 const denied=await api(auth(base,payload,{method:'PATCH'}),env);assert.equal(denied.status,405);assert.equal(denied.headers.get('Allow'),'GET, POST, OPTIONS');assert.equal(calls,0);
 for(const session of[{id:'not-a-uuid'},{id:uid,is_anonymous:true}]){
  let authCalls=0;const handle=createHandler({fetchImpl:async()=>{authCalls++;return Response.json(session);}}),r=await handle(auth(base,{}),env);
  assert.equal(r.status,session.is_anonymous?403:401);assert.equal(authCalls,1);await safe(r);
 }
});

test('053 verified actor selects four fixed RPCs and projects only receipt/current fields',async()=>{
 for(const[path,value,name,answer,args]of cases){
  const calls=[],api=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:uid.toUpperCase()}:{...answer,raw:{secret:'PRIVATE'},...(answer.receipt?{receipt:{...answer.receipt,raw:'PRIVATE'},current:{...answer.current,private:'PRIVATE'}}:{})});}});
  const r=await api(auth(path,value,{headers:{Origin:env.ALLOWED_ORIGINS}}),env);assert.equal(r.status,200);assert.deepEqual(await safe(r),answer);assert.equal(calls.length,2);
  assert.equal(calls[0].url,env.SUPABASE_URL+'/auth/v1/user');assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
  const rpc=calls[1];assert.equal(rpc.url,env.SUPABASE_URL+'/rest/v1/rpc/'+name);assert.equal(rpc.options.method,'POST');assert.equal(rpc.options.redirect,'manual');
  assert.equal(rpc.options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(rpc.options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);assert.deepEqual(JSON.parse(rpc.options.body),{...args,p_user_id:uid});
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);
 }
});

test('053 strict query/body rejects spoofed actors, unconfirmed writes, invalid money/date and 4KiB bodies before RPC',async()=>{
 let count=0;const api=createHandler({fetchImpl:async()=>{count++;return Response.json({id:uid});}});
 for(const[path,value,options,status]of[
  [base+'?limit=26',undefined,{},400],[base+'?limit=1&limit=2',undefined,{},400],[base+'?p_user_id='+uid,undefined,{},400],
  [base+'/commands/'+commandId+'?limit=1',undefined,{},400],[base+'/invalid',undefined,{},404],
  [base,{...payload,p_user_id:uid},{},400],[base,{...payload,confirmed:false},{},400],[base,{...payload,amount_cents:12571},{},400],
  [base,{...payload,amount_cents:'012571'},{},400],[base,{...payload,to_account_id:fromId},{},400],[base,{...payload,posted_on:'2026-02-30'},{},400],
  [base,payload,{headers:{'Content-Encoding':'gzip'}},400],[base,payload,{headers:{'Content-Type':'text/plain'}},400],
  [base,payload,{body:'x'.repeat(4097)},413],[base,payload,{headers:{'Content-Length':'4097'}},413],
 ]){const before=count,r=await api(auth(path,value,options),env);assert.equal(r.status,status,path);assert.equal(count-before,1);await safe(r);}
});

test('053 SQLSTATE errors are closed and sanitized; command absence is an unambiguous 404',async()=>{
 for(const[code,status,expected]of[['42501',403,'ERP_FORBIDDEN'],['22023',400,'ERP_INVALID_QUERY'],['P0002',404,'ERP_NOT_FOUND'],['40001',409,'ERP_CONFLICT'],['23505',409,'ERP_CONFLICT'],['55000',409,'ERP_CONFLICT'],['XX000',503,'ERP_RESULT_UNCONFIRMED']]){
  let writes=0;const api=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):(writes++,Response.json({code,message:'PRIVATE SQL',hint:env.SUPABASE_SERVICE_ROLE_KEY},{status:400}))});
  const r=await api(auth(base,payload),env);assert.equal(r.status,status,code);assert.equal((await safe(r)).error.code,expected);assert.equal(writes,1);
 }
 const api=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'P0002',message:'PRIVATE'},{status:404})});
 const r=await api(auth(base+'/commands/'+commandId),env);assert.equal(r.status,404);assert.equal((await safe(r)).error.code,'ERP_NOT_FOUND');
});

test('053 read and write response budgets are 256KiB; failed POST validation remains uncertain',async()=>{
 for(const[value,answer]of[[undefined,empty],[payload,saved]])for(const[size,ok]of[[131073,true],[262145,false]]){
  let rpcCalls=0;const api=createHandler({fetchImpl:async url=>url.endsWith('/auth/v1/user')?Response.json({id:uid}):(rpcCalls++,Response.json({...answer,ignored:'x'.repeat(size)}))});
  const r=await api(auth(base,value),env);assert.equal(r.status,ok?200:value?503:502);const out=await safe(r);assert.equal(out.ignored,undefined);assert.equal(rpcCalls,1);if(!ok&&value)assert.equal(out.error.code,'ERP_RESULT_UNCONFIRMED');
 }
});

test('053 lost ACK, redirect, malformed bytes or wrong receipt never trigger an automatic POST retry',async()=>{
 for(const response of[
  ()=>{throw Error('PRIVATE lost ACK');},()=>new Response(null,{status:307,headers:{Location:'https://never-follow.invalid/'}}),
  ()=>new Response('{broken'),()=>new Response(Uint8Array.of(0xff)),()=>Response.json({...saved,bank_operation_performed:true}),
  ()=>Response.json({...saved,receipt:{...receipt,command_id:transferId}}),
 ]){
  const calls=[],api=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):response();}});
  const r=await api(auth(base,payload),env);assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(calls.length,2);assert.equal(calls[1].options.redirect,'manual');
 }
});

test('053 historical receipt is preserved while command recovery can show later account versions and balances',async()=>{
 const later={...detail,current:{...current,from_account:{...current.from_account,version:4,balance_cents:'90000',name:'Nome atual\tpermitido',active:false}}};
 const api=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:later)}),r=await api(auth(base+'/commands/'+commandId),env);
 assert.equal(r.status,200);const out=await safe(r);assert.equal(out.receipt.from_account.balance_after_cents,'87429');assert.equal(out.current.from_account.balance_cents,'90000');assert.equal(out.current.from_account.active,false);
 const wrong=createHandler({fetchImpl:async url=>Response.json(url.endsWith('/auth/v1/user')?{id:uid}:{...detail,receipt:{...receipt,id:commandId}})});
 assert.equal((await wrong(auth(base+'/'+transferId),env)).status,502);
});

test('053 cancellation before Auth prevents dispatch; abort after sending preserves uncertainty and aborts upstream',async()=>{
 const stopped=new AbortController();stopped.abort();let count=0;
 const api=createHandler({fetchImpl:async()=>{count++;throw Error('UNEXPECTED');}});assert.equal((await api(auth(base,payload,{signal:stopped.signal}),env)).status,400);assert.equal(count,0);
 let entered;const reached=new Promise(resolve=>entered=resolve),abort=new AbortController();let writes=0,signal;
 const running=createHandler({fetchImpl:async(url,options)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});writes++;signal=options.signal;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 }})(auth(base,payload,{signal:abort.signal}),env);
 await reached;abort.abort();const r=await running;assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(signal.aborted,true);assert.equal(writes,1);
});

test('053 upstream deadline aborts the single mutation request with a recoverable response',async()=>{
 let signal,writes=0;const api=createHandler({timeoutMs:20,fetchImpl:async(url,options)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid});writes++;signal=options.signal;
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 }}),r=await api(auth(base,payload),env);
 assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(writes,1);assert.equal(signal.aborted,true);
});

test('053 integration preserves existing 010 finance dispatch',async()=>{
 const calls=[],api=createHandler({fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/auth/v1/user')?Response.json({id:uid}):Response.json({code:'42501',message:'PRIVATE'},{status:403});}});
 const r=await api(auth('/v1/financeiro/accounts'),env);assert.equal(r.status,403);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/rpc/erp_finance_list'));await safe(r);
});
