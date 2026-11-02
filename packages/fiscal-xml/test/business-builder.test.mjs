import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildBusinessXml } from '../src/business-builder.mjs';
import { resolveBusinessContent, resolveBusinessDocument } from '../../fiscal-core/src/business-document.mjs';
import { businessContentFixture } from '../../fiscal-core/test/business-content-fixtures.mjs';
import { businessFixture, refreshTaxProof } from '../../fiscal-core/test/business-fixtures.mjs';
import { credentials,HOLDER,NOW } from './fixtures.mjs';
import { createSigner, disposeSigner, signNfeXml, verifyNfeXml, addNfceOnlineSupplement, NFCE_SP_HOMOLOGATION_QR_V3 } from '../src/index.mjs';
import { parseStrict } from '../src/xml.mjs';

const credential=await credentials();
test('content extraction preserves the pre-refactor document and XML bytes for every supported branch and limits',()=>{
  // Digests captured from the previous implementation before extracting content.
  const golden=[
    [{model:'55',csosn:'101'},'ea2c6961859772fd8bf5d7e505e4c9eda990cf50a1c8f823c4e8511b2e0752ed','e93b8dd59291796614e95ef6e93637c00da4d812e5937740451168af03aa907e'],
    [{model:'55',csosn:'102'},'a5964f09abdedf2efccc32de347d169b97f8d5b23f7b43c27e7b43f0c092fdbf','6c519a609e63a8e752699f8d0816eb95f264ed69cd1bc21b75a912afe88c6d7f'],
    [{model:'55',csosn:'500'},'b3c5909adac93cd04294df31e5784e53d9dc6a25333236e31734c2e520cbfd9d','f6f423221f1f3b47e68cfda35a0d2ee46f58f8a36d92b71bbc41354b208e3170'],
    [{model:'65',csosn:'102'},'8ac88616c3be4df3de73f99b920457a47deb7b393f151065534686179993d85d','f88b4bb441b4a35e561b377d8d387ee7f5c2d7f65c8c37989551fd7b871614ff'],
    [{model:'65',csosn:'500'},'8b07583a46151fc102afbcdc141cbbcb1bf3ca9c038a6a9d38c9408013c6185b','33cc19eea1ad2a0f3906a86acefe21e1109ca5a10d52c12486e2d9491468ddc4'],
    [{count:2,discount:'0.03',freight:'1.01',other:'0.01'},'625bdfba7a1a698d814bef5f7aa4cc5a3d7c67b7f23428ea9f427686784470ee','149811c869be3505be8a80f2a97851bdb4245d9eeedfe46deba711cc7dd9e9b8'],
    [{count:250},'c952fac2bbc95a40132b0c02f744bfe620bd8d1427e25fdacf89da0dd1c5380f','57cb9bfc8b355fccb62efba696b404c2c11dbc2314ab05afca1b711d0084cdee'],
  ];
  const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
  for(const[options,documentHash,xmlHash]of golden){const input=businessFixture(options);
    assert.equal(digest(JSON.stringify(resolveBusinessDocument(input))),documentHash);
    const result=buildBusinessXml(input);assert.equal(digest(result.unsignedXml),xmlHash);assert.equal(result.unsigned_xml_sha256,xmlHash);
  }
  assert.throws(()=>buildBusinessXml(resolveBusinessContent(businessContentFixture().input)));
});
test('business-generated 55/65 are authenticated through the existing synthetic signer without changing the business flags',()=>{
  const signer=createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
  try {
    for(const model of['55','65'])for(const csosn of(model==='55'?['101','102','500']:['102','500'])){
      const f=businessFixture({model,csosn}),r=buildBusinessXml(f);
      assert.match(r.unsignedXml,new RegExp('<ICMSSN'+csosn+'>'));assert.match(r.unsignedXml,/<PISOutr><CST>49<\/CST>/);
      const signed=signNfeXml({xml:r.unsignedXml,signer,expectedIssuerCnpj:HOLDER,now:NOW});
      assert.equal(signed.verification.signatureVerified,true);
      assert.equal(verifyNfeXml({xml:signed.signedXml,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW}).signatureVerified,true);
      assert.equal(r.signature_verified,false);assert.equal(r.xsd_validated,false);assert.equal(r.numbering_reserved,false);assert.equal(r.can_transmit,false);
      if(model==='65'){
        assert.ok(!r.unsignedXml.includes('infNFeSupl'));
        const complete=addNfceOnlineSupplement({xml:signed.signedXml,profile:NFCE_SP_HOMOLOGATION_QR_V3,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW});
        assert.equal(complete.verification.signatureVerified,true);assert.match(complete.signedXml,/<infNFeSupl>/);
      }
    }
  }finally{disposeSigner(signer);}
});
test('serializer escapes all text as values, fixes namespace and exposes no raw snapshots or private review notes',()=>{
  const f=businessFixture();f.completion.additional_information='A & B <tag> "aspas"';
  f.taxPreparation.record.items[0].decisions.review_note='PRIVATE_REVIEW_NOTE';refreshTaxProof(f);
  const r=buildBusinessXml(f),doc=parseStrict(r.unsignedXml);
  assert.equal(doc.getElementsByTagName('tag').length,0);
  assert.equal(doc.getElementsByTagName('infCpl')[0].textContent,'A & B <tag> "aspas"');
  assert.equal(doc.getElementsByTagName('xProd')[0].textContent,'PRODUTO FICTICIO & TESTE');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_REVIEW_NOTE'));
  assert.ok(!Object.hasOwn(r,'snapshot'));assert.ok(!r.unsignedXml.includes('Signature'));
  assert.equal(buildBusinessXml(f).unsigned_xml_sha256,r.unsigned_xml_sha256);
});
test('serializer rejects overridden resolved documents, injected markup attributes and numeric coercion',()=>{
  for(const change of[f=>f.resolved={can_emit:true},f=>f.completion.identity.number='1" evil="1',f=>f.completion.items[0].item_id=['e0000000-0000-4000-8000-000000000001'],
    f=>f.completion.items[0].tributary.quantity=1,f=>f.completion.additional_information='x\u0000y']){
    const f=businessFixture();change(f);assert.throws(()=>buildBusinessXml(f));
  }
});
test('maximum ordinary line count stays bounded; meaningful origin changes alter the generated digest',()=>{
  const f=businessFixture({count:250}),r=buildBusinessXml(f);assert.equal((r.unsignedXml.match(/<det /g)||[]).length,250);
  assert.ok(Buffer.byteLength(r.unsignedXml)<480000);
  f.completion.identity.number='2';assert.notEqual(buildBusinessXml(f).unsigned_xml_sha256,r.unsigned_xml_sha256);
  f.completion.items.push(structuredClone(f.completion.items[0]));assert.throws(()=>buildBusinessXml(f));
});
