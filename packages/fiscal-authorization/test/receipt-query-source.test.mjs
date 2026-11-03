// Offline synthetic055/065, exact journal bytes and real local XSD. No network, database or private A1 read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {receiptFixture,receiptResponse} from './receipt-fixtures.mjs';
import {sourceFixture,realValidate} from './receipt-query-source-fixture.mjs';
import {hash,fiscalResponse} from './service-fixtures.mjs';
import {createReceiptQuerySource,receiptQuerySource,disposeReceiptQuerySource,RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from '../src/receipt-query-source.mjs';
import {authorizationReceiptDetails} from '../src/receipt-query-receipt.mjs';
import {prepareReceiptQuery,receiptRequestBytes,receiptValidationContext,parseReceiptResponse,assertReceiptResponse,createReceiptEvidenceReaderV2} from '../src/receipt-core.mjs';
import {composeReceiptQueryProcessedNfe} from '../src/receipt-query-processed.mjs';
import {projectReceiptQuerySource} from '../src/receipt-query-evidence.mjs';
let f;test.before(async()=>{f=await receiptFixture();});test.after(()=>f?.close());
const clone=structuredClone,code=c=>Object.assign(Error(c),{code:c});
const fixture=(...args)=>sourceFixture(f,...args);
test('55/65 both literal sources verify original four objects, public signature, SOAP, actual XSD and a second ACL read',async()=>{
 for(const model of ['55','65'])for(const kind of ['authorization','revalidation']){
  const x=fixture(model,kind),original=clone(x.source),files=[...x.files].map(([k,b])=>[k,hash(b)]),handle=await x.read(),r=receiptQuerySource(handle);
  assert.equal(r.source.source_kind,kind);assert.deepEqual(r.source,original);assert.deepEqual([...x.files].map(([k,b])=>[k,hash(b)]),files);
  assert.equal(r.source.original_source.artifact.evidence.outcome,kind==='authorization'?'receipt_pending':'invalid_response');
  assert.equal(r.source.selected_revalidation?.receipt.state??null,kind==='authorization'?null:'receipt_pending');
  assert.deepEqual(x.calls.validate,['response']);assert.equal(x.calls.read.length,4);assert.equal(x.calls.source.length,2);
  assert.equal(r.validation.tmed_seconds,1);assert.equal(r.tmedLiteral,'1');assert.equal(r.validation.signature_verified,true);assert.equal(r.validation.xsd_validated,true);assert.equal(r.validation.tls_origin_verified,true);
  for(const k of ['can_query','can_emit','can_transmit','tax_rules_validated'])assert.equal(r.validation[k],false);
  assert.equal(r.evidence.sourceKind,kind);assert.equal(r.evidence.commandId,x.input.authorizationCommandId);assert.equal(r.evidence.sourceCommandId,x.input.sourceCommandId);
  assert.ok(Object.isFrozen(r.source.original_source.artifact.evidence));assert.throws(()=>receiptQuerySource({...handle}),{code:'RECEIPT_QUERY_SOURCE_UNATTESTED'});disposeReceiptQuerySource(handle);assert.throws(()=>receiptQuerySource(handle));
 }
});
test('tMed accessor preserves literal zeroes, admits only parsed103 and never promotes capabilities',()=>{
 const x=fixture(),payload=fiscalResponse(x.request,{batch:'103',receipt:true,protocol:false});
 for(const literal of ['0','0001','9999']){const bytes=Buffer.from(payload.toString().replace('<tMed>1</tMed>',`<tMed>${literal}</tMed>`)),r=authorizationReceiptDetails({request:x.request,payloadBytes:bytes});assert.equal(r.tmed_literal,literal);assert.equal(r.tmed_seconds,Number(literal));assert.equal(r.payload_hash,hash(bytes));}
 for(const value of ['-1','1.0','10000',' 1','1 ', ''])assert.throws(()=>authorizationReceiptDetails({request:x.request,payloadBytes:Buffer.from(payload.toString().replace('<tMed>1</tMed>',`<tMed>${value}</tMed>`))}));
 for(const from of ['<tMed>1</tMed><tMed>1</tMed>','<x:tMed xmlns:x="urn:wrong">1</x:tMed>'])assert.throws(()=>authorizationReceiptDetails({request:x.request,payloadBytes:Buffer.from(payload.toString().replace('<tMed>1</tMed>',from))}));
 assert.throws(()=>authorizationReceiptDetails({request:{...x.request},payloadBytes:payload}));assert.throws(()=>authorizationReceiptDetails({request:x.request,payloadBytes:fiscalResponse(x.request)}));
});
test('sidecar observation time remains distinct from103 dhRecbto and the local reading time',async()=>{
 const x=fixture('65','revalidation');x.updateMeta(m=>m.received_at='2026-10-16T09:01:20-03:00');const r=receiptQuerySource(await x.read());assert.equal(r.validation.observed_at,'2026-10-16T12:01:20.000Z');assert.equal(r.validation.received_at,'2026-10-16T12:01:00.000Z');
});
test('legacy evidence timestamp remains the strict UTC DTO even when XML/sidecar use equivalent offsets',async()=>{
 const x=fixture();x.source.original_source.artifact.evidence.received_at='2026-10-16T09:01:00-03:00';await assert.rejects(x.read(),{code:'AUTHORIZATION_SERVICE_RESPONSE_INVALID'});assert.equal(x.calls.read.length,0);
});
test('source kinds cannot be relabeled or079 promoted to a fabricated pending064 record',async()=>{
 for(const kind of ['authorization','revalidation'])for(const edit of [s=>s.origin='synthetic',s=>s.authorization_attempt_id='f0000000-0000-4000-8000-000000000001',s=>s.source_command_id='f0000000-0000-4000-8000-000000000002',s=>s.original_source.recovery.actor=s.authorization_attempt_id,s=>s.original_source.rule_review.review_hash=null,s=>s.source_binding_hash='not-a-hash']){const x=fixture('55',kind);edit(x.source);await assert.rejects(x.read());assert.equal(x.calls.read.length,0);}
 const x=fixture('55','revalidation');x.source.original_source.artifact.evidence=clone(x.source.selected_revalidation.receipt.evidence);x.sync();await assert.rejects(x.read());assert.equal(x.calls.read.length,0);
 const y=fixture('55','authorization');y.source.selected_revalidation={receipt:{},source:{}};await assert.rejects(y.read());
});
test('selected079 state, parser pins, immutable source and proof context are independently bound',async()=>{
 for(const edit of [s=>s.selected_revalidation.receipt.parser_manifest_hash='0'.repeat(64),s=>s.selected_revalidation.receipt.state='authorized_homologation',s=>s.selected_revalidation.receipt.candidate_version++,s=>s.selected_revalidation.source.receipt.basis_hash='0'.repeat(64),s=>s.selected_revalidation.receipt.evidence.receipt_number='350000000000099']){
  const x=fixture('65','revalidation');edit(x.source);await assert.rejects(x.read());
 }
});
test('missing or corrupt bytes in each original object prevent source attestation',async()=>{
 for(const kind of ['authorization','revalidation'])for(const i of [0,1,2,3])for(const missing of [false,true]){const x=fixture('55',kind),key=[...x.files.keys()][i];if(missing)x.files.delete(key);else x.files.set(key,Buffer.from('SYNTHETIC_BAD_BYTES'));await assert.rejects(x.read(),e=>!e.message.includes('SYNTHETIC_BAD_BYTES'));assert.equal(x.calls.source.length,1);}
});
test('sidecar cannot substitute TLS, actor context, response or review even with newly computed metadata hashes',async()=>{
 for(const edit of [m=>m.tls_peer_verified=false,m=>m.tls_origin_verified=false,m=>m.server_trust_anchor_sha256='0'.repeat(64),m=>m.tls_protocol='TLSv1.1',m=>m.origin='synthetic',m=>m.command_id='f0000000-0000-4000-8000-000000000001',m=>m.subset_review_hash='0'.repeat(64),m=>m.http_status=500,m=>m.response_hash='0'.repeat(64),m=>m.extra=true]){const x=fixture('55','revalidation');x.updateMeta(edit);await assert.rejects(x.read());assert.equal(x.calls.validate.length,0);}
});
test('request reconstruction and public certificate fingerprint are verified without current A1',async()=>{
 const x=fixture();x.source.original_source.recovery.certificate_fingerprint='0'.repeat(64);await assert.rejects(x.read(),{code:'AUTHORIZATION_PINNED_CERTIFICATE_INVALID'});
 const y=fixture('55','revalidation'),c=y.source.original_source.recovery,old=c.request_hash,oldkeys=[y.path('requests'),y.path('responses'),y.path('observations')],wire=Buffer.from(y.files.get(oldkeys[0]).toString().replace('<Body>','<Body> ')),next=hash(wire);
 y.updateMeta(m=>m.request_hash=next);y.files.set(oldkeys[0],wire);c.request_hash=next;c.request_size=wire.length;y.source.original_source.artifact.evidence.request_hash=next;y.selectedEvidence.request_hash=next;y.sync();for(const k of oldkeys){const b=y.files.get(k);y.files.delete(k);y.files.set(k.replace(old,next),b);}
 await assert.rejects(y.read(),{code:'RECEIPT_QUERY_SOURCE_JOURNAL_CONFLICT'});assert.equal(y.calls.validate.length,0);
});
test('real XSD and exact payload pins reject structurally parseable invalid schema or substituted103',async()=>{
 const x=fixture('55','revalidation');x.updateRaw(Buffer.from(x.raw.toString().replace('<verAplic>SINTETICO</verAplic>','<verAplic>'+ 'A'.repeat(21)+'</verAplic>')));await assert.rejects(x.read(),{code:'RECEIPT_QUERY_SOURCE_XSD_INVALID'});
 const y=fixture('55','revalidation');y.updateRaw(Buffer.from(y.raw.toString().replace('350000000000001','350000000000002')));await assert.rejects(y.read(),{code:'RECEIPT_QUERY_SOURCE_CONTEXT_MISMATCH'});
});
test('fresh ACL and entire immutable source are checked after all object and validator waits',async()=>{
 for(const kind of ['authorization','revalidation']){
  const x=fixture('55',kind);let n=0;await assert.rejects(x.read({readSource:async()=>{if(++n===2)throw code('42501');return clone(x.source);}}),{code:'42501'});assert.equal(n,2);
  const y=fixture('55',kind);n=0;await assert.rejects(y.read({readSource:async()=>{const r=clone(y.source);if(++n===2)r.source_binding_hash='0'.repeat(64);return r;}}),{code:'RECEIPT_QUERY_SOURCE_SOURCE_CHANGED'});
 }
});
test('configuration, input and options are captured before waits; getters and extra ports are rejected',async()=>{
 const x=fixture(),input={...x.input},options={},reader=createReceiptQuerySource(x.ports),p=reader(input,options);input.actor='0'.repeat(36);options.deadline=0;await p;assert.deepEqual(x.calls.source,[x.input,x.input]);
 let calls=0;assert.throws(()=>reader({...x.input,get actor(){calls++;return x.input.actor;}}));assert.throws(()=>createReceiptQuerySource({...x.ports,putImmutable(){calls++;}}));assert.equal(calls,0);
 const y=fixture();await assert.rejects(y.read({readSource:async()=>{throw{get code(){calls++;return '42501';}};}}),{code:'RECEIPT_QUERY_SOURCE_READ_FAILED'});assert.equal(calls,0);
});
test('deadlines/abort bound reads and late Storage bodies are canceled without awaiting cleanup',async()=>{
 const x=fixture(),ac=new AbortController(),r=createReceiptQuerySource({...x.ports,readSource:()=>new Promise(()=>{})}),pending=r(x.input,{signal:ac.signal});ac.abort();await assert.rejects(pending,{code:'AUTHORIZATION_SERVICE_ABORTED'});
 let resolve,canceled=0;const y=fixture(),p=y.read({readObject:()=>new Promise(r=>{resolve=r;})},{deadline:Date.now()+15});await assert.rejects(p,{code:'AUTHORIZATION_SERVICE_TIMEOUT'});resolve(new Response(new ReadableStream({cancel(){canceled++;return new Promise(()=>{});}})));await new Promise(r=>setImmediate(r));assert.equal(canceled,1);
 const z=fixture();await assert.rejects(z.read({readObject:async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}),{headers:{'content-type':'application/octet-stream'}})},{deadline:Date.now()+15}),{code:'AUTHORIZATION_SERVICE_TIMEOUT'});
});
test('validator outputs are bounded to fixed pins and cannot mutate byte copies or escape cleanup after failure',async t=>{
 for(const edit of [r=>r.validatorHash='0'.repeat(64),r=>r.cStat='104',r=>r.protocolCStat='100',r=>r.signatureVerified=true,r=>r.model='65']){const x=fixture();await assert.rejects(x.read({validate:async(v,o)=>{const r=clone(await realValidate(v,o));edit(r);return r;}}),{code:'RECEIPT_QUERY_SOURCE_VALIDATOR_INVALID'});}
 let held;const y=fixture();await assert.rejects(y.read({validate:async(v,o)=>{held=v.xmlBytes;const r=await realValidate(v,o);v.xmlBytes.fill(0);return r;}}),{code:'RECEIPT_QUERY_SOURCE_VALIDATOR_INVALID'});assert.ok(held.every(x=>x===0));
 // Enter the validator before advancing its deadline: certificate parsing may
 // legitimately take longer than20ms on a busy test host.
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 try{
  let release,entered;const reached=new Promise(r=>{entered=r;}),z=fixture();
  const pending=z.read({validate:v=>{held=v.xmlBytes;entered();return new Promise(r=>{release=r;});}},{deadline:Date.now()+20});
  const timedOut=assert.rejects(pending,{code:'AUTHORIZATION_SERVICE_TIMEOUT'});
  await reached;t.mock.timers.tick(21);await timedOut;
  assert.ok(held.every(x=>x===0));release({});
 }finally{t.mock.timers.reset();}
});
test('dual-query provenance and processed candidate preserve exact NFe bytes; equal query hashes do not interchange handles',async()=>{
 for(const model of ['55','65'])for(const kind of ['authorization','revalidation']){
  const x=fixture(model,kind),h=await x.read(),s=receiptQuerySource(h),q=prepareReceiptQuery({evidence:s.evidence}),q2=prepareReceiptQuery({evidence:s.evidence});assert.equal(q.requestHash,q2.requestHash);assert.equal(q.sourceKind,kind);assert.ok(receiptRequestBytes(q).includes(Buffer.from(s.validation.receipt_number)));
  for(const batch of ['105','104']){const bytes=receiptResponse({...q,...receiptValidationContext(q)},{batch}),response=parseReceiptResponse({request:q,responseBytes:bytes});assert.equal(response.classification,batch==='105'?'receipt_pending':'authorization_declared');assert.throws(()=>assertReceiptResponse({request:q2,response}));
   if(batch==='105')assert.throws(()=>composeReceiptQueryProcessedNfe({source:h,request:q,response,responseBytes:bytes}));
   else{const p=composeReceiptQueryProcessedNfe({source:h,request:q,response,responseBytes:bytes});assert.equal(Object.hasOwn(p,'sourceKind'),false);assert.equal(Object.hasOwn(p,'sourceCommandId'),false);assert.equal(p.selectedSourceKind,kind);assert.equal(p.selectedSourceCommandId,x.input.sourceCommandId);assert.ok(Buffer.from(p.processedXml).includes(x.files.get(x.signedKey)));assert.equal(p.processedHash,hash(p.processedXml));assert.equal(p.signatureVerified,true);assert.equal(p.xsdValidated,false);assert.equal(p.tlsOriginVerified,false);assert.equal(p.canTransmit,false);
    const report=await realValidate({request:s.authorizationRequest,xmlBytes:Buffer.from(p.processedXml),kind:'processed'},{});assert.equal(report.ok,true);assert.throws(()=>composeReceiptQueryProcessedNfe({source:h,request:q,response,responseBytes:Buffer.from('invalid')}));
   }
  }
  const other=await x.read();const bytes=receiptResponse({...q,...receiptValidationContext(q)}),response=parseReceiptResponse({request:q,responseBytes:bytes});assert.throws(()=>composeReceiptQueryProcessedNfe({source:other,request:q,response,responseBytes:bytes}),{code:'RECEIPT_QUERY_SOURCE_MISMATCH'});
 }
});
test('V2 evidence factory refuses unbound payload and source while keeping original064 API distinct',async()=>{
 const x=fixture(),source=projectReceiptQuerySource(x.source,x.input),payload=fiscalResponse(x.request,{batch:'103',receipt:true,protocol:false});
 const reader=createReceiptEvidenceReaderV2({readReceipt:async()=>({source,payloadBytes:Buffer.from(payload.toString().replace('350000000000001','350000000000099'))})});await assert.rejects(reader({request:x.request,...x.input}),{code:'RECEIPT_SOURCE_CONTEXT_MISMATCH'});
 const valid=receiptQuerySource(await x.read());assert.throws(()=>prepareReceiptQuery({evidence:{...valid.evidence}}),{code:'RECEIPT_EVIDENCE_UNATTESTED'});
});
test('manifest hashes all versioned implementations while retaining unchanged079 parser pins',async()=>{
 assert.ok(RECEIPT_QUERY_SOURCE_MANIFEST.files.length>=4);for(const p of RECEIPT_QUERY_SOURCE_MANIFEST.files)assert.equal(hash(await readFile(new URL('../../../'+p.path,import.meta.url))),p.sha256,p.path);assert.equal(RECEIPT_QUERY_SOURCE_MANIFEST_HASH,hash(JSON.stringify(RECEIPT_QUERY_SOURCE_MANIFEST)));
 const pinned=await import('../src/stored-response-manifest.mjs');for(const p of pinned.STORED_RESPONSE_MANIFEST.files)assert.equal(hash(await readFile(new URL('../../../'+p.path,import.meta.url))),p.sha256,p.path);
});
