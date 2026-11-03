export type Model = '55' | '65';
export type InactiveFlags = Readonly<{
  xsdValidated:false; tlsOriginVerified:false; taxRulesValidated:false;
  icpBrasilChainValidated:false; revocationChecked:false; sefazAuthorized:false;
  authorizedInHomologation:false; productionAuthorized:false; legalFiscalValue:false;
  canEmit:false; canTransmit:false; retrySubmissionAllowed:false;
}>;
export const AUTHORIZATION_PROFILE: 'sp-single-homologation-authorization-candidate-v1';
export const MAX_AUTHORIZATION_BYTES: 512000;
export const AUTHORIZATION_FLAGS: InactiveFlags;
export class FiscalAuthorizationError extends Error { readonly code:string; }
declare const requestBrand: unique symbol;
declare const responseBrand: unique symbol;
export type AuthorizationRequest = InactiveFlags & Readonly<{
  [requestBrand]:true; profile:typeof AUTHORIZATION_PROFILE; model:Model; environment:'2'; batchId:string;
  accessKey:string; signedHash:string; requestHash:string; sizeBytes:number; referenceDigest:string; signatureVerified:true;
}>;
export type Protocol = Readonly<{cStat:string;number:string|null;receivedAt:string;referenceDigestMatched:boolean}>;
export type AuthorizationResponse = InactiveFlags & Readonly<{
  [responseBrand]:true; profile:typeof AUTHORIZATION_PROFILE; model:Model; environment:'2';
  requestHash:string; responseHash:string; sizeBytes:number;
  classification:'receipt_pending'|'authorization_declared'|'rejected'|'review_required';
  cStat:string;receivedAt:string;receiptNumber:string|null;protocol:Protocol|null;signatureVerified:false;
}>;
export function prepareAuthorization(input: {
  signedBytes:Uint8Array; expectedSignedHash:string; expectedModel:Model; expectedIssuerCnpj:string;
  expectedCertificate:string; expectedHolderCnpj:string; expectedCertificateFingerprint:string;
  now:Date; batchId:string;
}):AuthorizationRequest;
export function authorizationRequestBytes(request:AuthorizationRequest):Uint8Array;
export function parseAuthorizationResponse(input:{request:AuthorizationRequest;responseBytes:Uint8Array}):AuthorizationResponse;
export function composeProcessedNfe(input:{request:AuthorizationRequest;response:AuthorizationResponse}):InactiveFlags & Readonly<{
  profile:typeof AUTHORIZATION_PROFILE;processedXml:string;processedHash:string;sizeBytes:number;
  signedHash:string;requestHash:string;responseHash:string;referenceDigest:string;
  model:Model;environment:'2';protocol:Protocol;signatureVerified:true;
}>;
/** Local composition verification only; does not attest the source of the protocol. */
export function verifyProcessedAuthorization(input:{request:AuthorizationRequest;processedBytes:Uint8Array}):InactiveFlags & Readonly<{
  profile:typeof AUTHORIZATION_PROFILE;model:Model;environment:'2';signedHash:string;requestHash:string;
  processedHash:string;sizeBytes:number;referenceDigest:string;protocol:Protocol;signatureVerified:true;contextMatched:true;
}>;
export function authorizationBindingStatus(model:Model):Readonly<{
  model:Model;environment:'2';operation:'authorization';status:'reviewed_wsdl_required';
  bindingReviewed:false;bindingVerified:false;operationAuthorized:false;canTransmit:false;
}>;
