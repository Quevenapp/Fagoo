import type {Options,Storage} from './service.mjs';
import type {AuthorizationRequest} from './index.mjs';
import type {ValidationReport} from './validator.mjs';
import type {ReceiptEvidence,ReceiptSelectedIdentity} from './receipt-core.mjs';
import type {ReceiptQuerySourceInput,ReceiptQuerySourceSnapshot} from './receipt-query-evidence.mjs';
export type {ReceiptQuerySourceInput,ReceiptQuerySourceSnapshot} from './receipt-query-evidence.mjs';
export {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from './receipt-query-manifest.mjs';
export type ReceiptQuerySourceValidation=Readonly<{profile:'receipt-query-source-089-v1';manifest_hash:string;source_binding_hash:string;payload_hash:string;receipt_number:string;tmed_seconds:number;received_at:string;observed_at:string;signature_verified:true;xsd_validated:true;context_matched:true;tls_origin_verified:true;tax_rules_validated:false;can_query:false;can_emit:false;can_transmit:false}>;
declare const sourceBrand:unique symbol;
export type ReceiptQuerySourceHandle=Readonly<{[sourceBrand]:true;profile:'receipt-query-source-089-v1';manifest_hash:string;source_binding_hash:string;source_kind:'authorization'|'revalidation';source_command_id:string;authorization_command_id:string;authorization_attempt_id:string;model:'55'|'65';candidate_id:string;tax_rules_validated:false;can_query:false;can_emit:false;can_transmit:false}>;
export function createReceiptQuerySource(configuration:{
 readSource:(input:ReceiptQuerySourceInput,options:Readonly<{signal:AbortSignal;deadline:number}>)=>Promise<unknown>;
 readObject:Storage['read'];
 validate:(input:{request:AuthorizationRequest;xmlBytes:Uint8Array;kind:'response'},options:Readonly<{signal:AbortSignal;deadline:number}>)=>Promise<ValidationReport>;
}):(input:ReceiptQuerySourceInput,options?:Options)=>Promise<ReceiptQuerySourceHandle>;
export function receiptQuerySource(handle:ReceiptQuerySourceHandle):Readonly<{source:ReceiptQuerySourceSnapshot;validation:ReceiptQuerySourceValidation;authorizationRequest:AuthorizationRequest;evidence:ReceiptEvidence&ReceiptSelectedIdentity;tmedLiteral:string}>;
export function disposeReceiptQuerySource(handle:ReceiptQuerySourceHandle):void;
