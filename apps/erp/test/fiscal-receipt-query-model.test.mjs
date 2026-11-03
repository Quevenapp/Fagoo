import test from 'node:test';import assert from 'node:assert/strict';
import {receiptQueryContext,receiptQueryHistory,receiptQueryIntent,receiptQueryResult,receiptQueryAuthorizationReference,receiptQueryRevalidationReference,receiptQueryReferenceKey} from '../src/lib/fiscal-receipt-query-model.ts';
import {receiptQueryFixture,publicResult,publicHistory,uuid} from './helpers/fiscal-receipt-query-fixtures.mjs';
import {candidate,result as originalResult} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {original,revalidated} from './helpers/fiscal-revalidation-fixtures.mjs';
test('references preserve exact source069 or079 and reject another candidate/original',()=>{
 for(const model of ['55','65']){
  const c=candidate(model),r=originalResult(c,{state:'receipt_pending'}),ref=receiptQueryAuthorizationReference(r,c);assert.equal(ref.source_kind,'authorization');assert.equal(ref.original.cstat,'103');assert.ok(Object.isFrozen(ref));
  const old=original(c),v=revalidated(old,undefined,true,'receipt_pending'),via=receiptQueryRevalidationReference(v,c,old);assert.equal(via.source_kind,'revalidation');assert.equal(via.original.cstat,null);assert.equal(via.original.state,'review_required');assert.equal(via.revalidation.cstat,'103');assert.notEqual(receiptQueryReferenceKey(ref),receiptQueryReferenceKey(via));
  assert.throws(()=>receiptQueryRevalidationReference({...v,receipt:{...v.receipt,attempt_id:uuid(999)}},c,old));assert.throws(()=>receiptQueryAuthorizationReference(r,{...c,candidate_version:c.candidate_version+1}));assert.equal(receiptQueryAuthorizationReference(originalResult(c,{state:'authorized_homologation'}),c),null);
 }
});
test('context matches immutable response, candidate/model/size and selected source before creating any intent',()=>{
 for(const kind of ['authorization','revalidation'])for(const model of ['55','65']){
  const s=receiptQueryFixture({kind,model}),raw=s.context(),c=receiptQueryContext(raw,s.reference),body=receiptQueryIntent(c,s.reference,uuid(11),true);assert.equal(body.expected_source_binding_hash,c.source.source_binding_hash);assert.ok(Object.isFrozen(body));
  for(const edit of [x=>x.candidate_version++,x=>x.signed_size++,x=>x.model=model==='55'?'65':'55',x=>x.original.response_hash='a'.repeat(64),x=>x.original.response_size++,x=>x.original.recorded_at='2026-10-17T00:00:00.000Z']){const r=structuredClone(s.reference);edit(r);assert.throws(()=>receiptQueryContext(raw,r));}
  assert.throws(()=>receiptQueryIntent(c,s.reference,uuid(11),false));assert.throws(()=>receiptQueryIntent(receiptQueryFixture({ready:false}).context(),s.reference,uuid(11),true));
 }
});
test('readback permits mutable current/resolution but fixes receipt/source and previously stored observation',()=>{
 const s=receiptQueryFixture(),body=receiptQueryIntent(s.context(),s.reference,uuid(11),true),ack=publicResult({source:s.source,readOnly:false,queryId:body.command_id,state:'dispatched'}),saved=publicResult({source:s.source,queryId:body.command_id,state:'receipt_pending'});
 const first=receiptQueryResult(ack,s.reference,body.command_id,{input:body,mode:'run'});assert.equal(receiptQueryResult(saved,s.reference,body.command_id,{input:body,previous:first}).current.state,'receipt_pending');
 for(const edit of [x=>x.receipt.identity_version++,x=>x.receipt.created_at='2026-10-17T12:00:00.001Z',x=>x.source.original.response_hash='a'.repeat(64),x=>x.observation.response_hash='f'.repeat(64)]){const bad=structuredClone(saved);edit(bad);assert.throws(()=>receiptQueryResult(bad,s.reference,body.command_id,{previous:saved}));}
 const page=publicHistory([saved]);assert.equal(receiptQueryHistory(page.raw,s.reference,page.binding.input).items[0].command_id,body.command_id);assert.throws(()=>receiptQueryHistory(page.raw,{...s.reference,authorization_attempt_id:uuid(99)},page.binding.input));
});
