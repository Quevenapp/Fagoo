// Synthetic XMLDSig signer for the "Importar XML" tests (wave F of the notas fiscais lane): one RSA key generated in memory for the
// test process and a self-signed certificate per CNPJ, built here in DER with the ICP-Brasil otherName 2.16.76.1.3.3 of the holder. The
// certificate and the key are fictitious and never leave the process. The canonicalization is the one of the verifier under test; the
// independent cross-check against xml-crypto lives in fiscal-xml-signature.test.mjs.
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { canonicalize, parseSigned } from '../../../../packages/fiscal-xml/src/xml-signature-check.mjs';

const DS = 'http://www.w3.org/2000/09/xmldsig#', C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const spki = publicKey.export({ type: 'spki', format: 'der' });
const length = n => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const seq = (...parts) => tlv(0x30, ...parts);
const oid = text => { const [a, b, ...rest] = text.split('.').map(Number), out = [a * 40 + b]; for (const v of rest) { const bytes = [v & 0x7f]; for (let x = v >> 7; x; x >>= 7) bytes.unshift((x & 0x7f) | 0x80); out.push(...bytes); } return tlv(0x06, Buffer.from(out)); };
const utf8 = text => tlv(0x0c, Buffer.from(text, 'utf8'));
const name = text => seq(tlv(0x31, seq(oid('2.5.4.3'), utf8(text))));
const certificates = new Map();
/** A self-signed synthetic certificate (DER) of the holder CNPJ (null: no CNPJ in the certificate). */
export function syntheticCertificate(cnpj = null) {
  const cacheKey = cnpj ?? '';
  if (!certificates.has(cacheKey)) {
    const sha256Rsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
    const san = cnpj ? tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0xa0, oid('2.16.76.1.3.3'), tlv(0xa0, tlv(0x04, Buffer.from(cnpj, 'ascii'))))))))) : Buffer.alloc(0);
    const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([0x01, 0x23])), sha256Rsa, name('CERTIFICADO FICTICIO BRUFAP'),
      seq(tlv(0x17, Buffer.from('260101000000Z')), tlv(0x17, Buffer.from('271231235959Z'))), name(`EMPRESA FICTICIA:${cnpj ?? 'SEM CNPJ'}`), spki, san);
    const signer = createSign('sha256'); signer.update(tbs);
    certificates.set(cacheKey, seq(tbs, sha256Rsa, tlv(0x03, Buffer.concat([Buffer.from([0]), signer.sign(privateKey)]))));
  }
  return certificates.get(cacheKey);
}
/** The synthetic key and certificate as PEM, for the independent signer of the cross-check (xml-crypto). */
export const syntheticKeyPem = () => privateKey.export({ type: 'pkcs8', format: 'pem' });
export const syntheticCertificatePem = cnpj => `-----BEGIN CERTIFICATE-----\n${syntheticCertificate(cnpj).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
const sha1 = text => createHash('sha1').update(text, 'utf8').digest('base64');
/**
 * Signs the NFe of an nfeProc (or NFe) string like an emitter: Signature after infNFe (and infNFeSupl) with the digest of the canonical
 * infNFe, and the digVal of protNFe set to that digest. `cnpj` is the holder of the certificate (the emitter by default).
 */
export function signNfe(xml, { cnpj, digVal = true } = {}) {
  const doc = parseSigned(xml), inf = doc.getElementsByTagName('infNFe')[0], key = inf.getAttribute('Id');
  const digest = sha1(canonicalize(inf));
  const signedInfo = `<SignedInfo><CanonicalizationMethod Algorithm="${C14N}"/><SignatureMethod Algorithm="${DS}rsa-sha1"/><Reference URI="#${key}"><Transforms><Transform Algorithm="${DS}enveloped-signature"/>`
    + `<Transform Algorithm="${C14N}"/></Transforms><DigestMethod Algorithm="${DS}sha1"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const certificate = syntheticCertificate(cnpj === undefined ? (/<emit><CNPJ>(\d{14})<\/CNPJ>/.exec(xml)?.[1] ?? null) : cnpj).toString('base64');
  const draft = `<Signature xmlns="${DS}">${signedInfo}<SignatureValue>AA==</SignatureValue><KeyInfo><X509Data><X509Certificate>${certificate}</X509Certificate></X509Data></KeyInfo></Signature>`;
  const placed = xml.replace('</NFe>', `${draft}</NFe>`);
  const signer = createSign('RSA-SHA1'); signer.update(canonicalize(parseSigned(placed).getElementsByTagNameNS(DS, 'SignedInfo')[0]), 'utf8');
  const signed = placed.replace('<SignatureValue>AA==</SignatureValue>', `<SignatureValue>${signer.sign(privateKey, 'base64')}</SignatureValue>`);
  return { xml: digVal ? signed.replace(/<digVal>[^<]*<\/digVal>/, `<digVal>${digest}</digVal>`) : signed, digest };
}
