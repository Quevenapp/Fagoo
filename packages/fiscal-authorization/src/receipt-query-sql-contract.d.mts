/** Private SQL089 contract; never forward wholesale to a browser. No execution from replay. */
export type ReceiptQuerySourceKind = 'authorization' | 'revalidation';
export type ReceiptQueryState = 'prepared'|'request_ready'|'dispatched'|'uncertain'|'failed_before_dispatch'|'receipt_pending'|'rejected'|'review_required'|'authorized_homologation';
export type ReceiptQuerySource = Readonly<{
 source_kind:ReceiptQuerySourceKind; source_command_id:string; authorization_command_id:string;
 authorization_attempt_id:string; candidate_id:string; candidate_version:number; signed_hash:string; signed_size:number;
 model:'55'|'65'; environment:'2'; origin:'operational'; source_binding_hash:string;
 original_source:Readonly<{receipt:unknown;recovery:unknown;artifact:unknown;rule_review:unknown;observation:unknown}>;
 selected_revalidation:null|Readonly<{receipt:unknown;source:unknown}>;
}>;
export type ReceiptQuerySourceValidation = Readonly<{
 profile:'receipt-query-source-089-v1'; manifest_hash:string; source_binding_hash:string; payload_hash:string;
 receipt_number:string; tmed_seconds:number; received_at:string; observed_at:string;
 signature_verified:true;xsd_validated:true;context_matched:true;tls_origin_verified:true;
 tax_rules_validated:false;can_query:false;can_emit:false;can_transmit:false;
}>;
export type ReceiptQuerySelection = Readonly<{
 source_kind:ReceiptQuerySourceKind;source_command_id:string;expected_authorization_command_id:string;
 expected_attempt_id:string;expected_candidate_id:string;expected_candidate_version:number;expected_signed_hash:string;
 expected_source_binding_hash:string;expected_chain_hash:string;expected_identity_version:number;expected_a1_version:number;
 expected_query_policy_version:number;
}>;
export type ReceiptQueryResolution = Readonly<{
 state:'pending'|'authorized_homologation'|'rejected'|'review_required'|'conflict';
 resolution_hash:string;query_ids:readonly string[];selected_query_id:string|null;protocol:ReceiptQueryProtocol|null;
}>;
export type ReceiptQueryContext = Readonly<{
 data_mode:'fiscal_receipt_query';read_only:true;source:ReceiptQuerySource;observed_at:string;
 chain_hash:string;resolution:ReceiptQueryResolution;policy:ReceiptQueryPolicy;heads:Readonly<{identity_version:number;a1_version:number}>;
 selection:ReceiptQuerySelection;next_query_at:string|null;blockers:readonly ReceiptQueryBlocker[];
 can_query:false;source_validation_required:true;private_eligible_for_attested_source:boolean;history:readonly ReceiptQueryView[];
}>;
export type ReceiptQueryView = Readonly<{
 data_mode:'fiscal_receipt_query';query_id:string;receipt:ReceiptQueryReceipt;source:ReceiptQuerySource;source_validation:ReceiptQuerySourceValidation;
 current:Readonly<{state:ReceiptQueryState;grant_consumed:boolean;used_at:string|null;expires_at:string;lease_expired:boolean;finished_at:string|null;recovery_required:boolean}>;
 request:ReceiptQueryRequest|null;artifact:ReceiptQueryArtifact|null;recovery:ReceiptQueryRecovery;resolution:ReceiptQueryResolution;error_code:ReceiptQueryErrorCode|null;
 replayed?:boolean;execution?:ReceiptQueryRecovery|null;
}>;
export type ReceiptQuerySqlArgs = {
 context:{p_user_id:string;p_source_kind:ReceiptQuerySourceKind;p_source_command_id:string;p_expected_attempt_id:string};
 begin:{p_user_id:string;p_command_id:string;p_selection:ReceiptQuerySelection;p_source_validation:ReceiptQuerySourceValidation;p_confirmed:true};
 prepare:{p_user_id:string;p_query_id:string;p_lease_id:string;p_request_hash:string;p_request_size:number;p_evidence:ReceiptQueryPreparation};
 use:{p_user_id:string;p_query_id:string;p_lease_id:string};
 finish:{p_user_id:string;p_query_id:string;p_lease_id:string;p_response_hash:string;p_response_size:number;p_observation_hash:string;p_observation_size:number;p_evidence:ReceiptQueryResultEvidence;p_processed_hash:string|null;p_processed_size:number|null};
 fail:{p_user_id:string;p_query_id:string;p_lease_id:string;p_error_code:ReceiptQueryErrorCode};
 command:{p_user_id:string;p_command_id:string};
 history:{p_user_id:string;p_authorization_command_id:string;p_expected_attempt_id:string;p_limit:number;p_before:number|null};
};
export type ReceiptQueryReceipt = Readonly<{
 query_id:string;actor:string;authorization_command_id:string;authorization_attempt_id:string;
 source_kind:ReceiptQuerySourceKind;source_command_id:string;source_binding_hash:string;candidate_id:string;
 candidate_version:number;signed_hash:string;model:'55'|'65';environment:'2';origin:'operational';ordinal:number;
 identity_version:number;a1_version:number;query_policy_version:number;created_at:string;expires_at:string;
}>;
export type ReceiptQueryPreparation = Readonly<{
 profile:'receipt-query-source-089-v1';manifest_hash:string;query_id:string;nonce:string;source_binding_hash:string;
 request_hash:string;payload_hash:string;signed_hash:string;model:'55'|'65';environment:'2';receipt_number:string;
 signature_verified:true;xsd_validated:true;context_matched:true;tax_rules_validated:false;can_emit:false;can_transmit:false;
}>;
/** Receipt_number is the queried nRec even for invalid_response, not an unverified field extracted from it. */
export type ReceiptQueryResultEvidence = Readonly<{
 profile:'receipt-query-source-089-v1';manifest_hash:string;query_id:string;nonce:string;source_binding_hash:string;
 request_hash:string;response_hash:string;payload_hash:string|null;signed_hash:string;model:'55'|'65';environment:'2';receipt_number:string;
 outcome:'authorization_declared'|'receipt_pending'|'rejected'|'review_required'|'invalid_response';
 rejection_code:null|'SOAP_FAULT'|'SOAP_INVALID'|'XML_INVALID'|'XSD_INVALID'|'CONTEXT_MISMATCH'|'DIGEST_MISMATCH'|'PROCESSED_INVALID';
 cstat:string|null;protocol_cstat:string|null;protocol_number:string|null;received_at:string|null;reference_digest:string|null;
 signature_verified:boolean;xsd_validated:boolean;context_matched:boolean;processed_xsd_validated:boolean;tls_origin_verified:true;
 observation_hash:string;observation_size:number;tax_rules_validated:false;can_emit:false;can_transmit:false;
}>;
export type ReceiptQueryRequest = Readonly<{query_id:string;sha256:string;size_bytes:number;evidence:ReceiptQueryPreparation;created_at:string}>;
export type ReceiptQueryArtifact = Readonly<{query_id:string;response_hash:string;response_size:number;observation_hash:string;observation_size:number;evidence:ReceiptQueryResultEvidence;processed_hash:string|null;processed_size:number|null;created_at:string}>;
export type ReceiptQueryProtocol = Readonly<{state:'authorized_homologation'|'rejected';access_key:string;receipt_number:string;reference_digest:string|null;cstat:string;protocol_cstat:string;protocol_number:string|null;received_at:string}>;
export type ReceiptQueryErrorCode = 'RECEIPT_QUERY_PREPARATION_FAILED'|'RECEIPT_QUERY_CUSTODY_FAILED'|'RECEIPT_QUERY_TRANSPORT_FAILED'|'RECEIPT_QUERY_TRANSPORT_TIMEOUT'|'RECEIPT_QUERY_STORAGE_FAILED'|'RECEIPT_QUERY_RESULT_UNCONFIRMED'|'RECEIPT_QUERY_CANCELLED';
export type ReceiptQueryBlocker = 'SOURCE_VALIDATION_REQUIRED'|'POLICY_DISABLED'|'POLICY_TIME_INVALID'|'A1_UNAVAILABLE'|'A1_INVALID'|'A1_STORAGE_INVALID'|'IDENTITY_MISMATCH'|'POLICY_PROFILE_INVALID'|'RESOLUTION_CLOSED'|'QUERY_ACTIVE'|'CADENCE_REQUIRED'|'RATE_LIMIT';
export type ReceiptQueryPolicy = Readonly<{model:'55'|'65';version:number;enabled:boolean;profile:'receipt-query-source-089-v1';manifest_hash:string;origin:'operational';binding_profile:string;lease_seconds:60;cadence_seconds:60;max_queries_per_hour:10;valid_from:string;valid_until:string;created_at:string}>;
export type ReceiptQueryRecovery = Readonly<{
 private_executor_only:true;purpose:'sp-receipt-query-homologation-v1';query_id:string;actor:string;
 authorization_command_id:string;authorization_attempt_id:string;source_kind:ReceiptQuerySourceKind;source_command_id:string;source_binding_hash:string;
 candidate_id:string;candidate_version:number;signed_hash:string;signed_size:number;model:'55'|'65';environment:'2';origin:'operational';
 lease_id:string;nonce:string;created_at:string;expires_at:string;policy:ReceiptQueryPolicy;identity_version:number;a1_version:number;
 credential_id:string;envelope_hash:string;certificate_fingerprint:string;receipt_number:string;access_key:string;reference_digest:string;issuer_cnpj:string;
 request_hash:string|null;request_size:number|null;
}>;
export type ReceiptQueryHistory = Readonly<{data_mode:'fiscal_receipt_query';read_only:true;authorization_command_id:string;authorization_attempt_id:string;observed_at:string;chain_hash:string;resolution:ReceiptQueryResolution;items:readonly ReceiptQueryView[];next_before:number|null;limit:number}>;
