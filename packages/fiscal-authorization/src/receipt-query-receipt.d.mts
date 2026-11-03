import type {AuthorizationRequest} from './index.mjs';
export type AuthorizationReceiptDetails=Readonly<{payload_hash:string;receipt_number:string;tmed_literal:string;tmed_seconds:number;received_at:string}>;
/** Strict103 only. This does not claim TLS/XSD, authorize a query or expose an input for a browser. */
export function authorizationReceiptDetails(input:{request:AuthorizationRequest;payloadBytes:Uint8Array}):AuthorizationReceiptDetails;
