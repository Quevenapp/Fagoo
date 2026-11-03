import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',draft='a0000000-0000-4000-8000-000000000002';
const session={access_token:'synthetic-session-token-123456789',user:{id:uid}},tick=()=>new Promise(resolve=>setImmediate(resolve));
const member=role=>({user_id:uid,role,resources:['nfe','nfce'],data_mode:'staging_readonly'});
const json=(value,status=200)=>Response.json(value,{status});
function fixture(fetcher,configured=true){
 let callback=()=>{};
 const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange(fn){callback=fn;return{data:{subscription:{unsubscribe(){}}}};},
  signOut:async()=>{callback('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=createAccessController(auth,'https://erp.synthetic.invalid',fetcher,configured?{a1ApiUrl:'https://fiscal.synthetic.invalid'}:{});
 const stop=controller.start();return{controller,stop};
}
test('unsigned controller shares verified session, routes only to the fiscal gateway, and rejects actor overrides',async()=>{
 const calls=[],f=fixture(async(url,options)=>{calls.push({url,options});return json(url.endsWith('/v1/me')?member('fiscal'):{status:'synthetic'});});
 try{await tick();const body={draft_id:draft,completion_version:1};
  assert.equal((await f.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body})).status,'synthetic');
  const call=calls.at(-1);assert.equal(call.url,'https://fiscal.synthetic.invalid/v1/fiscal-unsigned/preview');assert.equal(call.options.headers.Authorization,'Bearer '+session.access_token);
  assert.deepEqual(JSON.parse(call.options.body),body);assert.equal(call.options.redirect,'manual');assert.equal(call.options.credentials,'omit');
  const size=calls.length;await assert.rejects(f.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{...body,actor:uid}}),e=>e instanceof AccessError&&e.status===400);
  assert.equal(calls.length,size);assert.equal(f.controller.getSnapshot().phase,'ready');
 }finally{f.stop();}
});
test('unsigned capability is unavailable without its origin and ordinary login remains usable',async()=>{
 const f=fixture(async()=>json(member('admin')),false);
 try{await tick();assert.equal(f.controller.getSnapshot().phase,'ready');await assert.rejects(f.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{draft_id:draft,completion_version:1}}),e=>e.status===503);assert.equal(f.controller.getSnapshot().phase,'ready');}finally{f.stop();}
});
test('logout aborts an in-flight unsigned request and rejects a late response from the previous session',async()=>{
 let signal,release;const pending=new Promise(resolve=>{release=resolve;});const f=fixture(async(url,options)=>{if(url.endsWith('/v1/me'))return json(member('admin'));signal=options.signal;return pending;});
 try{await tick();const running=f.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{draft_id:draft,completion_version:1}});const rejected=assert.rejects(running,e=>e.name==='AbortError');await tick();await f.controller.logout();await rejected;assert.equal(signal.aborted,true);release(json({private_data:'old-session'}));await tick();assert.equal(f.controller.getSnapshot().phase,'signed_out');}
 finally{release?.(json({}));f.stop();}
});
test('gateway401 ends the session and gateway403 rechecks membership before another unsigned action',async()=>{
 for(const status of[401,403]){
  let checks=0,gatewayCalls=0;const f=fixture(async url=>url.endsWith('/v1/me')?json(member(++checks===1?'fiscal':'consulta')):(gatewayCalls++,json({error:'not-shown'},status)));
  try{await tick();await assert.rejects(f.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{draft_id:draft,completion_version:1}}),e=>e.status===status);await tick();assert.equal(f.controller.getSnapshot().phase,status===401?'signed_out':'ready');if(status===403)assert.equal(f.controller.getSnapshot().membership.role,'consulta');
   await assert.rejects(f.controller.fiscalUnsigned('/v1/fiscal-unsigned/preview',{method:'POST',body:{draft_id:draft,completion_version:1}}),e=>e.status===(status===401?401:403));assert.equal(gatewayCalls,1);
  }finally{f.stop();}
 }
});
