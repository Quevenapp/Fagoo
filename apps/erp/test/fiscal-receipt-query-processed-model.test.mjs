import test from 'node:test';import assert from 'node:assert/strict';
import {receiptQueryProcessedReference} from '../src/lib/fiscal-receipt-query-processed-model.ts';
import {processedDocumentPath,processedReferenceKey,checkedProcessedDocument} from '../src/lib/fiscal-processed-document-model.ts';
import {publicSource,publicResult,uuid} from '../../../packages/fiscal-authorization/test/receipt-query-public-fixture.mjs';
import {FLAGS,downloadFilename} from '../../../packages/fiscal-danfe-runtime/src/processed-dto.mjs';
import {createHash} from 'node:crypto';
test('55/65 and both historical sources expose only the exact selected authorized089 receipt',()=>{
 for(const model of['55','65'])for(const kind of['authorization','revalidation'])for(const protocolCstat of['100','150']){
  const value=publicResult({source:publicSource({model,kind}),state:'authorized_homologation',protocolCstat}),ref=receiptQueryProcessedReference(value);
  assert.equal(ref.kind,'receipt_query');assert.equal(ref.model,model);assert.equal(ref.commandId,value.command_id);assert.equal(ref.authorizationCommandId,value.source.authorization_command_id);assert.equal(ref.resolutionHash,value.resolution.resolution_hash);assert.equal(ref.protocolCstat,protocolCstat);assert.ok(Object.isFrozen(ref));
  assert.equal(processedDocumentPath(ref,'xml'),`/v1/fiscal-danfe/receipt-queries/${value.command_id}/xml`);assert.equal(processedDocumentPath(ref,'print'),`/v1/fiscal-danfe/receipt-queries/${value.command_id}/print`);
 }
});
test('pending, rejected, review, conflict, malformed and nonselected observations offer no artifact reference',()=>{
 for(const state of['prepared','request_ready','dispatched','uncertain','receipt_pending','review_required','rejected','failed_before_dispatch'])assert.equal(receiptQueryProcessedReference(publicResult({state})),null,state);
 const a=publicResult({state:'authorized_homologation'});for(const mutate of[v=>{v.resolution={state:'conflict',resolution_hash:'a'.repeat(64),query_ids:[v.command_id,uuid(42)],selected_query_id:null,protocol:null};},v=>{v.resolution.query_ids.push(uuid(42));v.resolution.selected_query_id=uuid(42);},v=>{v.observation.processed_hash=null;},v=>{v.current.can_recover='false';},v=>{v.source.candidate_version++;},v=>{v.read_only=false;v.replayed=false;}]){const v=structuredClone(a);mutate(v);assert.equal(receiptQueryProcessedReference(v),null);}
 const later=publicResult({state:'receipt_pending',ordinal:2});later.resolution=a.resolution;assert.equal(receiptQueryProcessedReference(later),null);
});
test('resolution changes invalidate the reference while legacy reference keys and routes stay literal',()=>{
 const value=publicResult({state:'authorized_homologation'}),ref=receiptQueryProcessedReference(value),next={...ref,resolutionHash:'a'.repeat(64)};assert.notEqual(processedReferenceKey(ref),processedReferenceKey(next));
 const {resolutionHash,...base}=ref;for(const kind of['authorization','revalidation']){const legacy={...base,kind};assert.equal(processedReferenceKey(legacy),[kind,legacy.commandId,legacy.authorizationCommandId,legacy.attemptId,legacy.candidateId,legacy.candidateVersion,legacy.signedHash,legacy.model,legacy.processedHash,legacy.processedSize,legacy.protocolCstat,legacy.protocolNumber,legacy.protocolReceivedAt].join(':'));assert.equal(processedDocumentPath(legacy,'xml'),`/v1/fiscal-danfe/${kind==='authorization'?'authorizations':'revalidations'}/${legacy.commandId}/xml`);}
});
test('closed XML DTO must match resolution, processed bytes and protocol before browser use',async()=>{
 const value=publicResult({state:'authorized_homologation'}),bytes=Buffer.from('<nfeProc/>');value.observation.processed_hash=createHash('sha256').update(bytes).digest('hex');value.observation.processed_size=bytes.length;
 const ref=receiptQueryProcessedReference(value),source={source_kind:'receipt_query',source_command_id:ref.commandId,authorization_command_id:ref.authorizationCommandId,attempt_id:ref.attemptId,candidate_id:ref.candidateId,candidate_version:ref.candidateVersion,signed_hash:ref.signedHash,signed_size:value.source.signed_size,model:ref.model,environment:'2',processed_hash:ref.processedHash,processed_size:ref.processedSize,protocol:{cstat:ref.protocolCstat,number:ref.protocolNumber,received_at:ref.protocolReceivedAt},resolution_hash:ref.resolutionHash},raw={...FLAGS,action:'xml',source,xml_base64:bytes.toString('base64'),filename:downloadFilename(source)};
 assert.equal((await checkedProcessedDocument(raw,ref,'xml')).source.resolution_hash,ref.resolutionHash);
 for(const change of[s=>{s.resolution_hash='f'.repeat(64);},s=>{s.protocol.number='1'.repeat(s.protocol.number.length);},s=>{s.candidate_version++;},s=>{s.signed_hash='f'.repeat(64);},s=>{s.processed_hash='f'.repeat(64);}]){const bad=structuredClone(raw);change(bad.source);await assert.rejects(checkedProcessedDocument(bad,ref,'xml'));}
 const mutable={...ref},promise=checkedProcessedDocument(raw,mutable,'xml');mutable.resolutionHash='f'.repeat(64);assert.equal((await promise).source.resolution_hash,ref.resolutionHash);
});
