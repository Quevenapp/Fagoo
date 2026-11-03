import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {authorizationQaCandidate,authorizationQaPreview,AUTHORIZATION_QA_ACTOR as actor} from '../src/qa/authorization-fixture.ts';

const c=authorizationQaCandidate(),f={id:c.candidate_id,dto:authorizationQaPreview(c)},other='a0000000-0000-4000-8000-000000000799';
const token='synthetic-authorization-session-token-123456789',nextToken='synthetic-authorization-refreshed-token-123456789';
const path='/v1/fiscal-authorization/preview',origin='https://authorization.synthetic.invalid';
const body={candidate_id:c.candidate_id,signed_hash:c.artifact.sha256},opts=()=>({method:'POST',body:{...body}});
const session=(access_token=token,id=actor)=>({access_token,user:{id}}),member=(role='fiscal',id=actor)=>({user_id:id,role,resources:['nfe','nfce'],data_mode:'staging_readonly'});
const tick=()=>new Promise(r=>setImmediate(r));
async function until(p){for(let i=0;i<150&&!p();i++)await tick();assert.ok(p(),'bounded fixture wait');}
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function setup({role='fiscal',configured=true,before=()=>{},after=()=>{}}={}){
 let callback=()=>{};const state={role,actor},calls=[],phases=[];
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){callback=fn;return{data:{subscription:{unsubscribe(){}}}};},
  signOut:async options=>{assert.deepEqual(options,{scope:'local'});callback('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=createAccessController(auth,'https://erp.synthetic.invalid',async(url,options)=>{
  const call={url,options};calls.push(call);const custom=await before(call,state);if(custom)return custom;
  const value=url.endsWith('/v1/me')?member(state.role,state.actor):structuredClone(f.dto);
  if(!url.endsWith('/v1/me')){assert.equal(url,origin+path);assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),body);}
  return await after(call,state,value)??Response.json(value);
 },configured?{a1ApiUrl:origin}:{});
 const stop=controller.start(),unsubscribe=controller.subscribe(()=>phases.push(controller.getSnapshot().phase));
 return{controller,state,calls,phases,emit:(event,s)=>callback(event,s),close(){unsubscribe();stop();}};
}
const previews=p=>p.calls.filter(c=>c.url.startsWith(origin));
const me=p=>p.calls.filter(c=>c.url.endsWith('/v1/me'));
test('AUTHORIZATION controller forwards only authenticated read-only POSTs to the configured gateway; roles and malformed inputs cannot dispatch',async()=>{
 for(const role of ['admin','fiscal']){const p=setup({role});try{await until(()=>p.controller.getSnapshot().phase==='ready');const value=await p.controller.fiscalAuthorization(path,opts());assert.equal(value.signed_hash,f.dto.signed_hash);assert.equal(previews(p).length,1);assert.equal(previews(p)[0].options.headers.Authorization,`Bearer ${token}`);}finally{p.close();}}
 for(const role of ['consulta','vendas','financeiro','estoque']){const p=setup({role});try{await until(()=>p.controller.getSnapshot().phase==='ready');await assert.rejects(p.controller.fiscalAuthorization(path,opts()),e=>e instanceof AccessError&&e.status===403);assert.equal(previews(p).length,0);}finally{p.close();}}
 const p=setup();try{await until(()=>p.controller.getSnapshot().phase==='ready');
  for(const [route,o]of [[path,{method:'GET'}],[path,{method:'PATCH'}],[path,{body:undefined}],[path,{body:{}}],[path+'?x=1',{}],[path.replace('/preview','/run'),{}],['https://other.invalid'+path,{}]])await assert.rejects(p.controller.fiscalAuthorization(route,o),e=>e.status===400);
  assert.equal(previews(p).length,0);
 }finally{p.close();}
 const absent=setup({configured:false});try{await until(()=>absent.controller.getSnapshot().phase==='ready');await assert.rejects(absent.controller.fiscalAuthorization(path,opts()),e=>e.status===503);assert.equal(previews(absent).length,0);}finally{absent.close();}
});
test('AUTHORIZATION controller captures method/signal before lazy import, rejects accessors and removes the original listener',async()=>{
 const p=setup();try{await until(()=>p.controller.getSnapshot().phase==='ready');
  const abort=new AbortController(),counts={add:0,remove:0},add=abort.signal.addEventListener.bind(abort.signal),remove=abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener=(...args)=>{counts.add++;return add(...args);};abort.signal.removeEventListener=(...args)=>{counts.remove++;return remove(...args);};
  const options={...opts(),signal:abort.signal},pending=p.controller.fiscalAuthorization(path,options);options.body.signed_hash='0'.repeat(64);options.method='GET';options.signal=new AbortController().signal;
  await pending;assert.deepEqual(counts,{add:1,remove:1});assert.equal(previews(p)[0].options.method,'POST');
  let touched=0;const bad=Object.defineProperty({},'signal',{enumerable:true,get(){touched++;return undefined;}});await assert.rejects(p.controller.fiscalAuthorization(path,bad),e=>e.status===400);assert.equal(touched,0);
  const cancel=new AbortController(),reading=p.controller.fiscalAuthorization(path,{...opts(),signal:cancel.signal});const rejected=assert.rejects(reading,e=>e.name==='AbortError');cancel.abort();await rejected;assert.equal(previews(p).length,1);
 }finally{p.close();}
});
test('same-actor token refresh waits for fresh membership before a read-only preview, without sending under the stale credential',async()=>{
 const fresh=gate();const p=setup({before(call){if(call.url.endsWith('/v1/me')&&call.options.headers.Authorization===`Bearer ${nextToken}`)return fresh.promise;}});
 try{await until(()=>p.controller.getSnapshot().phase==='ready');p.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(p).length===2);
  const pending=p.controller.fiscalAuthorization(path,opts());await tick();assert.equal(previews(p).length,0);fresh.resolve(Response.json(member()));
  await pending;assert.equal(previews(p).length,1);assert.equal(previews(p)[0].options.headers.Authorization,`Bearer ${nextToken}`);
 }finally{fresh.resolve(Response.json(member()));p.close();}
});
test('old-token 401 after verified renewal does not sign out the current session or retry the GET',async()=>{
 const response=gate();const p=setup({after(call){if(call.url===origin+path&&call.options.headers.Authorization===`Bearer ${token}`)return response.promise;}});
 try{await until(()=>p.controller.getSnapshot().phase==='ready');const pending=p.controller.fiscalAuthorization(path,opts());await until(()=>previews(p).length===1);
  p.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(p).length===2&&p.controller.getSnapshot().permissionMessage===null);
  response.resolve(Response.json({error:'AUTHORIZATION_UNAUTHENTICATED',recovery_required:false},{status:401}));await assert.rejects(pending,e=>e.status===503);
  assert.equal(p.controller.getSnapshot().phase,'ready');assert.equal(previews(p).length,1);
  const explicit=await p.controller.fiscalAuthorization(path,opts());assert.equal(explicit.signed_hash,f.dto.signed_hash);assert.equal(previews(p).length,2);
 }finally{response.resolve(Response.json({}));p.close();}
});
test('current 401 signs out; operation403 rechecks membership once but never retries the preview',async()=>{
 const expired=setup({after(call){if(call.url===origin+path)return Response.json({error:'AUTHORIZATION_UNAUTHENTICATED',recovery_required:false},{status:401});}});
 try{await until(()=>expired.controller.getSnapshot().phase==='ready');await assert.rejects(expired.controller.fiscalAuthorization(path,opts()),e=>e.status===401);assert.equal(expired.controller.getSnapshot().phase,'signed_out');await assert.rejects(expired.controller.fiscalAuthorization(path,opts()),e=>e.status===401);assert.equal(previews(expired).length,1);}finally{expired.close();}
 const denied=setup({after(call){if(call.url===origin+path)return Response.json({error:'AUTHORIZATION_FORBIDDEN',recovery_required:false},{status:403});}});
 try{await until(()=>denied.controller.getSnapshot().phase==='ready');await assert.rejects(denied.controller.fiscalAuthorization(path,opts()),e=>e.status===403);await until(()=>me(denied).length===2&&denied.controller.getSnapshot().permissionMessage===null);assert.equal(denied.controller.getSnapshot().phase,'ready');assert.equal(previews(denied).length,1);}finally{denied.close();}
});
test('membership revoked or role changed during recheck cannot read another preview',async()=>{
 for(const revoke of [true,false]){
  let forbidden=false;const p=setup({before(call){if(call.url.endsWith('/v1/me')&&forbidden&&revoke)return Response.json({error:'forbidden'},{status:403});},after(call,state){if(call.url===origin+path){forbidden=true;state.role='consulta';return Response.json({error:'AUTHORIZATION_FORBIDDEN',recovery_required:false},{status:403});}}});
  try{await until(()=>p.controller.getSnapshot().phase==='ready');await assert.rejects(p.controller.fiscalAuthorization(path,opts()),e=>e.status===403);
   await until(()=>revoke?p.controller.getSnapshot().phase==='pending':p.controller.getSnapshot().membership?.role==='consulta');
   await assert.rejects(p.controller.fiscalAuthorization(path,opts()),e=>[401,403].includes(e.status));assert.equal(previews(p).length,1);
  }finally{p.close();}
 }
});
test('actor switch, logout and controller disposal fence a late response and cancel its private body',async()=>{
 for(const action of ['actor','logout','dispose']){
  const response=gate();let cancelled=false;const p=setup({after(call){if(call.url===origin+path)return response.promise;}});
  try{await until(()=>p.controller.getSnapshot().phase==='ready');const pending=p.controller.fiscalAuthorization(path,opts()),rejected=assert.rejects(pending,e=>e.name==='AbortError');await until(()=>previews(p).length===1);
   if(action==='actor'){p.state.actor=other;p.emit('SIGNED_IN',session(nextToken,other));await until(()=>p.controller.getSnapshot().membership?.user_id===other);}
   else if(action==='logout')await p.controller.logout();else p.close();
   await rejected;assert.equal(previews(p)[0].options.signal.aborted,true);
   response.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await until(()=>cancelled);assert.equal(previews(p).length,1);
  }finally{response.resolve(Response.json({}));p.close();}
 }
});
test('abort while membership refresh is pending never dispatches after permissions resolve; IO errors do not retry',async()=>{
 const fresh=gate();const p=setup({before(call){if(call.url.endsWith('/v1/me')&&call.options.headers.Authorization===`Bearer ${nextToken}`)return fresh.promise;}});
 try{await until(()=>p.controller.getSnapshot().phase==='ready');p.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(p).length===2);
  const cancel=new AbortController(),pending=p.controller.fiscalAuthorization(path,{...opts(),signal:cancel.signal}),rejected=assert.rejects(pending,e=>e.name==='AbortError');await tick();cancel.abort();await rejected;
  fresh.resolve(Response.json(member()));await until(()=>p.controller.getSnapshot().permissionMessage===null);assert.equal(previews(p).length,0);
 }finally{fresh.resolve(Response.json(member()));p.close();}
 const failed=setup({before(call){if(call.url===origin+path)throw Error('SYNTHETIC_PRIVATE_TOKEN');}});
 try{await until(()=>failed.controller.getSnapshot().phase==='ready');await assert.rejects(failed.controller.fiscalAuthorization(path,opts()),e=>e.status===503&&!String(e).includes('SYNTHETIC_PRIVATE'));await tick();assert.equal(previews(failed).length,1);}finally{failed.close();}
});
