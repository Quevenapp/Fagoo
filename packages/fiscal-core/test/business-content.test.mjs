import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {resolveBusinessContent,resolveBusinessDocument,BUSINESS_PROFILE,BUSINESS_SCHEMA,BUSINESS_BUILDER,BUSINESS_CONTENT_FINGERPRINT_PROFILE,BusinessDocumentError} from '../src/business-document.mjs';
import {businessContentFixture,refreshCompletionProof} from './business-content-fixtures.mjs';

const rejected=(input,code)=>assert.throws(()=>resolveBusinessContent(input),e=>e instanceof BusinessDocumentError&&(!code||e.code===code));
const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');

test('content uses 022/035/040/047 without identity and equals the legacy business fields for all supported branches',()=>{
 for(const model of['55','65'])for(const csosn of(model==='55'?['101','102','500']:['102','500'])){
  const {legacy,input}=businessContentFixture({model,csosn}),before=structuredClone(input),r=resolveBusinessContent(input),old=resolveBusinessDocument(legacy);
  for(const k of['operation','issuer','recipient','items','totals','payments','transport_mode','additional_information','pending','transformations','arithmetic_profile'])assert.deepEqual(r[k],old[k],k);
  for(const k of['identity','access_key','unsignedXml','unsigned_xml_sha256','cNF','issuedAt'])assert.equal(Object.hasOwn(r,k),false,k);
  for(const k of['identity_assigned','numbering_bound','xml_generated','numbering_reserved','can_emit','can_transmit','authorized','tax_rules_validated','xsd_validated','signature_verified','operational_effects'])assert.equal(r[k],false,k);
  assert.equal(r.arithmetic_verified,true);assert.equal(input.completionPreparation.arithmetic_verified,false);assert.equal(r.model,model);assert.equal(r.environment,'2');assert.deepEqual(input,before);
  assert.ok(r.pending.includes('NUMBERING_NOT_RESERVED'));assert.ok(r.pending.includes('TAX_APPLICABILITY_UNVERIFIED'));
 }
});

test('the fingerprint is exactly a 20-string version/hash tuple and matches PostgreSQL JSON text and UTF8 SHA256',async()=>{
 const {input}=businessContentFixture(),r=resolveBusinessContent(input),b=r.binding;
 const expected=[BUSINESS_CONTENT_FINGERPRINT_PROFILE,BUSINESS_PROFILE,BUSINESS_SCHEMA,BUSINESS_BUILDER,b.draft_id,String(b.draft_version),b.snapshot_hash,b.draft_record_hash,
  String(b.item_preparation_version),b.item_record_hash,String(b.tax_preparation_version),b.tax_record_hash,String(b.completion_version),b.completion_record_hash,
  String(b.company_identity_version),String(b.company_fiscal_version),b.source_document_id,String(b.source_document_version),r.model,'2'];
 assert.equal(expected.length,20);assert.ok(expected.every(v=>typeof v==='string'));assert.equal(r.basis_fingerprint_text,JSON.stringify(expected));
 const db=new PGlite();try{
  const {rows}=await db.query("select to_json($1::text[])::text tuple,array_to_json($1::text[])::text alternate,encode(sha256(convert_to(to_json($1::text[])::text,'UTF8')),'hex') digest",[expected]);
  assert.equal(rows[0].tuple,r.basis_fingerprint_text);assert.equal(rows[0].alternate,r.basis_fingerprint_text);assert.equal(rows[0].digest,digest(r.basis_fingerprint_text));
 }finally{await db.close();}
 assert.deepEqual(resolveBusinessContent(reorder(input)),r);
});

test('the fingerprint changes on any server hash or completion revision and never recomputes a PostgreSQL record hash',()=>{
 const {input}=businessContentFixture(),first=resolveBusinessContent(input);
 for(const key of Object.keys(input.basisHashes)){
  const changed=structuredClone(input);changed.basisHashes[key]='f'.repeat(64);
  if(key==='item_record_hash')changed.completionPreparation.record.item_preparation_hash=changed.basisHashes[key];
  if(key==='tax_record_hash')changed.completionPreparation.record.tax_preparation_hash=changed.basisHashes[key];
  assert.notEqual(resolveBusinessContent(changed).basis_fingerprint_text,first.basis_fingerprint_text);
 }
 const changed=structuredClone(input);changed.completionPreparation.record.version=2;changed.completionPreparation.current.completion_version=2;
 assert.notEqual(resolveBusinessContent(changed).basis_fingerprint_text,first.basis_fingerprint_text);assert.equal(resolveBusinessContent(changed).binding.completion_version,2);
 for(const key of['item_record_hash','tax_record_hash']){const bad=structuredClone(input);bad.basisHashes[key]='f'.repeat(64);rejected(bad,'BUSINESS_BASIS_CONFLICT');}
});

test('no raw completion, fake identity, stale receipts, previews or altered binding can be passed as current prepared content',()=>{
 const changes=[v=>v.completionPreparation.record=null,v=>v.completionPreparation.record.created_at=null,v=>v.completionPreparation.record.created_at='2026-02-30T12:00:00Z',
  v=>v.completionPreparation.record.completion.identity={series:'1',number:'1',cNF:'12345678',issuedAt:'2026-10-16T12:00:00-03:00'},v=>v.completionPreparation.record.version=0,
  v=>v.completionPreparation.record.draft_id='a0000000-0000-4000-8000-000000000002',v=>v.completionPreparation.record.draft_version++,v=>v.completionPreparation.record.snapshot_hash='f'.repeat(64),
  v=>v.completionPreparation.record.item_preparation_version++,v=>v.completionPreparation.record.tax_preparation_version++,v=>v.completionPreparation.record.source_document_version++,
  v=>v.completionPreparation.record.company_fiscal_version++,v=>v.completionPreparation.record.company_identity_version++,v=>v.completionPreparation.record.environment='1',v=>v.completionPreparation.record.model='65',
  v=>v.completionPreparation.current.completion_version++,v=>v.completionPreparation.current.company_changed=true,v=>v.completionPreparation.current.source_changed=true,
  v=>v.completionPreparation.current.source_status='cancelled',v=>v.completionPreparation.current.draft_status='archived',v=>v.completionPreparation.current.matches_current_draft=false,
  v=>v.completionPreparation.current.matches_current_item_preparation=false,v=>v.completionPreparation.current.matches_current_tax_preparation=false,v=>v.completionPreparation.current.matches_current_company=false,
  v=>v.completionPreparation.can_emit=true,v=>v.completionPreparation.arithmetic_verified=true,v=>v.completionPreparation.record.pending.general=[],v=>v.basisHashes.completion_record_hash='A'.repeat(64),v=>delete v.basisHashes.draft_record_hash];
 for(const change of changes){const{input}=businessContentFixture();change(input);rejected(input);}
 const {input,legacy}=businessContentFixture();rejected(legacy);rejected({...input,identity:legacy.completion.identity});rejected({...input,completion:input.completionPreparation.record.completion});
});

test('captured item membership, order and branch must be identical to preparation040',()=>{
 for(const change of[v=>v.completionPreparation.record.item_basis.reverse(),v=>v.completionPreparation.record.item_basis[0].csosn='500',v=>v.completionPreparation.record.item_basis[0].cest='0000000',
  v=>v.completionPreparation.record.item_basis[0].item_id='e0000000-0000-4000-8000-000000000099',v=>v.completionPreparation.record.completion.items.reverse()]){
  const {input}=businessContentFixture({count:2});change(input);rejected(input);
 }
});

test('shape-only persisted values are still rejected by the content arithmetic and precision checks',()=>{
 for(const [change,code]of [[x=>x.totals.vNF='0.01','BUSINESS_ARITHMETIC_MISMATCH'],[x=>x.items[0].allocations.freight='0.01','BUSINESS_ARITHMETIC_MISMATCH'],
  [x=>x.items[0].tributary.quantity='1.234567','BUSINESS_QUANTITY_PRECISION'],[x=>x.items[0].tributary.quantity=null,'BUSINESS_QUANTITY_PRECISION'],
  [x=>x.totals.vIPI='0.01','BUSINESS_PROFILE_UNSUPPORTED'],[x=>x.payments.items[0].amount='0.01','BUSINESS_ARITHMETIC_MISMATCH'],[x=>x.excluded_groups.ibs_cbs=null,'BUSINESS_PROFILE_UNSUPPORTED']]){
  const {input}=businessContentFixture();change(input.completionPreparation.record.completion);refreshCompletionProof(input);rejected(input,code);
 }
 const {input}=businessContentFixture({quantity:'1.234500'});assert.equal(resolveBusinessContent(input).items[0].quantity,'1.2345');
 const credit=businessContentFixture({csosn:'101'}).input;credit.completionPreparation.record.completion.items[0].icms.credit.amount='0.49';refreshCompletionProof(credit);rejected(credit,'BUSINESS_ARITHMETIC_MISMATCH');
});

test('all legacy field validation is shared; content cannot escape source/regime or commercial immutable checks',()=>{
 for(const change of[v=>v.draft.current.source_changed=true,v=>v.draft.record.snapshot.company.crt='3',v=>v.draft.record.preparation.operation_nature='x\ny',
  v=>v.draft.record.snapshot.items[0].gross='1.00',v=>v.itemPreparation.record.items[0].fields.ncm.value='99999999',v=>v.draft.record.snapshot.items[0].product.kind='S']){
  const {input}=businessContentFixture();change(input);rejected(input);
 }
});

test('250 items and above-safe-integer decimal products are exact; resolved mutation cannot alter any captured receipt',()=>{
 for(const options of[{count:250},{quantity:'123456.123400',unit_price:'1234567.1234'},{count:2,discount:'0.03',freight:'1.01',other:'0.01'}]){
  const {input,legacy}=businessContentFixture(options),before=structuredClone(input),r=resolveBusinessContent(input);
  assert.equal(r.totals.vNF,resolveBusinessDocument(legacy).totals.vNF);assert.ok(Buffer.byteLength(JSON.stringify(r))<1048576);
  for(const mutate of[()=>r.items[0].pis.amount='99.99',()=>r.operation.nature='OUTRO',()=>r.binding.completion_record_hash='f'.repeat(64)])assert.throws(mutate,TypeError);
  assert.deepEqual(input,before);assert.equal(Object.isFrozen(input),false);
 }
});
