import type {AuthorizationRequest} from './index.mjs';
import type {ReceiptQuery,ReceiptResponse,ReceiptProtocol,ReceiptFlags} from './receipt-core.mjs';
export const RECEIPT_PROCESSED_PROFILE:'sp-receipt-processed-candidate-20261017-v1';
export class ReceiptProcessedError extends Error{readonly code:string;}
export type ReceiptProcessedCandidate=Omit<ReceiptFlags,'signatureVerified'>&Readonly<{
 profile:typeof RECEIPT_PROCESSED_PROFILE;model:'55'|'65';environment:'2';origin:'synthetic'|'operational';sourceState:'receipt_pending';
 authorizationCommandId:string;sourceEvidenceHash:string;signedHash:string;batchId:string;receiptNumber:string;
 authorizationPayloadHash:string;queryPayloadHash:string;receiptResponseHash:string;processedXml:string;processedHash:string;
 sizeBytes:number;referenceDigest:string;protocol:ReceiptProtocol;signatureVerified:true;contextMatched:true;
}>;
export function composeReceiptProcessedNfe(input:{authorizationRequest:AuthorizationRequest;request:ReceiptQuery;response:ReceiptResponse;responseBytes:Uint8Array}):ReceiptProcessedCandidate;
