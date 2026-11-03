// Synthetic certificates/XML and in-memory read ports only. No database, network or real fiscal artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {receiptFixture} from './receipt-fixtures.mjs';
import {fiscalResponse,hash} from './service-fixtures.mjs';
import {actor,commandId} from '../../fiscal-authorization-http/test/fixtures.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,reviewedAuthorizationBinding} from '../src/authorization-soap-binding.mjs';
import {createAuthorizationValidator} from '../src/validator.mjs';
import {projectDispatchLedger} from '../src/dispatch-dto.mjs';
import {RULE_PROFILES} from '../src/rule-profile-registry.mjs';
import {createStoredResponseReader,STORED_RESPONSE_MANIFEST,STORED_RESPONSE_MANIFEST_HASH} from '../src/stored-response-reader.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
const clone=structuredClone,code=c=>Object.assign(new Error(c),{code:c});
let f;test.before(async()=>{f=await receiptFixture();});test.after(()=>f?.close());
const realValidate=createAuthorizationValidator({pythonPath:process.env.BRUFAP_TEST_PYTHON??'/Users/bruno/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',validatorPath:fileURLToPath(new URL('../validator.py',import.meta.url))});
function fixture(model='55',options={}){
 const base=f.create(model),record=clone(base.record),c=record.recovery,p=RULE_PROFILES[1],wire=Buffer.from(encodeReviewedAuthorizationSoap(prepareReviewedAuthorizationSoap({request:base.request}))),binding=reviewedAuthorizationBinding(model);
 Object.assign(record.receipt,{origin:'operational'});Object.assign(record.current,{state:'review_required'});
 Object.assign(c,{origin:'operational',request_hash:hash(wire),request_size:wire.length,binding_profile:binding.profile,rule_profile:p.profile,policy_manifest_hash:p.policyHashes[model]});
 const payload=fiscalResponse(base.request,options),raw=Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="${binding.serviceNamespace}">${payload}</nfeResultMsg></Body></Envelope>`);
 const proof={candidate_id:c.candidate_id,candidate_version:1,signed_hash:c.signed_hash,facts_hash:hash('synthetic facts'),profile:p.profile,profile_hash:p.profileHash,review_id:'a0000000-0000-4000-8000-000000000001',review_version:1,review_hash:hash('synthetic review'),reviewed_by:actor,reviewed_at:'2026-10-16T11:00:00Z',valid_until:'2026-10-16T13:00:00Z',coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false};
 const meta={profile:'authorization-reviewed-journal-v1',origin:'operational',attempt_id:c.attempt_id,command_id:c.command_id,candidate_id:c.candidate_id,batch_id:c.batch_id,signed_hash:c.signed_hash,request_hash:c.request_hash,response_hash:hash(raw),response_size:raw.length,http_status:200,received_at:'2026-10-16T12:01:00Z',tls_peer_verified:true,tls_origin_verified:true,tls_protocol:'TLSv1.2',server_trust_profile:SP_AUTHORIZATION_SERVER_TRUST,server_trust_anchor_sha256:SP_AUTHORIZATION_ROOT_HASH,subset_review_hash:proof.review_hash};
 const path=type=>`authorization/${c.attempt_id}/${type}/${c.request_hash}.${type==='observations'?'json':'xml'}`,signedKey=`candidates/${c.candidate_id}/${c.signed_hash}.xml`;
 // Reconstruct exact original signed NFe bytes from the attested fixture request.
 const signed=Buffer.from(wire.toString().slice(wire.toString().indexOf('<NFe '),wire.toString().lastIndexOf('</NFe>')+6));
 assert.equal(hash(signed),c.signed_hash);const files=new Map([[signedKey,signed],[path('requests'),wire],[path('responses'),raw],[path('observations'),Buffer.from(JSON.stringify(meta))]]);
 Object.assign(record.artifact,{response_hash:hash(raw),response_size:raw.length,evidence:{...record.artifact.evidence,origin:'operational',request_hash:c.request_hash,response_hash:hash(raw),payload_hash:null,binding_profile:c.binding_profile,rule_profile:c.rule_profile,outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,receipt_number:null,reference_digest:null,signature_verified:false,xsd_validated:false,context_matched:false,processed_xsd_validated:false,tls_origin_verified:true,transport_hash:hash(files.get(path('observations'))),transport_size:files.get(path('observations')).length}});
 record.rule_review=proof;record.observation={sha256:hash(files.get(path('observations'))),size_bytes:files.get(path('observations')).length};
 const calls={command:[],read:[],validate:[]},input={actor,authorizationCommandId:commandId};
 const ports={readCommand:async(x,o)=>{calls.command.push(clone(x));assert.equal(x.actor,actor);assert.equal(x.authorizationCommandId,commandId);assert.ok(o.signal instanceof AbortSignal);return clone(record);},readObject:async x=>{assert.equal(x.bucket,'brufap-fiscal-artifacts');calls.read.push(x);const b=files.get(x.key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream','content-length':String(b.length)}}):null;},validate:async(x,o)=>{calls.validate.push(x.kind);return realValidate(x,o);}};
 const updateMeta=edit=>{const m=JSON.parse(files.get(path('observations')));edit(m);const b=Buffer.from(JSON.stringify(m));files.set(path('observations'),b);record.observation={sha256:hash(b),size_bytes:b.length};record.artifact.evidence.transport_hash=hash(b);record.artifact.evidence.transport_size=b.length;};
 const updateRaw=bytes=>{files.set(path('responses'),bytes);record.artifact.response_hash=hash(bytes);record.artifact.response_size=bytes.length;record.artifact.evidence.response_hash=hash(bytes);updateMeta(m=>{m.response_hash=hash(bytes);m.response_size=bytes.length;});};
 projectDispatchLedger('command',clone(record),{p_user_id:actor,p_command_id:commandId});
 return{record,files,path,signedKey,calls,input,ports,raw,updateMeta,updateRaw,read:patch=>createStoredResponseReader({...ports,...patch})(input)};
}
test('versioned parser manifest pins both real implementations, independent of a SQL source hash',async()=>{
 for(const p of STORED_RESPONSE_MANIFEST.files)assert.equal(hash(await readFile(new URL('../../../'+p.path,import.meta.url))),p.sha256);
 assert.equal(STORED_RESPONSE_MANIFEST_HASH,hash(JSON.stringify(STORED_RESPONSE_MANIFEST)));
});
test('55/65 original lowercase-UTF8 SOAP, journal, public certificate, signature, context and real XSD produce exact processed bytes',async()=>{
 for(const model of ['55','65']){const x=fixture(model),before=[...x.files].map(([k,b])=>[k,hash(b)]),out=await x.read();
  assert.equal(out.validation.evidence.outcome,'authorization_declared');assert.equal(out.validation.evidence.cstat,'104');assert.equal(out.validation.evidence.protocol_cstat,'100');assert.equal(out.validation.evidence.response_hash,hash(x.raw));assert.equal(out.validation.evidence.tls_origin_verified,true);assert.equal(out.validation.evidence.signature_verified,true);assert.equal(out.validation.evidence.can_emit,false);assert.equal(out.validation.tax_rules_validated,false);
  assert.equal(hash(out.processedBytes),out.validation.processed_hash);assert.equal(out.processedBytes.length,out.validation.processed_size);assert.ok(out.processedBytes.includes(x.files.get(x.signedKey)));assert.equal(x.calls.command.length,2);assert.equal(x.calls.read.length,4);assert.deepEqual(x.calls.validate,['response','processed']);assert.deepEqual([...x.files].map(([k,b])=>[k,hash(b)]),before);assert.ok(Object.isFrozen(out.source.receipt));assert.ok(Object.isFrozen(out.validation));out.processedBytes.fill(0);
 }
});
test('receipt103, ordinary rejection and inconclusive status remain separate and never produce processed XML',async()=>{
 for(const [options,outcome]of [[{batch:'103',receipt:true,protocol:false},'receipt_pending'],[{status:'302'},'rejected'],[{status:'217'},'review_required']]){const x=fixture('55',options),r=await x.read();assert.equal(r.validation.evidence.outcome,outcome);assert.equal(r.processedBytes,null);assert.equal(r.validation.processed_hash,null);assert.equal(r.validation.evidence.signature_verified,false);assert.deepEqual(x.calls.validate,['response']);}
});
test('missing/corrupt bytes in each of four objects fail before releasing any result',async()=>{
 for(const position of [0,1,2,3])for(const missing of [true,false]){const x=fixture(),key=[...x.files.keys()][position];if(missing)x.files.delete(key);else x.files.set(key,Buffer.from('SYNTHETIC_PRIVATE_CORRUPTION'));await assert.rejects(x.read(),e=>!e.message.includes('SYNTHETIC_PRIVATE'));assert.equal(x.calls.command.length,1);}
});
test('sidecar must match persisted original context, review, response and pinned operational TLS even with a recomputed metadata hash',async()=>{
 for(const edit of [m=>m.command_id='f0000000-0000-4000-8000-000000000001',m=>m.candidate_id='f0000000-0000-4000-8000-000000000002',m=>m.request_hash='0'.repeat(64),m=>m.response_hash='0'.repeat(64),m=>m.subset_review_hash='0'.repeat(64),m=>m.tls_peer_verified=false,m=>m.tls_origin_verified=false,m=>m.tls_protocol='TLSv1.1',m=>m.server_trust_profile='unreviewed',m=>m.server_trust_anchor_sha256='0'.repeat(64),m=>m.origin='synthetic',m=>m.extra='PRIVATE',m=>m.received_at='not-a-time',m=>m.http_status=500]){
  const x=fixture();x.updateMeta(edit);await assert.rejects(x.read(),e=>/^AUTHORIZATION_STORED_RESPONSE_(JOURNAL_CONFLICT|SOAP_INVALID)$/.test(e.code));assert.equal(x.calls.validate.length,0);
 }
});
test('source is limited to consumed operational SOAP_INVALID terminal records and the exact actor/command',async()=>{
 for(const edit of [r=>r.receipt.origin='synthetic',r=>r.artifact.evidence.rejection_code='XSD_INVALID',r=>r.current.grant_consumed=false,r=>r.recovery.actor='f0000000-0000-4000-8000-000000000001',r=>r.rule_review.signed_hash='0'.repeat(64),r=>r.receipt.command_id='f0000000-0000-4000-8000-000000000002']){const x=fixture();edit(x.record);await assert.rejects(x.read());assert.equal(x.calls.read.length,0);}
});
test('real XSD rejects schema-invalid response, even when SOAP/context parser and all journal hashes match',async()=>{
 const x=fixture();x.updateRaw(Buffer.from(x.raw.toString().replaceAll('<verAplic>SINTETICO</verAplic>','<verAplic>'+ 'A'.repeat(21)+'</verAplic>')));await assert.rejects(x.read(),{code:'AUTHORIZATION_STORED_RESPONSE_XSD_INVALID'});assert.deepEqual(x.calls.validate,['response']);
});
test('cross-context response, swapped public-certificate pin and invalid signature are rejected',async()=>{
 const x=fixture();x.updateRaw(Buffer.from(x.raw.toString().replace(x.record.recovery.access_key,'9'.repeat(44))));await assert.rejects(x.read(),{code:'AUTHORIZATION_STORED_RESPONSE_SOAP_INVALID'});
 const y=fixture();y.record.recovery.certificate_fingerprint='0'.repeat(64);await assert.rejects(y.read(),{code:'AUTHORIZATION_PINNED_CERTIFICATE_INVALID'});
 const z=fixture(),bytes=Buffer.from(z.files.get(z.signedKey).toString().replace('<xNome>','<xNome>ALTERADO '));assert.notEqual(hash(bytes),z.record.recovery.signed_hash);
 // Update the signed byte pins too: cryptographic verification must still reject this tampered content.
 const old=z.record.recovery.signed_hash,next=hash(bytes);z.files.delete(z.signedKey);const key=z.signedKey.replace(old,next);z.files.set(key,bytes);for(const r of[z.record.receipt,z.record.recovery,z.record.rule_review])r.signed_hash=next;z.record.receipt.signed_size=bytes.length;z.record.recovery.signed_size=bytes.length;z.updateMeta(m=>m.signed_hash=next);
 await assert.rejects(z.read(),{code:'AUTHORIZATION_PINNED_CERTIFICATE_INVALID'});
});
test('validator may not mutate owned input, substitute hashes/models/pins or claim authorization for another protocol',async()=>{
 for(const edit of [(r)=>r.xmlDigest='0'.repeat(64),r=>r.model='65',r=>r.validatorHash='0'.repeat(64),r=>r.protocolCStat='150',r=>r.signatureVerified=true]){const x=fixture();await assert.rejects(x.read({validate:async(v,o)=>{const r=clone(await realValidate(v,o));edit(r);return r;}}),{code:'AUTHORIZATION_STORED_RESPONSE_VALIDATOR_INVALID'});}
 const x=fixture();await assert.rejects(x.read({validate:async(v,o)=>{const r=await realValidate(v,o);v.xmlBytes.fill(0);return r;}}),{code:'AUTHORIZATION_STORED_RESPONSE_VALIDATOR_INVALID'});
});
test('after all bytes/validation, command is reauthorized and immutable history is compared, not current A1/policy/review flags',async()=>{
 const x=fixture();let n=0;const out=await x.read({readCommand:async()=>{n++;const r=clone(x.record);if(n===2){r.current.identity_changed=true;r.current.a1_changed=true;r.current.policy_changed=true;r.current.policy_enabled=false;r.current.candidate.certificate_time_valid_now=false;r.current.candidate.artifact_current=false;}return r;}});assert.equal(n,2);assert.ok(out.processedBytes);out.processedBytes.fill(0);
 const y=fixture();n=0;await assert.rejects(y.read({readCommand:async()=>{if(++n===2)throw code('42501');return clone(y.record);}}),{code:'42501'});assert.equal(n,2);
 const z=fixture();n=0;await assert.rejects(z.read({readCommand:async()=>{const r=clone(z.record);if(++n===2)r.receipt.basis_hash='0'.repeat(64);return r;}}),{code:'AUTHORIZATION_STORED_RESPONSE_SOURCE_CHANGED'});
});
test('captures actor/command/options before await and refuses accessors or additional capabilities',async()=>{
 const x=fixture(),input={...x.input},options={},reader=createStoredResponseReader(x.ports),pending=reader(input,options);input.actor='f0000000-0000-4000-8000-000000000001';input.authorizationCommandId='f0000000-0000-4000-8000-000000000002';options.deadline=0;const out=await pending;assert.ok(out.processedBytes);out.processedBytes.fill(0);assert.deepEqual(x.calls.command,[x.input,x.input]);
 let invoked=0;const get={get actor(){invoked++;return actor;},authorizationCommandId:commandId};assert.throws(()=>reader(get));assert.equal(invoked,0);assert.throws(()=>createStoredResponseReader({...x.ports,transport(){invoked++;}}));assert.throws(()=>createStoredResponseReader({...x.ports,putImmutable(){invoked++;}}));assert.equal(invoked,0);
});
test('abort/deadline stop hung ports and late responses are canceled without releasing processed output',async()=>{
 const x=fixture(),abort=new AbortController(),reader=createStoredResponseReader({...x.ports,readCommand:()=>new Promise(()=>{})}),pending=reader(x.input,{signal:abort.signal,deadline:Date.now()+5000});abort.abort();await assert.rejects(pending,{code:'AUTHORIZATION_SERVICE_ABORTED'});
 let release,canceled=0;const y=fixture(),r=createStoredResponseReader({...y.ports,readObject:()=>new Promise(resolve=>{release=resolve;})});await assert.rejects(r(y.input,{deadline:Date.now()+15}),{code:'AUTHORIZATION_SERVICE_TIMEOUT'});release(new Response(new ReadableStream({cancel(){canceled++;}})));await new Promise(resolve=>setImmediate(resolve));assert.equal(canceled,1);assert.equal(y.calls.validate.length,0);
});
test('hash-consistent but altered original SOAP request cannot be reconstructed from the pinned candidate',async()=>{
 const x=fixture(),old=x.record.recovery.request_hash,keys=[x.path('requests'),x.path('responses'),x.path('observations')],wire=Buffer.from(x.files.get(keys[0]).toString().replace('<Body>','<Body> ')),next=hash(wire);
 x.updateMeta(m=>m.request_hash=next);x.files.set(keys[0],wire);
 x.record.recovery.request_hash=next;x.record.recovery.request_size=wire.length;x.record.artifact.evidence.request_hash=next;
 for(const k of keys){const b=x.files.get(k);x.files.delete(k);x.files.set(k.replace(old,next),b);}
 await assert.rejects(x.read(),{code:'AUTHORIZATION_STORED_RESPONSE_JOURNAL_CONFLICT'});assert.equal(x.calls.validate.length,0);
});
test('processed validator rejection and final ACL denial do not release output; validator-owned byte copies are erased',async()=>{
 const x=fixture(),copies=[];await assert.rejects(x.read({validate:async(v,o)=>{copies.push(v.xmlBytes);const r=await realValidate(v,o);return v.kind==='processed'?{...r,protocolCStat:'150'}:r;}}),{code:'AUTHORIZATION_STORED_RESPONSE_PROCESSED_INVALID'});assert.equal(copies.length,2);assert.ok(copies.every(b=>b.every(x=>x===0)));
 const y=fixture();let n=0;await assert.rejects(y.read({validate:async(v,o)=>{copies.push(v.xmlBytes);return realValidate(v,o);},readCommand:async()=>{if(++n===2)throw code('42501');return clone(y.record);}}),{code:'42501'});assert.ok(copies.every(b=>b.every(x=>x===0)));
});
test('object streams are size/deadline bounded and pending reader cleanup does not replace timeout',async()=>{
 const x=fixture();await assert.rejects(x.read({readObject:async()=>new Response(new Uint8Array(512001),{headers:{'content-type':'application/octet-stream'}})}),{code:'AUTHORIZATION_SERVICE_BODY_LIMIT'});
 const y=fixture(),reader=createStoredResponseReader({...y.ports,readObject:async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}),{headers:{'content-type':'application/octet-stream'}})});
 await assert.rejects(reader(y.input,{deadline:Date.now()+15}),{code:'AUTHORIZATION_SERVICE_TIMEOUT'});
});
test('untrusted exceptions and runner getters never expose messages or invoke diagnostic accessors',async()=>{
 const x=fixture();await assert.rejects(x.read({readObject:async()=>{throw Error('SYNTHETIC_PRIVATE_TOKEN');}}),{code:'AUTHORIZATION_STORED_RESPONSE_READ_FAILED'});
 let called=0;const y=fixture();await assert.rejects(y.read({readCommand:async()=>{throw{get code(){called++;throw Error('PRIVATE');}};}}),{code:'AUTHORIZATION_STORED_RESPONSE_READ_FAILED'});assert.equal(called,0);
 const z=fixture();await assert.rejects(z.read({validate:async()=>({get ok(){called++;return true;}})}),{code:'AUTHORIZATION_STORED_RESPONSE_VALIDATOR_INVALID'});assert.equal(called,0);
});
