import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,hash} from './fixture.mjs';
import {createSignedFiscalOrchestrator} from '../src/signed.mjs';
import {signerMaterial} from '../../fiscal-xml/src/certificate.mjs';
const using=fn=>async()=>{const f=await fixture();try{await fn(f);}finally{await f.close();}};
const code=value=>e=>e.code===value&&e.message===value;
const timeout=(p,ms=3000)=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('TEST_CHECKPOINT_TIMEOUT')),ms);t.unref();})]);
const noSecrets=v=>assert.doesNotMatch(JSON.stringify(v),/<NFe|BEGIN CERTIFICATE|credential_id|certificate_fingerprint|credential_context|lease_id|lease_until|key_id|access_key|cnpj|credentials\/|candidates\//);

test('signed orchestrator requires every injected port and rejects caller clock, identity or unknown options',async()=>{
 assert.throws(()=>createSignedFiscalOrchestrator(),code('SIGNED_PORTS_REQUIRED'));const f=await fixture();try{
  for(const patch of [{now:new Date()},{identity:{}},{unsignedHash:'bad'},{actor:[f.input.actor]},{expectedA1Version:0}])await assert.rejects(()=>f.orchestrator().run({...f.input,...patch}),code('SIGNED_INPUT_INVALID'));
  await assert.rejects(()=>f.orchestrator().run(f.input,{deadline:Date.now()+45001}),code('SIGNED_DEADLINE_INVALID'));assert.equal(f.calls.rpc.length,0);
 }finally{await f.close();}
});
test('real050 signs stored048 for55/65, pins evidence, disposes signer and returns only a safe summary',async()=>{
 for(const model of ['55','65']){const f=await fixture({model});try{
  const before=await f.counts(),result=await f.orchestrator().run(f.input);assert.equal(result.status,'stored');assert.equal(result.signature_verified,true);assert.equal(result.xsd_validated,true);assert.equal(result.can_emit,false);assert.equal(result.can_transmit,false);assert.equal(result.current.artifact_current,true);assert.equal(result.storage_operations,4);noSecrets(result);
  const known=await f.signedCommand();assert.equal(known.artifact.signed_hash,result.artifact.sha256);assert.equal(known.artifact.evidence.qr.verified,model==='65');assert.equal(f.calls.custody.length,1);assert.equal(f.calls.schema.length,1);assert.deepEqual(await f.counts(),before);
  for(const handle of f.handles)assert.throws(()=>signerMaterial(handle,new Date()),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));assert.ok(f.buffers.every(b=>b.every(v=>v===0)));
  const replay=await f.orchestrator().run(f.input);assert.equal(replay.status,'stored');assert.equal(replay.recovered,true);assert.equal(f.calls.custody.length,1);assert.equal(f.calls.put.length,1);noSecrets(replay);
 }finally{await f.close();}}
});
test('begin ACK lost retains the command, active lease does not sign, explicit expiry permits fenced recovery',using(async f=>{
 const run=f.orchestrator({rpc:async(n,a,o)=>{const r=await f.ports.rpc(n,a,o);if(n.endsWith('_begin'))throw Error('SECRET_LOST_BEGIN');return r;}});
 const first=await run.run(f.input);assert.equal(first.status,'recoverable');assert.equal(first.outcome,'unconfirmed');assert.equal(f.calls.custody.length,0);assert.doesNotMatch(JSON.stringify(first),/SECRET/);
 const pending=await f.orchestrator().run(f.input);assert.equal(pending.status,'pending');assert.equal(f.calls.custody.length,0);const known=await f.signedCommand();await f.expire({value:known});
 const recovered=await f.orchestrator().run(f.input);assert.equal(recovered.status,'stored');assert.equal(recovered.current.attempt_count,2);assert.equal(f.calls.custody.length,1);
}));
test('lost immutable PUT and finish ACK recover only exact persisted bytes without a second mutation',using(async f=>{
 const result=await f.orchestrator({storage:{...f.ports.storage,putImmutable:async o=>{await f.ports.storage.putImmutable(o);throw Error('PUT_ACK_LOST');}},rpc:async(n,a,o)=>{const value=await f.ports.rpc(n,a,o);if(n.endsWith('_finish'))throw Error('FINISH_ACK_LOST');return value;}}).run(f.input);
 assert.equal(result.status,'stored');assert.equal(result.recovered,true);assert.equal(f.calls.put.length,1);assert.equal(f.calls.rpc.filter(c=>c.name.endsWith('_finish')).length,1);assert.equal(f.calls.custody.length,1);noSecrets(result);
}));
test('finish recovery rejects an altered candidate hash/size/evidence or receipt rather than claiming success',using(async f=>{
 let finish=false;const result=await f.orchestrator({rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n.endsWith('_finish')){finish=true;throw Error('ACK_LOST');}if(finish&&n.endsWith('_command'))v.artifact.signed_hash=hash('wrong candidate');return v;}}).run(f.input);
 assert.equal(result.status,'recoverable');assert.equal(result.outcome,'unconfirmed');assert.equal((await f.signedCommand()).current.state,'stored');assert.equal((await f.orchestrator().run(f.input)).status,'stored');
}));
test('source hash and identity conflicts never reach custody, signing, schema or finalization',using(async f=>{
 const first=await f.orchestrator({storage:{...f.ports.storage,read:async o=>o.key.startsWith('jobs/')?new Response('bad',{headers:{'content-type':'application/octet-stream'}}):f.ports.storage.read(o)}}).run(f.input);
 assert.equal(first.status,'recoverable');assert.equal(first.code,'SIGNED_STORAGE_HASH_CONFLICT');assert.equal(f.calls.custody.length,0);assert.equal(f.calls.schema.length,0);assert.equal(f.calls.put.length,0);
 const old=await f.signedCommand();await f.expire({value:old});const second=await f.orchestrator({rpc:async(n,a,o)=>{const v=await f.ports.rpc(n,a,o);if(n.endsWith('_use'))v.access_key='0'.repeat(44);return v;}}).run(f.input);
 assert.equal(second.code,'SIGNED_IDENTITY_INVALID');assert.equal(f.calls.custody.length,0);assert.equal(f.calls.rpc.some(x=>x.name.endsWith('_fail')),false);
}));
test('custody must invoke exactly once, finish before returning, and cannot retain a usable signer',using(async f=>{
 let callback;const premature=await f.orchestrator({withAuthorizedSigner:async(_grant,cb)=>{callback=cb;}}).run(f.input);
 assert.equal(premature.code,'SIGNED_CUSTODY_NOT_COMPLETED');const late=f.signer();assert.throws(()=>callback(late),code('SIGNED_CUSTODY_CALLBACK_INVALID'));assert.throws(()=>signerMaterial(late,new Date()),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));
 await f.expire({value:await f.signedCommand()});const multiple=await f.orchestrator({withAuthorizedSigner:async(_grant,cb)=>{cb(f.signer());cb(f.signer());}}).run(f.input);assert.equal(multiple.code,'SIGNED_CUSTODY_CALLBACK_INVALID');assert.equal(f.calls.schema.length,0);
 await f.expire({value:await f.signedCommand()});const swallowed=await f.orchestrator({withAuthorizedSigner:async(_grant,cb)=>{cb(f.signer());try{cb(f.signer());}catch{/* A broken port swallowing its error must still be rejected. */}}}).run(f.input);assert.equal(swallowed.code,'SIGNED_CUSTODY_CALLBACK_INVALID');assert.equal(f.calls.schema.length,0);
 for(const handle of f.handles)assert.throws(()=>signerMaterial(handle,new Date()),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));
}));
test('successful XSD reports must bind exact bytes/profile/model and cannot promote trust flags',using(async f=>{
 const patches=[r=>r.xmlDigest=hash('wrong'),r=>r.schemaManifestHash=hash('wrong'),r=>r.signatureVerified=true,r=>r.model='65',r=>r.extra='secret'];
 for(const patch of patches){const result=await f.orchestrator({validateXsd:async(b,o)=>{const r=f.schemaReport(b,o);patch(r);return r;}}).run(f.input);assert.equal(result.code,'SIGNED_XSD_RESPONSE_INVALID');assert.equal(result.status,'recoverable');await f.expire({value:await f.signedCommand()});}
 assert.equal(f.calls.put.length,0);assert.equal(f.calls.rpc.some(x=>x.name.endsWith('_fail')),false);
}));
test('a complete XSD rejection is terminal; process errors and timeouts are not fiscal failures',using(async f=>{
 const result=await f.orchestrator({validateXsd:async(b,o)=>({...f.schemaReport(b,o),ok:false,xsdValidated:false,code:'XML_XSD_INVALID',diagnostics:[{line:1,column:2,domain:'SCHEMASV',type:'SCHEMAV_CVC_DATATYPE_VALID_1_2_1'}]})}).run(f.input);
 assert.equal(result.status,'failed');assert.equal(result.error_code,'XSD_INVALID');assert.equal(f.calls.put.length,0);assert.equal((await f.orchestrator().run(f.input)).status,'failed');noSecrets(result);
}));
test('A1 disable during XSD blocks finish while preserving the immutable orphan bytes and pending intent',using(async f=>{
 const result=await f.orchestrator({validateXsd:async(b,o)=>{await f.disable();return f.schemaReport(b,o);}}).run(f.input);
 assert.equal(result.status,'recoverable');assert.equal(result.code,'SIGNED_RPC_40001');assert.equal((await f.signedCommand()).current.state,'pending');assert.equal(await f.scalar('select count(*)::int value from erp_fiscal_signed.artifact'),0);assert.equal(f.calls.put.length,1);
}));
test('unavailable command read and failed XSD process preserve uncertain state rather than assert no prior commit',using(async f=>{
 const unread=await f.orchestrator({rpc:async()=>{throw Error('SECRET_STATUS_UNAVAILABLE');}}).run(f.input);assert.equal(unread.status,'recoverable');assert.equal(unread.outcome,'unconfirmed');assert.equal(unread.signed,null);assert.equal(f.calls.custody.length,0);assert.doesNotMatch(JSON.stringify(unread),/SECRET/);
 const failed=await f.orchestrator({validateXsd:async()=>{throw Error('PROCESS_SECRET');}}).run(f.input);assert.equal(failed.status,'recoverable');assert.equal(f.calls.rpc.some(v=>v.name.endsWith('_fail')),false);assert.equal(f.calls.put.length,0);assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
}));
test('current A1 changes never overwrite the historical version in a recovered result',using(async f=>{
 const stored=await f.orchestrator().run(f.input);assert.equal(stored.a1_version,2);await f.disable();const replay=await f.orchestrator().run(f.input);
 assert.equal(replay.status,'stored');assert.equal(replay.a1_version,2);assert.equal(replay.current.a1_version,3);assert.equal(replay.current.a1_changed,true);assert.equal(replay.current.artifact_current,false);assert.equal(f.calls.custody.length,1);noSecrets(replay);
}));
test('caller options are captured once, reject accessors, and remove only the original abort listener',using(async f=>{
 const original=new AbortController(),replacement=new AbortController();let oldRemoved=0,newRemoved=0;
 const oldRemove=original.signal.removeEventListener.bind(original.signal),newRemove=replacement.signal.removeEventListener.bind(replacement.signal);
 original.signal.removeEventListener=(...args)=>{oldRemoved++;return oldRemove(...args);};replacement.signal.removeEventListener=(...args)=>{newRemoved++;return newRemove(...args);};
 const options={signal:original.signal,deadline:Date.now()+45000},pending=f.orchestrator().run(f.input,options);options.signal=replacement.signal;options.deadline=1;
 assert.equal((await pending).status,'stored');assert.equal(oldRemoved,1);assert.equal(newRemoved,0);
 let called=false;const unsafe={};Object.defineProperty(unsafe,'signal',{get(){called=true;return original.signal;}});await assert.rejects(()=>f.orchestrator().run(f.input,unsafe),code('SIGNED_OPTIONS_INVALID'));assert.equal(called,false);
}));
test('aborting a stalled stream returns promptly, cancels bytes and prevents late custody or writes',using(async f=>{
 const abort=new AbortController();let enter,cancelled=false;const entered=new Promise(r=>enter=r);const result=f.orchestrator({storage:{...f.ports.storage,read:async()=>new Response(new ReadableStream({start(){enter();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/octet-stream'}})}}).run(f.input,{signal:abort.signal});
 await timeout(entered);abort.abort();const value=await timeout(result);assert.equal(value.code,'SIGNED_ABORTED');assert.equal(value.status,'recoverable');assert.equal(cancelled,true);assert.equal(f.calls.custody.length,0);assert.equal(f.calls.put.length,0);
}));
test('deadline during XSD wipes retained bytes and never records a deterministic fiscal failure',using(async f=>{
 let retained,entered;const ready=new Promise(r=>entered=r);
 const running=f.orchestrator({validateXsd:async(bytes)=>{retained=bytes;entered();return new Promise(()=>{});}}).run(f.input,{deadline:Date.now()+500});
 await timeout(ready);const result=await timeout(running);assert.equal(result.code,'SIGNED_TIMEOUT');assert.equal(result.status,'recoverable');assert.ok(retained.every(x=>x===0));assert.equal(f.calls.rpc.some(x=>x.name.endsWith('_fail')),false);assert.equal(f.calls.put.length,0);
 for(const h of f.handles)assert.throws(()=>signerMaterial(h,new Date()),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));
}));
test('abort after a Storage or finish commit never loses the command identity or starts another mutation',using(async f=>{
 const abort=new AbortController();const first=await f.orchestrator({storage:{...f.ports.storage,putImmutable:async o=>{await f.ports.storage.putImmutable(o);abort.abort();return{status:201};}}}).run(f.input,{signal:abort.signal});
 assert.equal(first.status,'recoverable');assert.equal(first.code,'SIGNED_ABORTED');assert.equal((await f.signedCommand()).current.state,'pending');assert.equal(f.calls.rpc.some(x=>x.name.endsWith('_finish')),false);
 await f.expire({value:await f.signedCommand()});const secondAbort=new AbortController();const second=await f.orchestrator({rpc:async(n,a,o)=>{const result=await f.ports.rpc(n,a,o);if(n.endsWith('_finish'))secondAbort.abort();return result;}}).run(f.input,{signal:secondAbort.signal});
 assert.equal(second.status,'recoverable');assert.equal(second.code,'SIGNED_ABORTED');assert.equal(f.calls.put.length,1);assert.equal((await f.signedCommand()).current.state,'stored');
 const final=await f.orchestrator().run(f.input);assert.equal(final.status,'stored');assert.equal(final.recovered,true);assert.equal(f.calls.custody.length,2);assert.equal(f.calls.rpc.filter(x=>x.name.endsWith('_finish')).length,1);
}));
test('concurrent same-process command and abort-ignoring late custody cannot cause another signature',using(async f=>{
 const abort=new AbortController();let enter,release,callback;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);const orchestrator=f.orchestrator({withAuthorizedSigner:async(_grant,cb)=>{callback=cb;enter();await hold;}}),running=orchestrator.run(f.input,{signal:abort.signal});
 await timeout(entered);await assert.rejects(()=>orchestrator.run(f.input),code('SIGNED_ALREADY_RUNNING'));abort.abort();assert.equal((await timeout(running)).code,'SIGNED_ABORTED');release();const handle=f.signer();assert.throws(()=>callback(handle),code('SIGNED_CUSTODY_CALLBACK_INVALID'));assert.throws(()=>signerMaterial(handle,new Date()),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));assert.equal(f.calls.put.length,0);
}));
