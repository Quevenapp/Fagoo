/** Browser-safe closed079 contract. No XML, credential, access key or transport input. */
export const REVALIDATION_PROFILE:'authorization-stored-response-utf8-v1';
export const REVALIDATION_PARSER_HASH:string;
export const MAX_REVALIDATION_REQUEST_BYTES:16384;
export const MAX_REVALIDATION_RESPONSE_BYTES:262144;
export const REVALIDATION_FLAGS:Readonly<{data_mode:'fiscal_authorization_revalidation';environment:'2';tax_rules_validated:false;can_emit:false;can_transmit:false;production_authorized:false;financial_mutation_performed:false;stock_mutation_performed:false;retry_submission_allowed:false}>;
export class RevalidationDtoError extends Error {readonly code:string;constructor(code?:string)}
export type RevalidationInput=Readonly<{command_id:string;authorization_command_id:string;expected_attempt_id:string;expected_source_hash:string;confirmed:true}>;
export type RevalidationBinding=Readonly<{action:'revalidationContext';authorizationCommandId:string;expectedAttemptId:string}|{action:'revalidationRun';commandId:string;input:RevalidationInput}|{action:'revalidationCommand';commandId:string}>;
export type RevalidationState='authorized_homologation'|'receipt_pending'|'rejected'|'review_required';
export type RevalidationArtifact=Readonly<{response_hash:string;response_size:number;payload_hash:string;outcome:'authorization_declared'|'receipt_pending'|'rejected'|'review_required';cstat:string;protocol_cstat:string|null;protocol_number:string|null;received_at:string;receipt_number:string|null;tls_origin_verified:true;signature_verified:boolean;xsd_validated:true;context_matched:true;processed_xsd_validated:boolean}>;
export type RevalidationReceipt=Readonly<{
 command_id:string;authorization_command_id:string;attempt_id:string;candidate_id:string;candidate_version:number;signed_hash:string;model:'55'|'65';origin:'operational';source_hash:string;
 parser_profile:typeof REVALIDATION_PROFILE;parser_manifest_hash:string;original_state:'review_required';state:RevalidationState;
 artifact:RevalidationArtifact;processed_hash:string|null;processed_size:number|null;created_at:string;tax_rules_validated:false;
}>;
export type RevalidationResult=Readonly<typeof REVALIDATION_FLAGS&{kind:'result';read_only:boolean;command_id:string;replayed:boolean;receipt:RevalidationReceipt}>;
export type RevalidationContext=Readonly<typeof REVALIDATION_FLAGS&{
 kind:'context';read_only:true;authorization_command_id:string;attempt_id:string;
 candidate:Readonly<{candidate_id:string;candidate_version:number;signed_hash:string;model:'55'|'65';origin:'operational'}>;
 source_hash:string;parser:Readonly<{profile:typeof REVALIDATION_PROFILE;manifest_hash:string}>;
 original:Readonly<{state:'review_required';outcome:'invalid_response';rejection_code:'SOAP_INVALID';cstat:null;protocol_cstat:null;response_hash:string;response_size:number;recorded_at:string}>;
 can_revalidate:boolean;existing:RevalidationResult|null;
}>;
export function captureRevalidationInput(raw:unknown):RevalidationInput;
export function projectRevalidationPublic(raw:unknown,binding:RevalidationBinding):RevalidationContext|RevalidationResult;
