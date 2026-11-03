import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHandler} from '../src/index.mjs';
import {createNetCreditFixture} from './helpers/itau-net-credit-fixture.mjs';

// Real public handler → synthetic Auth/HTTP Storage → real SQL058, with no network.
let f;
before(async()=>{f=await createNetCreditFixture();});
after(()=>f?.close());
const base='/v1/retornos-itau109',token='synthetic-058-bearer';
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-058-service-key',ALLOWED_ORIGINS:'https://erp.example.test'};
const req=(path,value,options={})=>new Request('https://api.example.test'+base+path,{method:value===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},...(value===undefined?{}:{body:JSON.stringify(value)}),...Object.fromEntries(Object.entries(options).filter(([k])=>k!=='headers'))});
async function safe(response){assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');const s=await response.text();assert.doesNotMatch(s,/PRIVATE|synthetic-058-service-key|synthetic-058-bearer/);return JSON.parse(s);}
function boundary({actor,override}={}){
 const calls=[],fetchImpl=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,env.SUPABASE_URL);assert.equal(options.redirect,'manual');calls.push({url,options});
  if(u.pathname==='/auth/v1/user'){assert.equal(options.headers.Authorization,'Bearer '+token);return Response.json({id:actor??f.users.financeiro});}
  assert.equal(options.headers.Authorization,'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);
  const match=/^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u.pathname);
  if(match){const name=match[1],args=JSON.parse(options.body);assert.equal(options.method,'POST');assert.equal(args.p_user_id,actor??f.users.financeiro);
   const run=async()=>{try{return Response.json(await f.rpc(name,args));}catch(e){return Response.json({code:e.code,message:'PRIVATE SQL details',hint:'PRIVATE'},{status:400});}};
   return override?override({name,args,run,options}):run();
  }
  const prefix='/storage/v1/object/authenticated/';assert.ok(u.pathname.startsWith(prefix));assert.equal(options.method,'GET');const bytes=f.objects.get(decodeURIComponent(u.pathname.slice(prefix.length)));assert.ok(bytes);return new Response(bytes.slice(),{headers:{'Content-Type':'application/octet-stream'}});
 };
 return{calls,handler:createHandler({fetchImpl})};
}
async function prepared(){const x=await f.prepare(),c=await f.category(),i=await f.importFile(x,f.source(x,{paid:'12000',fee:'345'}));return{x,c,i,selection:{file_id:i.ack.id,line:i.event.line,fee_category_id:c.id,expected_fee_category_version:c.version}};}
async function reviewed(b,t){const r=await b.handler(req(`/events/${t.i.event.event_id}/preview`,t.selection),env);assert.equal(r.status,200);const p=await safe(r);assert.equal(p.bytes_verified,true);assert.equal(p.context.settlement.allowed,true);return{...t.selection,command_id:randomUUID(),expected_approval_version:1,context_hash:p.context_hash,confirm:true};}

test('058 real middleware checks method/origin/session before parsing any money decision',async()=>{
 let calls=0;const handler=createHandler({fetchImpl:async()=>{calls++;throw Error('UNEXPECTED');}}),id=randomUUID();
 for(const[path,method]of[[`/events/${id}/preview`,'POST'],[`/events/${id}/settle`,'POST'],[`/commands/${id}`,'GET']]){
  const request=req(path,method==='POST'?{}:undefined,{headers:{Authorization:''},body:method==='POST'?'broken JSON':undefined});
  assert.equal((await handler(request,env)).status,401);assert.equal(request.bodyUsed,false);
  for(const candidate of['GET','POST','PATCH','DELETE']){
   const r=await handler(req(path,undefined,{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGINS,'Access-Control-Request-Method':candidate,'Access-Control-Request-Headers':'authorization,content-type'}}),env);assert.equal(r.status,candidate===method?204:403);
  }
  assert.equal((await handler(req(path,undefined,{method:'DELETE'}),env)).status,405);
 }
 assert.equal((await handler(req(`/commands/${id}`,undefined,{headers:{Origin:env.ALLOWED_ORIGINS+'.evil.invalid'}}),env)).status,403);assert.equal(calls,0);
 for(const session of[{id:'invalid'},{id:f.users.financeiro,is_anonymous:true}]){
  let count=0;const h=createHandler({fetchImpl:async()=>{count++;return Response.json(session);}});assert.equal((await h(req(`/commands/${id}`),env)).status,session.is_anonymous?403:401);assert.equal(count,1);
 }
});
test('058 real handler verifies bytes, injects actor and returns immutable receipt/current with exactly one pair',async()=>{
 const b=boundary(),t=await prepared(),command=await reviewed(b,t),r=await b.handler(req(`/events/${t.i.event.event_id}/settle`,command,{headers:{Origin:env.ALLOWED_ORIGINS}}),env);
 assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGINS);const ack=await safe(r);assert.equal(ack.receipt.posting.net_cash_cents,'12000');
 const current=await safe(await b.handler(req(`/commands/${command.command_id}`),env));assert.deepEqual(current.receipt,ack.receipt);assert.equal(current.current_account.balance_cents,'12000');
 assert.equal((await safe(await b.handler(req(`/events/${t.i.event.event_id}/settle`,command),env))).replayed,true);
 assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement where command_id=$1',[command.command_id]),2);
 assert.ok(b.calls.some(c=>c.url.includes('/storage/v1/object/authenticated/brufap-cnab/')));
});
test('058 boundary rejects body injection and strict limits after Auth but before RPC',async()=>{
 let calls=0;const h=createHandler({fetchImpl:async()=>{calls++;return Response.json({id:f.users.financeiro});}}),t=await prepared();
 for(const[value,options,path]of[[{...t.selection,p_user_id:randomUUID()},{}],[{...t.selection,principal_cents:'1'},{}],[{...t.selection,account_id:randomUUID()},{}],[t.selection,{headers:{'Content-Encoding':'gzip'}}],[t.selection,{body:'x'.repeat(8193)}],[t.selection,{},'?x=1']]){
  const before=calls,r=await h(req(`/events/${t.i.event.event_id}/preview${path??''}`,value,options),env);assert.equal(r.status,400);await safe(r);assert.equal(calls-before,1);
 }
});
test('058 boundary maps SQL errors without private diagnostics and command absence stays404',async()=>{
 const id=randomUUID();for(const[code,status]of[['42501',403],['22023',400],['P0002',404],['40001',409],['23505',409],['55000',409]]){
  const b=boundary({override:async()=>Response.json({code,message:'PRIVATE SQL',hint:env.SUPABASE_SERVICE_ROLE_KEY},{status:400})}),r=await b.handler(req(`/commands/${id}`),env);assert.equal(r.status,status,code);await safe(r);assert.equal(b.calls.length,2);
 }
 const b=boundary({actor:f.users.vendas});assert.equal((await b.handler(req(`/commands/${id}`),env)).status,403);
 assert.equal((await boundary().handler(req(`/commands/${id}`),env)).status,404);
});
test('058 real commit then lost ACK remains recoverable with GET and never retries automatically',async()=>{
 let posts=0;const b=boundary({override:async({name,run})=>{const r=await run();if(name==='erp_cnab_itau_net_credit_settle'){posts++;assert.equal(r.status,200);throw Error('PRIVATE ACK LOST');}return r;}}),t=await prepared(),command=await reviewed(b,t);
 const r=await b.handler(req(`/events/${t.i.event.event_id}/settle`,command),env);assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');
 const read=await safe(await b.handler(req(`/commands/${command.command_id}`),env));assert.equal(read.current_account.balance_cents,'12000');assert.equal(posts,1);
});
test('058 response budget256KiB applies to reads and write ACK; oversized post stays uncertain',async()=>{
 const b=boundary(),t=await prepared(),command=await reviewed(b,t);assert.equal((await b.handler(req(`/events/${t.i.event.event_id}/settle`,command),env)).status,200);
 for(const size of[131073,262145]){
  const limited=boundary({override:async({name,run})=>{const response=await run();if(name==='erp_cnab_itau_net_credit_command'||name==='erp_cnab_itau_net_credit_settle')return Response.json({...await response.json(),ignored:'x'.repeat(size)});return response;}});
  for(const[path,value]of[[`/commands/${command.command_id}`,undefined],[`/events/${t.i.event.event_id}/settle`,command]]){
   const r=await limited.handler(req(path,value),env);assert.equal(r.status,size<262144?200:value?503:502);const out=await safe(r);assert.equal(out.ignored,undefined);if(size>262144&&value)assert.equal(out.error.code,'ERP_RESULT_UNCONFIRMED');
  }
 }
});
test('058 request abort after SQL commit is uncertain and stops dispatch, while GET recovers exact same pair',async()=>{
 const stop=new AbortController();let posts=0,upstreamSignal;
 const b=boundary({override:async({name,run,options})=>{const r=await run();if(name==='erp_cnab_itau_net_credit_settle'){posts++;upstreamSignal=options.signal;stop.abort();}return r;}}),t=await prepared(),command=await reviewed(b,t);
 const r=await b.handler(req(`/events/${t.i.event.event_id}/settle`,command,{signal:stop.signal}),env);assert.equal(r.status,503);assert.equal((await safe(r)).error.code,'ERP_RESULT_UNCONFIRMED');assert.equal(posts,1);assert.equal(upstreamSignal.aborted,true);
 const read=await safe(await b.handler(req(`/commands/${command.command_id}`),env));assert.equal(read.receipt.movements.length,2);assert.equal(read.current_account.balance_cents,'12000');
});
