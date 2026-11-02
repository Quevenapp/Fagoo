import { FiscalXmlError, MAX_XML_BYTES, need, sha256 } from './common.mjs';
import { prepareProtocolSoapDraft, extractProtocolSoapCandidate } from './protocol-soap.mjs';

const PROFILE = 'sp-protocol-soap12-reviewed-v1';
const SERVICE = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4';
const ACTION = SERVICE + '/nfeConsultaNF';
const CONTENT_TYPE = `application/soap+xml; charset=utf-8; action="${ACTION}"`;
const FLAGS = Object.freeze({ bindingReviewed: true, bindingVerified: false, operationAuthorized: false,
  canQuery: false, canTransmit: false, canEmit: false, sefazAuthorized: false,
  xsdValidated: false, verified: false, tlsOriginVerified: false, signatureVerified: false });

// Reviewed local snapshots obtained by a separately authorized GET. No WSDL
// bodies, credentials or SQL grants are embedded here. Hashes pin exact bytes;
// a future document at the same URL does not silently become this profile.
const bindings = Object.freeze(Object.fromEntries([
  ['55', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    '57c25222d3b8b8d8bbf3ae50b646c3ce961f7a8b334199aac976973da391e882', 3189],
  ['65', 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
    '9bd481ee87d12fe983a70cb851d241da6beea457cd3f00eb7572b55e83cf2562', 3192],
].map(([model, endpoint, wsdlHash, wsdlSizeBytes]) => [model, Object.freeze({
  profile: PROFILE, model, environment: '2', operation: 'protocol', reviewedOn: '2026-10-16',
  endpoint, wsdlUrl: endpoint + '?WSDL', wsdlHash, wsdlSizeBytes,
  soapVersion: '1.2', style: 'document', use: 'literal', serviceNamespace: SERVICE,
  bindingName: 'NFeConsultaProtocolo4Soap12', operationName: 'nfeConsultaNF',
  inputElement: 'nfeDadosMsg', outputElement: 'nfeResultMsg', soapAction: ACTION,
  ...FLAGS,
})])));
const requests = new WeakMap();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bytesLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const bytesOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const bytesBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

function fields(value, allowed) {
  try {
    need(value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'SOAP_BINDING_INPUT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    need(keys.length === allowed.length && keys.every(key => typeof key === 'string' && allowed.includes(key)
      && descriptors[key].enumerable && 'value' in descriptors[key]), 'SOAP_BINDING_INPUT_INVALID');
    return Object.fromEntries(allowed.map(key => [key, descriptors[key].value]));
  } catch { throw new FiscalXmlError('SOAP_BINDING_INPUT_INVALID'); }
}
function binding(model) {
  need(typeof model === 'string' && ['55', '65'].includes(model), 'SOAP_BINDING_MODEL_UNSUPPORTED');
  return bindings[model];
}
function copyBytes(value) {
  try {
    need(ArrayBuffer.isView(value) && value instanceof Uint8Array, 'SOAP_BINDING_BYTES_INVALID');
    // Native getters bypass caller accessors/iterators on a Buffer/Uint8Array.
    const size = bytesLength.call(value), buffer = bytesBuffer.call(value), offset = bytesOffset.call(value);
    need(size > 0 && size <= MAX_XML_BYTES
      && !(typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer), 'SOAP_BINDING_BYTES_INVALID');
    return Uint8Array.from(new Uint8Array(buffer, offset, size));
  } catch { throw new FiscalXmlError('SOAP_BINDING_BYTES_INVALID'); }
}

/** Fixed metadata only. This review is not a grant, transport or live binding attestation. */
export function reviewedProtocolBinding(model) { return binding(model); }

/** Offline identity check of a supplied WSDL snapshot; never downloads or parses external dependencies. */
export function verifyReviewedProtocolWsdl(input) {
  const value = fields(input, ['model', 'wsdlBytes']), profile = binding(value.model);
  const bytes = copyBytes(value.wsdlBytes);
  try {
    need(bytes.length === profile.wsdlSizeBytes && sha256(bytes) === profile.wsdlHash, 'SOAP_BINDING_WSDL_MISMATCH');
    return profile;
  } finally { bytes.fill(0); }
}

/** Builds exact UTF-8 content for a future dedicated executor, without authorizing a POST. */
export function prepareReviewedProtocolSoap(input) {
  const value = fields(input, ['accessKey', 'expectedModel', 'environment', 'requestId']);
  const profile = binding(value.expectedModel), draft = prepareProtocolSoapDraft(value);
  need(draft.endpoint === profile.endpoint && draft.model === profile.model && draft.environment === '2', 'SOAP_BINDING_CONTEXT_MISMATCH');
  const prepared = Object.freeze({ ...draft, profile: PROFILE, bindingStatus: 'reviewed-local-wsdl-snapshot', binding: profile,
    method: 'POST', contentType: CONTENT_TYPE, soapAction: ACTION,
    // SOAP1.2 action is a Content-Type parameter, not the SOAP1.1 SOAPAction header.
    headers: Object.freeze({ 'Content-Type': CONTENT_TYPE }),
    envelopeSizeBytes: Buffer.byteLength(draft.envelopeXml, 'utf8'), ...FLAGS,
  });
  requests.set(prepared, Object.freeze({ accessKey: draft.accessKey, model: draft.model, binding: profile }));
  return prepared;
}

/** Owned bounded bytes. A clone or caller-built object cannot supply a new URL/action/body. */
export function encodeReviewedProtocolSoap(request) {
  need(requests.has(request), 'SOAP_BINDING_REQUEST_UNATTESTED');
  return new TextEncoder().encode(request.envelopeXml);
}

/** Extracts an untrusted fiscal candidate bound to a prepared request. XSD/origin/ACL remain external. */
export function extractReviewedProtocolSoap(input) {
  const value = fields(input, ['request', 'envelopeBytes']), context = requests.get(value.request);
  need(context, 'SOAP_BINDING_REQUEST_UNATTESTED');
  const bytes = copyBytes(value.envelopeBytes);
  try {
    let envelopeXml;
    try { envelopeXml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new FiscalXmlError('SOAP_BINDING_ENCODING_INVALID'); }
    const candidate = extractProtocolSoapCandidate({ envelopeXml, expectedAccessKey: context.accessKey,
      expectedModel: context.model, environment: '2' });
    // The response remains untrusted even when its exact bytes and context match.
    need(candidate.envelopeDigest === sha256(bytes), 'SOAP_BINDING_BYTES_MISMATCH');
    return Object.freeze({ ...candidate, profile: PROFILE, bindingStatus: 'reviewed-local-wsdl-snapshot',
      binding: context.binding, envelopeSizeBytes: bytes.length, ...FLAGS });
  } finally { bytes.fill(0); }
}
