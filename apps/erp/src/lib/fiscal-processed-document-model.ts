import {publicProcessedResult,type ProcessedSourceKind,type ProcessedXml,type ProcessedPrint} from '../../../../packages/fiscal-danfe-runtime/src/processed-dto.mjs';
import type {DispatchResult} from './fiscal-reviewed-authorization-model';
import type {RevalidationResult} from './fiscal-stored-response-revalidation-model';
import type {SignedCandidate} from './fiscal-signed-model';
type ProcessedDocumentBaseReference=Readonly<{commandId:string;authorizationCommandId:string;attemptId:string;candidateId:string;candidateVersion:number;signedHash:string;model:'55'|'65';processedHash:string;processedSize:number;protocolCstat:'100'|'150';protocolNumber:string;protocolReceivedAt:string}>;
export type ProcessedDocumentReference=ProcessedDocumentBaseReference&(Readonly<{kind:Exclude<ProcessedSourceKind,'receipt_query'>}>|Readonly<{kind:'receipt_query';resolutionHash:string}>);
export const processedReferenceKey=(v:ProcessedDocumentReference)=>[v.kind,v.commandId,v.authorizationCommandId,v.attemptId,v.candidateId,v.candidateVersion,v.signedHash,v.model,v.processedHash,v.processedSize,v.protocolCstat,v.protocolNumber,v.protocolReceivedAt,...(v.kind==='receipt_query'?[v.resolutionHash]:[])].join(':');
export const processedDocumentPath=(v:ProcessedDocumentReference,action:'xml'|'print')=>`/v1/fiscal-danfe/${v.kind==='authorization'?'authorizations':v.kind==='revalidation'?'revalidations':'receipt-queries'}/${v.commandId}/${action}`;
const sameCandidate=(r:{candidate_id:string;candidate_version:number;signed_hash:string;model:'55'|'65'},c:SignedCandidate)=>r.candidate_id===c.candidate_id&&r.candidate_version===c.candidate_version&&r.signed_hash===c.artifact?.sha256&&r.model===c.model;
/** Only an already validated complete receipt supplies these references. The GET still enforces the original actor's ACL. */
export function processedAuthorizationReference(value:DispatchResult,candidate:SignedCandidate):ProcessedDocumentReference|null{
 const r=value.receipt,a=value.artifact;if(!r||value.status!=='authorized_homologation'||value.authorized_in_homologation!==true||r.origin!=='operational'||!a?.processed_hash||!a.processed_size||(a.protocol_cstat!=='100'&&a.protocol_cstat!=='150')||!a.protocol_number||!a.received_at||!sameCandidate(r,candidate))return null;
 return Object.freeze({kind:'authorization',commandId:value.command_id,authorizationCommandId:r.command_id,attemptId:r.attempt_id,candidateId:r.candidate_id,candidateVersion:r.candidate_version,signedHash:r.signed_hash,model:r.model,processedHash:a.processed_hash,processedSize:a.processed_size,protocolCstat:a.protocol_cstat,protocolNumber:a.protocol_number,protocolReceivedAt:new Date(a.received_at).toISOString()});
}
export function processedRevalidationReference(value:RevalidationResult,candidate:SignedCandidate):ProcessedDocumentReference|null{
 const r=value.receipt,a=r.artifact;if(r.state!=='authorized_homologation'||r.origin!=='operational'||!r.processed_hash||!r.processed_size||(a.protocol_cstat!=='100'&&a.protocol_cstat!=='150')||!a.protocol_number||!a.received_at||!sameCandidate(r,candidate))return null;
 return Object.freeze({kind:'revalidation',commandId:value.command_id,authorizationCommandId:r.authorization_command_id,attemptId:r.attempt_id,candidateId:r.candidate_id,candidateVersion:r.candidate_version,signedHash:r.signed_hash,model:r.model,processedHash:r.processed_hash,processedSize:r.processed_size,protocolCstat:a.protocol_cstat,protocolNumber:a.protocol_number,protocolReceivedAt:new Date(a.received_at).toISOString()});
}
/** Receipt binding is captured before the asynchronous digest. Never accept a source swap. */
export async function checkedProcessedDocument(raw:unknown,reference:ProcessedDocumentReference,action:'xml'|'print'):Promise<ProcessedXml|ProcessedPrint>{
 const r={...reference},value=await publicProcessedResult(raw,{sourceKind:r.kind,commandId:r.commandId,action}),s=value.source;
 if(s.authorization_command_id!==r.authorizationCommandId||s.attempt_id!==r.attemptId||s.candidate_id!==r.candidateId||s.candidate_version!==r.candidateVersion||s.signed_hash!==r.signedHash||s.model!==r.model||s.processed_hash!==r.processedHash||s.processed_size!==r.processedSize||s.protocol.cstat!==r.protocolCstat||s.protocol.number!==r.protocolNumber||s.protocol.received_at!==r.protocolReceivedAt||r.kind==='receipt_query'&&(s.source_kind!=='receipt_query'||s.resolution_hash!==r.resolutionHash))throw new Error('DANFE_SOURCE_MISMATCH');return value;
}
