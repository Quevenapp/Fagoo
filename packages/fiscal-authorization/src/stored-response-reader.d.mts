import type {AuthorizationRequest} from './index.mjs';
import type {ValidationReport} from './validator.mjs';
import type {Options,PrivateJson,Storage} from './service.mjs';
export {STORED_RESPONSE_MANIFEST,STORED_RESPONSE_MANIFEST_HASH} from './stored-response-manifest.mjs';
export type StoredResponseInput=Readonly<{actor:string;authorizationCommandId:string}>;
/** Private069 projected command, never the public HTTP DTO. Authorization is checked by this port on every call. */
export type StoredCommandReader=(input:StoredResponseInput,options:Readonly<{signal:AbortSignal;deadline:number}>)=>Promise<unknown>;
export type StoredResponseEvidence=Readonly<{
 origin:'operational';request_hash:string;response_hash:string;payload_hash:string;
 schema_profile:string;schema_manifest_hash:string;validator_hash:string;binding_profile:string;rule_profile:string;
 outcome:'authorization_declared'|'receipt_pending'|'rejected'|'review_required';rejection_code:null;cstat:string;protocol_cstat:string|null;
 protocol_number:string|null;received_at:string;receipt_number:string|null;reference_digest:string|null;
 signature_verified:boolean;xsd_validated:true;context_matched:true;processed_xsd_validated:boolean;tls_origin_verified:true;
 transport_hash:string;transport_size:number;can_emit:false;can_transmit:false;
}>;
export type StoredResponseResult=Readonly<{
 source:Readonly<{receipt:PrivateJson;recovery:PrivateJson;artifact:PrivateJson;rule_review:PrivateJson;observation:PrivateJson}>;
 validation:Readonly<{parser_profile:'authorization-stored-response-utf8-v1';parser_manifest_hash:string;evidence:StoredResponseEvidence;
  signed_hash:string;signed_size:number;response_size:number;processed_hash:string|null;processed_size:number|null;tax_rules_validated:false}>;
 /** Owned mutable copy; consumer must verify hash/size before persistence and erase when finished. */
 processedBytes:Uint8Array|null;
}>;
/** No current A1/policy/review requirement, no writes or transport. Requires authenticated read ports and a pinned local validator. */
export function createStoredResponseReader(configuration:{readCommand:StoredCommandReader;readObject:Storage['read'];
 validate:(input:{request:AuthorizationRequest;xmlBytes:Uint8Array;kind:'response'|'processed'},options:{signal:AbortSignal;deadline:number})=>Promise<ValidationReport>;
}):(input:StoredResponseInput,options?:Options)=>Promise<StoredResponseResult>;
