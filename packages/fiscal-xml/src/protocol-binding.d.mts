export interface ProtocolBindingFlags {
  readonly bindingReviewed: true; readonly bindingVerified: false; readonly operationAuthorized: false;
  readonly canQuery: false; readonly canTransmit: false; readonly canEmit: false; readonly sefazAuthorized: false;
  readonly xsdValidated: false; readonly verified: false; readonly tlsOriginVerified: false; readonly signatureVerified: false;
}
export interface ReviewedProtocolBinding extends ProtocolBindingFlags {
  readonly profile: 'sp-protocol-soap12-reviewed-v1'; readonly model: '55' | '65'; readonly environment: '2';
  readonly operation: 'protocol'; readonly reviewedOn: '2026-10-16'; readonly endpoint: string; readonly wsdlUrl: string;
  readonly wsdlHash: string; readonly wsdlSizeBytes: number; readonly soapVersion: '1.2'; readonly style: 'document'; readonly use: 'literal';
  readonly serviceNamespace: string; readonly bindingName: 'NFeConsultaProtocolo4Soap12'; readonly operationName: 'nfeConsultaNF';
  readonly inputElement: 'nfeDadosMsg'; readonly outputElement: 'nfeResultMsg'; readonly soapAction: string;
}
declare const requestBrand: unique symbol;
export interface ReviewedProtocolSoapRequest extends ProtocolBindingFlags {
  readonly [requestBrand]: true; readonly profile: 'sp-protocol-soap12-reviewed-v1'; readonly bindingStatus: 'reviewed-local-wsdl-snapshot';
  readonly binding: ReviewedProtocolBinding; readonly method: 'POST'; readonly operation: 'protocol'; readonly requestId: string;
  readonly accessKey: string; readonly model: '55' | '65'; readonly environment: '2'; readonly endpoint: string;
  readonly xml: string; readonly xmlDigest: string; readonly envelopeXml: string; readonly envelopeDigest: string; readonly envelopeSizeBytes: number;
  readonly requiresMutualTls: true; readonly contentType: string; readonly soapAction: string; readonly headers: Readonly<{ 'Content-Type': string }>;
}
export interface ReviewedProtocolSoapCandidate extends ProtocolBindingFlags {
  readonly profile: 'sp-protocol-soap12-reviewed-v1'; readonly bindingStatus: 'reviewed-local-wsdl-snapshot';
  readonly binding: ReviewedProtocolBinding; readonly model: '55' | '65'; readonly environment: '2';
  readonly envelopeDigest: string; readonly envelopeSizeBytes: number; readonly payloadXml: string; readonly payloadDigest: string;
  readonly queryContextMatched: true; readonly requiresProtocolValidation: true;
}
export function reviewedProtocolBinding(model: '55' | '65'): ReviewedProtocolBinding;
export function verifyReviewedProtocolWsdl(input: { model: '55' | '65'; wsdlBytes: Uint8Array }): ReviewedProtocolBinding;
export function prepareReviewedProtocolSoap(input: { accessKey: string; expectedModel: '55' | '65'; environment: '2'; requestId: string }): ReviewedProtocolSoapRequest;
export function encodeReviewedProtocolSoap(request: ReviewedProtocolSoapRequest): Uint8Array;
export function extractReviewedProtocolSoap(input: { request: ReviewedProtocolSoapRequest; envelopeBytes: Uint8Array }): ReviewedProtocolSoapCandidate;
