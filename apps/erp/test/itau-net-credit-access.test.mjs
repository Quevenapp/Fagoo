import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {captureNetCreditRequest} from '../src/lib/itau-net-credit-client.ts';
import {uid} from './helpers/itau-net-credit-fixtures.mjs';
const BASE='/v1/retornos-itau109',actor=uid(1000),event=uid(4),command=uid(90),tick=()=>new Promise(r=>setTimeout(r,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
const body=()=>({file_id:uid(3),line:2,fee_category_id:uid(20),expected_fee_category_version:1,command_id:command,expected_approval_version:1,context_hash:'a'.repeat(64),confirm:true});
const member=role=>Response.json({user_id:actor,role,resources:[],data_mode:'staging_readonly'});
async function setup({role='admin',data=()=>Response.json({synthetic:true}),me=()=>member(role)}={}){
 let listener,n=0;const session={access_token:'synthetic-token',user:{id:actor}},auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:cb=>{listener=cb;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})},calls=[];
 const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return me(++n);calls.push({url,options});return data(url,options,calls.length);});const stop=controller.start();await tick();return{controller,calls,stop,refresh:()=>listener('TOKEN_REFRESHED',{access_token:'synthetic-renewed',user:{id:actor}})};
}
test('058 controller authorizes exact read/write roles and fixed paths; browser cannot supply money or actor',async()=>{
 for(const role of ['admin','financeiro','consulta','vendas','estoque','fiscal']){const s=await setup({role});try{
  if(['admin','financeiro','consulta'].includes(role))await s.controller.itauNetCredit(`${BASE}/commands/${command}`);else await assert.rejects(()=>s.controller.itauNetCredit(`${BASE}/commands/${command}`),status(403));
  if(['admin','financeiro'].includes(role))await s.controller.itauNetCredit(`${BASE}/events/${event}/settle`,{method:'POST',body:body()});else await assert.rejects(()=>s.controller.itauNetCredit(`${BASE}/events/${event}/settle`,{method:'POST',body:body()}),status(403));
  for(const c of s.calls){assert.equal(c.options.headers.Authorization,'Bearer synthetic-token');assert.equal(c.options.cache,'no-store');assert.equal(c.options.redirect,'error');}
 }finally{s.stop();}}
 const s=await setup();try{for(const path of [BASE,`${BASE}/commands/${command}?secret=1`,`${BASE}/commands/${command}#fragment`,'https://foreign.invalid'+BASE,`${BASE}/../financeiro`,`${BASE}/events/${event}/settle/`])await assert.rejects(()=>s.controller.itauNetCredit(path),status(400));
  for(const patch of [{actor:uid(1)},{amount_cents:'1'},{posted_on:'2026-10-16'},{fee_category_id:null},{confirm:false}])await assert.rejects(()=>s.controller.itauNetCredit(`${BASE}/events/${event}/settle`,{method:'POST',body:{...body(),...patch}}),status(400));
  await assert.rejects(()=>s.controller.itauNetCredit(`${BASE}/commands/${command}`,{method:'POST',body:{}}),status(400));assert.equal(s.calls.length,0);
 }finally{s.stop();}
});
test('058 capture rejects getters and preserves immutable body/signal across same-actor TOKEN_REFRESHED wait',async()=>{
 let reads=0;assert.throws(()=>captureNetCreditRequest(`${BASE}/events/${event}/settle`,{method:'POST',get body(){reads++;return body();}}));assert.equal(reads,0);
 let release;const gate=new Promise(r=>release=r),s=await setup({me:n=>n===2?gate:member('admin')});try{s.refresh();const source=body(),signal=new AbortController(),replacement=new AbortController(),options={method:'POST',body:source,signal:signal.signal},pending=s.controller.itauNetCredit(`${BASE}/events/${event}/settle`,options);const expected=structuredClone(source);source.fee_category_id=uid(99);options.signal=replacement.signal;options.body={};await tick();assert.equal(s.calls.length,0);release(member('admin'));await pending;assert.deepEqual(JSON.parse(s.calls[0].options.body),expected);assert.equal(s.calls[0].options.headers.Authorization,'Bearer synthetic-renewed');replacement.abort();assert.equal(s.calls[0].options.signal.aborted,false);}finally{release(member('admin'));s.stop();}
});
test('058403 revalidation preserves same-actor ready state and never retries a write automatically',async()=>{
 const s=await setup({data:()=>Response.json({}, {status:403})});try{await assert.rejects(()=>s.controller.itauNetCredit(`${BASE}/events/${event}/settle`,{method:'POST',body:body()}),status(403));await tick();assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(s.controller.getSnapshot().membership.user_id,actor);assert.equal(s.calls.length,1);}finally{s.stop();}
});
test('058 limits256KiB and cancellation prevent invalid or late results; no automatic POST repetition',async()=>{
 const bounded=await setup({data:()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(262145)}})});try{await assert.rejects(()=>bounded.controller.itauNetCredit(`${BASE}/commands/${command}`),status(502));assert.equal(bounded.calls.length,1);}finally{bounded.stop();}
 for(const cancel of ['signal','logout']){let release;const s=await setup({data:()=>new Promise(r=>release=r)}),abort=new AbortController();try{const pending=s.controller.itauNetCredit(`${BASE}/events/${event}/settle`,{method:'POST',body:body(),signal:abort.signal}),rejected=assert.rejects(pending,e=>e.name==='AbortError');await tick();if(cancel==='logout')await s.controller.logout();else abort.abort();assert.equal(s.calls[0].options.signal.aborted,true);release(Response.json({synthetic:'late'}));await rejected;assert.equal(s.calls.length,1);}finally{s.stop();}}
});
