import test from 'node:test';
import assert from 'node:assert/strict';
import { addNfceOnlineSupplement, createSigner, disposeSigner, NFCE_SP_HOMOLOGATION_QR_V3,
  signNfeXml, verifyNfeXml } from '../src/index.mjs';
import { credentials, HOLDER, NOW, unsignedXml } from './fixtures.mjs';

const credential = await credentials();
const signer = createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
const trust = {expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW};
const profile = NFCE_SP_HOMOLOGATION_QR_V3;
const signed = options => signNfeXml({xml:unsignedXml({model:'65',...options}),signer,expectedIssuerCnpj:HOLDER,now:NOW}).signedXml;
const add = (xml = signed(),overrides = {}) => addNfceOnlineSupplement({xml,profile,...trust,...overrides});
const verify = xml => verifyNfeXml({xml,nfceQrProfile:profile,...trust});
const fails = (fn,code) => assert.throws(fn,error => error.code === code);
test.after(() => disposeSigner(signer));

test('online QR v3 is derived from authenticated identity, preserves signature and uses fixed SP homologation URLs', () => {
  const original = signed(), before = verifyNfeXml({xml:original,...trust});
  const result = add(original), after = verify(result.signedXml);
  assert.equal(after.signatureVerified,true);
  assert.equal(after.signedContentDigest,before.signedContentDigest);
  assert.notEqual(after.xmlDigest,before.xmlDigest);
  assert.equal(result.supplement.qrCode,`https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${before.accessKey}|3|2`);
  assert.equal(result.supplement.urlChave,'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta');
  assert.equal(after.supplement.partOfSignature,false);
  assert.equal(after.supplement.derivedFromSignedIdentity,true);
  assert.equal(result.signedXml.includes('<![CDATA['),false);
  assert.match(result.signedXml,/<\/infNFe><infNFeSupl>.*<\/infNFeSupl><Signature/s);
  assert.ok(Object.isFrozen(after.supplement));
  for (const name of ['xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canTransmit']) {
    assert.equal(result[name],false); assert.equal(after[name],false);
  }
});
test('explicit profile is required; unsigned, already supplemented and profile mismatches are rejected', () => {
  fails(() => add(signed(),{profile:undefined}),'NFCE_QR_PROFILE_UNSUPPORTED');
  fails(() => add(signed(),{profile:'production'}),'NFCE_QR_PROFILE_UNSUPPORTED');
  fails(() => add(unsignedXml({model:'65'})),'XML_NFE_STRUCTURE_INVALID');
  const {signedXml} = add();
  fails(() => verifyNfeXml({xml:signedXml,...trust}),'XML_NFE_STRUCTURE_INVALID');
  fails(() => verify(signed()),'XML_NFE_STRUCTURE_INVALID');
  fails(() => add(signedXml),'XML_NFE_STRUCTURE_INVALID');
});
test('NF-e55, other states, offline contingency and production cannot use this profile', () => {
  for (const options of [{model:'55'},{cUF:'41'},{tpEmis:'9'}]) fails(() => add(signed(options)),'NFCE_QR_IDENTITY_UNSUPPORTED');
  fails(() => add(unsignedXml({model:'65',environment:'1'})),'XML_NFE_STRUCTURE_INVALID');
});
test('altering any unsigned QR field, host, key, version or environment is rejected independently', () => {
  const {signedXml,supplement} = add();
  for (const changed of [
    signedXml.replace('/qrcode?p=','/evil?p='),
    signedXml.replace('/consulta</urlChave>','/other</urlChave>'),
    signedXml.replace('www.homologacao.nfce.fazenda.sp.gov.br/qrcode','attacker.invalid/qrcode'),
    signedXml.replace('|3|2</qrCode>','|3|1</qrCode>'),
    signedXml.replace('|3|2</qrCode>','|2|2</qrCode>'),
    signedXml.replace(supplement.qrCode,supplement.qrCode+'|additional'),
    signedXml.replace(supplement.qrCode,supplement.qrCode.replace('?p=35','?p=41')),
  ]) fails(() => verify(changed),'XML_NFCE_SUPPLEMENT_MISMATCH');
});
test('supplement shape rejects duplicate, misplaced, foreign namespace, nested and attributed content', () => {
  const {signedXml} = add();
  const group = signedXml.match(/<infNFeSupl>.*<\/infNFeSupl>/s)[0];
  fails(() => verify(signedXml.replace(group,group+group)),'XML_NFE_STRUCTURE_INVALID');
  fails(() => verify(signedXml.replace(group,'').replace('</NFe>',group+'</NFe>')),'XML_SIGNATURE_LOCATION_INVALID');
  fails(() => verify(signedXml.replace('<infNFeSupl>','<infNFeSupl xmlns="urn:evil">')),'XML_NFCE_SUPPLEMENT_LOCATION_INVALID');
  fails(() => verify(signedXml.replace('<qrCode>','<qrCode a="b">')),'XML_ATTRIBUTE_UNSUPPORTED');
  fails(() => verify(signedXml.replace('</qrCode>','<extra/></qrCode>')),'XML_NFCE_SUPPLEMENT_INVALID');
  fails(() => verify(signedXml.replace('</urlChave>','</urlChave><qrCode/>')),'XML_NFCE_SUPPLEMENT_INVALID');
  fails(() => verify(signedXml.replace('<infNFeSupl>','<infNFeSupl>extra')),'XML_NFCE_SUPPLEMENT_INVALID');
});
test('supplement does not bypass signed-content tampering, certificate pins or XML parser restrictions', async () => {
  const {signedXml} = add();
  fails(() => verify(signedXml.replace('EMPRESA FICTICIA','ADULTERADA')),'XML_SIGNATURE_INVALID');
  const other = await credentials();
  fails(() => verifyNfeXml({xml:signedXml,nfceQrProfile:profile,...trust,expectedCertificate:other.certificate}),'XML_CERTIFICATE_PIN_MISMATCH');
  fails(() => verify(signedXml.replace('<qrCode>','<qrCode><![CDATA[').replace('</qrCode>',']]></qrCode>')),'XML_DECLARATION_UNSUPPORTED');
});
