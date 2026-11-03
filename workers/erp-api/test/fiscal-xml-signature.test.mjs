import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { X509Certificate } from 'node:crypto';
import { canonicalize, certificateInfo, parseSigned, verifyNfeSignature, SignatureCheckError } from '../../../packages/fiscal-xml/src/xml-signature-check.mjs';
import { nfeXml, SUPPLIER, COMPANY } from './helpers/fiscal-import-xml.mjs';
import { signNfe, syntheticCertificate, syntheticCertificatePem, syntheticKeyPem } from './helpers/fiscal-xml-signer.mjs';

// Wave F of the notas fiscais lane (synthetic certificate and key in memory only): the signature check of "Importar XML", cross-checked
// both ways with xml-crypto, the independent XMLDSig library the homologation emitter signs with.
const { SignedXml } = createRequire(new URL('../../../packages/fiscal-xml/package.json', import.meta.url))('xml-crypto');
const DS = 'http://www.w3.org/2000/09/xmldsig#', C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const refused = (code, field) => error => error instanceof SignatureCheckError && error.code === code && (field === undefined || error.field === field);
/** The NFe signed by xml-crypto (as the emitter signs before SEFAZ wraps it in nfeProc), then wrapped with the protocol. */
function xmlCryptoSigned(unsignedNfe, protocol = '', cnpj = SUPPLIER) {
  const signer = new SignedXml({ privateKey: syntheticKeyPem(), publicCert: syntheticCertificatePem(cnpj), signatureAlgorithm: `${DS}rsa-sha1`, canonicalizationAlgorithm: C14N });
  signer.addReference({ xpath: "//*[local-name()='infNFe']", transforms: [`${DS}enveloped-signature`, C14N], digestAlgorithm: `${DS}sha1` });
  signer.computeSignature(unsignedNfe, { location: { reference: "//*[local-name()='NFe']", action: 'append' } });
  const signed = signer.getSignedXml(), digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(signed)[1];
  return { xml: `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${signed}${protocol.replace(/<digVal>[^<]*<\/digVal>/, `<digVal>${digest}</digVal>`)}</nfeProc>`, digest };
}
const split = xml => ({ nfe: /<NFe[\s>][\s\S]*<\/NFe>/.exec(xml)[0].replace(/<Signature[\s\S]*<\/Signature>/, ''), protocol: /<protNFe[\s\S]*<\/protNFe>/.exec(xml)?.[0] ?? '' });

test('a signature made by xml-crypto is verified, including texts that need escaping and accents', async () => {
  const { xml } = nfeXml({ signature: 'none', items: [{ code: 'A&B', name: 'Peça "dupla" & cia <sintética> > outra', quantity: '1.0000', price: '3.0000' }] });
  const { nfe, protocol } = split(xml);
  const signed = xmlCryptoSigned(nfe, protocol);
  const result = await verifyNfeSignature(signed.xml);
  assert.deepEqual([result.verified, result.digest, result.holder_cnpj], [true, signed.digest, SUPPLIER]);
});

test('a signature of the synthetic signer is verified by xml-crypto: the canonical form is the one of the standard', () => {
  const { xml } = nfeXml({ items: [{ code: 'Q', name: "Aspas 'simples' & <tags>", quantity: '2.0000', price: '1.5000' }] });
  const nfe = /<NFe[\s>][\s\S]*<\/NFe>/.exec(xml)[0];
  const verifier = new SignedXml({ publicCert: syntheticCertificatePem(SUPPLIER), getCertFromKeyInfo: () => null });
  verifier.loadSignature(/<Signature[\s\S]*<\/Signature>/.exec(nfe)[0]);
  assert.equal(verifier.checkSignature(nfe), true);
});

test('the NFe is canonicalized as its own document when nfeProc declares other namespaces around it', async () => {
  const { xml } = nfeXml({ signature: 'none' }), { nfe, protocol } = split(xml);
  const signed = xmlCryptoSigned(nfe, protocol);
  const wrapped = signed.xml.replace('<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">', '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" versao="4.00">');
  assert.notEqual(wrapped, signed.xml);
  assert.equal((await verifyNfeSignature(wrapped)).verified, true);
});

test('changed content, protocol, certificate, algorithms or a missing signature are refused with the field', async () => {
  const { xml } = nfeXml();
  await assert.rejects(verifyNfeSignature(xml.replace('Parafuso sintético', 'Prego sintético')), refused('xml_signature_invalid', 'DigestValue'));
  await assert.rejects(verifyNfeSignature(xml.replace(/<SignatureValue>[A-Za-z0-9+/]{8}/, '<SignatureValue>AAAAAAAA')), refused('xml_signature_invalid', 'SignatureValue'));
  await assert.rejects(verifyNfeSignature(xml.replace(/<digVal>[^<]+<\/digVal>/, '<digVal>c2ludGV0aWNv</digVal>')), refused('xml_signature_invalid', 'digVal'));
  await assert.rejects(verifyNfeSignature(xml.replace('rsa-sha1', 'rsa-sha256')), refused('xml_signature_invalid', 'SignedInfo'));
  await assert.rejects(verifyNfeSignature(xml.replace(/URI="#NFe\d+"/, 'URI="#outra"')), refused('xml_signature_invalid', 'Reference'));
  await assert.rejects(verifyNfeSignature(nfeXml({ signature: 'none' }).xml), refused('xml_signature_missing', 'Signature'));
  await assert.rejects(verifyNfeSignature(nfeXml({ signature: 'fake' }).xml), refused('xml_signature_invalid'));
  // A certificate of another CNPJ base than the emitter is refused; a certificate without the ICP-Brasil CNPJ is checked by the key only.
  await assert.rejects(verifyNfeSignature(nfeXml({ signer: COMPANY }).xml), refused('xml_signature_invalid', 'X509Certificate'));
  assert.equal((await verifyNfeSignature(nfeXml({ signer: null }).xml)).holder_cnpj, null);
  // Another key: the certificate of the XML is replaced by one that does not match the signature.
  const other = xml.replace(/<X509Certificate>[^<]+<\/X509Certificate>/, `<X509Certificate>${Buffer.from(syntheticCertificate('99999999000191')).toString('base64')}</X509Certificate>`);
  assert.notEqual(other, xml);
  await assert.rejects(verifyNfeSignature(other), refused('xml_signature_invalid'));
  for (const forbidden of [`<!DOCTYPE x>${xml}`, '', 'x'.repeat(10)]) await assert.rejects(verifyNfeSignature(forbidden), error => error instanceof SignatureCheckError);
});

test('canonical XML: namespaces once, sorted attributes, start and end tags and the escapes of the standard', () => {
  const doc = parseSigned('<a xmlns="urn:a" xmlns:z="urn:z"><b z:y="2" x="1&amp;&lt;&#9;"/><c xmlns="urn:a">t&gt;&#13;</c><d xmlns=""><e/></d></a>');
  assert.equal(canonicalize(doc.documentElement), '<a xmlns="urn:a" xmlns:z="urn:z"><b x="1&amp;&lt;&#x9;" z:y="2"></b><c>t&gt;&#xD;</c><d xmlns=""><e></e></d></a>');
  const inner = doc.getElementsByTagName('b')[0];
  assert.equal(canonicalize(inner), '<b xmlns="urn:a" xmlns:z="urn:z" x="1&amp;&lt;&#x9;" z:y="2"></b>', 'the apex renders the namespaces in scope');
  const info = certificateInfo(new Uint8Array(syntheticCertificate(SUPPLIER)));
  assert.equal(info.cnpj, SUPPLIER);
  assert.deepEqual(Buffer.from(info.spki), new X509Certificate(syntheticCertificate(SUPPLIER)).publicKey.export({ type: 'spki', format: 'der' }));
  assert.equal(signNfe(nfeXml({ signature: 'none' }).xml).digest.length, 28);
});
