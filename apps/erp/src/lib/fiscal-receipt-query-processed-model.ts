import {projectReceiptQueryPublic,type ReceiptQueryPublicResult} from '../../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import type {ProcessedDocumentReference} from './fiscal-processed-document-model';
/** Only a freshly read selected089 receipt offers files. The GET rechecks the current resolution and access. */
export function receiptQueryProcessedReference(value:ReceiptQueryPublicResult):ProcessedDocumentReference|null{
 let v:ReceiptQueryPublicResult;try{v=projectReceiptQueryPublic(value,{action:'receiptQueryCommand',commandId:value.command_id});}catch{return null;}
 const s=v.source,r=v.resolution,a=v.observation;
 if(v.current.state!=='authorized_homologation'||r.state!=='authorized_homologation'||r.selected_query_id!==v.command_id||!r.query_ids.includes(v.command_id)||!a?.processed_hash||!a.processed_size||!a.protocol_number||!a.received_at||(a.protocol_cstat!=='100'&&a.protocol_cstat!=='150'))return null;
 return Object.freeze({kind:'receipt_query',commandId:v.command_id,authorizationCommandId:s.authorization_command_id,attemptId:s.authorization_attempt_id,candidateId:s.candidate_id,candidateVersion:s.candidate_version,signedHash:s.signed_hash,model:s.model,processedHash:a.processed_hash,processedSize:a.processed_size,protocolCstat:a.protocol_cstat,protocolNumber:a.protocol_number,protocolReceivedAt:new Date(a.received_at).toISOString(),resolutionHash:r.resolution_hash});
}
