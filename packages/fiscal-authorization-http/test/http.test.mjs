import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthorizationHttpBoundary} from '../src/handler.mjs';
import {publicResult,FLAGS,SERVICE_FAILURE_CODES} from '../src/dto.mjs';
import {SERVICE_FAILURE_CODES as serviceCodes} from '../../fiscal-authorization/src/service.mjs';
import {FLAGS as serviceFlags} from '../../fiscal-authorization/src/service-dto.mjs';
import {actor,otherActor,candidateId,commandId,previewBody,runBody,preview,result,history,service,request} from './fixtures.mjs';
const ctx={actor};
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:v=>resolve(v)};};
const error=async(response,status,code,recovery=false)=>{assert.equal(response.status,status);const body=await response.json();assert.equal(body.error,code);assert.equal(body.recovery_required,recovery);assert.equal(response.headers.get('cache-control'),'no-store');return body;};

test('public constants stay identical to the service; run is always blocked while reads/recovery remain usable',async()=>{
 assert.deepEqual(FLAGS,serviceFlags);assert.deepEqual(SERVICE_FAILURE_CODES,serviceCodes);let runCalls=0;const calls=[];
 const h=createAuthorizationHttpBoundary({service:service({run:async()=>{runCalls++;},preview:async i=>{calls.push(i);return preview();}})});
 const blocked=await h(request('/run',runBody),ctx);assert.equal((await error(blocked,503,'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE')).command_id,commandId);assert.equal(runCalls,0);
 const p=await h(request('/preview',previewBody),ctx);assert.equal(p.status,200);assert.equal((await p.json()).can_prepare,false);assert.deepEqual(calls,[{actor,candidateId,signedHash:previewBody.signed_hash}]);
 assert.equal((await h(request('/commands/'+commandId),ctx)).status,200);
 assert.equal((await h(request('/candidates/'+candidateId+'/history',{limit:25,before:null}),ctx)).status,200);
 assert.equal((await h(request('/recover',{command_id:commandId}),ctx)).status,200);
});

test('methods, paths, query, bodies, confirmations and bigint cursors are closed',async()=>{
 let calls=0;const h=createAuthorizationHttpBoundary({service:service({history:async()=>{calls++;return history();}})});
 for(const [path,body,options,status] of [['/run',undefined,{},405],['/commands/'+commandId,{}, {},405],['/candidates/'+candidateId+'/history',undefined,{},405],['/preview?actor='+actor,previewBody,{},400],['/preview/',previewBody,{},404],['/commands/AAAAAAAA-0000-4000-8000-000000000001',undefined,{},404],['/preview',{...previewBody,actor},{},400],['/run',{...runBody,confirmed:false},{},400],['/recover',{command_id:commandId,confirmed:true},{},400],['/candidates/'+candidateId+'/history',{limit:25,before:1},{},400],['/candidates/'+candidateId+'/history',{limit:25,before:'01'},{},400],['/candidates/'+candidateId+'/history',{limit:25,before:'1000000000000000'},{},400],['/candidates/'+candidateId+'/history',{limit:26,before:null},{},400]])assert.equal((await h(request(path,body,options),ctx)).status,status,path);
 assert.equal(calls,0);
 const allowed=createAuthorizationHttpBoundary({service:service({history:async i=>{assert.equal(i.before,'999999999999999');return history();}})});assert.equal((await allowed(request('/candidates/'+candidateId+'/history',{limit:25,before:'999999999999999'}),ctx)).status,200);
});

test('context, selected operation and method references are captured before the body await',async()=>{
 let stream,seen;const input={actor,deadline:Date.now()+10000},methods=service({preview:async i=>{seen=i;return preview();}}),h=createAuthorizationHttpBoundary({service:methods});
 const req=request('/preview',previewBody,{body:new ReadableStream({start(c){stream=c;}}),duplex:'half'});
 const promise=h(req,input);input.actor=otherActor;input.deadline=0;methods.preview=async()=>{throw Error('replaced');};Object.defineProperty(req,'url',{get(){throw Error('late URL accessor');}});
 stream.enqueue(new TextEncoder().encode(JSON.stringify(previewBody)));stream.close();assert.equal((await promise).status,200);assert.deepEqual(seen,{actor,candidateId,signedHash:previewBody.signed_hash});assert.ok(Object.isFrozen(seen));
});

test('getters, symbols and unsupported configuration/context objects are rejected without invocation',async()=>{
 let getters=0;const accessor={get actor(){getters++;return actor;}};const h=createAuthorizationHttpBoundary({service:service()});
 assert.equal((await h(request('/preview',previewBody),accessor)).status,400);assert.equal((await h(request('/preview',previewBody),{actor,[Symbol()]:true})).status,400);
 assert.equal((await h(request('/preview',previewBody),Object.assign(Object.create({}),{actor}))).status,400);
 const methods=service();Object.defineProperty(methods,'preview',{get(){getters++;return()=>preview();}});assert.throws(()=>createAuthorizationHttpBoundary({service:methods}));
 assert.throws(()=>createAuthorizationHttpBoundary({service:service(),enabled:true}));assert.equal(getters,0);
});

test('header identity is never an actor source; a valid trusted actor is mandatory',async()=>{
 let called=0;const h=createAuthorizationHttpBoundary({service:service({preview:async i=>{called++;assert.equal(i.actor,actor);return preview();}})});
 const req=()=>request('/preview',previewBody,{headers:{'content-type':'application/json',authorization:'Bearer PRIVATE_SENTINEL','x-actor':otherActor}});
 await error(await h(req(),{actor:'invalid'}),401,'AUTHORIZATION_UNAUTHENTICATED');assert.equal(called,0);assert.equal((await h(req(),ctx)).status,200);assert.equal(called,1);
});

test('body byte limit, fatal UTF8, compression, media type and length reject and cancel before any service call',async()=>{
 let calls=0,cancelled=0;const h=createAuthorizationHttpBoundary({service:service({preview:async()=>{calls++;return preview();}})});
 for(const [body,headers,status] of [[new Uint8Array([0xff]),{'content-type':'application/json'},400],['x'.repeat(4097),{'content-type':'application/json'},413],[JSON.stringify(previewBody),{'content-type':'application/json','content-encoding':'gzip'},400],[JSON.stringify(previewBody),{'content-type':'text/plain'},415],[JSON.stringify(previewBody),{'content-type':'application/json','content-length':'1'},400]])assert.equal((await h(request('/preview',previewBody,{body,headers}),ctx)).status,status);
 const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(4097));},cancel(){cancelled++;}});assert.equal((await h(request('/preview',previewBody,{body,duplex:'half'}),ctx)).status,413);assert.equal(cancelled,1);assert.equal(calls,0);
 const empty=new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;}});assert.equal((await h(request('/preview',previewBody,{body:empty,duplex:'half'}),ctx)).status,400);assert.equal(cancelled,2);
});

test('stalled body and pre-dispatch abort are bounded, cancel the stream and never dispatch',async()=>{
 let calls=0,cancelled=0;const h=createAuthorizationHttpBoundary({service:service({preview:async()=>{calls++;return preview();}})});
 const body=new ReadableStream({cancel(){cancelled++;}}),response=await h(request('/preview',previewBody,{body,duplex:'half'}),{actor,deadline:Date.now()+30});assert.ok([408,503].includes(response.status));assert.equal((await response.json()).recovery_required,false);assert.equal(cancelled,1);
 const ac=new AbortController();ac.abort();await error(await h(request('/preview',previewBody),{actor,signal:ac.signal}),503,'AUTHORIZATION_REQUEST_UNCONFIRMED');assert.equal(calls,0);
});

test('abort after recover dispatch keeps the same command, cancels the captured signal and ignores a late result without retries',async()=>{
 const entered=deferred(),late=deferred(),ac=new AbortController(),foreign=new AbortController();let calls=0,portSignal;
 const h=createAuthorizationHttpBoundary({service:service({recover:async(i,o)=>{calls++;assert.equal(i.commandId,commandId);portSignal=o.signal;entered.resolve();return late.promise;}})}),context={actor,signal:ac.signal};
 const pending=h(request('/recover',{command_id:commandId}),context);context.signal=foreign.signal;await entered.promise;ac.abort();const failed=await error(await pending,503,'AUTHORIZATION_REQUEST_UNCONFIRMED',true);assert.equal(failed.command_id,commandId);assert.equal(portSignal.aborted,true);assert.equal(foreign.signal.aborted,false);
 late.resolve(result({reading:false}));await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});

test('SQL failures and arbitrary port exceptions are sanitized with no implicit recovery/retry',async()=>{
 for(const [code,status,closed] of [['42501',403,'AUTHORIZATION_FORBIDDEN'],['40001',409,'AUTHORIZATION_CONFLICT'],['55000',409,'AUTHORIZATION_CONFLICT'],['P0002',404,'AUTHORIZATION_NOT_FOUND'],['22023',400,'AUTHORIZATION_INVALID_REQUEST'],['PRIVATE_PROVIDER_TEXT',503,'AUTHORIZATION_SERVICE_UNAVAILABLE']]){
  let calls=0;const h=createAuthorizationHttpBoundary({service:service({recover:async()=>{calls++;throw Object.assign(Error('PRIVATE_SENTINEL'),{code});}})});const body=await error(await h(request('/recover',{command_id:commandId}),ctx),status,closed,true);assert.equal(body.command_id,commandId);assert.equal(calls,1);assert.ok(!JSON.stringify(body).includes('PRIVATE'));
 }
 let getters=0;const h=createAuthorizationHttpBoundary({service:service({command:async()=>{throw {get code(){getters++;return '42501';}};}})});await error(await h(request('/commands/'+commandId),ctx),503,'AUTHORIZATION_SERVICE_UNAVAILABLE');assert.equal(getters,0);
});

test('all compact states validate; synthetic evidence cannot become operational or authorization',()=>{
 for(const state of ['prepared','request_ready','dispatched','submission_uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorization_observed','authorized_homologation']){const out=publicResult(result({state}),{action:'command',commandId});assert.equal(out.status,state);assert.equal(out.can_emit,false);assert.equal(out.can_transmit,false);assert.ok(Object.isFrozen(out.current));}
 for(const mutate of [v=>{v.can_emit=true;},v=>{v.receipt.origin=null;},v=>{v.current.authorized_in_homologation=true;},v=>{v.artifact.tls_origin_verified=true;},v=>{v.current.state=v.status='authorized_homologation';v.current.authorized_in_homologation=true;}]){const v=result({state:'authorization_observed'});mutate(v);assert.throws(()=>publicResult(v,{action:'command',commandId}),/AUTHORIZATION_RESPONSE_INVALID/);}
});

test('response bindings and nested secret fields fail closed instead of silently reaching the client',async()=>{
 for(const mutate of [v=>{v.command_id=otherActor;},v=>{v.receipt.candidate_id='invalid';},v=>{v.receipt.actor=actor;},v=>{v.receipt.access_key='PRIVATE';},v=>{v.current.candidate.credential_id=actor;},v=>{v.recovery={lease:'PRIVATE'};},v=>{v.current.used_at='2026-02-30T00:00:00Z';},v=>{v.recoverable_by_actor=true;}]){
  const v=result();mutate(v);const h=createAuthorizationHttpBoundary({service:service({command:async()=>v})});await error(await h(request('/commands/'+commandId),ctx),502,'AUTHORIZATION_RESPONSE_INVALID');
 }
 let getter=0;const v=result();Object.defineProperty(v.current,'state',{enumerable:true,get(){getter++;return'prepared';}});assert.throws(()=>publicResult(v,{action:'command',commandId}));assert.equal(getter,0);
});

test('uncertainty preserves historical receipt/current and never promotes a stale receipt to a current result',()=>{
 const v=result({reading:false,state:'dispatched'});Object.assign(v,{status:'unconfirmed',failure_code:'AUTHORIZATION_JOURNAL_MISSING'});const out=publicResult(v,{action:'recover',commandId});assert.equal(out.recovery_required,true);assert.equal(out.receipt.command_id,commandId);assert.equal(out.current.state,'dispatched');
 const empty={...v,receipt:null,current:null,error_code:null,artifact:null,recoverable_by_actor:false};assert.equal(publicResult(empty,{action:'recover',commandId}).receipt,null);
 const changed=result({state:'authorization_observed'});changed.current.a1_changed=true;changed.current.identity_changed=true;changed.current.candidate.a1_version=3;changed.current.candidate.a1_changed=true;changed.current.candidate.artifact_current=false;assert.equal(publicResult(changed,{action:'command',commandId}).receipt.a1_version,2);
});

test('history maintains string ordinals, strict descending pages and the maximum response budget',async()=>{
 const items=Array.from({length:25},(_,i)=>result({state:'authorization_observed',ordinal:String(999999999999999n-BigInt(i)),id:'30000000-0000-4000-8000-'+String(i+1).padStart(12,'0')}));const raw={...history(items),has_more:true,next_cursor:items.at(-1).receipt.ordinal};
 const h=createAuthorizationHttpBoundary({service:service({history:async()=>raw})});const response=await h(request('/candidates/'+candidateId+'/history',{limit:25,before:null}),ctx);assert.equal(response.status,200);const text=await response.text();assert.ok(Buffer.byteLength(text)<131072);assert.equal(JSON.parse(text).items[0].receipt.ordinal,'999999999999999');
 for(const mutate of [v=>{v.items.reverse();},v=>{v.items[1]=v.items[0];},v=>{v.items[0].receipt.candidate_id=otherActor;},v=>{v.next_cursor='1';},v=>{v.items[0].receipt.ordinal=999999999999999;}]){const v=structuredClone(raw);mutate(v);assert.throws(()=>publicResult(v,{action:'history',candidateId,limit:25,before:null}));}
 assert.throws(()=>publicResult(raw,{action:'history',candidateId,limit:25,before:'999999999999999'}));
});

test('preview cannot add readiness, bypass signature checks, leak a private field or normalize an invalid calendar',()=>{
 for(const mutate of [v=>{v.can_prepare=true;},v=>{v.signature_checked=false;},v=>{v.operational_binding_available=true;},v=>{v.policy.credential_id=actor;},v=>{v.policy.valid_until='2027-02-30T00:00:00Z';},v=>{v.signed_hash='f'.repeat(64);}]){const v=preview();mutate(v);assert.throws(()=>publicResult(v,{action:'preview',candidateId,signedHash:previewBody.signed_hash}));}
 const p=preview();p.blockers=[];assert.equal(publicResult(p,{action:'preview',candidateId,signedHash:previewBody.signed_hash}).can_prepare,false);
});
