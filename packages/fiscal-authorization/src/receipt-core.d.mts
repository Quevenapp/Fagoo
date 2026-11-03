import type {AuthorizationRequest} from './index.mjs';
import type {ReceiptQuerySourceInput,ReceiptQuerySourceSnapshot} from './receipt-query-evidence.mjs';
export const RECEIPT_PROFILE:'sp-receipt-payload-reviewed-20261016-v1';
export const RECEIPT_MANIFEST_HASH:string;
export const MAX_RECEIPT_BYTES:512000;
export const MAX_RECEIPT_RECORD_BYTES:131072;
export type ReceiptFlags=Readonly<{xsdValidated:false;tlsOriginVerified:false;taxRulesValidated:false;signatureVerified:false;sefazAuthorized:false;authorizedInHomologation:false;productionAuthorized:false;legalFiscalValue:false;canQuery:false;canEmit:false;canTransmit:false;retrySubmissionAllowed:false}>;
export const RECEIPT_FLAGS:ReceiptFlags;
export class FiscalReceiptError extends Error{readonly code:string;}
declare const evidenceBrand:unique symbol;
declare const queryBrand:unique symbol;
declare const responseBrand:unique symbol;
export type ReceiptSelectedIdentity=Readonly<{sourceProfile:'receipt-query-source-089-v1';sourceManifestHash:string;sourceKind:'authorization'|'revalidation';sourceCommandId:string;authorizationAttemptId:string;sourceBindingHash:string}>;
export type ReceiptIdentity=Partial<ReceiptSelectedIdentity>&Readonly<{profile:typeof RECEIPT_PROFILE;manifestHash:string;model:'55'|'65';environment:'2';origin:'synthetic'|'operational';candidateId:string;commandId:string;sourceState:'receipt_pending';batchId:string;signedHash:string;receiptNumber:string;sourceEvidenceHash:string}>;
export type ReceiptEvidence=ReceiptIdentity&ReceiptFlags&Readonly<{[evidenceBrand]:true;actor:string;candidateVersion:number;authorizationPayloadHash:string;authorizationRequestHash:string;sourceResponseHash:string;sourcePayloadHash:string}>;
export type ReceiptQuery=ReceiptIdentity&ReceiptFlags&Readonly<{[queryBrand]:true;requestHash:string;sizeBytes:number}>;
export type ReceiptReadInput=Readonly<{request:AuthorizationRequest;actor:string;candidateId:string;commandId:string}>;
export type ReceiptReadOptions=Readonly<{signal?:AbortSignal;deadline?:number}>;
/** Backend-only. The caller must provide authorization and exact verified journal/payload evidence. */
export type ReadReceiptPort=(query:Readonly<{actor:string;candidateId:string;commandId:string;signedHash:string;model:'55'|'65';batchId:string}>,options:Readonly<{signal:AbortSignal;deadline:number;maxRecordBytes:131072;maxPayloadBytes:512000}>)=>Promise<Readonly<{recordBytes:Uint8Array;payloadBytes:Uint8Array}>>;
export function createReceiptEvidenceReader(configuration:{readReceipt:ReadReceiptPort}):(input:ReceiptReadInput,options?:ReceiptReadOptions)=>Promise<ReceiptEvidence>;
export function prepareReceiptQuery(input:{evidence:ReceiptEvidence}):ReceiptQuery;
export function receiptRequestBytes(handle:ReceiptQuery):Uint8Array;
export function assertReceiptQueryEvidence(input:{evidence:ReceiptEvidence;request:ReceiptQuery}):ReceiptQuery;
export type ReceiptValidationContext=Readonly<{model:'55'|'65';accessKey:string;referenceDigest:string;issuedAt:string;receiptNumber:string}>;
/** Private local-validator context, never a public DTO or authority to query. */
export function receiptValidationContext(handle:ReceiptQuery):ReceiptValidationContext;
export type ReceiptProtocol=Readonly<{cStat:string;number:string|null;receivedAt:string;referenceDigestMatched:boolean}>;
export type ReceiptResponse=ReceiptIdentity&ReceiptFlags&Readonly<{[responseBrand]:true;requestHash:string;responseHash:string;sizeBytes:number;cStat:string;receivedAt:string;classification:'receipt_pending'|'review_required'|'rejected'|'authorization_declared';protocol:ReceiptProtocol|null}>;
export function parseReceiptResponse(input:{request:ReceiptQuery;responseBytes:Uint8Array}):ReceiptResponse;
export function assertReceiptResponse(input:{request:ReceiptQuery;response:ReceiptResponse}):ReceiptResponse;

/** Versioned backend port: literal069/079 source, never a fabricated064 current state. */
export function createReceiptEvidenceReaderV2(configuration:{readReceipt:(input:ReceiptQuerySourceInput,options:Readonly<{signal:AbortSignal;deadline:number;maxPayloadBytes:512000}>)=>Promise<Readonly<{source:ReceiptQuerySourceSnapshot;payloadBytes:Uint8Array}>>}):(input:ReceiptQuerySourceInput&Readonly<{request:AuthorizationRequest}>,options?:ReceiptReadOptions)=>Promise<ReceiptEvidence&ReceiptSelectedIdentity>;
