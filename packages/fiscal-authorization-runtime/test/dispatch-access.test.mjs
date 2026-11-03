import test from 'node:test';import assert from 'node:assert/strict';
import {createDispatchAccessReader} from '../src/dispatch-access.mjs';
const actor='10000000-0000-4000-8000-000000000069',other='20000000-0000-4000-8000-000000000069',projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic_service_key_no_real_credential';
const options=()=>({signal:new AbortController().signal,deadline:Date.now()+5000});
const member=(role='fiscal')=>({user_id:actor,role,resources:['nfe','nfce'],data_mode:'staging_readonly'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};},tick=()=>new Promise(r=>setImmediate(r));
const make=fetchImpl=>createDispatchAccessReader({projectUrl,serviceKey,fetchImpl});
const denied=(code,status)=>e=>e.code===code&&e.status===status;

test('dispatch status uses only the fixed read-only membership RPC, exact actor and current admin/fiscal role',async()=>{
 for(const role of ['admin','fiscal']){const calls=[],config={projectUrl,serviceKey,fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(member(role));}},read=createDispatchAccessReader(config);config.projectUrl='https://wrong.invalid';config.serviceKey='changed';config.fetchImpl=async()=>{throw Error('Changed port must not run');};const result=await read(actor,options());
  assert.deepEqual(result,{actor,role});assert.ok(Object.isFrozen(result));assert.equal(calls.length,1);const {url,init}=calls[0];assert.equal(url,projectUrl+'/rest/v1/rpc/erp_access_me');assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{p_user_id:actor});assert.equal(init.headers.Authorization,'Bearer '+serviceKey);assert.equal(init.headers.apikey,serviceKey);assert.equal(init.headers['Accept-Encoding'],'identity');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.signal.aborted,true);
 }
});
test('dispatch status rejects other roles and ignores auth/profile-like metadata as an authority',async()=>{
 for(const role of ['vendas','financeiro','estoque','consulta','ADMIN',null])await assert.rejects(make(async()=>Response.json(member(role)))(actor,options()),denied('AUTHORIZATION_FORBIDDEN',403));
 for(const raw of [{...member(),user_id:other},{...member(),data_mode:'erp_native'},{...member(),resources:null},{...member(),resources:Array(11).fill('nfe')},{...member(),resources:[{}]},{...member(),user_metadata:{role:'admin'}},{user:{id:actor,app_metadata:{role:'admin'}}},[member()],null])await assert.rejects(make(async()=>Response.json(raw))(actor,options()),denied('AUTHORIZATION_SERVICE_UNAVAILABLE',503));
});
test('dispatch status denies explicit SQL ACL failures and sanitizes upstream business text',async()=>{
 for(const status of [400,401,403,500]){const reader=make(async()=>Response.json({code:status===400?'42501':'UNTRUSTED',message:'PRIVATE_SQL_DETAIL_DO_NOT_RETURN'},{status}));await assert.rejects(reader(actor,options()),e=>{assert.doesNotMatch(e.message,/PRIVATE_SQL_DETAIL/);return [400,401,403].includes(status)?denied('AUTHORIZATION_FORBIDDEN',403)(e):denied('AUTHORIZATION_SERVICE_UNAVAILABLE',503)(e);});}
});
test('dispatch status configuration is closed to extra fields and getters and never chooses a caller route',()=>{
 let getters=0;const get=()=>{getters++;return projectUrl;};for(const value of [{projectUrl:'http://abcdefghijklmnopqrst.supabase.co',serviceKey,fetchImpl:fetch},{projectUrl:projectUrl+'/rest/v1',serviceKey,fetchImpl:fetch},{projectUrl:'https://user@abcdefghijklmnopqrst.supabase.co',serviceKey,fetchImpl:fetch},{projectUrl:projectUrl+'?query=1',serviceKey,fetchImpl:fetch},{projectUrl,serviceKey:'short',fetchImpl:fetch},{projectUrl,serviceKey:serviceKey+'\n',fetchImpl:fetch},{projectUrl,serviceKey,fetchImpl:fetch,endpoint:'https://other.invalid'},Object.defineProperty({serviceKey,fetchImpl:fetch},'projectUrl',{enumerable:true,get})])assert.throws(()=>createDispatchAccessReader(value));assert.equal(getters,0);
});
test('dispatch status snapshots options synchronously and rejects forged fields/accessors before fetch',async()=>{
 const gate=deferred(),calls=[],reader=make(async(url,init)=>{calls.push(init);return gate.promise;}),abort=new AbortController(),original={signal:abort.signal,deadline:Date.now()+5000},pending=reader(actor,original);original.signal=new AbortController().signal;original.deadline=0;await tick();assert.equal(calls.length,1);gate.resolve(Response.json(member()));assert.deepEqual(await pending,{actor,role:'fiscal'});
 let getters=0;for(const opts of [Object.defineProperty({deadline:Date.now()+1000},'signal',{enumerable:true,get(){getters++;return abort.signal;}}),{...options(),role:'admin'},{...options(),deadline:NaN},{...options(),signal:{}}])await assert.rejects(reader(actor,opts));for(const bad of [null,other.toUpperCase().replace('2','Z'),''])await assert.rejects(reader(bad,options()));assert.equal(calls.length,1);assert.equal(getters,0);
});
test('dispatch status rejects already cancelled or expired scopes without contacting any service',async()=>{
 let calls=0;const reader=make(async()=>{calls++;return Response.json(member());}),aborted=new AbortController();aborted.abort();await assert.rejects(reader(actor,{signal:aborted.signal,deadline:Date.now()+1000}),denied('AUTHORIZATION_UPSTREAM_UNAVAILABLE',503));await assert.rejects(reader(actor,{signal:new AbortController().signal,deadline:Date.now()-1}),denied('AUTHORIZATION_UPSTREAM_UNAVAILABLE',503));assert.equal(calls,0);
});
test('dispatch status abort fences a late fetch and cancels its body without a retry',async()=>{
 const gate=deferred(),abort=new AbortController();let cancelled=0,calls=0,signal;const reader=make(async(_,init)=>{calls++;signal=init.signal;return gate.promise;}),pending=reader(actor,{signal:abort.signal,deadline:Date.now()+5000}),rejected=assert.rejects(pending,denied('AUTHORIZATION_UPSTREAM_UNAVAILABLE',503));await tick();abort.abort();await rejected;assert.equal(signal.aborted,true);gate.resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}));await tick();assert.equal(cancelled,1);assert.equal(calls,1);
});
test('dispatch status reading is bounded by caller deadline and abort, including a stalled body',async()=>{
 for(const stop of ['deadline','abort']){const abort=new AbortController();let cancel=0,calls=0;const reader=make(async()=>{calls++;return new Response(new ReadableStream({cancel(){cancel++;}}),{headers:{'Content-Type':'application/json'}});}),pending=reader(actor,{signal:abort.signal,deadline:Date.now()+(stop==='deadline'?30:5000)}),rejected=assert.rejects(pending,e=>[408,503].includes(e.status));await tick();if(stop==='abort')abort.abort();await rejected;await tick();assert.equal(calls,1);assert.equal(cancel,1);}
});
test('dispatch status rejects redirect, foreign response origin, encoding, malformed UTF8/JSON and bytes beyond8192',async()=>{
 const results=[()=>new Response('{}',{status:302,headers:{location:'https://other.invalid','Content-Type':'application/json'}}),()=>Object.defineProperty(Response.json(member()),'redirected',{value:true}),()=>Object.defineProperty(Response.json(member()),'url',{value:'https://other.invalid/rpc'}),()=>new Response(JSON.stringify(member()),{headers:{'Content-Type':'text/html'}}),()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Encoding':'gzip'}}),()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'8193'}}),()=>new Response(' '.repeat(8193),{headers:{'Content-Type':'application/json'}}),()=>new Response(Uint8Array.of(0xc3,0x28),{headers:{'Content-Type':'application/json'}}),()=>new Response('{malformed',{headers:{'Content-Type':'application/json'}}),()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'1'}})];
 for(const makeResponse of results){let calls=0;await assert.rejects(make(async()=>{calls++;return makeResponse();})(actor,options()));assert.equal(calls,1);}
});
test('dispatch status does not grant access after an abort during response parsing',async()=>{
 const abort=new AbortController(),response=Response.json(member()),reader=make(async()=>{Object.defineProperty(response,'status',{get(){abort.abort();return 200;}});return response;});await assert.rejects(reader(actor,{signal:abort.signal,deadline:Date.now()+5000}),denied('AUTHORIZATION_UPSTREAM_UNAVAILABLE',503));
});
