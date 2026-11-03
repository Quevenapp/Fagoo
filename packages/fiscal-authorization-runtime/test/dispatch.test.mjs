import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {route} from '../src/protocol.mjs';
import {dispatchRoute,captureDispatchInput,dispatchBinding,MAX_DISPATCH_RESPONSE_BYTES} from '../src/dispatch-protocol.mjs';
import {projectDispatchPublic,DISPATCH_FAILURE_CODES} from '../src/dispatch-public-dto.mjs';
import {SERVICE_FAILURE_CODES} from '../../fiscal-authorization/src/dispatch-service.mjs';
import {isMutationAction,mutationPath} from '../src/review-protocol.mjs';
import {actor,candidateId,commandId,secret,keyId,audience,internal,external,env,service,runBody as legacyRunBody,deferred,bounded} from './fixtures.mjs';
import {dispatchResult,dispatchHistory,dispatchService} from './dispatch-fixtures.mjs';
import {selectedRunBody as runBody} from './dispatch-fixtures.mjs';
function setup({enabled=false,access,overrides={}}={}){
 const calls=[],reads=[];const actual=dispatchService(overrides),tracked=Object.fromEntries(Object.keys(actual).map(k=>[k,async(...args)=>{calls.push([k,...args]);return actual[k](...args);} ]));
 const handler=createAuthorizationRuntimeHandler({service:service(),dispatch:{service:tracked,enabled,readAccess:access??(async actor=>{reads.push(actor);return{actor,role:'fiscal'};})},transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor,role:'admin'}),now:Date.now,nonce:randomUUID});
 const environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'true',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
 return{handler,gateway,environment,calls,reads,close:()=>handler.dispose()};
}
test('reviewed routes are explicit, bounded and history is signed read-only; old syntax unchanged',()=>{
 const p='/internal/v1/fiscal-authorization';assert.equal(route(p+'/reviewed/run','POST').limit,4096);assert.equal(route(p+'/reviewed/status','GET').responseLimit,262144);assert.equal(route(p+'/preview','POST').responseLimit,undefined);
 assert.equal(route(p+`/candidates/${candidateId}/review`,'POST').limit,147456);
 assert.equal(dispatchRoute(p+'/run','POST',p),null);assert.throws(()=>route(p+'/reviewed/run/','POST'));assert.throws(()=>route(p+'/reviewed/status','POST'));
 assert.equal(isMutationAction('dispatchHistory'),false);assert.equal(mutationPath(p+`/reviewed/candidates/${candidateId}/history`,'POST'),false);assert.equal(mutationPath(p+'/reviewed/run','POST'),true);
 assert.deepEqual(captureDispatchInput('dispatchRun',runBody),runBody);let gets=0;const bad={...runBody};Object.defineProperty(bad,'candidate_id',{enumerable:true,get(){gets++;}});assert.throws(()=>captureDispatchInput('dispatchRun',bad));assert.equal(gets,0);
 for(const patch of[{actor},{review_id:randomUUID()},{tax_rules_validated:true},{endpoint:'https://evil.invalid'},{confirmed:false}])assert.throws(()=>captureDispatchInput('dispatchRun',{...runBody,...patch}));
 assert.deepEqual([...DISPATCH_FAILURE_CODES].sort(),[...SERVICE_FAILURE_CODES].sort());
});
test('DTO preserves operational homologation only, closed subset proof and journal, no private projection',()=>{
 const v=dispatchResult({state:'authorized_homologation'});assert.deepEqual(projectDispatchPublic(v,{action:'command',commandId}),v);
 for(const change of[x=>x.tax_rules_validated=true,x=>x.receipt.origin='synthetic',x=>x.authorized_in_homologation=false,x=>x.observation=null,x=>x.subset_review.profile_hash='0'.repeat(64),x=>x.subset_review.candidate_version++,x=>x.execution={},x=>x.artifact.private_xml='PRIVATE']){const b=structuredClone(v);change(b);assert.throws(()=>projectDispatchPublic(b,{action:'command',commandId}),e=>e.code==='AUTHORIZATION_RESPONSE_INVALID');}
 const reading=dispatchResult({state:'dispatched',reading:false});reading.status='unconfirmed';reading.recovery_required=true;reading.failure_code='AUTHORIZATION_SUBSET_REVIEW_CHANGED';assert.equal(projectDispatchPublic(reading,{action:'run',commandId,input:runBody}).failure_code,reading.failure_code);
 assert.throws(()=>projectDispatchPublic(reading,{action:'run',commandId,input:{...runBody,signed_hash:'0'.repeat(64)}}));
 const page=dispatchHistory(Array.from({length:25},(_,i)=>dispatchResult({state:'authorized_homologation',ordinal:String(25-i),id:randomUUID()})));assert.equal(projectDispatchPublic(page,{action:'history',candidateId,limit:25,before:null}).items.length,25);assert.ok(Buffer.byteLength(JSON.stringify(page))<MAX_DISPATCH_RESPONSE_BYTES);
 let invoked=0;Object.defineProperty(page.items,'0',{get(){invoked++;return v;}});assert.throws(()=>projectDispatchPublic(page,{action:'history',candidateId,limit:25,before:null}));assert.equal(invoked,0);
});
test('status requires real access port and never trusts role supplied by Auth; gate defaults closed before any RPC',async()=>{
 const f=setup();try{
  const status=await f.gateway(external('/reviewed/status'),f.environment);assert.equal(status.status,200);assert.equal((await status.json()).runtime_enabled,false);assert.deepEqual(f.reads,[actor]);assert.equal(f.calls.length,0);
  const disabled=await f.handler(await internal('/reviewed/run',runBody));assert.equal(disabled.status,503);assert.deepEqual(await disabled.json(),{error:'AUTHORIZATION_SERVICE_DISABLED',recovery_required:false,command_id:commandId});assert.equal(f.calls.length,0);assert.equal(f.reads.length,1);
 }finally{f.close();}
 for(const role of ['consulta','vendas','financeiro','estoque']){const g=setup({access:async actor=>({actor,role})});try{assert.equal((await g.gateway(external('/reviewed/status'),g.environment)).status,403);}finally{g.close();}}
});
test('gateway and runtime gates are independent; legacy run remains unavailable even when new gates are enabled',async()=>{
 const f=setup({enabled:true});try{
  for(const flag of[undefined,'false']){const e={...f.environment};flag===undefined?delete e.FISCAL_AUTHORIZATION_REVIEWED_ENABLED:e.FISCAL_AUTHORIZATION_REVIEWED_ENABLED=flag;assert.equal((await f.gateway(external('/reviewed/run',runBody),e)).status,503);assert.equal(f.calls.length,0);}
  assert.equal((await f.gateway(external('/run',legacyRunBody),f.environment)).status,503);assert.equal(f.calls.length,0);
  const response=await f.gateway(external('/reviewed/run',runBody),f.environment);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).authorized_in_homologation,true);assert.equal(f.calls[0][1].actor,actor);
 }finally{f.close();}
});
test('command/history/recover work gatefalse; HMAC path/body and CSRF block before service calls',async()=>{
 const f=setup();try{
  for(const[p,b]of[[`/reviewed/commands/${commandId}`,undefined],[`/reviewed/candidates/${candidateId}/history`,{limit:25,before:null}],['/reviewed/recover',{command_id:commandId}]])assert.equal((await f.gateway(external(p,b),f.environment)).status,200);
  assert.deepEqual(f.calls.map(x=>x[0]),['command','history','recover']);
  const request=await internal('/reviewed/recover',{command_id:commandId}),bad=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({command_id:randomUUID()})});assert.equal((await f.handler(bad)).status,401);
  const old=await internal('/recover',{command_id:commandId});assert.equal((await f.handler(new Request(request.url,{method:'POST',headers:old.headers,body:JSON.stringify({command_id:commandId})}))).status,401);
  const csrf=external('/reviewed/status');csrf.headers.set('Origin','https://evil.invalid');assert.equal((await f.gateway(csrf,f.environment)).status,403);assert.equal(f.calls.length,3);
 }finally{f.close();}
});
test('lost runtime ACK preserves UUID and only GET command follows; no second run or leak',async()=>{
 let runs=0;const f=setup({enabled:true,overrides:{run:async()=>{runs++;throw Error('PRIVATE_TOKEN_XML');}}});try{
  const failed=await f.gateway(external('/reviewed/run',runBody),f.environment),body=await failed.json();assert.equal(failed.status,503);assert.equal(body.recovery_required,true);assert.equal(body.command_id,commandId);assert.doesNotMatch(JSON.stringify(body),/PRIVATE|TOKEN|XML/);
  assert.equal((await f.gateway(external(`/reviewed/commands/${commandId}`),f.environment)).status,200);assert.equal(runs,1);
 }finally{f.close();}
});
test('known ACL/CAS errors are closed and definitive; invalid response after dispatch remains uncertain',async()=>{
 for(const [code,status]of[['42501',403],['40001',409],['P0002',404]]){const f=setup({enabled:true,overrides:{run:async()=>{throw Object.assign(Error('PRIVATE'),{code});}}});try{const r=await f.gateway(external('/reviewed/run',runBody),f.environment);assert.equal(r.status,status);assert.equal((await r.json()).recovery_required,false);}finally{f.close();}}
 const f=setup({enabled:true,overrides:{run:async()=>({...dispatchResult({reading:false}),execution:{secret:'PRIVATE'}})}});try{const r=await f.gateway(external('/reviewed/run',runBody),f.environment);assert.equal(r.status,502);assert.equal((await r.json()).recovery_required,true);}finally{f.close();}
});
test('abort ignores late response and preserves recovery without rerun',async()=>{const entered=deferred(),gate=deferred();const f=setup({enabled:true,overrides:{run:async()=>{entered.resolve();await gate.promise;return dispatchResult({reading:false});}}}),controller=new AbortController();try{const pending=f.handler(await internal('/reviewed/run',runBody,{signal:controller.signal}));await entered.promise;controller.abort();const r=await bounded(pending);assert.equal(r.status,503);assert.equal((await r.json()).recovery_required,true);gate.resolve();assert.equal(f.calls.length,1);}finally{gate.resolve();f.close();}});


test('072 preflight is authenticated, HMAC-bound and read-only even when upstream fails',async()=>{
 const f=setup();try{
  const input={candidate_id:candidateId,signed_hash:runBody.signed_hash};
  const r=await f.gateway(external('/reviewed/preflight',input),f.environment);assert.equal(r.status,200,await r.clone().text());const v=await r.json();assert.equal(v.read_only,true);assert.equal(v.can_run,false);assert.equal(v.runtime_enabled,false);assert.equal(f.calls[0][0],'preflight');assert.equal(f.calls[0][1].actor,actor);
  assert.equal(isMutationAction('dispatchPreflight'),false);assert.equal(mutationPath('/internal/v1/fiscal-authorization/reviewed/preflight','POST'),false);
  const signed=await internal('/reviewed/preflight',input),changed=new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify({...input,signed_hash:'0'.repeat(64)})});assert.equal((await f.handler(changed)).status,401);assert.equal(f.calls.length,1);
 }finally{f.close();}
 for(const code of ['42501','40001','PRIVATE_TIMEOUT']){const g=setup({overrides:{preflight:async()=>{throw Object.assign(Error('PRIVATE'),{code});}}});try{const r=await g.gateway(external('/reviewed/preflight',{candidate_id:candidateId,signed_hash:runBody.signed_hash}),g.environment);assert.equal(r.status,code==='42501'?403:code==='40001'?409:503);assert.equal((await r.json()).recovery_required,false);}finally{g.close();}}
});
test('073 refuses previous run body, incomplete selection and browser proof before either run entrypoint',async()=>{
 const f=setup({enabled:true});try{
  for(const payload of [legacyRunBody,{...runBody,expected_review_hash:undefined},{...runBody,rule_review:{}},{...runBody,request_profile:'legacy_v1'}]){const r=await f.gateway(external('/reviewed/run',payload),f.environment);assert.equal(r.status,400);assert.equal(f.calls.length,0);}
  const signed=await internal('/reviewed/run',runBody),changed=new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify({...runBody,expected_review_version:2})});assert.equal((await f.handler(changed)).status,401);assert.equal(f.calls.length,0);
  const r=await f.gateway(external('/reviewed/run',runBody),f.environment);assert.equal(r.status,200);assert.equal(f.calls[0][0],'runReviewed');assert.deepEqual(f.calls[0][1].request,runBody);
 }finally{f.close();}
});

test('080 temporal refusal before begin is definitive; the same public code after use preserves recovery',async()=>{
 for(const code of ['AUTHORIZATION_NFCE_EMISSION_EXPIRED','AUTHORIZATION_NFCE_EMISSION_FUTURE','AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT']){
  const f=setup({enabled:true,overrides:{run:async()=>{throw Object.assign(Error('PRIVATE_XML_TIMESTAMP'),{code});}}});
  try{const r=await f.gateway(external('/reviewed/run',runBody),f.environment);assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:code,recovery_required:false,command_id:commandId});assert.equal(f.calls.length,1);}finally{f.close();}
  const uncertain=dispatchResult({state:'dispatched',reading:false});uncertain.status='unconfirmed';uncertain.recovery_required=true;uncertain.failure_code=code;
  const g=setup({enabled:true,overrides:{run:async()=>uncertain}});try{const r=await g.gateway(external('/reviewed/run',runBody),g.environment);assert.equal(r.status,200);const v=await r.json();assert.equal(v.failure_code,code);assert.equal(v.recovery_required,true);assert.equal(v.current.grant_consumed,true);assert.equal((await g.gateway(external(`/reviewed/commands/${commandId}`),g.environment)).status,200);assert.deepEqual(g.calls.map(x=>x[0]),['runReviewed','command']);}finally{g.close();}
 }
});
