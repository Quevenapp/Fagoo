import { NS, need, sha256, safeError } from './common.mjs';
import { parseStrict, elements, serialize } from './xml.mjs';
import { prepareProtocolQuery } from './protocol-query.mjs';

const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
// National service naming convention, NOT a downloaded/verified SP WSDL binding.
// Do not promote this draft into a network client without reviewing that binding.
const SERVICE = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4';
const PROFILE = 'sp-protocol-soap12-offline-draft-v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const NO_TRUST = Object.freeze({ bindingVerified: false, xsdValidated: false, verified: false,
  tlsOriginVerified: false, signatureVerified: false, sefazAuthorized: false, canTransmit: false });

function parameters(value, allowed) {
  need(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'SOAP_INPUT_INVALID');
}
function attributes(node, allowed = []) {
  for (const attr of Array.from(node.attributes ?? [])) {
    if (attr.namespaceURI === XMLNS) continue;
    need(!attr.namespaceURI && allowed.includes(attr.name), 'SOAP_ATTRIBUTE_UNSUPPORTED');
  }
}
function whitespace(node) {
  need(Array.from(node.childNodes).every(child => child.nodeType !== 3 || !child.data.trim()), 'SOAP_MIXED_CONTENT');
}
function exact(node, name, namespace) {
  need(node?.localName === name && node.namespaceURI === namespace, 'SOAP_STRUCTURE_INVALID');
}
function one(parent, name, namespace = NS) {
  const matches = elements(parent).filter(node => node.localName === name);
  need(matches.length === 1 && matches[0].namespaceURI === namespace, 'SOAP_CONTEXT_AMBIGUOUS');
  return matches[0];
}
function text(node) {
  attributes(node); need(elements(node).length === 0, 'SOAP_CONTEXT_AMBIGUOUS'); return node.textContent;
}
function context(payload, expectedKey) {
  exact(payload, 'retConsSitNFe', NS); attributes(payload, ['versao']);
  need(payload.getAttribute('versao') === '4.00', 'SOAP_LAYOUT_UNSUPPORTED');
  need(text(one(payload, 'tpAmb')) === '2' && text(one(payload, 'cUF')) === '35'
    && text(one(payload, 'chNFe')) === expectedKey, 'SOAP_QUERY_CONTEXT_MISMATCH');
  const all = [payload, ...Array.from(payload.getElementsByTagName('*'))];
  // Reject outer-context duplicates, even under an unrelated namespace/wrapper.
  need(all.filter(node => node.localName === 'retConsSitNFe').length === 1, 'SOAP_PAYLOAD_AMBIGUOUS');
  const protocols = all.filter(node => node.localName === 'protNFe');
  need(protocols.length <= 1 && protocols.every(node => node.parentNode === payload && node.namespaceURI === NS), 'SOAP_PROTOCOL_AMBIGUOUS');
  const infos = all.filter(node => node.localName === 'infProt');
  need(infos.length === protocols.length && infos.every(node => node.parentNode === protocols[0] && node.namespaceURI === NS), 'SOAP_PROTOCOL_AMBIGUOUS');
  if (infos.length) {
    need(text(one(infos[0], 'tpAmb')) === '2' && text(one(infos[0], 'chNFe')) === expectedKey, 'SOAP_QUERY_CONTEXT_MISMATCH');
  }
  // Includes any observed event/cancellation context. Full event/schema validation
  // is still required downstream; none of these nodes become authenticated here.
  for (const node of all) if (['tpAmb', 'chNFe', 'cUF'].includes(node.localName)) {
    need(node.namespaceURI === NS, 'SOAP_CONTEXT_NAMESPACE_INVALID');
    need(one(node.parentNode, node.localName) === node, 'SOAP_CONTEXT_AMBIGUOUS');
    need(text(node) === ({ tpAmb: '2', chNFe: expectedKey, cUF: '35' })[node.localName], 'SOAP_QUERY_CONTEXT_MISMATCH');
  }
}

/** Pure draft: no fetch/http, certificate, retry policy, SOAPAction or trust claim. */
export function prepareProtocolSoapDraft(input) {
  parameters(input, ['accessKey', 'expectedModel', 'environment', 'requestId']);
  const query = prepareProtocolQuery(input);
  const envelopeXml = `<soap12:Envelope xmlns:soap12="${SOAP}"><soap12:Body><nfeDadosMsg xmlns="${SERVICE}">${query.xml}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
  return Object.freeze({ ...query, profile: PROFILE, envelopeXml, envelopeDigest: sha256(envelopeXml),
    contentType: 'application/soap+xml; charset=utf-8', soapAction: null,
    bindingStatus: 'pending-sp-wsdl', ...NO_TRUST });
}

/**
 * Extracts a bounded, untrusted candidate for ProtocolValidator, not a response
 * accepted by SEFAZ. Returned XML is serialized from the selected DOM subtree:
 * its digest is distinct from the hash of the original envelope bytes.
 */
export function extractProtocolSoapCandidate(input) {
  parameters(input, ['envelopeXml', 'expectedAccessKey', 'expectedModel', 'environment']);
  const expected = prepareProtocolQuery({ accessKey: input.expectedAccessKey, expectedModel: input.expectedModel,
    environment: input.environment, requestId: 'offline-soap-context' });
  const doc = parseStrict(input.envelopeXml), envelope = doc.documentElement;
  exact(envelope, 'Envelope', SOAP); attributes(envelope); whitespace(envelope);
  const children = elements(envelope);
  need(children.length === 1 || children.length === 2, 'SOAP_STRUCTURE_INVALID');
  if (children.length === 2) {
    exact(children[0], 'Header', SOAP); attributes(children[0]); whitespace(children[0]);
    need(elements(children[0]).length === 0, 'SOAP_HEADER_UNSUPPORTED');
  }
  const body = children.at(-1); exact(body, 'Body', SOAP); attributes(body); whitespace(body);
  const all = [envelope, ...Array.from(envelope.getElementsByTagName('*'))];
  need(all.filter(node => node.localName === 'Envelope').length === 1
    && all.filter(node => node.localName === 'Body').length === 1
    && all.filter(node => node.localName === 'Header').length === children.length - 1, 'SOAP_WRAPPING_REJECTED');
  need(!all.some(node => node.localName === 'Fault'), 'SOAP_FAULT_REJECTED');
  const results = elements(body);
  need(results.length === 1, 'SOAP_RESULT_AMBIGUOUS');
  const result = results[0]; exact(result, 'nfeResultMsg', SERVICE); attributes(result); whitespace(result);
  need(all.filter(node => node.localName === 'nfeResultMsg').length === 1, 'SOAP_RESULT_AMBIGUOUS');
  const payloads = elements(result);
  need(payloads.length === 1, 'SOAP_PAYLOAD_AMBIGUOUS');
  const payload = payloads[0]; context(payload, expected.accessKey);
  let payloadXml;
  try { payloadXml = serialize(payload); } catch { throw safeError(null, 'SOAP_SERIALIZATION_FAILED'); }
  // Reparse ensures inherited namespaces survive standalone serialization.
  context(parseStrict(payloadXml).documentElement, expected.accessKey);
  return Object.freeze({ profile: PROFILE, payloadXml, payloadDigest: sha256(payloadXml),
    envelopeDigest: sha256(input.envelopeXml), model: expected.model, environment: '2',
    queryContextMatched: true, requiresProtocolValidation: true,
    bindingStatus: 'pending-sp-wsdl', ...NO_TRUST });
}
