import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createReceiptEvidenceReader,prepareReceiptQuery,receiptRequestBytes,receiptValidationContext,parseReceiptResponse,assertReceiptResponse,RECEIPT_FLAGS} from '../src/receipt-core.mjs';
import {RECEIPT_MANIFEST} from '../src/receipt-manifest.mjs';
import {receiptFixture,receiptResponse,hash,actor} from './receipt-fixtures.mjs';
let f;before(async()=>{f=await receiptFixture();});after(()=>f?.close());
const rejects=(work,code)=>assert.rejects(work,e=>e.code===code);
const throws=(work,code)=>assert.throws(work,e=>e.code===code);
const response=(x,q,o={})=>receiptResponse({...q,...receiptValidationContext(q)},o);
const reader=x=>createReceiptEvidenceReader({readReceipt:async()=>x.answer()});
test('55/65: source103 proof, private envelope hash distinct from payload, derived receipt and immutable false flags',async()=>{
 for(const model of ['55','65']){const x=f.create(model),e=await x.read(),q=prepareReceiptQuery({evidence:e});
  assert.equal(e.model,model);assert.equal(e.origin,'synthetic');assert.equal(e.sourceState,'receipt_pending');assert.notEqual(e.authorizationRequestHash,e.authorizationPayloadHash);
  assert.equal(receiptRequestBytes(q).toString(),'<consReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><nRec>350000000000001</nRec></consReciNFe>');
  const copy=receiptRequestBytes(q);copy.fill(0);assert.notEqual(receiptRequestBytes(q)[0],0);
  for(const [k,v]of Object.entries(RECEIPT_FLAGS)){assert.equal(q[k],v);assert.equal(e[k],v);}assert.ok(Object.isFrozen(e)&&Object.isFrozen(q));
 }
});
test('free receipt, cloned/Proxy evidence and getters are rejected before invocation',async()=>{
 let touched=0;const x=f.create(),e=await x.read();
 for(const value of ['350000000000001',{...e},new Proxy(e,{get(){touched++;throw Error();}})])throws(()=>prepareReceiptQuery({evidence:value}),'RECEIPT_EVIDENCE_UNATTESTED');
 const fake={get model(){touched++;return'55';}};await rejects(()=>reader(x)({...x.input,request:fake}),'RECEIPT_AUTHORIZATION_UNATTESTED');
 throws(()=>createReceiptEvidenceReader({get readReceipt(){touched++;}}),'RECEIPT_INPUT_INVALID');assert.equal(touched,0);
});
test('actor/command/candidate/model/hash/batch and key/digest mismatches are rejected',async()=>{
 const cases=[r=>r.recovery.actor='10000000-0000-4000-8000-000000000099',r=>r.receipt.command_id='30000000-0000-4000-8000-000000000099',r=>r.receipt.candidate_id='20000000-0000-4000-8000-000000000099',r=>{r.receipt.model='65';r.recovery.model='65';},r=>{r.receipt.signed_hash='f'.repeat(64);r.recovery.signed_hash=r.receipt.signed_hash;},r=>{r.receipt.batch_id='9';r.receipt.ordinal='9';r.recovery.batch_id='9';},r=>r.recovery.reference_digest=Buffer.alloc(20,1).toString('base64')];
 for(const mutate of cases){const x=f.create();mutate(x.record);await assert.rejects(()=>reader(x)(x.input),e=>/^RECEIPT_(BACKEND_EVIDENCE_INVALID|SOURCE_CONTEXT_MISMATCH)$/.test(e.code));}
});
test('payload hash, original103 receipt and received timestamp are mandatory, caller source bytes unchanged',async()=>{
 const x=f.create(),saved=Buffer.from(x.source);x.source[10]^=1;await rejects(()=>reader(x)(x.input),'RECEIPT_SOURCE_HASH_MISMATCH');saved.copy(x.source);
 x.record.artifact.evidence.receipt_number='350000000000002';await rejects(()=>reader(x)(x.input),'RECEIPT_SOURCE_CONTEXT_MISMATCH');
 x.record.artifact.evidence.receipt_number='350000000000001';x.record.artifact.evidence.received_at='2026-10-16T12:01:01.000Z';await rejects(()=>reader(x)(x.input),'RECEIPT_SOURCE_CONTEXT_MISMATCH');
 assert.deepEqual(x.source,saved);
});
test('current A1/base/policy changes do not erase historical103 or alter source evidence hash',async()=>{
 const x=f.create(),a=await x.read();Object.assign(x.record.current,{a1_changed:true,identity_changed:true,policy_changed:true});Object.assign(x.record.current.candidate,{a1_version:3,a1_changed:true,artifact_current:false,basis_changed:true});const b=await x.read();assert.equal(a.sourceEvidenceHash,b.sourceEvidenceHash);assert.equal(b.sourceState,'receipt_pending');
});
test('source other than103 cannot mint a handle, even a terminal record',async()=>{
 const x=f.create();x.record.current.state='review_required';Object.assign(x.record.artifact.evidence,{outcome:'review_required',cstat:'217',receipt_number:null});await rejects(()=>reader(x)(x.input),'RECEIPT_SOURCE_NOT_PENDING');
});
test('bounded read captures actor and options before await; late port cannot bypass abort/deadline',async()=>{
 const x=f.create();let resolve,observed;const wait=new Promise(r=>resolve=r),input={...x.input};
 const read=createReceiptEvidenceReader({readReceipt:async(q,o)=>{observed={q,o};await wait;return x.answer();}});const p=read(input);input.actor='10000000-0000-4000-8000-000000000099';await Promise.resolve();resolve();const got=await p;assert.equal(got.actor,actor);assert.equal(observed.q.actor,actor);assert.equal(observed.o.maxRecordBytes,131072);
 const ac=new AbortController(),blocked=createReceiptEvidenceReader({readReceipt:()=>new Promise(()=>{})});const pending=blocked(x.input,{signal:ac.signal});ac.abort();await rejects(()=>pending,'RECEIPT_ABORTED');
 await rejects(()=>blocked(x.input,{deadline:Date.now()+10}),'RECEIPT_DEADLINE_EXCEEDED');
 await rejects(()=>read(x.input,{deadline:Date.now()-1}),'RECEIPT_DEADLINE_EXCEEDED');
});
test('reader rejects accessors, oversized or shared bytes, malformed JSON and UTF8',async()=>{
 const x=f.create();for(const answer of [{recordBytes:Buffer.alloc(131073),payloadBytes:x.source},{recordBytes:new Uint8Array(new SharedArrayBuffer(20)),payloadBytes:x.source},{recordBytes:Buffer.from('{'),payloadBytes:x.source},{recordBytes:Buffer.from([255]),payloadBytes:x.source},{get recordBytes(){throw Error('MUST NOT RUN');},payloadBytes:x.source}])await assert.rejects(()=>createReceiptEvidenceReader({readReceipt:async()=>answer})(x.input),e=>['RECEIPT_BYTES_INVALID','RECEIPT_BACKEND_EVIDENCE_INVALID','RECEIPT_INPUT_INVALID'].includes(e.code));
});
test('105 pending;106/217/204/539/unknown review; original source always remains receipt_pending',async()=>{
 const x=f.create(),q=await x.query();for(const c of ['105','106','217','204','539','999']){const r=parseReceiptResponse({request:q,responseBytes:response(x,q,{batch:c})});assert.equal(r.classification,c==='105'?'receipt_pending':'review_required');assert.equal(r.sourceState,'receipt_pending');assert.equal(r.retrySubmissionAllowed,false);}
});
test('104 binds exactly one original candidate;100/150 remain declarations, rejection distinct from duplicate',async()=>{
 for(const model of ['55','65']){const x=f.create(model),q=await x.query();for(const status of ['100','150','215','204','539','217']){const r=parseReceiptResponse({request:q,responseBytes:response(x,q,{status})});assert.equal(r.classification,['100','150'].includes(status)?'authorization_declared':['204','539','217'].includes(status)?'review_required':'rejected');assert.equal(r.origin,'synthetic');assert.equal(r.sefazAuthorized,false);assert.equal(r.canTransmit,false);}}
});
test('divergent receipt/key/digest/environment, wrong calendar and incomplete protocol fail closed',async()=>{
 const x=f.create(),q=await x.query(),xml=response(x,q).toString();const cases=[['<nRec>350000000000001','<nRec>350000000000002'],['<tpAmb>2','<tpAmb>1'],['<cUF>35','<cUF>33'],[q.receiptNumber,q.receiptNumber+'0'],[x.request.accessKey,'9'.repeat(44)],[x.request.referenceDigest,Buffer.alloc(20).toString('base64')],['2026-10-16T09:01:00-03:00','2026-02-30T09:01:00-03:00'],['<nProt>13526000000000001</nProt>',''],['2026-10-16T09:01:00-03:00','2026-10-15T09:01:00-03:00']];for(const[a,b]of cases)assert.throws(()=>parseReceiptResponse({request:q,responseBytes:Buffer.from(xml.replace(a,b))}));
});
test('multiple protocols are never searched for a matching candidate, and protocols on105 are invalid',async()=>{
 const x=f.create(),q=await x.query(),xml=response(x,q).toString(),protocol=xml.match(/<protNFe[\s\S]+<\/protNFe>/)[0];
 throws(()=>parseReceiptResponse({request:q,responseBytes:Buffer.from(xml.replace('</retConsReciNFe>',protocol+'</retConsReciNFe>'))}),'RECEIPT_SINGLE_CANDIDATE_REQUIRED');
 throws(()=>parseReceiptResponse({request:q,responseBytes:response(x,q,{batch:'105',protocol:true})}),'RECEIPT_BATCH_STRUCTURE_MISMATCH');
});
test('parser rejects wrong namespaces/attrs, DTD/wrapping, shared/oversized bytes and unbranded requests',async()=>{
 const x=f.create(),q=await x.query(),xml=response(x,q).toString();for(const changed of [xml.replace('<infProt>','<infProt xmlns="urn:wrong">'),xml.replace('<protNFe ','<protNFe untrusted="x" '),xml.replace('<retConsReciNFe ','<retConsReciNFe extra="1" '),'<!DOCTYPE x>'+xml,'<wrapper>'+xml+'</wrapper>',xml.replace('<cStat>104','<cStat>104</cStat><cStat>104')])assert.throws(()=>parseReceiptResponse({request:q,responseBytes:Buffer.from(changed)}));
 throws(()=>parseReceiptResponse({request:q,responseBytes:new Uint8Array(new SharedArrayBuffer(10))}),'RECEIPT_BYTES_INVALID');throws(()=>parseReceiptResponse({request:q,responseBytes:Buffer.alloc(512001)}),'RECEIPT_BYTES_INVALID');throws(()=>parseReceiptResponse({request:{...q},responseBytes:Buffer.from(xml)}),'RECEIPT_QUERY_UNATTESTED');
});
test('manifest pins exact independently observed55/65 WSDL bytes; never authorization65 inferred',{skip:process.env.FAGOO_TEST_LOCAL_RECEIPT_WSDL!=='1'},async()=>{
 for(const b of RECEIPT_MANIFEST.bindings){const path=fileURLToPath(new URL(`../../../private/fiscal/wsdl/model-${b.model}-receipt-20261016.xml`,import.meta.url));const bytes=await readFile(path);assert.equal(bytes.length,b.wsdl.sizeBytes);assert.equal(hash(bytes),b.wsdl.sha256);const s=bytes.toString();assert.ok(s.includes(b.endpoint)&&s.includes(b.soapAction));}assert.ok(Object.isFrozen(RECEIPT_MANIFEST.bindings[0]));
});
test('deadline is rechecked after parsing/hash work and port errors never expose private text',async()=>{
 const x=f.create(),originalNow=Date.now,originalParse=JSON.parse;let expired=false;
 try{const now=originalNow();Date.now=()=>expired?now+10001:now;JSON.parse=(...args)=>{const value=originalParse(...args);expired=true;return value;};await rejects(()=>reader(x)(x.input,{deadline:now+10000}),'RECEIPT_DEADLINE_EXCEEDED');}finally{Date.now=originalNow;JSON.parse=originalParse;}
 await rejects(()=>createReceiptEvidenceReader({readReceipt:async()=>{throw new Error('PRIVATE_RECORD_DO_NOT_EXPOSE');}})(x.input),'RECEIPT_BACKEND_READ_FAILED');
});
test('timeout and cancellation abort the injected read; operational origin cannot be fabricated with synthetic proof',async()=>{
 const x=f.create();let portSignal;const read=createReceiptEvidenceReader({readReceipt:(_q,o)=>{portSignal=o.signal;return new Promise(()=>{});}});await rejects(()=>read(x.input,{deadline:Date.now()+10}),'RECEIPT_DEADLINE_EXCEEDED');assert.equal(portSignal.aborted,true);
 x.record.receipt.origin='operational';x.record.recovery.origin='operational';x.record.artifact.evidence.origin='operational';await rejects(()=>reader(x)(x.input),'RECEIPT_BACKEND_EVIDENCE_INVALID');
});
test('receipt is textual including leading zeros; source receipt cannot be changed by free builder options',async()=>{
 const x=f.create(),receipt='000000000000001';x.source=Buffer.from(x.source.toString().replace('350000000000001',receipt));
 // This fixture answers from lexical storage bytes; it does not normalize through Number.
 const raw=structuredClone(x.record);Object.assign(raw.artifact,{response_hash:hash(x.source),response_size:x.source.length});Object.assign(raw.artifact.evidence,{receipt_number:receipt,response_hash:hash(x.source),payload_hash:hash(x.source)});
 const evidence=await createReceiptEvidenceReader({readReceipt:async()=>({recordBytes:Buffer.from(JSON.stringify(raw)),payloadBytes:x.source})})(x.input);
 const q=prepareReceiptQuery({evidence});assert.equal(q.receiptNumber,receipt);assert.match(receiptRequestBytes(q).toString(),/<nRec>000000000000001<\/nRec>/);throws(()=>prepareReceiptQuery({evidence,receiptNumber:'350000000000001'}),'RECEIPT_INPUT_INVALID');
});

test('parsed result is attested to its exact query handle, not cloned metadata',async()=>{
 const x=f.create(),q=await x.query(),r=parseReceiptResponse({request:q,responseBytes:response(x,q)});assert.equal(assertReceiptResponse({request:q,response:r}),r);const other=await x.query();throws(()=>assertReceiptResponse({request:other,response:r}),'RECEIPT_RESPONSE_UNATTESTED');let touched=0;throws(()=>assertReceiptResponse({request:q,response:new Proxy(r,{get(){touched++;throw Error();}})}),'RECEIPT_RESPONSE_UNATTESTED');throws(()=>assertReceiptResponse({request:q,response:{...r}}),'RECEIPT_RESPONSE_UNATTESTED');assert.equal(touched,0);
});
