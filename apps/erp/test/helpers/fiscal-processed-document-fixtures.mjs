import {processedFixtures} from '../../../../packages/fiscal-danfe-runtime/test/processed-fixtures.mjs';
import {createProcessedSource,processedSource,disposeProcessedSource} from '../../../../packages/fiscal-danfe-runtime/src/processed-source.mjs';
import {renderProcessedHtml} from '../../../../packages/fiscal-danfe/src/processed-render.mjs';
import {FLAGS,downloadFilename,publicProcessedResult} from '../../../../packages/fiscal-danfe-runtime/src/processed-dto.mjs';
import {dispatchResult} from '../../../../packages/fiscal-authorization/src/dispatch-dto.mjs';
import {revalidationPublicFromLedger} from '../../../../packages/fiscal-authorization/src/revalidation-dto.mjs';
import {authorizationQaCandidate} from '../../src/qa/authorization-fixture.ts';
export async function processedUiFixtures(){
 const f=await processedFixtures();return{close:()=>f.close(),async create(model='55',kind='authorization'){
  const x=f.create(model,kind),h=await createProcessedSource(x.ports)(x.input),owned=processedSource(h),source=owned.metadata;
  try{const p=renderProcessedHtml(h),xml=await publicProcessedResult({...FLAGS,action:'xml',source,xml_base64:Buffer.from(owned.processedBytes).toString('base64'),filename:downloadFilename(source)},{sourceKind:kind,commandId:x.input.commandId,action:'xml'});
   const print=await publicProcessedResult({...FLAGS,action:'print',source,html:p.html,html_sha256:p.sha256,html_size_bytes:Buffer.byteLength(p.html),page_count:p.page_count,profile:p.profile},{sourceKind:kind,commandId:x.input.commandId,action:'print'});
   const reference={kind,commandId:source.source_command_id,authorizationCommandId:source.authorization_command_id,attemptId:source.attempt_id,candidateId:source.candidate_id,candidateVersion:source.candidate_version,signedHash:source.signed_hash,model,processedHash:source.processed_hash,processedSize:source.processed_size,protocolCstat:source.protocol.cstat,protocolNumber:source.protocol.number,protocolReceivedAt:source.protocol.received_at};
   const candidate=authorizationQaCandidate(model),r=x.original.receipt;
   Object.assign(candidate,{candidate_id:r.candidate_id,candidate_version:r.candidate_version,unsigned_job_id:r.unsigned_job_id,basis_hash:r.basis_hash,completion_version:r.completion_version,completion_hash:r.completion_hash,a1_version:r.signing_a1_version});candidate.artifact={...candidate.artifact,sha256:r.signed_hash,size_bytes:r.signed_size};
   const original=dispatchResult(kind==='authorization'?x.record:x.original,{readOnly:true}),revalidation=kind==='revalidation'?revalidationPublicFromLedger(x.record,{action:'revalidationCommand',commandId:x.input.commandId}):null;
   return{xml,print,reference,actor:x.input.actor,candidate,original,revalidation};
  }finally{owned.signedBytes.fill(0);owned.processedBytes.fill(0);disposeProcessedSource(h);}
 }};
}
