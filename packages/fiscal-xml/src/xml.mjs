import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { C14N, DS, ENVELOPED, MAX_XML_BYTES, NS, RSA_SHA1, SHA1, need, safeError } from './common.mjs';
import { expectedNfceSupplement } from './nfce-profile.mjs';

export const elements = node => Array.from(node.childNodes ?? []).filter(child => child.nodeType === 1);
export const serialize = node => new XMLSerializer().serializeToString(node, { requireWellFormed:true });
function noAttributesExcept(node, permitted = []) {
  for (const attribute of Array.from(node.attributes ?? [])) {
    if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
    need(!attribute.namespaceURI && permitted.includes(attribute.name), 'XML_ATTRIBUTE_UNSUPPORTED');
  }
}
export function parseStrict(xml) {
  need(typeof xml === 'string' && Buffer.byteLength(xml,'utf8') > 0 && Buffer.byteLength(xml,'utf8') <= MAX_XML_BYTES, 'XML_SIZE_INVALID');
  need(!xml.includes('\uFEFF') && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml) && Buffer.from(xml,'utf8').toString('utf8') === xml, 'XML_ENCODING_INVALID');
  // This narrow profile deliberately excludes DTD, entity declarations, comments and CDATA.
  // It prevents external entity resolution before any XML library is invoked.
  need(!/<!/i.test(xml), 'XML_DECLARATION_UNSUPPORTED');
  // XML1.0 §4.3.3: encoding names are case-insensitive; XML syntax is not.
  const declaration = xml.match(/^<\?xml version="1\.0"(?: encoding="[Uu][Tt][Ff]-8")?\?>/);
  const body = declaration ? xml.slice(declaration[0].length) : xml;
  need(!body.includes('<?'), 'XML_PROCESSING_INSTRUCTION_UNSUPPORTED');
  need((body.match(/</g) ?? []).length <= 40000, 'XML_NODE_LIMIT');
  let doc;
  try { doc = new DOMParser({ onError:() => { throw new Error('XML_PARSE_REJECTED'); } }).parseFromString(xml,'application/xml'); }
  catch { throw safeError(null,'XML_MALFORMED'); }
  need(doc.documentElement && !doc.doctype, 'XML_ROOT_REQUIRED');
  let count = 0;
  const stack = [[doc,0]];
  while (stack.length) {
    const [node,depth] = stack.pop();
    need(depth <= 80 && ++count <= 25000, 'XML_TREE_LIMIT');
    need([1,3,7,9].includes(node.nodeType), 'XML_NODE_TYPE_UNSUPPORTED');
    if (node.nodeType === 7) need(node.target === 'xml' && node.parentNode === doc && node === doc.firstChild, 'XML_PROCESSING_INSTRUCTION_UNSUPPORTED');
    if (node.nodeType === 1) need(node.attributes.length <= 40, 'XML_ATTRIBUTE_LIMIT');
    for (const child of Array.from(node.childNodes ?? [])) stack.push([child,depth+1]);
  }
  need(elements(doc).length === 1 && Array.from(doc.childNodes).every(node => node.nodeType !== 3 || !node.data.trim()),'XML_ROOT_AMBIGUOUS');
  return doc;
}
const named = (node,name,ns = NS) => elements(node).filter(child => child.localName === name && child.namespaceURI === ns);
function one(node,name,ns = NS) { const result = named(node,name,ns); need(result.length === 1,'XML_REQUIRED_ELEMENT_AMBIGUOUS'); return result[0]; }
function leaf(node,name) {
  const value = one(node,name); need(elements(value).length === 0,'XML_VALUE_NOT_TEXT');
  return value.textContent;
}
function signatureShape(signature,id,expectedCertificateDer) {
  const check = (node,children,attributes = []) => {
    need(node.namespaceURI === DS,'XML_SIGNATURE_NAMESPACE_INVALID'); noAttributesExcept(node,attributes);
    need(elements(node).map(child => child.localName).join(',') === children.join(','),'XML_SIGNATURE_STRUCTURE_INVALID');
    for (const child of elements(node)) need(child.namespaceURI === DS,'XML_SIGNATURE_NAMESPACE_INVALID');
    if (children.length || attributes.includes('Algorithm')) need(Array.from(node.childNodes).every(child => child.nodeType !== 3 || !child.data.trim()),'XML_SIGNATURE_STRUCTURE_INVALID');
  };
  check(signature,['SignedInfo','SignatureValue','KeyInfo']);
  const info = one(signature,'SignedInfo',DS); check(info,['CanonicalizationMethod','SignatureMethod','Reference']);
  const method = one(info,'CanonicalizationMethod',DS); check(method,[],['Algorithm']); need(method.getAttribute('Algorithm') === C14N,'XML_SIGNATURE_ALGORITHM_UNSUPPORTED');
  const algorithm = one(info,'SignatureMethod',DS); check(algorithm,[],['Algorithm']); need(algorithm.getAttribute('Algorithm') === RSA_SHA1,'XML_SIGNATURE_ALGORITHM_UNSUPPORTED');
  const reference = one(info,'Reference',DS); check(reference,['Transforms','DigestMethod','DigestValue'],['URI']); need(reference.getAttribute('URI') === '#' + id,'XML_SIGNATURE_REFERENCE_INVALID');
  const transforms = one(reference,'Transforms',DS); check(transforms,['Transform','Transform']);
  elements(transforms).forEach((transform,index) => { check(transform,[],['Algorithm']); need(transform.getAttribute('Algorithm') === [ENVELOPED,C14N][index],'XML_SIGNATURE_TRANSFORM_UNSUPPORTED'); });
  const digest = one(reference,'DigestMethod',DS); check(digest,[],['Algorithm']); need(digest.getAttribute('Algorithm') === SHA1,'XML_SIGNATURE_ALGORITHM_UNSUPPORTED');
  const digestValue = one(reference,'DigestValue',DS); check(digestValue,[]);
  need(/^[A-Za-z0-9+/]{27}=$/.test(digestValue.textContent) && Buffer.from(digestValue.textContent,'base64').toString('base64') === digestValue.textContent,'XML_DIGEST_ENCODING_INVALID');
  const signatureValue = one(signature,'SignatureValue',DS); check(signatureValue,[]);
  need(/^[A-Za-z0-9+/]+={0,2}$/.test(signatureValue.textContent) && signatureValue.textContent.length <= 684
    && Buffer.from(signatureValue.textContent,'base64').toString('base64') === signatureValue.textContent,'XML_SIGNATURE_ENCODING_INVALID');
  const keyInfo = one(signature,'KeyInfo',DS); check(keyInfo,['X509Data']);
  const data = one(keyInfo,'X509Data',DS); check(data,['X509Certificate']);
  const certificate = one(data,'X509Certificate',DS); check(certificate,[]);
  const encoded = certificate.textContent;
  need(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && Buffer.from(encoded,'base64').toString('base64') === encoded,'XML_CERTIFICATE_ENCODING_INVALID');
  // Candidate KeyInfo must equal the pinned certificate, but never supplies the verification key.
  need(Buffer.from(encoded,'base64').equals(expectedCertificateDer),'XML_CERTIFICATE_PIN_MISMATCH');
}

export function inspectNfe(xml,{ signed = false, expectedCertificateDer, nfceQrProfile } = {}) {
  const doc = parseStrict(xml), root = doc.documentElement;
  need(root.localName === 'NFe' && root.namespaceURI === NS && !root.prefix,'XML_NFE_ROOT_INVALID'); noAttributesExcept(root);
  const children = elements(root);
  need(Array.from(root.childNodes).every(child => child.nodeType !== 3 || !child.data.trim()),'XML_NFE_STRUCTURE_INVALID');
  const withSupplement = signed && nfceQrProfile !== undefined;
  need(children.length === (signed ? (withSupplement ? 3 : 2) : 1) && children[0].localName === 'infNFe' && children[0].namespaceURI === NS, 'XML_NFE_STRUCTURE_INVALID');
  const signature = signed ? children.at(-1) : null;
  const inf = children[0]; noAttributesExcept(inf,['Id','versao']);
  const id = inf.getAttribute('Id'); need(inf.getAttribute('versao') === '4.00' && /^NFe[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/.test(id),'XML_NFE_ID_INVALID');
  for (const element of Array.from(doc.getElementsByTagName('*'))) {
    for (const attribute of Array.from(element.attributes)) if (attribute.localName?.toLowerCase() === 'id') need(element === inf && attribute.name === 'Id' && !attribute.namespaceURI,'XML_DUPLICATE_OR_ALTERNATE_ID');
    if (element === root || element === inf || inf.contains(element)) need(element.namespaceURI === NS && !element.prefix,'XML_NFE_NAMESPACE_INVALID');
    if (element.localName === 'NFe') need(element === root,'XML_NFE_DUPLICATED');
    if (element.localName === 'infNFe') need(element === inf,'XML_INFNFE_DUPLICATED');
    if (element.localName === 'Signature') need(signed && element === signature && element.namespaceURI === DS,'XML_SIGNATURE_LOCATION_INVALID');
    if (element.localName === 'infNFeSupl') need(withSupplement && element === children[1] && element.namespaceURI === NS,'XML_NFCE_SUPPLEMENT_LOCATION_INVALID');
  }
  const ide = one(inf,'ide'), emit = one(inf,'emit');
  const identity = { cUF:leaf(ide,'cUF'),cnpj:leaf(emit,'CNPJ'),model:leaf(ide,'mod'),environment:leaf(ide,'tpAmb'),series:leaf(ide,'serie'),
    number:leaf(ide,'nNF'),issuedAt:leaf(ide,'dhEmi'),cNF:leaf(ide,'cNF'),tpEmis:leaf(ide,'tpEmis') };
  need(identity.environment === '2','XML_PRODUCTION_NOT_SUPPORTED');
  let key; try { key = buildAccessKey(identity); } catch { throw safeError(null,'XML_FISCAL_IDENTITY_INVALID'); }
  need(id === 'NFe' + key && leaf(ide,'cDV') === key.at(-1),'XML_ACCESS_KEY_MISMATCH');
  if (withSupplement) {
    const supplement = children[1], expected = expectedNfceSupplement(identity,nfceQrProfile);
    need(supplement.localName === 'infNFeSupl' && supplement.namespaceURI === NS && !supplement.prefix,'XML_NFCE_SUPPLEMENT_LOCATION_INVALID');
    noAttributesExcept(supplement);
    need(Array.from(supplement.childNodes).every(child => child.nodeType !== 3 || !child.data.trim()),'XML_NFCE_SUPPLEMENT_INVALID');
    const fields = elements(supplement);
    need(fields.length === 2 && fields.map(field => field.localName).join(',') === 'qrCode,urlChave','XML_NFCE_SUPPLEMENT_INVALID');
    for (const field of fields) {
      need(field.namespaceURI === NS && !field.prefix && elements(field).length === 0,'XML_NFCE_SUPPLEMENT_INVALID');
      noAttributesExcept(field);
      need(field.textContent === expected[field.localName],'XML_NFCE_SUPPLEMENT_MISMATCH');
    }
  }
  if (signed) {
    need(signature.localName === 'Signature' && signature.namespaceURI === DS,'XML_SIGNATURE_LOCATION_INVALID');
    signatureShape(signature,id,expectedCertificateDer);
  }
  return { doc,inf,signature,id,identity,accessKey:key };
}
