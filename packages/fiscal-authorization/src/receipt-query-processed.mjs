/** Pure receipt-query candidate without a durable089 command identity. Does not persist/promote a DANFE, resolve the ledger or claim TLS/XSD. */
import {data,freeze} from './service-common.mjs';
import {receiptQuerySource} from './receipt-query-source.mjs';
import {assertReceiptQueryEvidence} from './receipt-core.mjs';
import {composeReceiptProcessedNfe} from './receipt-processed.mjs';
export function composeReceiptQueryProcessedNfe(input){
 const v=data(input,['source','request','response','responseBytes']),s=receiptQuerySource(v.source);
 assertReceiptQueryEvidence({evidence:s.evidence,request:v.request});
 const result=composeReceiptProcessedNfe({authorizationRequest:s.authorizationRequest,request:v.request,response:v.response,responseBytes:v.responseBytes});
 return freeze({...result,selectedSourceKind:s.source.source_kind,selectedSourceCommandId:s.source.source_command_id,
  authorizationAttemptId:s.source.authorization_attempt_id,sourceBindingHash:s.source.source_binding_hash,sourceProfile:s.validation.profile,sourceManifestHash:s.validation.manifest_hash});
}
