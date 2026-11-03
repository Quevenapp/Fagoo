import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {fixture} from '../../fiscal-unsigned-orchestrator/test/fixture.mjs';
import {createUnsignedRuntimeHandler} from '../src/handler.mjs';
import {digest,signRuntimeRequest} from '../src/auth.mjs';

const secret=new Uint8Array(32).fill(41),keyId='synthetic-handler',audience='test-handler-unsigned';
const prefix='/internal/v1/fiscal-unsigned',origin='https://fiscal-runtime.internal';
const bytes=value=>new TextEncoder().encode(JSON.stringify(value));
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const reached=(entered,running)=>{let observed=false;return Promise.race([entered.then(()=>{observed=true;}),running.then(async response=>{if(!observed)throw Error(`Handler returned before the expected test checkpoint: ${response.status} ${await response.text()}`);})]);};
const trackReaders=request=>{let reads=0;const original=request.body.getReader.bind(request.body);request.body.getReader=(...args)=>{reads++;return original(...args);};return()=>reads;};
const generation=j=>({command_id:j.commandId,reservation_id:j.reservationId,draft_id:j.draftId,completion_version:j.completionVersion,completion_hash:j.completionHash,basis_hash:j.basisHash});
let f;before(async()=>{f=await fixture();});after(async()=>{secret.fill(0);await f?.close();});
const handler=overrides=>createUnsignedRuntimeHandler({rpc:f.rpc,storage:f.ports.storage,transportSecret:secret,transportKeyId:keyId,audience,...overrides});
async function request(action,payload,{actor=f.users.fiscal,signal,raw,claimedBytes,headers={},signed={}}={}){
 const method=payload===undefined&&raw===undefined?'GET':'POST',path=prefix+'/'+action;
 const body=raw??(payload===undefined?new Uint8Array():bytes(payload));
 const auth=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor,nonce:randomUUID(),method,path,bodyHash:await digest(claimedBytes??body),...signed});
 return new Request(origin+path,{method,signal,headers:{Authorization:auth,...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},...(method==='POST'?{body}:{} )});
}
async function result(response,status=200){assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('referrer-policy'),'no-referrer');return response.json();}
function projected(value){
 assert.equal(value.can_emit,false);assert.equal(value.can_transmit,false);assert.equal(value.signature_verified,false);assert.equal(value.xsd_validated,false);
 assert.doesNotMatch(JSON.stringify(value),/access_key|cnpj|identity|issuedAt|cNF|lease_id|<NFe|execution|inputs|proofs|bucket|PRIVATE-|INTERNAL-COMMERCIAL/);
}

test('real048 previews without allocating and generates both models with scoped GET job/command/history',async()=>{
 const h=handler(),unreserved=await f.prepare({reserve:false}),before=await f.counts();
 const preview=await result(await h(await request('preview',{draft_id:unreserved.draft.record.id,completion_version:1})));
 assert.equal(preview.status,'checked');assert.equal(preview.identity_assigned,false);assert.deepEqual(await f.counts(),before);
 for(const model of['55','65']){
  const j=await f.input(await f.prepare({model})),initial=await f.counts();
  const created=await result(await h(await request('generate',generation(j))));assert.equal(created.status,'stored');projected(created);
  const job=await result(await h(await request('jobs/'+created.job_id)));assert.equal(job.job_id,created.job_id);assert.equal(job.read_only,true);projected(job);
  assert.equal(Object.hasOwn(job,'command_id'),false);
  const command=await result(await h(await request('commands/'+j.commandId)));assert.equal(command.command_id,j.commandId);assert.equal(command.artifact.sha256,job.artifact.sha256);projected(command);
  const history=await result(await h(await request('history',{reservation_id:j.reservationId,limit:1,before:null})));
  assert.equal(history.items.length,1);assert.equal(history.items[0].job_id,job.job_id);assert.equal(history.has_more,false);projected(history);
  const current=await f.counts();assert.equal(current.reservations,initial.reservations);assert.equal(current.numbers,initial.numbers);assert.equal(current.finance,0);assert.equal(current.stock,0);
 }
});

test('the same signed generate request can be delivered twice without new identity, number, upload or finish',async()=>{
 const h=handler(),j=await f.input(await f.prepare()),original=await request('generate',generation(j)),copy=original.clone();
 const first=await result(await h(original)),counts=await f.counts(),puts=f.calls.put.length,finishes=f.calls.rpc.filter(v=>v.name.endsWith('_finish')).length;
 const replay=await result(await h(copy));assert.equal(replay.job_id,first.job_id);assert.equal(replay.recovered,true);
 assert.deepEqual(await f.counts(),counts);assert.equal(f.calls.put.length,puts);assert.equal(f.calls.rpc.filter(v=>v.name.endsWith('_finish')).length,finishes);
});

test('current stale flags survive historical command recovery; actor is imposed by HMAC and rechecked by SQL',async()=>{
 const h=handler(),p=await f.prepare(),j=await f.input(p),first=await result(await h(await request('generate',generation(j))));
 await f.updateCompletion(p,{additional_information:'ALTERACAO SINTETICA APOS XML'});
 const old=await result(await h(await request('commands/'+j.commandId)));assert.equal(old.current.basis_changed,true);assert.equal(old.current.artifact_current,false);assert.equal(old.artifact.sha256,first.artifact.sha256);
 const count=await f.counts();
 const denied=await result(await h(await request('jobs/'+first.job_id,undefined,{actor:f.users.consulta})),403);assert.equal(denied.error,'UNSIGNED_FORBIDDEN');
 const otherActor=await result(await h(await request('commands/'+j.commandId,undefined,{actor:f.users.admin})),403);assert.equal(otherActor.error,'UNSIGNED_FORBIDDEN');
 const newJob=await f.input(await f.prepare());const blocked=await result(await h(await request('generate',generation(newJob),{actor:f.users.vendas})));
 assert.equal(blocked.status,'blocked');assert.equal(blocked.code,'UNSIGNED_RPC_42501');assert.equal(blocked.outcome,'not_started');
 // The extra prepare above allocates its explicit046 reservation, but no denied call creates a048 job.
 assert.equal((await f.counts()).jobs,count.jobs);
 const calls=f.calls.rpc.length,override={...generation(newJob),actor:f.users.admin};
 assert.equal((await result(await h(await request('generate',override)),400)).error,'UNSIGNED_INVALID_REQUEST');assert.equal(f.calls.rpc.length,calls);
});

test('authentication checks domain, actor, time, path and exact body before any RPC or body consumption',async()=>{
 let calls=0;const h=handler({rpc:async()=>{calls++;throw new Error('PRIVATE-UPSTREAM');}}),payload={draft_id:randomUUID(),completion_version:1};
 const invalids=[{signed:{audience:'wrong-unsigned'}},{signed:{now:Date.now()-61000}},{signed:{now:Date.now()+6000}},
  {signed:{path:prefix+'/generate'}},{claimedBytes:bytes({...payload,completion_version:2})}];
 for(const input of invalids){const out=await result(await h(await request('preview',payload,input)),401);assert.match(out.error,/^UNSIGNED_(?:RUNTIME_UNAUTHORIZED|BODY_AUTHENTICATION_FAILED)$/);}
 const signed=await request('preview',payload),authorization=signed.headers.get('authorization'),[id,encoded]=authorization.slice('Brufap-Unsigned '.length).split('.');
 const badDomain=createHmac('sha256',secret).update('brufap-a1-request-v1.'+id+'.'+encoded).digest('hex');
 signed.headers.set('authorization',`Brufap-Unsigned ${id}.${encoded}.${badDomain}`);assert.equal((await result(await h(signed),401)).error,'UNSIGNED_RUNTIME_UNAUTHORIZED');
 const malformed=await request('preview',payload),parts=malformed.headers.get('authorization').slice('Brufap-Unsigned '.length).split('.');
 const claims=JSON.parse(Buffer.from(parts[1],'base64url'));claims.actor=[f.users.fiscal];const token=Buffer.from(JSON.stringify(claims)).toString('base64url');
 malformed.headers.set('authorization',`Brufap-Unsigned ${keyId}.${token}.${createHmac('sha256',secret).update('brufap-unsigned-request-v1.'+keyId+'.'+token).digest('hex')}`);
 assert.equal((await result(await h(malformed),401)).error,'UNSIGNED_RUNTIME_UNAUTHORIZED');
 const raw=new Request(origin+prefix+'/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:bytes(payload)}),readers=trackReaders(raw);
 assert.equal((await result(await h(raw),401)).error,'UNSIGNED_RUNTIME_UNAUTHORIZED');assert.equal(readers(),0);assert.equal(calls,0);
});

test('signed bodies remain bounded and reject unsupported encoding, identity fields and malformed UTF8',async()=>{
 let calls=0;const h=handler({rpc:async()=>{calls++;throw Error('PRIVATE-ERROR');}}),payload={draft_id:randomUUID(),completion_version:1};
 for(const[options,status,code]of[
  [{raw:new Uint8Array(4097)},413,'UNSIGNED_BODY_TOO_LARGE'],
  [{raw:new Uint8Array([0xc3,0x28])},400,'UNSIGNED_BODY_INVALID'],
  [{headers:{'Content-Encoding':'gzip'}},400,'UNSIGNED_ENCODING_UNSUPPORTED'],
  [{headers:{'Content-Type':'application/octet-stream'}},415,'UNSIGNED_CONTENT_TYPE_UNSUPPORTED'],
  [{raw:bytes({...payload,identity:{number:'1'}})},400,'UNSIGNED_INVALID_REQUEST'],
 ])assert.equal((await result(await h(await request('preview',payload,options)),status)).error,code);
 assert.equal(calls,0);
 const valid=await request('preview',payload);const wrongOrigin=new Request('https://elsewhere.invalid'+prefix+'/preview',valid),readers=trackReaders(wrongOrigin);
 assert.equal((await result(await h(wrongOrigin),400)).error,'UNSIGNED_INVALID_REQUEST');assert.equal(readers(),0);
});

test('lost finish and readback responses preserve the command and recover through a current GET without reupload',async()=>{
 const p=await f.prepare(),j=await f.input(p);let uncertain=false,lose=true;
 const h=handler({rpc:async(name,args,options)=>{
  if(uncertain&&(name.endsWith('_command')||name.endsWith('_get')))throw Error('PRIVATE-UNCERTAIN');
  const value=await f.rpc(name,args,options);if(name.endsWith('_finish')&&lose){lose=false;uncertain=true;throw Error('PRIVATE-ACK-LOST');}return value;
 }});
 const pending=await result(await h(await request('generate',generation(j))));assert.equal(pending.status,'recoverable');assert.equal(pending.xml_generated,null);assert.equal(pending.outcome,'unconfirmed');assert.equal(pending.command_id,j.commandId);projected(pending);
 const puts=f.calls.put.length,count=await f.counts();uncertain=false;
 const current=await result(await h(await request('commands/'+j.commandId)));assert.equal(current.status,'stored');assert.equal(current.current.artifact_current,true);
 const retry=await result(await h(await request('generate',generation(j))));assert.equal(retry.status,'stored');assert.equal(retry.job_id,current.job_id);assert.equal(f.calls.put.length,puts);assert.deepEqual(await f.counts(),count);
});

test('aborting a dispatched begin returns promptly, releases capacity and never continues late into Storage',{timeout:15000},async()=>{
 const prepared=await f.prepare(),j=await f.input(prepared),entered=defer(),release=defer();let late;
 const h=handler({concurrency:1,rpc:async(name,args,opts)=>{
  const value=await f.rpc(name,args,opts);if(name.endsWith('_begin')){late=value;entered.resolve();await release.promise;}return value;
 }}),abort=new AbortController(),puts=f.calls.put.length;
 const running=h(await request('generate',generation(j),{signal:abort.signal}));await reached(entered.promise,running);abort.abort();
 const stopped=await result(await running,503);assert.equal(stopped.recovery_required,true);assert.equal(stopped.error,'UNSIGNED_UPSTREAM_UNAVAILABLE');
 const pending=await result(await h(await request('commands/'+j.commandId)));assert.equal(pending.status,'pending');assert.equal(pending.job_id,late.receipt.job_id);
 release.resolve();await nextTurn();await nextTurn();assert.equal(f.calls.put.length,puts);assert.equal((await f.command(j)).current.state,'pending');
});

test('capacity is bounded and request abortion cancels a stalled body without sending any RPC',{timeout:15000},async()=>{
 let rpcCalls=0,cancelled=false;const h=handler({concurrency:1,rpc:async()=>{rpcCalls++;throw Error('PRIVATE');}}),abort=new AbortController(),entered=defer();
 const path=prefix+'/preview',auth=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor:f.users.fiscal,nonce:randomUUID(),method:'POST',path,bodyHash:await digest(new Uint8Array())});
 const body=new ReadableStream({pull(){entered.resolve();return new Promise(()=>{});},cancel(){cancelled=true;}},{highWaterMark:0});
 const pending=h(new Request(origin+path,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body,duplex:'half',signal:abort.signal}));
 await reached(entered.promise,pending);const second=await request('preview',{draft_id:randomUUID(),completion_version:1}),readers=trackReaders(second);
 try{assert.equal((await result(await h(second),503)).error,'UNSIGNED_RUNTIME_BUSY');assert.equal(readers(),0);}finally{abort.abort();}
 assert.equal((await result(await pending,503)).error,'UNSIGNED_UPSTREAM_UNAVAILABLE');await nextTurn();assert.equal(cancelled,true);assert.equal(rpcCalls,0);
 const denied=await h(new Request(origin+path,{method:'POST'}));assert.equal(denied.status,401);
});

test('the total45s deadline includes an uncooperative RPC and excludes its eventual late result',{timeout:15000},async t=>{
 const entered=defer(),release=defer();let observedSignal;
 const h=handler({rpc:async(_name,_args,{signal})=>{observedSignal=signal;entered.resolve();await release.promise;return{private_payload:'NEVER-EXPOSED'};}});
 const req=await request('preview',{draft_id:randomUUID(),completion_version:1});
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 try{const running=h(req);await reached(entered.promise,running);t.mock.timers.tick(45001);const out=await result(await running,503);assert.equal(out.error,'UNSIGNED_UPSTREAM_UNAVAILABLE');assert.equal(observedSignal.aborted,true);release.resolve();await nextTurn();assert.doesNotMatch(JSON.stringify(out),/NEVER-EXPOSED/);}finally{release.resolve();t.mock.timers.reset();}
});

test('read responses are bound to the requested job and errors never expose port diagnostics',async()=>{
 const j=await f.input(await f.prepare()),stored=await f.orchestrator().run(j),sql=await f.get(stored.job_id);
 const swapped=handler({rpc:async()=>sql});assert.equal((await result(await swapped(await request('jobs/'+randomUUID())),502)).error,'UNSIGNED_RESPONSE_INVALID');
 for(const[code,status,out]of[['42501',403,'UNSIGNED_FORBIDDEN'],['40001',409,'UNSIGNED_CONFLICT'],['55000',409,'UNSIGNED_CONFLICT'],['P0002',404,'UNSIGNED_NOT_FOUND'],['22023',400,'UNSIGNED_INVALID_REQUEST'],['XX000',503,'UNSIGNED_RUNTIME_FAILED']]){
  const h=handler({rpc:async()=>{throw Object.assign(Error('PRIVATE-SERVICE-KEY'),{code,details:'PRIVATE-SQL'});}}),response=await result(await h(await request('jobs/'+stored.job_id)),status);
  assert.equal(response.error,out);assert.equal(response.recovery_required,false);assert.doesNotMatch(JSON.stringify(response),/PRIVATE/);
 }
});
