import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {WsdlServiceError,createWsdlPreparationAuthorizer} from '../src/service.mjs';
const cases=(name,fn)=>test(name,async()=>{const f=await serviceFixture();try{await fn(f);}finally{await f.close();}});
const count=(f,action)=>f.calls.rpc.filter(x=>x.name==='erp_fiscal_wsdl_'+action).length;
for(const model of ['55','65'])test(`051 SQL→fixedGET→immutableStorage→finish→command model${model}`,async()=>{
 const f=await serviceFixture({model});try{const service=f.service(),done=await service.run(f.input);assert.equal(done.status,'stored');assert.equal(done.read_only,false);assert.equal(done.failure_code,null);assert.equal(done.binding_verified,false);assert.equal(done.artifact.inspection_status,'supported');assert.equal(done.receipt.model,model);assert.equal(f.wire.calls,1);assert.equal(count(f,'use'),1);assert.equal(count(f,'finish'),1);assert.equal(f.calls.put.length,1);assert.ok(f.buffers.every(b=>b.every(x=>x===0)));assert.doesNotMatch(JSON.stringify(done),/credential_id|fingerprint|issuer_cnpj|SecureContext|metadata|execution|wsdl\/|key_id/);
 const read=await service.command({actor:f.actor,commandId:f.input.commandId});assert.equal(read.read_only,true);assert.equal(read.status,'stored');const replay=await service.run(f.input);assert.equal(replay.status,'stored');assert.equal(f.wire.calls,1);assert.equal(count(f,'use'),1);
 }finally{await f.close();}
});
cases('lost begin response recovers preparation and explicit same-command run may consume it once',async f=>{
 let lost=true;const s=f.service({rpc:async(...args)=>{const v=await f.ports.rpc(...args);if(args[0].endsWith('_begin')&&lost){lost=false;throw new Error('SECRET');}return v;}});
 const first=await s.run(f.input);assert.equal(first.status,'prepared');assert.equal(first.recovery_required,true);assert.equal(f.wire.calls,0);assert.equal(count(f,'use'),0);const next=await s.run(f.input);assert.equal(next.status,'stored');assert.equal(f.wire.calls,1);
});
cases('lost use ACK never issues GET and later runs only recover consumed state',async f=>{
 const s=f.service({rpc:async(...args)=>{const v=await f.ports.rpc(...args);if(args[0].endsWith('_use'))throw new Error('SECRET');return v;}});const result=await s.run(f.input);assert.equal(result.status,'dispatched');assert.equal(result.recovery_required,true);assert.equal(f.wire.calls,0);assert.equal((await s.run(f.input)).status,'dispatched');assert.equal(count(f,'use'),1);assert.equal(f.wire.calls,0);assert.equal(count(f,'finish'),0);
});
cases('lost PUT response uses verified readback and lost finish response uses command only',async f=>{
 const s=f.service({storage:{...f.ports.storage,putImmutable:async o=>{await f.ports.storage.putImmutable(o);throw new Error('SECRET');}},rpc:async(...args)=>{const v=await f.ports.rpc(...args);if(args[0].endsWith('_finish'))throw new Error('SECRET');return v;}});const v=await s.run(f.input);assert.equal(v.status,'stored');assert.equal(v.recovered,true);assert.equal(f.calls.put.length,1);assert.equal(count(f,'finish'),1);assert.equal(f.wire.calls,1);assert.equal((await s.run(f.input)).status,'stored');assert.equal(f.wire.calls,1);
});
cases('verified finish ACK survives failed command reads and replay performs only command',async f=>{
 let finished=false,reads=0;const s=f.service({rpc:async(name,...args)=>{if(name.endsWith('_command')&&finished&&reads++<2)throw new Error('SECRET');const v=await f.ports.rpc(name,...args);if(name.endsWith('_finish'))finished=true;return v;}});
 const first=await s.run(f.input);assert.equal(first.status,'stored');assert.equal(first.recovery_required,false);assert.equal(first.current.state,'stored');assert.equal(first.recovered,true);assert.equal(first.failure_code,null);assert.ok(first.artifact.sha256);const next=await s.run(f.input);assert.equal(next.status,'stored');assert.deepEqual(first.artifact,next.artifact);assert.equal(count(f,'finish'),1);assert.equal(f.wire.calls,1);
});
cases('lost finish ACK and unavailable command leave outcome unconfirmed without an invented artifact',async f=>{
 let finished=false;const s=f.service({rpc:async(name,...args)=>{if(name.endsWith('_command')&&finished)throw new Error('SECRET');const v=await f.ports.rpc(name,...args);if(name.endsWith('_finish')){finished=true;throw new Error('SECRET');}return v;}});
 const first=await s.run(f.input);assert.equal(first.status,'unconfirmed');assert.equal(first.recovery_required,true);assert.equal(first.artifact,null);assert.equal(first.current.state,'prepared');assert.equal((await f.command()).current.state,'stored');assert.equal(count(f,'finish'),1);assert.equal(f.wire.calls,1);
});
cases('recovered stored result must match attempt and locally generated hash/size/evidence',async f=>{
 let finished=false;const s=f.service({rpc:async(name,...args)=>{const v=await f.ports.rpc(name,...args);if(name.endsWith('_finish')){finished=true;throw new Error('lost');}if(name.endsWith('_command')&&finished)return{...v,artifact:{...v.artifact,wsdl_hash:'f'.repeat(64),evidence:{...v.artifact.evidence,wsdl_hash:'f'.repeat(64)}}};return v;}});
 const result=await s.run(f.input);assert.equal(result.status,'unconfirmed');assert.equal(result.artifact,null);assert.equal(result.recovery_required,true);assert.equal(f.wire.calls,1);
});
cases('readback conflict or incomplete object never finalizes or repeats GET',async f=>{
 let writes=0;const s=f.service({storage:{...f.ports.storage,putImmutable:async o=>{writes++;return f.ports.storage.putImmutable(o);},read:async o=>writes?new Response('wrong',{headers:{'content-type':'application/octet-stream'}}):f.ports.storage.read(o)}});const result=await s.run(f.input);assert.equal(result.status,'uncertain');assert.equal(count(f,'finish'),0);assert.equal(f.wire.calls,1);await s.run(f.input);assert.equal(f.wire.calls,1);
});
test('unsafe response is not stored; structurally unsupported safe response is stored with false gates',async()=>{
 for(const[bytes,status]of [[Buffer.from('<broken>'),'uncertain'],[Buffer.from('<safe/>'),'stored']]){const f=await serviceFixture({transportOptions:{bytes}});try{const v=await f.service().run(f.input);assert.equal(v.status,status);assert.equal(f.wire.calls,1);assert.equal(v.binding_verified,false);if(status==='stored')assert.equal(v.artifact.inspection_status,'unsupported');else assert.equal(f.calls.put.length,0);}finally{await f.close();}}
});
cases('abort after consume but before GET prevents request and finalization',async f=>{
 const c=new AbortController();const s=f.service({rpc:async(...args)=>{const v=await f.ports.rpc(...args);if(args[0].endsWith('_use'))c.abort();return v;}});const v=await s.run(f.input,{signal:c.signal});assert.equal(v.recovery_required,true);assert.equal(f.wire.calls,0);assert.equal(count(f,'finish'),0);assert.equal((await f.command()).current.grant_consumed,true);
});
cases('abort during Storage read cancels reader and leaves consumed state without finish',async f=>{
 const c=new AbortController();let cancelled=false;const s=f.service({storage:{...f.ports.storage,read:async()=>new Response(new ReadableStream({start(){queueMicrotask(()=>c.abort());},cancel(){cancelled=true;}}),{headers:{'content-type':'application/octet-stream'}})}});const v=await s.run(f.input,{signal:c.signal});assert.equal(v.recovery_required,true);assert.equal(cancelled,true);assert.equal(count(f,'finish'),0);assert.equal(f.wire.calls,1);
});
cases('mutated input and removed original abort signal cannot change the captured command',async f=>{
 const input={...f.input},c=new AbortController(),o={signal:c.signal};let release,entered;const enteredPromise=new Promise(r=>entered=r),s=f.service({withPreparedTlsSession:async(...args)=>{entered();await new Promise(r=>release=r);return f.ports.withPreparedTlsSession(...args);}});
 const pending=s.run(input,o);input.commandId=randomUUID();input.model='65';o.signal=undefined;await enteredPromise;c.abort();release();const v=await pending;assert.equal(v.command_id,f.input.commandId);assert.equal(v.recovery_required,true);assert.equal(f.wire.calls,0);assert.equal(count(f,'use'),0);
});
cases('duplicate or unawaited custody callback cannot grant a second GET',async f=>{
 const s=f.service({withPreparedTlsSession:async(value,action,o)=>f.ports.withPreparedTlsSession(value,async session=>{const first=action(session);try{await action(session);}catch{}await first;},o)});const v=await s.run(f.input);assert.equal(v.recovery_required,true);assert.equal(f.wire.calls,0);assert.equal(count(f,'use'),1);assert.equal(count(f,'finish'),0);
});
cases('custody authorization replays existing begin and rechecks current role before any opening',async f=>{
 const s=f.service({withPreparedTlsSession:async(...args)=>{await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.actor]);return f.ports.withPreparedTlsSession(...args);}});const v=await s.run(f.input);assert.equal(v.recovery_required,true);assert.equal(f.wire.calls,0);assert.equal(count(f,'use'),0);assert.doesNotMatch(JSON.stringify(v),/password|PFX|BEGIN CERTIFICATE/);
});
cases('ports that ignore abort are bounded; late callbacks cannot consume a grant',async f=>{
 let late,passed;const s=f.service({withPreparedTlsSession:async(value,action,o)=>{passed=[value,action,o];await new Promise(r=>late=r);return f.ports.withPreparedTlsSession(value,action,o);}});const v=await s.run(f.input,{deadline:Date.now()+1300});assert.equal(v.recovery_required,true);assert.equal(v.failure_code,'WSDL_SERVICE_GET_FAILED');assert.ok(passed);late();await new Promise(r=>setTimeout(r,20));assert.equal(f.wire.calls,0);assert.equal(count(f,'use'),0);
});
cases('accessors and false confirmation fail before a port; closed errors never expose arbitrary codes',async f=>{
 const s=f.service();let touched=false;await assert.rejects(()=>s.run({...f.input,get model(){touched=true;return'55';}}),e=>e.code==='WSDL_SERVICE_INPUT_INVALID');assert.equal(touched,false);await assert.rejects(()=>s.run({...f.input,confirmed:false}),e=>e.code==='WSDL_SERVICE_INPUT_INVALID');assert.equal(f.calls.rpc.length,0);
 const hostile=f.service({rpc:async()=>{throw new WsdlServiceError('WSDL_SERVICE_TOKEN_SECRET');}});const result=await hostile.run(f.input);assert.equal(result.failure_code,'WSDL_SERVICE_PORT_FAILED');assert.doesNotMatch(JSON.stringify(result),/TOKEN_SECRET/);
});
