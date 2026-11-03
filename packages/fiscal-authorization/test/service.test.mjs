import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture,hash} from './service-sql-fixture.mjs';
import {AuthorizationServiceError} from '../src/service.mjs';
import {projectResponse} from '../src/service-dto.mjs';
import {createAuthorizationRpc} from '../src/rpc.mjs';
let f;before(async()=>{f=await serviceFixture();});after(async()=>{await f?.close();});
const options=()=>({deadline:Date.now()+45000});
const raw=x=>f.callSql('erp_fiscal_authorization_command',{p_user_id:x.actor,p_command_id:x.commandId});
const counts=()=>({uses:f.calls.rpc.filter(x=>x.name.endsWith('_authorization_use')).length,transport:f.calls.transport.length,custody:f.calls.custody.length});
test('SQL064→real signature/XSD→immutable wire/journal/processed;55/65 and replay no second transport',async()=>{
 for(const model of ['55','65']){
  const {input}=await f.source(model),service=f.service(),start=counts(),out=await service.run(input,options());assert.equal(out.status,'authorization_observed',JSON.stringify(out));assert.equal(out.artifact.protocol_cstat,'100');assert.equal(out.current.authorized_in_homologation,false);assert.equal(out.can_transmit,false);assert.equal(out.can_emit,false);
  const saved=await raw(input),ctx=saved.recovery;assert.notEqual(saved.artifact.evidence.payload_hash,ctx.request_hash);assert.equal(hash(f.files.get(`authorization/${ctx.attempt_id}/requests/${ctx.request_hash}.xml`)),ctx.request_hash);assert.equal(hash(f.files.get(`authorization/${ctx.attempt_id}/responses/${ctx.request_hash}.xml`)),saved.artifact.response_hash);assert.ok(saved.artifact.processed_hash);
  assert.doesNotMatch(JSON.stringify(out),/private_executor_only|certificate_fingerprint|issuer_cnpj|lease_id|<NFe|BEGIN CERTIFICATE/);
  const again=await service.run({...input},options());assert.equal(again.status,'authorization_observed');assert.equal(again.recovered,true);assert.deepEqual(counts(),{uses:start.uses+1,transport:start.transport+1,custody:start.custody+1});
  const history=await service.history({actor:f.users.admin,candidateId:input.candidateId,limit:25,before:null},options());assert.equal(history.items.length,1);assert.equal(history.items[0].read_only,true);assert.equal(history.items[0].recoverable_by_actor,false);
 }
 f.buffers.forEach(b=>assert.ok(b.every(x=>x===0)));
});
test('preview uses pinned050 bytes/readback, creates no command or idLote; operational run is closed',async()=>{
 const {input}=await f.source(),service=f.service({enabled:false}),start=f.calls.rpc.length,preview=await service.preview({actor:input.actor,candidateId:input.candidateId,signedHash:input.signedHash},options());
 assert.equal(preview.signature_checked,true);assert.equal(preview.can_prepare,false);assert.equal(preview.operational_binding_available,false);assert.ok(f.calls.rpc.slice(start).every(x=>['erp_fiscal_signed_get','erp_fiscal_authorization_preview'].includes(x.name)));assert.equal(Object.hasOwn(preview,'batch_id'),false);
 assert.throws(()=>service.run(input),e=>e.code==='AUTHORIZATION_SERVICE_DISABLED');assert.throws(()=>f.service({mode:'operational',enabled:true}).run(input),e=>e.code==='AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
});
test('history25 with conservative maximum-width terminal evidence fits the RPC JSONB response budget',async t=>{
 const {input}=await f.source(),service=f.service();await service.run(input,options());
 const args={p_user_id:input.actor,p_candidate_id:input.candidateId,p_limit:25,p_before:null};
 const base=await f.callSql('erp_fiscal_authorization_history',args),template=base.items[0];
 // More pessimistic than a reachable SQL history: one intent can consume only once,
 // whereas every row here includes the largest terminal artifact/evidence shape.
 const maximum=2147483647,stamp=second=>`2026-10-16T00:00:0${second}.000000+00:00`;
 const items=Array.from({length:25},(_,i)=>{
  const row=structuredClone(template),r=row.receipt,c=row.current,a=row.artifact,e=a.evidence;
  for(const key of ['candidate_version','signing_a1_version','completion_version','policy_version','identity_version','a1_version'])r[key]=maximum;
  r.ordinal=r.batch_id=String(999999999999999n-BigInt(i));r.signed_size=512000;r.origin='operational';r.created_at=stamp(0);
  c.state='authorized_homologation';c.authorized_in_homologation=true;c.used_at=stamp(1);c.expires_at=stamp(2);c.finished_at=stamp(3);
  c.candidate.a1_version=maximum;c.candidate.latest_candidate_version=maximum;c.candidate.attempt_count=100;
  a.response_size=a.processed_size=512000;a.created_at=stamp(3);
  e.origin='operational';e.binding_profile=e.rule_profile='x'.repeat(120);e.protocol_number='9'.repeat(17);e.tls_origin_verified=true;e.transport_hash='e'.repeat(64);e.transport_size=8192;
  return row;
 });
 const page={...base,items,has_more:true,next_cursor:items.at(-1).receipt.ordinal};
 projectResponse('erp_fiscal_authorization_history',page,args);
 const [{body}]=(await f.db.query('select $1::jsonb::text as body',[JSON.stringify(page)])).rows;
 const byteLength=Buffer.byteLength(body);assert.ok(byteLength<131072,`history response exceeds128KiB: ${byteLength}`);
 const rpc=createAuthorizationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-a-secret',fetchImpl:async()=>new Response(body,{headers:{'content-type':'application/json','content-length':String(byteLength)}})});
 assert.equal((await rpc('erp_fiscal_authorization_history',args,options())).items.length,25);
 t.diagnostic(`Maximum-width history25 JSONB response: ${byteLength} bytes; limit131072.`);
});
test('103/150/rejection/217 and invalid response stay distinct, preserving raw bytes before parsing',async()=>{
 for(const spec of [{batch:'103',protocol:false,receipt:true,status:'receipt_pending'},{individual:'150',status:'authorization_observed'},{batch:'225',protocol:false,status:'rejected'},{batch:'217',protocol:false,status:'review_required'},{invalid:true,status:'review_required'}]){
  const {input}=await f.source(),service=f.service({transport:async(v)=>new Response(spec.invalid?'<broken':f.response(v.request,{batch:spec.batch??'104',status:spec.individual??'100',protocol:spec.protocol??true,receipt:spec.receipt??false}),{headers:{'content-type':'application/octet-stream'}})});
  const out=await service.run(input,options());assert.equal(out.status,spec.status,JSON.stringify(out));const v=await raw(input);assert.equal(v.current.grant_consumed,true);if(spec.invalid){assert.equal(v.artifact.evidence.outcome,'invalid_response');assert.equal(f.files.get(`authorization/${v.receipt.attempt_id}/responses/${v.recovery.request_hash}.xml`).toString(),'<broken');}assert.equal(out.retry_submission_allowed,false);
 }
});
test('lost use ACK never reaches transport and recover cannot consume or open custody again',async()=>{
 const {input}=await f.source(),start=counts();let lost=false;const service=f.service({rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n.endsWith('_authorization_use')&&!lost){lost=true;throw Error('PRIVATE_LOST_ACK');}return v;}});
 const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');assert.equal(out.recovery_required,true);const after=counts();assert.deepEqual(after,{uses:start.uses+1,transport:start.transport,custody:start.custody+1});
 const again=await service.recover({actor:input.actor,commandId:input.commandId},options());assert.equal(again.status,'unconfirmed');assert.deepEqual(counts(),after);
 const replay=await service.run(input,options());assert.equal(replay.status,'unconfirmed');assert.deepEqual(counts(),after);
});
test('lost finish ACK and command failure recover through saved journal without A1 or new transport',async()=>{
 const {input}=await f.source('65');let finished=false,down=true;const service=f.service({rpc:async(n,a,o)=>{if(finished&&down&&n.endsWith('_command'))throw Error('PRIVATE_READ_FAILED');const v=await f.ports.rpc(n,a,o);if(n.endsWith('_authorization_finish')&&!finished){finished=true;throw Error('PRIVATE_FINISH_ACK');}return v;}});
 const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');const after=counts();down=false;
 const recovered=await f.service({enabled:false,withPreparedSession:()=>assert.fail('no custody'),transport:()=>assert.fail('no transport')}).recover({actor:input.actor,commandId:input.commandId},options());assert.equal(recovered.status,'authorization_observed');assert.equal(recovered.recovered,true);assert.deepEqual(counts(),after);
});
test('saved invalid bytes survive validator outage and a later recovery classifies them without another POST',async()=>{
 const {input}=await f.source();let unavailable=true,transports=0;const service=f.service({transport:async()=>{transports++;return new Response('<invalid>',{headers:{'content-type':'application/octet-stream'}});},validate:async(v,o)=>{if(unavailable&&v.kind==='response')throw Error('PRIVATE_VALIDATOR_FAILED');return f.ports.validate(v,o);}});
 const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');const v=await raw(input),key=`authorization/${v.receipt.attempt_id}/responses/${v.recovery.request_hash}.xml`;assert.equal(f.files.get(key).toString(),'<invalid>');unavailable=false;
 const recovered=await service.recover({actor:input.actor,commandId:input.commandId},options());assert.equal(recovered.status,'review_required');assert.equal(recovered.artifact.outcome,'invalid_response');assert.equal(transports,1);
});
test('confirmed finish ACK survives unavailable command reads only after all expected artifact hashes pass',async()=>{
 const {input}=await f.source();let committed=false;const service=f.service({rpc:async(n,a,o)=>{if(committed&&n.endsWith('_command'))throw Error('PRIVATE_READ_FAILED');const v=await f.ports.rpc(n,a,o);if(n.endsWith('_authorization_finish'))committed=true;return v;}});
 const out=await service.run(input,options());assert.equal(out.status,'authorization_observed',JSON.stringify(out));assert.equal(out.recovered,true);assert.equal(out.failure_code,null);
});
test('a conflicting immutable journal is never replaced or finalized',async()=>{
 const {input}=await f.source();const storage={...f.ports.storage,putImmutable:async o=>{if(o.key.includes('/responses/')){const bad=Buffer.from('<conflicting/>');f.files.set(o.key,bad);return{status:409,requires_readback:true};}return f.ports.storage.putImmutable(o);}};
 const out=await f.service({storage}).run(input,options());assert.equal(out.status,'unconfirmed');assert.equal((await raw(input)).artifact,null);const before=f.calls.transport.length;await f.service().recover({actor:input.actor,commandId:input.commandId},options());assert.equal(f.calls.transport.length,before);
});
test('aborted/duplicate/late callbacks cannot finalize or start a second transport',async()=>{
 const {input}=await f.source();let calls=0;const controller=new AbortController();const service=f.service({withPreparedSession:async(v,fn,o)=>{await fn({synthetic:true});try{await fn({synthetic:true});}catch{}},transport:async v=>{calls++;return new Response(f.response(v.request),{headers:{'content-type':'application/octet-stream'}});}});
 const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');assert.equal(calls,1);assert.equal((await raw(input)).artifact,null);
 const next=await f.source(),s=f.service({transport:async()=>{controller.abort();return new Response('PRIVATE_LATE_RESPONSE',{headers:{'content-type':'application/octet-stream'}});}});const stop=await s.run(next.input,{signal:controller.signal,deadline:Date.now()+45000});assert.equal(stop.status,'unconfirmed');assert.equal((await raw(next.input)).artifact,null);
});
test('HTTP500/Fault bytes are journaled, and even a valid100 body over500 cannot authorize',async()=>{
 for(const fault of [true,false]){
  const {input}=await f.source(),body=Buffer.from('<SOAP-FAULT-SYNTHETIC/>'),service=f.service({transport:async v=>new Response(fault?body:f.response(v.request),{status:500,headers:{'content-type':'application/soap+xml'}}),binding:{...f.ports.binding,extract:(_c,b)=>{if(fault)throw Object.assign(Error('PRIVATE_FAULT'),{code:'SOAP_FAULT'});return Buffer.from(b);}}});
  const out=await service.run(input,options());assert.equal(out.status,'review_required');assert.equal(out.artifact.rejection_code,fault?'SOAP_FAULT':'SOAP_INVALID');const value=await raw(input),key=`authorization/${value.receipt.attempt_id}/responses/${value.recovery.request_hash}.xml`;if(fault)assert.deepEqual(f.files.get(key),body);assert.equal(value.artifact.processed_hash,null);
 }
});
test('prepared recovery is read-only, and captured run body survives mutation while command is pending',async()=>{
 const {input}=await f.source(),b=await f.callSql('erp_fiscal_authorization_begin',{p_user_id:input.actor,p_command_id:input.commandId,p_candidate_id:input.candidateId,p_signed_hash:input.signedHash,p_expected_identity_version:1,p_expected_a1_version:2,p_expected_policy_version:2,p_confirmed:true});
 const start=f.calls.rpc.length,service=f.service();const recovered=await service.recover({actor:input.actor,commandId:input.commandId},options());assert.equal(recovered.status,'prepared');assert.deepEqual(f.calls.rpc.slice(start).map(x=>x.name),['erp_fiscal_authorization_command']);
 const snapshot={...input};let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);let first=true;
 const held=f.service({rpc:async(n,a,o)=>{if(first&&n.endsWith('_command')){first=false;enter();await hold;}return f.ports.rpc(n,a,o);}}),pending=held.run(input,options());await entered;input.candidateId='0'.repeat(36);input.signedHash='0'.repeat(64);input.expectedA1Version=99;release();const out=await pending;assert.equal(out.status,'authorization_observed');assert.equal(out.receipt.candidate_id,snapshot.candidateId);assert.equal(out.receipt.attempt_id,b.receipt.attempt_id);
});
test('DTO rejects synthetic promotion, altered request context, missing receipt fields and unexpected private keys',async()=>{
 const {input}=await f.source(),out=await f.service().run(input,options());assert.equal(out.status,'authorization_observed');const good=await raw(input),args={p_user_id:input.actor,p_command_id:input.commandId};
 assert.equal(projectResponse('erp_fiscal_authorization_command',good,args).current.state,'authorization_observed');
 for(const mutate of [v=>{v.current.state='authorized_homologation';v.current.authorized_in_homologation=true;},v=>v.recovery.request_hash='0'.repeat(64),v=>{delete v.receipt.batch_id;},v=>v.recovery.password='PRIVATE_SENTINEL',v=>v.artifact.evidence.can_emit=true]){const bad=structuredClone(good);mutate(bad);assert.throws(()=>projectResponse('erp_fiscal_authorization_command',bad,args));}
});
test('caller abort while a port ignores cancellation returns promptly and blocks a late callback',async()=>{
 const {input}=await f.source(),controller=new AbortController();let callback,enter;const entered=new Promise(r=>enter=r);const service=f.service({withPreparedSession:async(_v,fn)=>{callback=fn;enter();return new Promise(()=>{});}});
 const pending=service.run(input,{signal:controller.signal,deadline:Date.now()+45000});await entered;controller.abort();const out=await pending;assert.equal(out.status,'unconfirmed');const count=counts();await assert.rejects(callback({synthetic:true}));assert.deepEqual(counts(),count);assert.equal((await raw(input)).current.grant_consumed,false);
});
test('deadline crossing after use cannot schedule transport even when the microtask was already queued',async()=>{
 const {input}=await f.source(),original=Date.now;let ticks=0,consumed=0,transports=0;
 const service=f.service({rpc:async(n,a,o)=>{const value=await f.ports.rpc(n,a,o);if(n.endsWith('_authorization_use')){consumed++;const base=original(),end=o.deadline;Date.now=()=>++ticks>=2?end:base;}return value;},transport:async()=>{transports++;throw Error('MUST_NOT_DISPATCH');}});
 try{const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');assert.equal(consumed,1);assert.equal(transports,0);}finally{Date.now=original;}
 const replay=await service.run(input,options());assert.equal(replay.status,'unconfirmed');assert.equal(consumed,1);assert.equal(transports,0);
});

test('custody returned early fences a retained callback before the recovery command wait',async()=>{
 const {input}=await f.source(),start=counts();let late,invoked=false,callbackCode,usePortCalls=0;
 const service=f.service({withPreparedSession:async(v,action,o)=>f.ports.withPreparedSession(v,async session=>{late=()=>action(session);},o),rpc:async(name,args,o)=>{
  if(name.endsWith('_command')&&late&&!invoked){invoked=true;try{await late();}catch(e){callbackCode=e.code;}}
  if(name.endsWith('_use'))usePortCalls++;
  return f.ports.rpc(name,args,o);
 }});
 const out=await service.run(input,options());assert.equal(out.status,'failed_before_dispatch');assert.equal(invoked,true);assert.equal(callbackCode,'AUTHORIZATION_CALLBACK_INVALID');assert.equal(usePortCalls,0);assert.equal((await raw(input)).current.grant_consumed,false);assert.deepEqual(counts(),{...start,custody:start.custody+1});
});
test('closing custody while use ACK is pending prevents continuation even when the backend already consumed',async()=>{
 const {input}=await f.source(),start=counts();let entered,release,callback,callbackCode,held=false,released=false;
 const useEntered=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const service=f.service({withPreparedSession:async(v,action)=>{f.calls.custody.push(v);callback=action(Object.freeze({synthetic:true})).catch(e=>{callbackCode=e.code;});await useEntered;},rpc:async(name,args,o)=>{
  if(name.endsWith('_command')&&held&&!released){released=true;release();await callback;}
  const value=await f.ports.rpc(name,args,o);
  if(name.endsWith('_use')){held=true;entered();await hold;}
  return value;
 }});
 const out=await service.run(input,options());await callback;assert.equal(out.status,'unconfirmed');assert.equal(callbackCode,'AUTHORIZATION_CALLBACK_INVALID');assert.equal((await raw(input)).current.grant_consumed,true);assert.deepEqual(counts(),{uses:start.uses+1,custody:start.custody+1,transport:start.transport});
 await service.recover({actor:input.actor,commandId:input.commandId},options());assert.deepEqual(counts(),{uses:start.uses+1,custody:start.custody+1,transport:start.transport});
});
test('explicit42501 after a finish ACK suppresses receipt and all fallback private reads',async()=>{
 const {input}=await f.source(),start=counts();let committed=false,readsAtFinish,queriesAfterFinish=0;
 const service=f.service({rpc:async(name,args,o)=>{
  if(committed&&name.endsWith('_command')){queriesAfterFinish++;throw new AuthorizationServiceError('42501');}
  const value=await f.ports.rpc(name,args,o);if(name.endsWith('_finish')){committed=true;readsAtFinish=f.calls.read.length;}return value;
 }});
 const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');assert.equal(out.command_id,input.commandId);assert.equal(out.failure_code,'42501');assert.equal(out.recovery_required,true);assert.equal(out.receipt,null);assert.equal(out.current,null);assert.equal(out.artifact,null);assert.equal(queriesAfterFinish,1);assert.equal(f.calls.read.length,readsAtFinish);
 const recovered=await f.service({enabled:false}).recover({actor:input.actor,commandId:input.commandId},options());assert.equal(recovered.status,'authorization_observed');assert.deepEqual(counts(),{uses:start.uses+1,custody:start.custody+1,transport:start.transport+1});
});
test('explicit42501 during error recovery discards earlier authorized metadata without another lookup',async()=>{
 const {input}=await f.source();let deny=false,deniedQueries=0,readsAtDenial;
 const service=f.service({validate:async(v,o)=>{if(v.kind==='response'){deny=true;throw Error('synthetic validator outage');}return f.ports.validate(v,o);},rpc:async(name,args,o)=>{
  if(deny&&name.endsWith('_command')){deniedQueries++;readsAtDenial=f.calls.read.length;throw new AuthorizationServiceError('42501');}return f.ports.rpc(name,args,o);
 }});
 const out=await service.run(input,options());assert.equal(out.status,'unconfirmed');assert.equal(out.failure_code,'42501');assert.equal(out.receipt,null);assert.equal(out.current,null);assert.equal(out.artifact,null);assert.equal(deniedQueries,1);assert.equal(f.calls.read.length,readsAtDenial);
});

test('recovery after lease, policy and A1 changes uses historical pinned certificate and never opens custody',async()=>{
 const {input}=await f.source();let down=true;const service=f.service({validate:async(v,o)=>{if(down&&v.kind==='response')throw Error('PRIVATE_TEMPORARY');return f.ports.validate(v,o);}});
 const first=await service.run(input,options());assert.equal(first.status,'unconfirmed');const snapshot=counts();await f.age(input.commandId);await f.disable();await f.install(3);down=false;
 const out=await service.recover({actor:input.actor,commandId:input.commandId},options());assert.equal(out.status,'authorization_observed');assert.equal(out.current.a1_changed,true);assert.equal(out.current.policy_changed,true);assert.equal(out.current.lease_expired,true);assert.equal(out.current.candidate.artifact_current,false);assert.deepEqual(counts(),snapshot);
});
