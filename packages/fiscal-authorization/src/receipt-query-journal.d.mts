import type {Storage} from './service.mjs';
import type {ReceiptQueryRecovery,ReceiptQueryArtifact} from './receipt-query-sql-contract.d.mts';
import type {ReceiptQueryLedgerView} from './receipt-query-ledger-dto.mjs';
import type {ReceiptQueryScope} from './receipt-query-processing.mjs';
export type ReceiptQueryObservation=Readonly<{profile:'receipt-query-journal-089-v1';origin:'operational';query_id:string;nonce:string;authorization_command_id:string;authorization_attempt_id:string;source_kind:'authorization'|'revalidation';source_command_id:string;source_binding_hash:string;candidate_id:string;signed_hash:string;request_hash:string;response_hash:string;response_size:number;http_status:200|500;received_at:string;tls_peer_verified:true;tls_origin_verified:true;tls_protocol:'TLSv1.2'|'TLSv1.3';server_trust_profile:'node-bundled-plus-iti-ssl-v10-20261016';server_trust_anchor_sha256:string}>;
export function receiptQueryPath(context:ReceiptQueryRecovery,type:'requests'|'responses'|'observations'|'processed',tag?:string):string;
export function receiptQuerySidecar(raw:unknown,context:ReceiptQueryRecovery,responseHash:string,responseSize:number):ReceiptQueryObservation;
export function createReceiptQueryJournal(storage:Storage):Readonly<{
 read(key:string,scope:ReceiptQueryScope,expected?:{max?:number;expectedHash?:string;expectedSize?:number}):Promise<Uint8Array|null>;
 persist(key:string,bytes:Uint8Array,scope:ReceiptQueryScope):Promise<string>;
 response(context:ReceiptQueryRecovery,scope:ReceiptQueryScope,expected?:ReceiptQueryArtifact|null):Promise<{bytes:Uint8Array;observation:ReceiptQueryObservation;httpStatus:200|500;observationHash:string;observationSize:number}>;
 verify(view:ReceiptQueryLedgerView,scope:ReceiptQueryScope):Promise<void>;
}>;
