import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBusinessDocument, BUSINESS_FLAGS, BusinessDocumentError } from '../src/business-document.mjs';
import { businessFixture,refreshTaxProof } from './business-fixtures.mjs';

const rejects=(f,code)=>assert.throws(()=>resolveBusinessDocument(f),e=>e instanceof BusinessDocumentError&&(!code||e.code===code));
test('both models resolve only explicit supported decisions, preserve origins and never enable emission',()=>{
  for(const model of['55','65'])for(const csosn of(model==='55'?['101','102','500']:['102','500'])){
    const f=businessFixture({model,csosn}),before=structuredClone(f),r=resolveBusinessDocument(f);
    assert.deepEqual(f,before);assert.equal(r.items[0].icms.csosn,csosn);assert.equal(r.totals.vNF,'12.50');assert.equal(r.items[0].quantity,'1.25');
    assert.ok(Object.keys(BUSINESS_FLAGS).every(k=>r[k]===false));assert.ok(r.pending.includes('NUMBERING_NOT_RESERVED'));
    assert.equal(r.binding.snapshot_hash,f.draft.record.snapshot_hash);assert.equal(r.binding.tax_preparation_version,1);
    if(model==='65')assert.ok(r.pending.includes('NFCE_SUPPLEMENT_REQUIRED'));
  }
});
test('JSON object order is irrelevant while the source item array order remains bound',()=>{
  const reorder=v=>Array.isArray(v)?v.map(reorder):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
  const f=businessFixture({count:2,csosn:'500'});
  assert.deepEqual(resolveBusinessDocument(reorder(f)),resolveBusinessDocument(f));
  const g=reorder(f);g.taxPreparation.record.items.reverse();rejects(g,'BUSINESS_BASIS_CONFLICT');
});
test('base revisions, source identities and fiscal identifiers cannot be swapped or overruled by completion',()=>{
  const mutations=[f=>f.itemPreparation.record.draft_version++,f=>f.taxPreparation.record.item_preparation_version++,f=>f.taxPreparation.record.company_identity_version++,
    f=>f.taxPreparation.record.snapshot_hash='b'.repeat(64),f=>f.taxPreparation.record.source_document_id='b0000000-0000-4000-8000-000000000002',
    f=>f.itemPreparation.record.items[0].item_id='e0000000-0000-4000-8000-000000000002',f=>f.itemPreparation.record.items[0].fields.ncm.value='99999999',
    f=>f.completion.items[0].unit_price='1.00',f=>f.completion.issuer={cnpj:'bad'},f=>f.taxPreparation.can_emit=true];
  for(const change of mutations){const f=businessFixture();change(f);rejects(f);}
});
test('stale, archived, cancelled, regime and outside-profile branches fail with stable pending codes',()=>{
  for(const change of[f=>f.draft.current.source_changed=true,f=>f.draft.current.status='archived',f=>f.draft.current.source_status='cancelled',
    f=>f.taxPreparation.current.company_changed=true,f=>f.draft.record.snapshot.company.crt='3',f=>f.completion.operation.idDest='2',
    f=>f.completion.identity.environment='1',f=>f.completion.identity.series='900',f=>f.completion.excluded_groups.ibs_cbs=null]){
    const f=businessFixture();change(f);rejects(f);
  }
  const f=businessFixture({model:'65'});f.completion.operation.indFinal='0';rejects(f,'BUSINESS_PROFILE_UNSUPPORTED');
});
test('six-place quantities are only normalized when exact; commercial and tributary products must agree',()=>{
  assert.equal(resolveBusinessDocument(businessFixture({quantity:'1.234500'})).items[0].quantity,'1.2345');
  rejects(businessFixture({quantity:'1.234567'}),'BUSINESS_QUANTITY_PRECISION');
  const f=businessFixture();f.completion.items[0].tributary.quantity='2';rejects(f,'BUSINESS_ARITHMETIC_MISMATCH');
  const g=businessFixture();g.completion.items[0].tributary={unit:'CX',quantity:'0.1250',unit_price:'100.0000'};
  assert.equal(resolveBusinessDocument(g).items[0].tributary.quantity,'0.125');
});
test('explicit allocations conserve every cent and cannot borrow line discount or exceed the item',()=>{
  const f=businessFixture({count:2,discount:'0.03',freight:'1.01',other:'0.01'}),r=resolveBusinessDocument(f);
  assert.equal(r.totals.vNF,'25.99');assert.equal(r.items[0].discount,'0.03');
  f.completion.items[0].allocations.global_discount='0.02';rejects(f,'BUSINESS_ARITHMETIC_MISMATCH');
  const g=businessFixture({count:2,discount:'15.00'});rejects(g,'BUSINESS_ARITHMETIC_MISMATCH');
  g.completion.items[0].allocations.global_discount='10.00';g.completion.items[1].allocations.global_discount='5.00';assert.doesNotThrow(()=>resolveBusinessDocument(g));
});
test('null is not zero; manual 101 credit requires its explicit base and exact calculation',()=>{
  const f=businessFixture({csosn:'101'});f.completion.items[0].icms.credit.amount='0.49';rejects(f,'BUSINESS_ARITHMETIC_MISMATCH');
  for(const field of['base','rate','amount']){const g=businessFixture();g.taxPreparation.record.items[0].decisions.pis[field]=null;refreshTaxProof(g);rejects(g);}
  const g=businessFixture({csosn:'101'});g.taxPreparation.record.items[0].decisions.icms.credit_rate=null;refreshTaxProof(g);rejects(g,'BUSINESS_TAX_UNPREPARED');
  const h=businessFixture({csosn:'101'});h.completion.items[0].icms.credit=null;rejects(h,'BUSINESS_TAX_UNPREPARED');
});
test('500 supports only explicit full groups or reviewed omissions; retained amounts are not invented',()=>{
  const f=businessFixture({csosn:'500'}),c=f.taxPreparation.record.items[0].decisions.icms;
  c.retention={base:'20.00',rate:'18.00',substitute_icms:'1.00',retained_icms:'2.60'};
  c.fcp={base:'20.00',rate:'2.00',amount:'0.40'};c.effective={reduction_rate:'10.00',base:'18.00',rate:'18.00',amount:'3.24'};
  f.completion.items[0].icms.groups500={retention:'include',fcp:'include',effective:'include'};f.completion.totals.vFCPSTRet='0.40';refreshTaxProof(f);
  assert.equal(resolveBusinessDocument(f).items[0].icms.retention.retained_icms,'2.60');
  f.completion.items[0].icms.groups500.retention='omit';rejects(f,'BUSINESS_GROUP_DECISION_REQUIRED');
  const g=businessFixture({csosn:'500'});g.completion.items[0].icms.groups500.fcp='include';rejects(g,'BUSINESS_TAX_UNPREPARED');
});
test('PIS/COFINS arithmetic and document totals are independently checked with exact decimal strings',()=>{
  const f=businessFixture(),d=f.taxPreparation.record.items[0].decisions;
  d.pis={cst:'49',base:'12.50',rate:'1.6500',amount:'0.21'};d.cofins={cst:'49',base:'12.50',rate:'7.6000',amount:'0.95'};
  f.completion.totals.vPIS='0.21';f.completion.totals.vCOFINS='0.95';refreshTaxProof(f);assert.doesNotThrow(()=>resolveBusinessDocument(f));
  f.completion.totals.vPIS='0.20';rejects(f,'BUSINESS_ARITHMETIC_MISMATCH');
  const g=businessFixture();g.completion.totals.vNF='12.49';rejects(g,'BUSINESS_ARITHMETIC_MISMATCH');
  const h=businessFixture();h.completion.totals.vIPI='1.00';rejects(h,'BUSINESS_PROFILE_UNSUPPORTED');
});
test('payments are explicit, conserve totals and cash change, and never derive from a financial title',()=>{
  const f=businessFixture();f.completion.payments={items:[{type:'01',timing:'0',amount:'20.00'}],change:'7.50'};assert.doesNotThrow(()=>resolveBusinessDocument(f));
  f.completion.payments.items[0].type='15';rejects(f,'BUSINESS_ARITHMETIC_MISMATCH');
  const g=businessFixture();g.completion.payments.items[0].type='90';rejects(g,'BUSINESS_PAYMENT_UNSUPPORTED');
  g.completion.payments.items[0].amount='0.00';rejects(g,'BUSINESS_PAYMENT_UNSUPPORTED');
  const nfc=businessFixture({model:'65'});nfc.completion.payments.items[0]={type:'90',timing:'0',amount:'0.00'};rejects(nfc,'BUSINESS_PAYMENT_UNSUPPORTED');
  for(const type of['03','17','99',1]){const h=businessFixture();h.completion.payments.items[0].type=type;rejects(h,'BUSINESS_PAYMENT_UNSUPPORTED');}
});
test('unprepared classifications, free products, malformed recipient and unsafe text never get defaults',()=>{
  for(const change of[f=>f.itemPreparation.record.items[0].fields.gtin.provenance.source='unreviewed',f=>f.completion.items[0].cest_absence=null,
    f=>f.draft.record.snapshot.items[0].product.kind='S',f=>f.draft.record.snapshot.contact.document='11111111111111',
    f=>f.completion.recipient.municipality_code='3304557',f=>f.draft.record.snapshot.company.identity.legal_name=' EMPRESA',
    f=>f.draft.record.preparation.operation_nature='x\nY',f=>f.completion.additional_information='\ud800',f=>f.completion.additional_information='😀']){
    const f=businessFixture();change(f);rejects(f);
  }
});
test('250 lines and above-safe-integer decimal multiplication remain exact and input cannot be mutated through output',()=>{
  const f=businessFixture({count:250}),r=resolveBusinessDocument(f);assert.equal(r.items.length,250);assert.equal(r.totals.vNF,'3125.00');
  r.items[0].pis.amount='99.00';assert.equal(f.taxPreparation.record.items[0].decisions.pis.amount,'0.00');
  const g=businessFixture({quantity:'123456.123400',unit_price:'1234567.1234'});assert.equal(resolveBusinessDocument(g).totals.vNF,g.draft.record.snapshot.totals.total);
  const h=businessFixture();h.completion.items[0].allocations.freight=0;rejects(h,'BUSINESS_DECIMAL_INVALID');
});
