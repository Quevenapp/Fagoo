import type {ReceiptQuery,ReceiptResponse,ReceiptFlags} from './receipt-core.mjs';
export const MAX_RECEIPT_SOAP_BYTES:512000;
export type ReceiptSoapFlags=ReceiptFlags&Readonly<{bindingReviewed:true;bindingVerified:false;operationAuthorized:false}>;
export const RECEIPT_SOAP_FLAGS:ReceiptSoapFlags;
export type ReceiptSoapManifest=Readonly<{
 profile:string;payloadProfile:string;payloadManifestHash:string;model:'55'|'65';environment:'2';operation:'receipt';soapVersion:'1.2';style:'document';use:'literal';
 serviceNamespace:string;bindingName:'NFeRetAutorizacao4Soap12';operationName:'nfeRetAutorizacaoLote';soapAction:string;
 inputElement:'nfeDadosMsg';outputElement:'nfeResultMsg';outputPart:'nfeRetAutorizacaoLoteResult';declaredSoapHeaders:false;externalDependencies:false;
 endpoint:string;wsdl:Readonly<{url:string;sha256:string;sizeBytes:number}>;source:Readonly<{url:string;sha256:string;sizeBytes:number}>;limitations:readonly string[];
}>;
export const RECEIPT_SOAP_MANIFESTS:Readonly<Record<'55'|'65',ReceiptSoapManifest>>;
export const RECEIPT_SOAP_MANIFEST_HASHES:Readonly<Record<'55'|'65',string>>;
export type ReviewedReceiptBinding=ReceiptSoapManifest&ReceiptSoapFlags&Readonly<{manifestHash:string}>;
declare const soapBrand:unique symbol;
export type ReviewedReceiptSoapRequest=ReceiptSoapFlags&Readonly<{
 [soapBrand]:true;profile:string;binding:ReviewedReceiptBinding;model:'55'|'65';environment:'2';operation:'receipt';method:'POST';endpoint:string;
 contentType:string;soapAction:string;headers:Readonly<{'Content-Type':string}>;signedHash:string;batchId:string;authorizationCommandId:string;sourceEvidenceHash:string;
 payloadHash:string;payloadSizeBytes:number;envelopeHash:string;envelopeSizeBytes:number;
}>;
export type ReviewedReceiptSoapCandidate=ReceiptSoapFlags&Readonly<{
 profile:string;binding:ReviewedReceiptBinding;model:'55'|'65';environment:'2';envelopeHash:string;envelopeSizeBytes:number;
 payloadXml:string;payloadHash:string;payloadSizeBytes:number;response:ReceiptResponse;
}>;
export class ReceiptSoapBindingError extends Error{readonly code:string;}
export function reviewedReceiptBinding(model:'55'|'65'):ReviewedReceiptBinding;
export function verifyReviewedReceiptWsdl(input:{model:'55'|'65';wsdlBytes:Uint8Array}):ReviewedReceiptBinding;
export function prepareReviewedReceiptSoap(input:{request:ReceiptQuery}):ReviewedReceiptSoapRequest;
export function encodeReviewedReceiptSoap(request:ReviewedReceiptSoapRequest):Uint8Array;
export function extractReviewedReceiptSoap(input:{request:ReviewedReceiptSoapRequest;envelopeBytes:Uint8Array}):ReviewedReceiptSoapCandidate;
