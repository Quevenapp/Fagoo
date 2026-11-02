import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { createSigner, disposeSigner, inspectCertificate, signNfeXml, verifyNfeXml } from '../src/index.mjs';
import { C14N, ENVELOPED, NS, RSA_SHA1, SHA1 } from '../src/common.mjs';
import { credentials, HOLDER, NOW, OTHER, unsignedXml } from './fixtures.mjs';

const credential = await credentials();
const signer = createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
const sign = (xml = unsignedXml()) => signNfeXml({xml,signer,expectedIssuerCnpj:HOLDER,now:NOW});
const verify = (xml,overrides = {}) => verifyNfeXml({xml,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW,...overrides});
const fails = (fn,code) => assert.throws(fn,error => error.code === code);

test('synthetic certificate is self-signed; verified metadata does not attest ICP or A1 trust', () => {
  const certificate = new X509Certificate(credential.certificate);
  assert.equal(certificate.verify(certificate.publicKey),true);
  const result = inspectCertificate(credential.certificate,{expectedHolderCnpj:HOLDER,now:NOW});
  assert.equal(result.holderCnpj,HOLDER); assert.equal(result.metadataChecked,true); assert.equal(result.chainTrusted,false); assert.equal(result.typeA1Attested,false);
});
test('NF-e55 and NFC-e65 sign only infNFe with MOC algorithms and verify their authenticated references', () => {
  for (const model of ['55','65']) {
    const result = sign(unsignedXml({model})); const verification = verify(result.signedXml);
    assert.equal(verification.signatureVerified,true); assert.equal(verification.identity.model,model);
    assert.match(verification.authenticatedInfNfe,/^<infNFe/); assert.ok(!verification.authenticatedInfNfe.includes('<Signature'));
    for (const name of ['xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canTransmit']) assert.equal(verification[name],false);
    assert.ok(result.signedXml.includes(RSA_SHA1)); assert.ok(result.signedXml.includes(C14N)); assert.equal((result.signedXml.match(/<Reference /g) ?? []).length,1);
    assert.match(verification.xmlDigest,/^[a-f0-9]{64}$/); assert.ok(Object.isFrozen(verification.identity));
  }
});
test('tampered signed content and altered SignatureValue are rejected', () => {
  const {signedXml} = sign();
  fails(() => verify(signedXml.replace('EMPRESA FICTICIA','EMPRESA ALTERADA')),'XML_SIGNATURE_INVALID');
  fails(() => verify(signedXml.replace(/(<SignatureValue>)[A-Za-z0-9+/]/,(_,prefix) => prefix + '!')),'XML_SIGNATURE_ENCODING_INVALID');
});
test('exact reference, unique Id and root prevent wrapping and nested duplicate invoices', () => {
  const {signedXml} = sign(); const id = signedXml.match(/Id="([^"]+)"/)[1];
  fails(() => verify(signedXml.replace('</emit>',`<extra Id="${id}"/></emit>`)),'XML_DUPLICATE_OR_ALTERNATE_ID');
  fails(() => verify(`<wrapper>${signedXml}</wrapper>`),'XML_NFE_ROOT_INVALID');
  fails(() => verify(signedXml.replace('<xNome>','<xNome xml:id="evil">')),'XML_DUPLICATE_OR_ALTERNATE_ID');
  fails(() => verify(signedXml.replace('</emit>','<infNFe/></emit>')),'XML_INFNFE_DUPLICATED');
  fails(() => verify(signedXml.replace(`URI="#${id}"`,'URI="https://attacker.invalid/data"')),'XML_SIGNATURE_REFERENCE_INVALID');
  fails(() => verify(signedXml.replace(`URI="#${id}"`,'URI=""')),'XML_SIGNATURE_REFERENCE_INVALID');
});
test('candidate KeyInfo cannot choose verification certificate, even for the same CNPJ', async () => {
  const other = await credentials(), {signedXml} = sign();
  fails(() => verify(signedXml.replace(/<X509Certificate>[^<]+/,`<X509Certificate>${other.certificateDer.toString('base64')}`)),'XML_CERTIFICATE_PIN_MISMATCH');
  fails(() => verify(signedXml,{expectedCertificate:other.certificate}),'XML_CERTIFICATE_PIN_MISMATCH');
  // Sign with another private key, publish the pinned certificate: RSA verification must still fail.
  const forged = new SignedXml({privateKey:other.privateKey,publicCert:credential.certificate,signatureAlgorithm:RSA_SHA1,canonicalizationAlgorithm:C14N});
  forged.addReference({xpath:`//*[local-name()='infNFe']`,transforms:[ENVELOPED,C14N],digestAlgorithm:SHA1});
  forged.computeSignature(unsignedXml(),{location:{reference:`/*[local-name()='NFe']`,action:'append'}});
  fails(() => verify(forged.getSignedXml()),'XML_SIGNATURE_INVALID');
});
test('algorithm substitutions, extra references, objects and transform parameters are rejected', () => {
  const {signedXml} = sign();
  fails(() => verify(signedXml.replace(RSA_SHA1,'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')),'XML_SIGNATURE_ALGORITHM_UNSUPPORTED');
  fails(() => verify(signedXml.replace(ENVELOPED,'http://www.w3.org/TR/1999/REC-xslt-19991116')),'XML_SIGNATURE_TRANSFORM_UNSUPPORTED');
  fails(() => verify(signedXml.replace('</SignedInfo>','<Reference URI="#evil"/></SignedInfo>')),'XML_SIGNATURE_STRUCTURE_INVALID');
  fails(() => verify(signedXml.replace('</Signature>','<Object/></Signature>')),'XML_SIGNATURE_STRUCTURE_INVALID');
  fails(() => verify(signedXml.replace('<SignedInfo>','<SignedInfo>unexpected')),'XML_SIGNATURE_STRUCTURE_INVALID');
  fails(() => verify(signedXml.replace('</NFe>','extra</NFe>')),'XML_NFE_STRUCTURE_INVALID');
});
test('parser limits reject deeply nested or over-attributed elements', () => {
  const xml = unsignedXml();
  fails(() => sign(xml.replace('</emit>','<x>'.repeat(90) + '</x>'.repeat(90) + '</emit>')),'XML_TREE_LIMIT');
  fails(() => sign(xml.replace('<xNome>',`<xNome ${Array.from({length:41},(_,i) => `a${i}="x"`).join(' ')}>`)),'XML_ATTRIBUTE_LIMIT');
});
test('signing rechecks certificate expiry and refuses already signed XML', () => {
  fails(() => signNfeXml({xml:unsignedXml(),signer,expectedIssuerCnpj:HOLDER,now:new Date('2028-01-01T00:00:00Z')}),'CERTIFICATE_NOT_CURRENTLY_VALID');
  fails(() => sign(sign().signedXml),'XML_NFE_STRUCTURE_INVALID');
});
test('DTD/XXE/entities, malformed XML, comments, processing instructions and excessive size fail before signing', () => {
  const xml = unsignedXml();
  for (const prefix of ['<!DOCTYPE NFe SYSTEM "file:///etc/passwd">','<!DOCTYPE NFe [<!ENTITY x "boom">]>','<!--comment-->']) fails(() => sign(prefix+xml),'XML_DECLARATION_UNSUPPORTED');
  fails(() => sign('<?danger instruction?>'+xml),'XML_PROCESSING_INSTRUCTION_UNSUPPORTED');
  fails(() => sign(xml.replace('EMPRESA FICTICIA','&unknown;')),'XML_MALFORMED');
  fails(() => sign(xml.replace('</emit>','</emit extra>')),'XML_MALFORMED');
  fails(() => sign(' '.repeat(512001)),'XML_SIZE_INVALID');
  fails(() => sign(xml.replace('EMPRESA FICTICIA','\u0000')),'XML_ENCODING_INVALID');
});
test('issuer, access key, namespace and production gates fail closed', () => {
  fails(() => sign(unsignedXml({environment:'1'})),'XML_PRODUCTION_NOT_SUPPORTED');
  fails(() => sign(unsignedXml({cnpj:OTHER})),'XML_EXPECTED_ISSUER_MISMATCH');
  fails(() => sign(unsignedXml().replace('<nNF>1</nNF>','<nNF>2</nNF>')),'XML_ACCESS_KEY_MISMATCH');
  fails(() => sign(unsignedXml().replace(NS,'urn:not-nfe')),'XML_NFE_ROOT_INVALID');
  fails(() => sign(unsignedXml().replace('</infNFe>','</infNFe><infNFeSupl/>')),'XML_NFE_STRUCTURE_INVALID');
});
test('metadata validity, CNPJ SAN, key usage and matching private key are required', async () => {
  fails(() => inspectCertificate(credential.certificate,{expectedHolderCnpj:OTHER,now:NOW}),'CERTIFICATE_HOLDER_MISMATCH');
  fails(() => inspectCertificate(credential.certificate,{expectedHolderCnpj:HOLDER,now:new Date('2028-01-01T00:00:00Z')}),'CERTIFICATE_NOT_CURRENTLY_VALID');
  fails(() => inspectCertificate(credential.certificate,{expectedHolderCnpj:HOLDER,now:new Date('2025-01-01T00:00:00Z')}),'CERTIFICATE_NOT_CURRENTLY_VALID');
  for (const [options,error] of [[{omitCnpj:true},'CERTIFICATE_CNPJ_MISSING'],[{duplicateCnpj:true},'CERTIFICATE_CNPJ_INVALID'],[{digitalSignature:false},'CERTIFICATE_DIGITAL_SIGNATURE_USAGE_REQUIRED'],[{ca:true},'CERTIFICATE_CA_NOT_ALLOWED']]) {
    const cert = await credentials(options); fails(() => inspectCertificate(cert.certificate,{expectedHolderCnpj:HOLDER,now:NOW}),error);
  }
  const other = await credentials();
  fails(() => createSigner({privateKey:other.privateKey,certificate:credential.certificate,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'}),'PRIVATE_KEY_CERTIFICATE_MISMATCH');
});
test('opaque signer cannot be serialized or reused after disposal; no private key in output', () => {
  const disposable = createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
  assert.ok(!JSON.stringify(disposable).includes('PRIVATE KEY')); assert.equal(disposeSigner(disposable),true);
  fails(() => signNfeXml({xml:unsignedXml(),signer:disposable,expectedIssuerCnpj:HOLDER,now:NOW}),'SIGNER_HANDLE_INVALID_OR_DISPOSED');
  fails(() => signNfeXml({xml:unsignedXml(),signer:{...signer},expectedIssuerCnpj:HOLDER,now:NOW}),'SIGNER_HANDLE_INVALID_OR_DISPOSED');
});
