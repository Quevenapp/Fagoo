/** Browser-safe089 contract. Private ledger/source projectors must run before server projection. */
export const RECEIPT_QUERY_PUBLIC_PROFILE:'receipt-query-public-089-v1';
export const RECEIPT_QUERY_SOURCE_PROFILE:'receipt-query-source-089-v1';
export const RECEIPT_QUERY_SOURCE_MANIFEST_HASH:string;
export const MAX_RECEIPT_QUERY_INPUT_BYTES:16384;
export const MAX_RECEIPT_QUERY_PUBLIC_BYTES:262144;
export const RECEIPT_QUERY_PUBLIC_FLAGS:Readonly<{
 data_mode:'fiscal_receipt_query';profile:'receipt-query-public-089-v1';environment:'2';
 tax_rules_validated:false;can_emit:false;can_transmit:false;production_authorized:false;
 financial_mutation_performed:false;stock_mutation_performed:false;retry_submission_allowed:false;
}>;
export class ReceiptQueryPublicError extends Error {readonly code:string;constructor(code?:string)}
export type ReceiptQueryPublicSourceKind='authorization'|'revalidation';
export type ReceiptQueryPublicState='prepared'|'request_ready'|'dispatched'|'uncertain'|'failed_before_dispatch'|'receipt_pending'|'rejected'|'review_required'|'authorized_homologation';
export type ReceiptQueryPublicRejection='SOAP_FAULT'|'SOAP_INVALID'|'XML_INVALID'|'XSD_INVALID'|'CONTEXT_MISMATCH'|'DIGEST_MISMATCH'|'PROCESSED_INVALID';
export type ReceiptQueryPublicBlocker='SOURCE_VALIDATION_REQUIRED'|'POLICY_DISABLED'|'POLICY_TIME_INVALID'|'POLICY_PROFILE_INVALID'|'IDENTITY_MISMATCH'|'A1_UNAVAILABLE'|'A1_INVALID'|'A1_STORAGE_INVALID'|'RESOLUTION_CLOSED'|'QUERY_ACTIVE'|'CADENCE_REQUIRED'|'RATE_LIMIT'|'RUNTIME_DISABLED';
export type ReceiptQueryPublicErrorCode='RECEIPT_QUERY_PREPARATION_FAILED'|'RECEIPT_QUERY_CUSTODY_FAILED'|'RECEIPT_QUERY_TRANSPORT_FAILED'|'RECEIPT_QUERY_TRANSPORT_TIMEOUT'|'RECEIPT_QUERY_STORAGE_FAILED'|'RECEIPT_QUERY_RESULT_UNCONFIRMED'|'RECEIPT_QUERY_CANCELLED';
export type ReceiptQueryContextInput=Readonly<{source_kind:ReceiptQueryPublicSourceKind;source_command_id:string;expected_attempt_id:string}>;
export type ReceiptQueryHistoryInput=Readonly<{authorization_command_id:string;expected_attempt_id:string;limit:number;before:number|null}>;
export type ReceiptQueryPublicSelection=Readonly<{
 source_kind:ReceiptQueryPublicSourceKind;source_command_id:string;expected_authorization_command_id:string;
 expected_attempt_id:string;expected_candidate_id:string;expected_candidate_version:number;expected_signed_hash:string;
 expected_source_binding_hash:string;expected_chain_hash:string;expected_identity_version:number;expected_a1_version:number;
 expected_query_policy_version:number;
}>;
export type ReceiptQueryRunInput=Readonly<ReceiptQueryPublicSelection&{command_id:string;confirmed:true}>;
export type ReceiptQueryRecoverInput=Readonly<{confirmed:true}>;
export type ReceiptQueryPublicBinding=
 |Readonly<{action:'receiptQueryContext';input:ReceiptQueryContextInput}>
 |Readonly<{action:'receiptQueryHistory';input:ReceiptQueryHistoryInput}>
 |Readonly<{action:'receiptQueryRun';commandId:string;input:ReceiptQueryRunInput}>
 |Readonly<{action:'receiptQueryCommand';commandId:string}>
 |Readonly<{action:'receiptQueryRecover';commandId:string;input:ReceiptQueryRecoverInput}>;
export type ReceiptQueryPublicSource=Readonly<{
 source_kind:ReceiptQueryPublicSourceKind;source_command_id:string;authorization_command_id:string;authorization_attempt_id:string;
 candidate_id:string;candidate_version:number;signed_hash:string;signed_size:number;model:'55'|'65';environment:'2';origin:'operational';source_binding_hash:string;
 original:Readonly<{state:'receipt_pending'|'review_required';outcome:'receipt_pending'|'invalid_response';rejection_code:null|'SOAP_INVALID';
  cstat:'103'|null;protocol_cstat:null;response_hash:string;response_size:number;recorded_at:string}>;
 revalidation:null|Readonly<{command_id:string;state:'receipt_pending';cstat:'103';protocol_cstat:null;recorded_at:string}>;
}>;
export type ReceiptQueryPublicProtocol=Readonly<{state:'authorized_homologation'|'rejected';cstat:'104';protocol_cstat:string;protocol_number:string|null;received_at:string}>;
export type ReceiptQueryPublicResolution=Readonly<{
 state:'pending'|'authorized_homologation'|'rejected'|'review_required'|'conflict';resolution_hash:string;
 query_ids:readonly string[];selected_query_id:string|null;protocol:ReceiptQueryPublicProtocol|null;
}>;
export type ReceiptQueryPublicReceipt=Readonly<{
 query_id:string;authorization_command_id:string;authorization_attempt_id:string;source_kind:ReceiptQueryPublicSourceKind;
 source_command_id:string;source_binding_hash:string;candidate_id:string;candidate_version:number;signed_hash:string;
 model:'55'|'65';environment:'2';origin:'operational';ordinal:number;identity_version:number;a1_version:number;
 query_policy_version:number;created_at:string;expires_at:string;
}>;
export type ReceiptQueryPublicCurrent=Readonly<{
 state:ReceiptQueryPublicState;grant_consumed:boolean;used_at:string|null;expires_at:string;lease_expired:boolean;
 finished_at:string|null;recovery_required:boolean;can_recover:boolean;
}>;
export type ReceiptQueryPublicObservation=Readonly<{
 response_hash:string;response_size:number;recorded_at:string;
 outcome:'authorization_declared'|'receipt_pending'|'rejected'|'review_required'|'invalid_response';rejection_code:ReceiptQueryPublicRejection|null;
 cstat:string|null;protocol_cstat:string|null;protocol_number:string|null;received_at:string|null;
 signature_verified:boolean;xsd_validated:boolean;context_matched:boolean;processed_xsd_validated:boolean;tls_origin_verified:true;
 processed_hash:string|null;processed_size:number|null;
}>;
export type ReceiptQueryPublicResult=Readonly<typeof RECEIPT_QUERY_PUBLIC_FLAGS&{
 kind:'result';can_query:false;read_only:boolean;replayed:boolean;command_id:string;source:ReceiptQueryPublicSource;
 receipt:ReceiptQueryPublicReceipt;current:ReceiptQueryPublicCurrent;observation:ReceiptQueryPublicObservation|null;
 resolution:ReceiptQueryPublicResolution;error_code:ReceiptQueryPublicErrorCode|null;
}>;
export type ReceiptQueryPublicContext=Readonly<typeof RECEIPT_QUERY_PUBLIC_FLAGS&{
 kind:'context';read_only:true;source:ReceiptQueryPublicSource;observed_at:string;chain_hash:string;
 source_validation:Readonly<{profile:'receipt-query-source-089-v1';manifest_hash:string;verified:boolean}>;
 eligibility:Readonly<{ledger_eligible:boolean;runtime_enabled:boolean}>;
 policy:null|Readonly<{version:number;enabled:boolean;valid_from:string;valid_until:string;cadence_seconds:60;max_queries_per_hour:10}>;
 can_query:boolean;selection:ReceiptQueryPublicSelection|null;next_query_at:string|null;blockers:readonly ReceiptQueryPublicBlocker[];
 resolution:ReceiptQueryPublicResolution;history:readonly ReceiptQueryPublicResult[];
}>;
export type ReceiptQueryPublicHistory=Readonly<typeof RECEIPT_QUERY_PUBLIC_FLAGS&{
 kind:'history';can_query:false;read_only:true;authorization_command_id:string;authorization_attempt_id:string;
 observed_at:string;chain_hash:string;resolution:ReceiptQueryPublicResolution;items:readonly ReceiptQueryPublicResult[];
 next_before:number|null;limit:number;
}>;
export function captureReceiptQueryContextInput(raw:unknown):ReceiptQueryContextInput;
export function captureReceiptQueryHistoryInput(raw:unknown):ReceiptQueryHistoryInput;
export function captureReceiptQueryRunInput(raw:unknown):ReceiptQueryRunInput;
export function captureReceiptQueryRecoverInput(raw:unknown):ReceiptQueryRecoverInput;
export function projectReceiptQueryPublic(raw:unknown,binding:Extract<ReceiptQueryPublicBinding,{action:'receiptQueryContext'}>):ReceiptQueryPublicContext;
export function projectReceiptQueryPublic(raw:unknown,binding:Extract<ReceiptQueryPublicBinding,{action:'receiptQueryHistory'}>):ReceiptQueryPublicHistory;
export function projectReceiptQueryPublic(raw:unknown,binding:Exclude<ReceiptQueryPublicBinding,{action:'receiptQueryContext'|'receiptQueryHistory'}>):ReceiptQueryPublicResult;
export function projectReceiptQueryPublic(raw:unknown,binding:ReceiptQueryPublicBinding):ReceiptQueryPublicContext|ReceiptQueryPublicHistory|ReceiptQueryPublicResult;
