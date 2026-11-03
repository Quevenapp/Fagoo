import type {AuthorizationRequest,AuthorizationResponse,InactiveFlags} from './index.mjs';
import {AUTHORIZATION_SOAP_MANIFESTS} from './authorization-soap-manifest.mjs';
export {AUTHORIZATION_SOAP_MANIFEST,AUTHORIZATION_SOAP_MANIFESTS} from './authorization-soap-manifest.mjs';
export const MAX_AUTHORIZATION_SOAP_BYTES:512000;
export const AUTHORIZATION_SOAP_MANIFEST_HASH:string;
export const AUTHORIZATION_SOAP_MANIFEST_HASHES:Readonly<{'55':string;'65':string}>;
export type AuthorizationSoapFlags=InactiveFlags&Readonly<{signatureVerified:false;bindingReviewed:true;bindingVerified:false;operationAuthorized:false}>;
export const AUTHORIZATION_SOAP_FLAGS:AuthorizationSoapFlags;
export type ReviewedAuthorizationBinding=(typeof AUTHORIZATION_SOAP_MANIFESTS)['55'|'65']&AuthorizationSoapFlags&Readonly<{manifestHash:string}>;
declare const soapRequestBrand:unique symbol;
export type ReviewedAuthorizationSoapRequest=AuthorizationSoapFlags&Readonly<{
 [soapRequestBrand]:true;profile:ReviewedAuthorizationBinding['profile'];binding:ReviewedAuthorizationBinding;
 model:'55'|'65';environment:'2';operation:'authorization';method:'POST';endpoint:string;contentType:string;soapAction:string;
 headers:Readonly<{'Content-Type':string}>;signedHash:string;batchId:string;payloadHash:string;payloadSizeBytes:number;envelopeHash:string;envelopeSizeBytes:number;
}>;
export type ReviewedAuthorizationSoapCandidate=AuthorizationSoapFlags&Readonly<{
 profile:ReviewedAuthorizationBinding['profile'];binding:ReviewedAuthorizationBinding;model:'55'|'65';environment:'2';
 envelopeHash:string;envelopeSizeBytes:number;payloadXml:string;payloadHash:string;payloadSizeBytes:number;response:AuthorizationResponse;
}>;
export class AuthorizationSoapBindingError extends Error{readonly code:string;}
/** Each model uses its separately observed exact WSDL pin and endpoint. */
export function reviewedAuthorizationBinding(model:'55'|'65'):ReviewedAuthorizationBinding;
export function verifyReviewedAuthorizationWsdl(input:{model:'55'|'65';wsdlBytes:Uint8Array}):ReviewedAuthorizationBinding;
export function prepareReviewedAuthorizationSoap(input:{request:AuthorizationRequest}):ReviewedAuthorizationSoapRequest;
export function encodeReviewedAuthorizationSoap(request:ReviewedAuthorizationSoapRequest):Uint8Array;
export function extractReviewedAuthorizationSoap(input:{request:ReviewedAuthorizationSoapRequest;envelopeBytes:Uint8Array}):ReviewedAuthorizationSoapCandidate;
