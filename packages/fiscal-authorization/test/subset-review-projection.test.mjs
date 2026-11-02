import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {prepareAuthorization} from '../src/index.mjs';
import {inspectSpCrt1Candidate,projectSpCrt1CandidateReview,SP_CRT1_RULE_MANIFEST_HASH} from '../src/sp-crt1-rule-profile.mjs';
import {captureSubsetReviewChoices} from '../src/subset-review-service.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),candidateId='a0000000-0000-4000-8000-000000000001';
const sorted=x=>x===null||typeof x!=='object'?x:Array.isArray(x)?x.map(sorted):Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])]));
let credential,signer;
before(async()=>{credential=await credentials();signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});});
after(()=>{disposeSigner(signer);credential.privateDer.fill(0);});
function fixture(model,csosn='102'){
 const xml=buildBusinessXml(businessFixture({model,csosn})).unsignedXml;
 const signed=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(xml),expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW});
 const input={signedBytes:Buffer.from(signed.signedXml),expectedSignedHash:signed.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedHolderCnpj:HOLDER,expectedCertificate:credential.certificate,expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW};
 return{input,candidate:inspectSpCrt1Candidate({candidateId,request:prepareAuthorization({...input,batchId:'1'})})};
}
test('owned55/65 presentation keeps exact existing facts hash and excludes the inspection batch marker',()=>{
 for(const model of ['55','65']){
  const f=fixture(model),p=projectSpCrt1CandidateReview(f.candidate),again=projectSpCrt1CandidateReview(f.candidate);
  assert.equal(hash(JSON.stringify(sorted(p.facts))),f.candidate.factsHash);assert.equal(f.candidate.profileHash,SP_CRT1_RULE_MANIFEST_HASH);
  assert.deepEqual(p,again);assert.notEqual(p,again);assert.notEqual(p.facts,again.facts);assert.notEqual(p.facts.items,again.facts.items);assert.ok(Object.isFrozen(p.labels.items[0]));
  assert.equal(typeof p.labels.items[0].description,'string');assert.equal(p.facts.items[0].icms.CSOSN,'102');
  assert.throws(()=>{p.facts.items[0].cfop='9999';});
  const other=inspectSpCrt1Candidate({candidateId,request:prepareAuthorization({...f.input,batchId:'987654321'})});assert.equal(other.factsHash,f.candidate.factsHash);assert.equal(other.signedHash,f.candidate.signedHash);
  for(const key of ['certificate','accessKey','signedXml','requestHash','batchId'])assert.equal(JSON.stringify(p).includes('"'+key+'"'),false);
 }
});
test('projection rejects forged handles/clones/proxies without executing getters',()=>{
 const f=fixture('55');let invoked=0;const fake={get candidateId(){invoked++;return candidateId;}};
 for(const value of [fake,{...f.candidate},new Proxy(f.candidate,{}),null])assert.throws(()=>projectSpCrt1CandidateReview(value),e=>e.code==='RULE_CANDIDATE_UNATTESTED');assert.equal(invoked,0);
});
test('101 facts stay literal; choices cannot fabricate a hash, credit proof or automatic classification',()=>{
 const p=projectSpCrt1CandidateReview(fixture('55','101').candidate);assert.equal(p.facts.items[0].icms.CSOSN,'101');
 const c={document:{operation:'unreviewed',recipient_regime:'unreviewed',acquisition_purpose:'unreviewed',payment:'unreviewed',excluded_groups:'unreviewed'},items:[{position:1,classification:'unreviewed',benefit:'unreviewed',pis_cofins:'unreviewed',gtin:'unreviewed',st:'unreviewed',fcp:'unreviewed',credit:null}]};
 assert.deepEqual(captureSubsetReviewChoices(c),c);
 for(const patch of [{item_hash:'a'.repeat(64)},{credit:{source_hash:'a'.repeat(64)}},{position:2}])assert.throws(()=>captureSubsetReviewChoices({...c,items:[{...c.items[0],...patch}]}));
 let read=0;const malicious={...c.items[0]};Object.defineProperty(malicious,'credit',{enumerable:true,get(){read++;return null;}});assert.throws(()=>captureSubsetReviewChoices({...c,items:[malicious]}));assert.equal(read,0);
});
