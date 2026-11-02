/**
 * Conferência da assinatura digital de um XML de NF-e / NFC-e autorizado (notas fiscais lane, wave F: "Importar XML NF-e").
 * Runs in the Worker (WebCrypto and @xmldom/xmldom only, no Node built-ins). What is checked, in this order:
 *  1. the XMLDSig profile of the NF-e: one Signature in NFe, SignedInfo with C14N 1.0 (inclusive, without comments), RSA-SHA1, one
 *     Reference to "#" + the Id of infNFe with the enveloped-signature and C14N transforms, SHA-1, and one X509Certificate;
 *  2. the digest: SHA-1 of the canonical infNFe equals DigestValue (the content was not changed after signing);
 *  3. the signature: SignatureValue verifies over the canonical SignedInfo with the public key of that certificate;
 *  4. the protocol: digVal of protNFe/infProt equals DigestValue (the authorization belongs to these bytes);
 *  5. the holder: when the certificate carries the CNPJ (ICP-Brasil otherName 2.16.76.1.3.3), its base is the base of the emitter CNPJ.
 * Not checked (said on the screen): the ICP-Brasil chain, revocation and the validity of the certificate on the issue date.
 */
import { DOMParser } from '@xmldom/xmldom';

const NFE = 'http://www.portalfiscal.inf.br/nfe', DS = 'http://www.w3.org/2000/09/xmldsig#', XMLNS = 'http://www.w3.org/2000/xmlns/', XML_NS = 'http://www.w3.org/XML/1998/namespace';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315', ENVELOPED = `${DS}enveloped-signature`, RSA_SHA1 = `${DS}rsa-sha1`, SHA1 = `${DS}sha1`;
export class SignatureCheckError extends Error { constructor(code, field = null) { super(code); this.code = code; this.field = field; } }
const fail = (code, field = null) => { throw new SignatureCheckError(code, field); };
const elements = node => Array.from(node?.childNodes ?? []).filter(n => n.nodeType === 1);
const only = (node, name, ns) => { const found = elements(node).filter(n => n.localName === name && n.namespaceURI === ns); return found.length === 1 ? found[0] : null; };

// ---------------- Canonical XML 1.0 (inclusive, without comments) of an element and its descendants ----------------
const escapeText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
/**
 * The namespaces in scope of an element (prefix '' is the default), from the element and its ancestors up to `boundary` (inclusive; the
 * whole document when null). The NF-e is signed while NFe is the root, so the namespaces nfeProc may add around it are not part of it.
 */
function inScope(element, boundary = null) {
  const chain = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentNode) { chain.unshift(node); if (node === boundary) break; }
  const scope = new Map();
  for (const node of chain) for (const attribute of Array.from(node.attributes ?? [])) {
    if (attribute.namespaceURI !== XMLNS) continue;
    const prefix = attribute.name === 'xmlns' ? '' : attribute.localName;
    if (prefix === '' && attribute.value === '') scope.delete(''); else scope.set(prefix, attribute.value);
  }
  return scope;
}
/** C14N of `apex` as the apex of a document subset (the whole subtree is in the node-set; the Signature is outside infNFe). */
export function canonicalize(apex, boundary = null) {
  let out = '';
  const visit = (node, rendered) => {
    if (node.nodeType === 3 || node.nodeType === 4) { out += escapeText(node.data); return; }
    if (node.nodeType !== 1) return; // comments and processing instructions are not part of C14N without comments
    const scope = inScope(node, boundary), next = new Map(rendered), declarations = [];
    for (const [prefix, uri] of [...scope.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (rendered.get(prefix) !== uri) { declarations.push(prefix === '' ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`); next.set(prefix, uri); }
    }
    // A default namespace rendered above but absent here is undeclared.
    if (!scope.has('') && rendered.has('') && rendered.get('') !== '') { declarations.unshift(' xmlns=""'); next.delete(''); }
    const attributes = Array.from(node.attributes ?? []).filter(a => a.namespaceURI !== XMLNS)
      .map(a => ({ ns: a.namespaceURI ?? '', local: a.localName ?? a.name, name: a.name, value: a.value }))
      .sort((a, b) => (a.ns === b.ns ? (a.local < b.local ? -1 : a.local > b.local ? 1 : 0) : a.ns < b.ns ? -1 : 1));
    out += `<${node.nodeName}${declarations.join('')}${attributes.map(a => ` ${a.name}="${escapeAttribute(a.value)}"`).join('')}>`;
    for (const child of Array.from(node.childNodes ?? [])) visit(child, next);
    out += `</${node.nodeName}>`;
  };
  // The xml prefix is implicit and never rendered.
  visit(apex, new Map([['xml', XML_NS]]));
  return out;
}

/** Bounded strict parse of the XML (no DTD or entities, XML 1.0 line endings), returning the document. */
export function parseSigned(xml, maxBytes = 1024 * 1024) {
  if (typeof xml !== 'string' || !xml || new TextEncoder().encode(xml).byteLength > maxBytes) fail('xml_invalid');
  const body = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (/<!/.test(body)) fail('xml_invalid');
  let doc;
  try { doc = new DOMParser({ normalizeLineEndings: text => text.replace(/\r\n?/g, '\n'), onError: () => { throw new Error('parse'); } }).parseFromString(body, 'application/xml'); } catch { fail('xml_invalid'); }
  if (!doc?.documentElement || doc.doctype) fail('xml_invalid');
  return doc;
}

// ---------------- base64 and DER ----------------
const base64Bytes = (text, field) => {
  const clean = String(text ?? '').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) fail('xml_signature_invalid', field);
  const binary = atob(clean), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const bytesBase64 = bytes => { let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); };
function tlv(bytes, offset) {
  if (offset + 2 > bytes.length) fail('xml_signature_invalid', 'X509Certificate');
  const tag = bytes[offset];
  let length = bytes[offset + 1], start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 4 || start + count > bytes.length) fail('xml_signature_invalid', 'X509Certificate');
    length = 0; for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];
    start += count;
  }
  const end = start + length;
  if (end > bytes.length) fail('xml_signature_invalid', 'X509Certificate');
  return { tag, start, end, offset };
}
const children = (bytes, node) => { const list = []; for (let at = node.start; at < node.end;) { const item = tlv(bytes, at); list.push(item); at = item.end; } return list; };
const oid = (bytes, node) => {
  const v = bytes.subarray(node.start, node.end), parts = [Math.floor(v[0] / 40), v[0] % 40];
  let value = 0; for (let i = 1; i < v.length; i++) { value = value * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { parts.push(value); value = 0; } }
  return parts.join('.');
};
/** The subject public key info and, when present, the CNPJ of the ICP-Brasil holder (otherName 2.16.76.1.3.3 of subjectAltName). */
export function certificateInfo(der) {
  const certificate = tlv(der, 0);
  if (certificate.tag !== 0x30 || certificate.end !== der.length) fail('xml_signature_invalid', 'X509Certificate');
  const [tbs] = children(der, certificate);
  if (!tbs || tbs.tag !== 0x30) fail('xml_signature_invalid', 'X509Certificate');
  const fields = children(der, tbs), start = fields[0]?.tag === 0xa0 ? 1 : 0;
  const spki = fields[start + 5];
  if (!spki || spki.tag !== 0x30) fail('xml_signature_invalid', 'X509Certificate');
  let cnpj = null;
  const extensions = fields.find(f => f.tag === 0xa3);
  if (extensions) {
    const [list] = children(der, extensions);
    for (const extension of list ? children(der, list) : []) {
      const parts = children(der, extension);
      if (parts[0]?.tag !== 0x06 || oid(der, parts[0]) !== '2.5.29.17') continue;
      const octets = parts.at(-1);
      if (octets?.tag !== 0x04) continue;
      const names = tlv(der, octets.start);
      for (const name of names.tag === 0x30 ? children(der, names) : []) {
        if (name.tag !== 0xa0) continue; // otherName
        const [typeId, value] = children(der, name);
        if (typeId?.tag !== 0x06 || oid(der, typeId) !== '2.16.76.1.3.3' || !value) continue;
        const inner = value.tag === 0xa0 ? tlv(der, value.start) : value;
        const digits = new TextDecoder().decode(der.subarray(inner.start, inner.end)).replace(/\D/g, '');
        if (/^\d{14}$/.test(digits)) cnpj = digits;
      }
    }
  }
  return { spki: der.slice(spki.offset, spki.end), cnpj };
}

// ---------------- the check ----------------
/**
 * Checks the signature of an authorized NF-e / NFC-e XML (nfeProc or NFe). Returns { verified: true, digest, holder_cnpj }; throws
 * SignatureCheckError('xml_signature_missing' | 'xml_signature_invalid', field) otherwise. `subtle` is the WebCrypto SubtleCrypto.
 */
export async function verifyNfeSignature(xml, { subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) fail('xml_signature_invalid', 'crypto');
  const doc = parseSigned(xml), root = doc.documentElement;
  const nfe = root.localName === 'NFe' && root.namespaceURI === NFE ? root : only(root, 'NFe', NFE);
  const inf = only(nfe, 'infNFe', NFE);
  if (!nfe || !inf) fail('xml_invalid', 'NFe');
  const signatures = elements(nfe).filter(n => n.localName === 'Signature');
  if (!signatures.length) fail('xml_signature_missing', 'Signature');
  if (signatures.length !== 1 || signatures[0].namespaceURI !== DS) fail('xml_signature_invalid', 'Signature');
  const signature = signatures[0];
  const signedInfo = only(signature, 'SignedInfo', DS), value = only(signature, 'SignatureValue', DS), keyInfo = only(signature, 'KeyInfo', DS);
  const algorithm = (node, name) => only(node, name, DS)?.getAttribute('Algorithm');
  if (!signedInfo || !value || !keyInfo || algorithm(signedInfo, 'CanonicalizationMethod') !== C14N || algorithm(signedInfo, 'SignatureMethod') !== RSA_SHA1) fail('xml_signature_invalid', 'SignedInfo');
  const references = elements(signedInfo).filter(n => n.localName === 'Reference');
  const id = inf.getAttribute('Id');
  if (references.length !== 1 || !id || references[0].getAttribute('URI') !== `#${id}`) fail('xml_signature_invalid', 'Reference');
  const reference = references[0], transforms = elements(only(reference, 'Transforms', DS)).map(t => t.getAttribute('Algorithm'));
  if (transforms.length !== 2 || !transforms.includes(ENVELOPED) || !transforms.includes(C14N) || algorithm(reference, 'DigestMethod') !== SHA1) fail('xml_signature_invalid', 'Transforms');
  const digestValue = only(reference, 'DigestValue', DS)?.textContent?.replace(/\s+/g, '') ?? '';
  const certificates = elements(only(keyInfo, 'X509Data', DS)).filter(n => n.localName === 'X509Certificate');
  if (certificates.length !== 1) fail('xml_signature_invalid', 'X509Certificate');
  // 2. The digest of the canonical infNFe (the enveloped transform removes the Signature, which is outside infNFe). The NFe is signed
  // as its own document; an nfeProc that declares other namespaces around it is also tried as a whole document.
  const contexts = root === nfe ? [null] : [nfe, null];
  const sha1 = async text => bytesBase64(new Uint8Array(await subtle.digest('SHA-1', new TextEncoder().encode(text))));
  let context;
  for (const candidate of contexts) if (await sha1(canonicalize(inf, candidate)) === digestValue) { context = candidate; break; }
  if (context === undefined) fail('xml_signature_invalid', 'DigestValue');
  const digest = digestValue;
  // 3. The signature over the canonical SignedInfo with the key of the certificate of the XML.
  const der = base64Bytes(certificates[0].textContent, 'X509Certificate'), info = certificateInfo(der);
  let key;
  try { key = await subtle.importKey('spki', info.spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['verify']); } catch { fail('xml_signature_invalid', 'X509Certificate'); }
  const signatureBytes = base64Bytes(value.textContent, 'SignatureValue');
  let ok = false;
  for (const candidate of [context, ...contexts.filter(c => c !== context)]) {
    if (await subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, new TextEncoder().encode(canonicalize(signedInfo, candidate)))) { ok = true; break; }
  }
  if (!ok) fail('xml_signature_invalid', 'SignatureValue');
  // 4. The authorization belongs to these bytes.
  const prot = root.localName === 'nfeProc' ? only(only(root, 'protNFe', NFE), 'infProt', NFE) : null;
  const digVal = prot ? only(prot, 'digVal', NFE)?.textContent?.replace(/\s+/g, '') : null;
  if (prot && digVal && digVal !== digestValue) fail('xml_signature_invalid', 'digVal');
  // 5. The holder of an e-CNPJ certificate is the emitter (same CNPJ base, as SEFAZ requires).
  const emitter = only(only(inf, 'emit', NFE), 'CNPJ', NFE)?.textContent ?? null;
  if (info.cnpj && emitter && info.cnpj.slice(0, 8) !== emitter.slice(0, 8)) fail('xml_signature_invalid', 'X509Certificate');
  return { verified: true, digest, holder_cnpj: info.cnpj };
}
