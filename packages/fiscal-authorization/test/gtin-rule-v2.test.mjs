import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareAuthorization,authorizationRequestBytes} from '../src/index.mjs';
import {ruleEngine} from '../src/rule-profiles.mjs';
import {RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH,matchesRuleProfile} from '../src/rule-profile-registry.mjs';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {canonical} from '../src/subset-review-dto.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),v1=ruleEngine(RULE_PROFILE_V1_HASH),v2=ruleEngine(RULE_PROFILE_V2_HASH),id='a0000000-0000-4000-8000-000000000001';
let credential,signer;
before(async()=>{credential=await credentials();signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});});after(()=>disposeSigner(signer));
function fixture(model='55',gtin='7891234567895',gtinTax=gtin){
 const xml=buildBusinessXml(businessFixture({model})).unsignedXml.replace('<cEAN>SEM GTIN</cEAN>',`<cEAN>${gtin}</cEAN>`).replace('<cEANTrib>SEM GTIN</cEANTrib>',`<cEANTrib>${gtinTax}</cEANTrib>`),s=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(xml),expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW});
 const request=prepareAuthorization({signedBytes:Buffer.from(s.signedXml),expectedSignedHash:s.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW,batchId:'1'});
 return{request,gtin,gtinTax,c1:v1.inspectSpCrt1Candidate({candidateId:id,request}),c2:v2.inspectSpCrt1Candidate({candidateId:id,request})};
}
async function evidence(engine,candidate,gtinChoice='reviewed_identifiers'){
 return engine.createSpCrt1ReviewReader({readReview:async q=>{const r={id:'b0000000-0000-4000-8000-000000000001',version:1,candidate_id:q.candidateId,signed_hash:q.signedHash,facts_hash:q.factsHash,profile:q.profile,profile_hash:q.profileHash,reviewed_by:'c0000000-0000-4000-8000-000000000001',reviewed_at:'2026-10-16T11:00:00Z',valid_until:'2026-10-25T23:59:59Z',document:{operation:'internal_normal_sale',recipient_regime:'noncontributor',acquisition_purpose:'final_consumption',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:q.items.map(x=>({position:x.position,item_hash:x.itemHash,classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:gtinChoice,st:'not_applicable',fcp:'not_applicable',credit:null}))};return Buffer.from(canonical({...r,review_hash:hash(canonical(r))}));}})({candidate,now:NOW});
}
const evaluate=(e,c,ev)=>e.evaluateSpCrt1Rules({candidate:c,reviewEvidence:ev,now:NOW});
const digit=body=>body+String((10-[...body].reverse().reduce((s,d,i)=>s+Number(d)*(i%2?1:3),0)%10)%10);
test('55/65 numeric identifier removes only the v1 missing-table issue, without mutation or fiscal authority',async()=>{
 for(const model of ['55','65']){const f=fixture(model),bytes=authorizationRequestBytes(f.request),before=hash(bytes),one=evaluate(v1,f.c1,await evidence(v1,f.c1)),two=evaluate(v2,f.c2,await evidence(v2,f.c2));assert.equal(one.pendingClassification.some(x=>x.code==='GS1_PREFIX_TABLE_NOT_PINNED'),true);assert.equal(two.status,'reviewed_subset');assert.deepEqual(two.invalidCombinations,[]);assert.deepEqual(two.pendingClassification,[]);assert.equal(hash(authorizationRequestBytes(f.request)),before);assert.equal(two.factsHash,one.factsHash);assert.equal(two.signedHash,one.signedHash);for(const k of ['canEmit','canTransmit','sefazAuthorized','taxRulesValidated','operationallyApproved'])assert.equal(two[k],false);}
});
test('separate opaque handles prevent v1 review/report/candidate from becoming v2 evidence',async()=>{const f=fixture(),old=await evidence(v1,f.c1);assert.throws(()=>evaluate(v2,f.c2,old),e=>e.code==='RULE_REVIEW_UNATTESTED');assert.throws(()=>evaluate(v2,f.c1,null),e=>e.code==='RULE_CANDIDATE_UNATTESTED');assert.throws(()=>v2.assertSpCrt1RuleReport(evaluate(v1,f.c1,old),f.c2),e=>e.code==='RULE_REPORT_UNATTESTED');});
test('both cEAN and cEANTrib use the complete fixed table and preserve exact lengths/zero prefixes',async()=>{
 for(const value of [digit('9638507'),digit('03600029145'),'7891234567895',digit('1789123456789'),digit('000000000000')]){const f=fixture('55',value),r=evaluate(v2,f.c2,await evidence(v2,f.c2));assert.deepEqual(r.invalidCombinations,[],value);assert.equal(v2.projectSpCrt1CandidateReview(f.c2).facts.items[0].gtin,value);}
 const missing=digit('140123456789');for(const[gtin,gtinTax,expected]of [[missing,'7891234567895','GTIN_CEAN_PREFIX_NOT_LISTED'],['7891234567895',missing,'GTIN_CEANTRIB_PREFIX_NOT_LISTED']]){const f=fixture('55',gtin,gtinTax),r=evaluate(v2,f.c2,await evidence(v2,f.c2));const issue=r.invalidCombinations.find(x=>x.code===expected);assert.ok(issue);assert.deepEqual(issue.sources,['gtin2021','gs1prefix20261016']);}
});
test('DV/pair/absence/human review and temporal boundary remain conservative',async()=>{
 const invalid=fixture('55','7891234567896');assert.ok(evaluate(v2,invalid.c2,await evidence(v2,invalid.c2)).invalidCombinations.some(x=>x.code==='GTIN_CHECK_DIGIT_INVALID'));
 const pair=fixture('55','7891234567895','SEM GTIN');assert.ok(evaluate(v2,pair.c2,await evidence(v2,pair.c2)).invalidCombinations.some(x=>x.code==='GTIN_PAIR_MISMATCH'));
 const absent=fixture('55','SEM GTIN'),r=evaluate(v2,absent.c2,await evidence(v2,absent.c2,'reviewed_absent'));assert.equal(r.status,'reviewed_subset');
 const numeric=fixture();assert.equal(evaluate(v2,numeric.c2,null).status,'pending_classification');assert.ok(evaluate(v2,numeric.c2,await evidence(v2,numeric.c2,'unreviewed')).pendingClassification.some(x=>x.code==='GTIN_CLASSIFICATION_PENDING'));
 const late=v2.evaluateSpCrt1Rules({candidate:numeric.c2,reviewEvidence:await evidence(v2,numeric.c2),now:new Date('2026-10-26T03:00:00Z')});assert.ok(late.unsupportedScope.some(x=>x.code==='PROFILE_REVIEW_DATE_OUTSIDE_WINDOW'));
});
test('corrupted table or manifest cannot load the v2 fixed backend helper',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fagoo-077-pin-'));try{
  const pin=await readFile(new URL('../src/gtin-prefix-pinned.mjs',import.meta.url),'utf8');
  const actual=await import('../src/gtin-prefix-profile.mjs');for(const mode of ['table','manifest']){const table=structuredClone(actual.GTIN_PREFIX_TABLE),manifest=structuredClone(actual.GTIN_PREFIX_MANIFEST);if(mode==='table')table[0].to='009';else manifest.source.sha256='f'.repeat(64);await writeFile(join(dir,'stub-'+mode+'.mjs'),`export const GTIN_PREFIX_TABLE=${JSON.stringify(table)};export const GTIN_PREFIX_MANIFEST=${JSON.stringify(manifest)};export const GTIN_PREFIX_MANIFEST_HASH=${JSON.stringify(actual.GTIN_PREFIX_MANIFEST_HASH)};export function inspectGtinPrefix(){throw Error('NEVER')}\n`);await writeFile(join(dir,'pin-'+mode+'.mjs'),pin.replace('./gtin-prefix-profile.mjs','./stub-'+mode+'.mjs'));await assert.rejects(import(pathToFileURL(join(dir,'pin-'+mode+'.mjs'))),e=>e.code==='GS1_PREFIX_TABLE_NOT_PINNED');}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('closed profile pair rejects absent and unknown identities, including two undefined values',()=>{for(const x of [null,undefined,'','x','f'.repeat(64)])assert.equal(matchesRuleProfile(undefined,x),false);assert.equal(matchesRuleProfile('sp-crt1-internal-sale-homologation-20261016-v1',RULE_PROFILE_V2_HASH),false);});
