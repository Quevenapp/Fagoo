import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolveBusinessContent,resolveBusinessDocument,assertResolvedBusinessContent} from '../../fiscal-core/src/business-document.mjs';
import {buildAccessKey} from '../../fiscal-core/src/identity.mjs';
import {businessContentFixture} from '../../fiscal-core/test/business-content-fixtures.mjs';
import {bindResolvedBusinessContent,buildBoundBusinessXml} from '../src/bound-business.mjs';
import {buildBusinessXml} from '../src/business-builder.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex'),code=c=>e=>e.code===c;
function fixture(options={}){
 const {input,legacy}=businessContentFixture(options),content=resolveBusinessContent(input),b=content.binding,identity=resolveBusinessDocument(legacy).identity;
 const receipt={job_id:'f0000000-0000-4000-8000-000000000001',reservation_id:'f0000000-0000-4000-8000-000000000002',version:1,draft_id:b.draft_id,
  completion_version:b.completion_version,completion_hash:b.completion_record_hash,basis_hash:hash(content.basis_fingerprint_text),builder_version:content.builder,
  proofs:{draft_id:b.draft_id,draft_version:b.draft_version,snapshot_hash:b.snapshot_hash,item_preparation_version:b.item_preparation_version,tax_preparation_version:b.tax_preparation_version,
   item_preparation_hash:b.item_record_hash,tax_preparation_hash:b.tax_record_hash,model:content.model,environment:'2',company_identity_version:b.company_identity_version,
   company_fiscal_version:b.company_fiscal_version,source_document_id:b.source_document_id,source_document_version:b.source_document_version,completion_version:b.completion_version,
   completion_hash:b.completion_record_hash,builder_version:content.builder,basis_hashes:structuredClone(input.basisHashes)},identity,access_key:buildAccessKey(identity),created_at:'2026-10-16T12:00:01.123456+00:00'};
 return{input,legacy,content,receipt};
}
test('bound entry point shares exact XML bytes with legacy for every branch and250items, without claiming reservation or operational permission',()=>{
 for(const options of[{model:'55',csosn:'101'},{model:'55',csosn:'102'},{model:'55',csosn:'500'},{model:'65',csosn:'102'},{model:'65',csosn:'500'},{count:2,discount:'0.03',freight:'1.01',other:'0.01'},{model:'65',count:250}]){
  const f=fixture(options),before=structuredClone(f.receipt),bound=bindResolvedBusinessContent({content:f.content,receipt:f.receipt}),result=buildBoundBusinessXml(bound),legacy=buildBusinessXml(f.legacy);
  assert.equal(result.unsignedXml,legacy.unsignedXml);assert.equal(result.unsigned_xml_sha256,legacy.unsigned_xml_sha256);assert.equal(result.access_key,f.receipt.access_key);
  assert.equal(bound.xml_generated,false);assert.equal(Object.hasOwn(bound,'unsignedXml'),false);assert.equal(result.xml_generated,true);
  assert.equal(f.content.pending.includes('NUMBERING_NOT_RESERVED'),true);assert.equal(legacy.pending.includes('NUMBERING_NOT_RESERVED'),true);
  assert.deepEqual(bound.pending,f.content.pending.filter(code=>code!=='NUMBERING_NOT_RESERVED'));assert.deepEqual(result.pending,bound.pending);
  assert.equal(result.pending.includes('XML_NOT_GENERATED'),false);
  for(const v of[bound,result]){assert.equal(v.identity_assigned,true);assert.equal(v.numbering_bound,true);assert.equal(v.arithmetic_verified,true);
   for(const k of['numbering_reserved','operational_effects','tax_rules_validated','xsd_validated','signature_verified','authorized','can_emit','can_transmit'])assert.equal(v[k],false,k);}
  assert.deepEqual(f.receipt,before);assert.equal(Object.isFrozen(f.receipt),false);assert.equal(result.job.id,f.receipt.job_id);assert.equal(result.job.reservation_id,f.receipt.reservation_id);
  assert.equal(result.binding.completion_record_hash,f.receipt.completion_hash);assert.equal(result.job.basis_hash,hash(result.basis_fingerprint_text));
 }
});
test('local attestation rejects JSON, clones, proxies and lookalike objects; nested content and bound values are immutable',()=>{
 const f=fixture(),bind=content=>bindResolvedBusinessContent({content,receipt:f.receipt});
 assertResolvedBusinessContent(f.content);
 for(const value of[null,{},structuredClone(f.content),JSON.parse(JSON.stringify(f.content)),new Proxy(f.content,{}),Object.create(f.content)]){
  assert.throws(()=>assertResolvedBusinessContent(value),code('BUSINESS_CONTENT_UNATTESTED'));assert.throws(()=>bind(value),code('BUSINESS_CONTENT_UNATTESTED'));
 }
 const bound=bind(f.content);for(const value of[f.content,{},null,structuredClone(bound),JSON.parse(JSON.stringify(bound)),new Proxy(bound,{})])assert.throws(()=>buildBoundBusinessXml(value),code('BUSINESS_BOUND_DOCUMENT_UNATTESTED'));
 for(const mutate of[()=>f.content.items[0].pis.amount='9.00',()=>f.content.pending.push('fake'),()=>bound.identity.number='2',()=>bound.job.version++,()=>bound.binding.completion_version++])assert.throws(mutate,TypeError);
 const result=buildBoundBusinessXml(bound);assert.throws(()=>result.identity.number='2',TypeError);assert.throws(()=>result.transformations.push('fake'),TypeError);
 const restored=resolveBusinessContent(JSON.parse(JSON.stringify(f.input)));assert.equal(buildBoundBusinessXml(bind(restored)).unsignedXml,result.unsignedXml);
});
test('every captured proof and hash must match; metadata alone never substitutes for authenticated server inputs',()=>{
 const f=fixture();assert.equal(Object.keys(f.receipt).length,12);assert.equal(Object.keys(f.receipt.proofs).length,17);
 const rejection=change=>{const receipt=structuredClone(f.receipt);change(receipt);assert.throws(()=>bindResolvedBusinessContent({content:f.content,receipt}),code('BUSINESS_JOB_BASIS_CONFLICT'));};
 for(const key of Object.keys(f.receipt.proofs).filter(k=>k!=='basis_hashes'))rejection(v=>v.proofs[key]=typeof v.proofs[key]==='number'?v.proofs[key]+1:'OTHER');
 for(const key of Object.keys(f.receipt.proofs.basis_hashes))rejection(v=>v.proofs.basis_hashes[key]='f'.repeat(64));
 for(const key of['draft_id','completion_hash','basis_hash','builder_version'])rejection(v=>v[key]='f'.repeat(64));
 rejection(v=>v.completion_version++);rejection(v=>delete v.proofs.source_document_id);rejection(v=>v.proofs.current=true);
 rejection(v=>v.basis_hash=hash(JSON.stringify(JSON.parse(f.content.basis_fingerprint_text),null,1)));
 const reordered=structuredClone(f.receipt);reordered.proofs=Object.fromEntries(Object.entries(reordered.proofs).reverse());assert.equal(buildBoundBusinessXml(bindResolvedBusinessContent({content:f.content,receipt:reordered})).access_key,f.receipt.access_key);
});
test('receipt metadata is strict, dates use a real calendar and no lease/current assertion is accepted by the pure binder',()=>{
 const f=fixture();
 for(const change of[v=>v.job_id='bad',v=>v.reservation_id='bad',v=>v.version='1',v=>v.version=0,v=>v.version=2147483648,v=>v.created_at='2026-02-30T12:00:00Z',v=>v.created_at=null,v=>v.extra=true,v=>delete v.proofs]){
  const receipt=structuredClone(f.receipt);change(receipt);assert.throws(()=>bindResolvedBusinessContent({content:f.content,receipt}),code('BUSINESS_JOB_RECEIPT_INVALID'));
 }
 for(const input of[{},null,{content:f.content,receipt:f.receipt,lease_valid:true},{content:f.content,receipt:f.receipt,current:{state:'pending'}}])assert.throws(()=>bindResolvedBusinessContent(input),code('BUSINESS_BINDING_INPUT_INVALID'));
});
test('identity is canonical, exactly bound to issuer/model/environment and access key; supplied numeric coercion or fabricated key fail',()=>{
 const f=fixture();
 for(const change of[v=>v.cUF='33',v=>v.cnpj='88000000000191',v=>v.model='65',v=>v.environment='1',v=>v.tpEmis='9',v=>v.series='001',v=>v.series='890',v=>v.series=1,
  v=>v.number='0',v=>v.number='01',v=>v.number='1000000000',v=>v.number=1,v=>v.cNF='1234567',v=>v.cNF=12345678,v=>v.issuedAt='2026-02-30T12:00:00-03:00',
  v=>v.issuedAt='2026-10-16T12:00:00Z',v=>v.issuedAt='2100-01-01T12:00:00-03:00',v=>v.issuedAt='2026-10-16T12:00:00.000-03:00',v=>v.secret='no']){
  const receipt=structuredClone(f.receipt);change(receipt.identity);assert.throws(()=>bindResolvedBusinessContent({content:f.content,receipt}),code('BUSINESS_INPUT_INVALID'));
 }
 for(const change of[v=>v.access_key='0'.repeat(44),v=>v.identity.cNF='87654321',v=>v.identity.number='2']){
  const receipt=structuredClone(f.receipt);change(receipt);assert.throws(()=>bindResolvedBusinessContent({content:f.content,receipt}),code('BUSINESS_JOB_KEY_CONFLICT'));
 }
});
test('binding never chooses a new date/seed; old persisted identity is deterministic across repeat and detached receipt changes',()=>{
 const f=fixture();f.receipt.identity.issuedAt='2000-02-29T00:00:00-03:00';f.receipt.identity.series='0';f.receipt.identity.number='999999999';f.receipt.identity.cNF='00000000';f.receipt.access_key=buildAccessKey(f.receipt.identity);
 const bound=bindResolvedBusinessContent({content:f.content,receipt:f.receipt}),first=buildBoundBusinessXml(bound);f.receipt.identity.number='7';f.receipt.proofs.basis_hashes.draft_record_hash='f'.repeat(64);
 assert.equal(buildBoundBusinessXml(bound).unsignedXml,first.unsignedXml);assert.equal(bound.identity.number,'999999999');assert.equal(bound.identity.issuedAt,'2000-02-29T00:00:00-03:00');
 assert.equal(first.numbering_reserved,false);assert.throws(()=>buildBusinessXml(bound));
});
