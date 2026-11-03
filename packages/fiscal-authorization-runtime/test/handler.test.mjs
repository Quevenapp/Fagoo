import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {AuthorizationServiceError} from '../../fiscal-authorization/src/service-common.mjs';
import {internal,secret,keyId,audience,actor,commandId,candidateId,previewBody,runBody,preview,result,history,service,deferred,bounded} from './fixtures.mjs';
function setup(patch={}){const calls=[];const methods=service();for(const action of Object.keys(methods)){const method=patch[action]??methods[action];methods[action]=async(x,o)=>{calls.push({action,x,o});return method(x,o);};}return{calls,handler:createAuthorizationRuntimeHandler({service:methods,transportSecret:secret,transportKeyId:keyId,audience})};}
test('authenticated preview, command and history bind the actor, exact inputs and public projection',async()=>{
 const f=setup();try{
  const a=await f.handler(await internal('/preview',previewBody));assert.equal(a.status,200);assert.deepEqual(await a.json(),preview());
  const b=await f.handler(await internal('/commands/'+commandId));assert.equal(b.status,200);assert.deepEqual(await b.json(),result());
  const c=await f.handler(await internal(`/candidates/${candidateId}/history`,{limit:25,before:null}));assert.equal(c.status,200);assert.deepEqual(await c.json(),history());
  assert.deepEqual(f.calls.map(x=>x.action),['preview','command','history']);for(const call of f.calls){assert.equal(call.x.actor,actor);assert.ok(Object.isFrozen(call.x));assert.ok(call.o.signal.aborted);assert.ok(call.o.deadline<=Date.now()+45000);}
  assert.deepEqual(f.calls[2].x,{actor,candidateId,limit:25,before:null});
 }finally{f.handler.dispose();}
});
test('run is always503 before any service method; recover only reports the same command unavailable after service ACL',async()=>{
 const f=setup({recover:()=>{throw new AuthorizationServiceError('AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');}});try{
  let r=await f.handler(await internal('/run',runBody));assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE',recovery_required:false,command_id:commandId});assert.equal(f.calls.length,0);
  r=await f.handler(await internal('/recover',{command_id:commandId}));assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE',recovery_required:true,command_id:commandId});assert.deepEqual(f.calls.map(x=>x.action),['recover']);
 }finally{f.handler.dispose();}
});
test('all other transport domains, wrong audience, stale auth and body tampering are rejected before service',async()=>{
 const f=setup();try{
  const base=await internal('/preview',previewBody);const header=base.headers.get('authorization'),[scheme,token]=header.split(' '),[id,encoded]=token.split('.');
  for(const domain of ['a1','signed','wsdl','reconciliation','danfe','unsigned']){
   const mac=createHmac('sha256',secret).update(`brufap-${domain}-request-v1.${id}.${encoded}`).digest('hex');
   const r=await f.handler(await internal('/preview',previewBody,{header:`${scheme} ${id}.${encoded}.${mac}`}));assert.equal(r.status,401);
  }
  assert.equal((await f.handler(await internal('/preview',previewBody,{now:Date.now()-61000}))).status,401);
  assert.equal((await f.handler(await internal('/preview',{...previewBody,signed_hash:'b'.repeat(64)},{header}))).status,401);
  assert.equal((await f.handler(await internal('/preview',previewBody,{origin:'https://foreign.invalid'}))).status,400);
  assert.equal(f.calls.length,0);
 }finally{f.handler.dispose();}
});
test('abort and disposal close admission, ignore late service results and preserve captured request',async()=>{
 const entered=deferred(),release=deferred(),abort=new AbortController();const f=setup({preview:async()=>{entered.resolve();await release.promise;return preview();}});
 const request=await internal('/preview',previewBody,{signal:abort.signal});const pending=f.handler(request);await bounded(entered.promise);abort.abort();const r=await bounded(pending);assert.equal(r.status,503);assert.equal((await r.json()).recovery_required,false);assert.equal(f.calls[0].o.signal.aborted,true);release.resolve();
 f.handler.dispose();f.handler.dispose();assert.equal((await f.handler(await internal('/preview',previewBody))).status,503);assert.equal(f.calls.length,1);
});
test('response projection refuses private fields, mismatched identifiers and invalid bounded bodies',async()=>{
 for(const patch of [{private_execution:{}},{candidate_id:commandId}]){const f=setup({preview:()=>({...preview(),...patch})});try{const r=await f.handler(await internal('/preview',previewBody));assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/private_execution/);}finally{f.handler.dispose();}}
 const f=setup();try{const valid=await internal('/preview',previewBody);const r=await f.handler(new Request(valid,{headers:{...Object.fromEntries(valid.headers),'Content-Length':'4097'}}));assert.equal(r.status,413);assert.equal(f.calls.length,0);}finally{f.handler.dispose();}
});
test('RPC ACL failures stay closed and each call keeps its verified actor',async()=>{
 const f=setup({command:()=>{throw Object.assign(Error('private server details'),{code:'42501'});}});try{const r=await f.handler(await internal('/commands/'+commandId));assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'AUTHORIZATION_FORBIDDEN',recovery_required:false,command_id:commandId});}finally{f.handler.dispose();}
});
test('runtime total45s expires before accepting a delayed port result',async t=>{
 const realNow=Date.now;let clock=realNow();t.mock.method(Date,'now',()=>clock);
 const f=setup({preview:async()=>{clock+=45001;return preview();}});try{const r=await f.handler(await internal('/preview',previewBody));assert.equal(r.status,503);assert.equal(f.calls.length,1);assert.equal(f.calls[0].o.signal.aborted,true);}finally{f.handler.dispose();}
});
test('handler construction rejects getters and captures its key and methods before later mutation',async()=>{
 let getter=0;assert.throws(()=>createAuthorizationRuntimeHandler({get service(){getter++;return service();},transportSecret:secret,transportKeyId:keyId,audience}));assert.equal(getter,0);
 const key=new Uint8Array(secret),methods=service(),handler=createAuthorizationRuntimeHandler({service:methods,transportSecret:key,transportKeyId:keyId,audience});key.fill(0);methods.preview=()=>{throw Error('MUTATED_METHOD');};try{assert.equal((await handler(await internal('/preview',previewBody))).status,200);}finally{handler.dispose();}
});
