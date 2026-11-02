import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildFiscalReview,validateFiscalReview,fiscalExactDecimal,FISCAL_REVIEW_FLAGS,FISCAL_REVIEW_LIMITS} from '../src/review.mjs';
import {reviewBasis,reviewIds} from './review-fixtures.mjs';
const codes=result=>result.report.findings.map(f=>f.code);
test('exact decimal conversion removes only trailing zeroes and refuses rounding, exponents or unsafe types',()=>{
 for(const[value,expected]of[['1.230000','1.23'],['0.000100','0.0001'],['12345678901.0000','12345678901'],['1.234567',null],['0.000001',null],['100000000000',null],['01.00',null],['1e3',null],[1.23,null],['-1',null]])assert.equal(fiscalExactDecimal(value,4,11),expected);
 assert.equal(fiscalExactDecimal('12345678901.1234567890',10,11),'12345678901.123456789');
 assert.equal(fiscalExactDecimal('1.12345678901',10,11),null);
});
test('review keeps tax/emission flags false and never replaces missing snapshot fields with current catalog values',()=>{
 const basis=reviewBasis(),result=buildFiscalReview(basis);
 for(const[key,value]of Object.entries(FISCAL_REVIEW_FLAGS))assert.equal(result[key],value);
 assert.equal(result.report.items[0].quantity_lexical,'1.23');
 assert.ok(codes(result).includes('ITEM_ORIGIN_NOT_CAPTURED'));assert.equal(result.basis.catalog[0].record.origin,'0');
 assert.ok(!Object.hasOwn(result.basis.draft.record.snapshot.items[0].product,'origin'));
 assert.ok(codes(result).includes('NCM_CLASSIFICATION_UNVERIFIED'));assert.ok(codes(result).includes('TAX_REVIEW_REQUIRED'));
 assert.equal(result.basis.draft.record.snapshot_hash,basis.draft.record.snapshot_hash);assert.deepEqual(basis,reviewBasis());
});
test('official local XSD boundaries match review limits and values above them become field-specific findings',async()=>{
 const xsd=await readFile(new URL('../../fiscal-schema/schemas/pl010f-v1.04/leiauteNFe_v4.00.xsd',import.meta.url),'utf8');
 for(const[tag,key]of[['xProd','description'],['cProd','code'],['uCom','unit']]){
  const node=xsd.slice(xsd.indexOf('name="'+tag+'"'));assert.match(node.slice(0,node.indexOf('</xs:element>')),new RegExp('<xs:maxLength value="'+FISCAL_REVIEW_LIMITS[key]+'"'));
 }
 const exact=buildFiscalReview(reviewBasis({item:{description:'A'.repeat(120),code:'B'.repeat(60),unit:'C'.repeat(6),quantity:'1.234500'}}));
 assert.ok(!codes(exact).some(c=>['ITEM_DESCRIPTION_LIMIT','ITEM_CODE_LIMIT','ITEM_UNIT_LIMIT','ITEM_QUANTITY_PRECISION'].includes(c)));
 const over=buildFiscalReview(reviewBasis({item:{description:'A'.repeat(121),code:'B'.repeat(61),unit:'C'.repeat(7),quantity:'1.234567'}}));
 for(const code of['ITEM_DESCRIPTION_LIMIT','ITEM_CODE_LIMIT','ITEM_UNIT_LIMIT','ITEM_QUANTITY_PRECISION'])assert.ok(codes(over).includes(code));
 const unicode=buildFiscalReview(reviewBasis({item:{description:'Peça 😀'}}));assert.ok(codes(unicode).includes('TEXT_CHARACTERS_OUTSIDE_SCHEMA'));
});
test('NCM syntax, unverified classification, GTIN decisions and free/service items are distinct',()=>{
 assert.ok(codes(buildFiscalReview(reviewBasis({product:{ncm:'12'}}))).includes('ITEM_NCM_OUTSIDE_PRODUCT_PROFILE'));
 assert.ok(codes(buildFiscalReview(reviewBasis({product:{ncm:'ABCDEFGH'}}))).includes('ITEM_NCM_FORMAT'));
 const absent=buildFiscalReview(reviewBasis({product:{ncm:null,gtin:null}}));assert.ok(codes(absent).includes('ITEM_NCM_MISSING'));assert.ok(codes(absent).includes('GTIN_DECISION_REQUIRED'));
 const free=buildFiscalReview(reviewBasis({free:true}));assert.ok(codes(free).includes('ITEM_FREE_REQUIRES_FISCAL_DATA'));assert.equal(free.report.items[0].catalog_state,'unlinked');
 const service=buildFiscalReview(reviewBasis({product:{kind:'S',format:'E'}}));assert.ok(codes(service).includes('ITEM_KIND_OUTSIDE_PROFILE'));assert.ok(codes(service).includes('ITEM_FORMAT_REQUIRES_REVIEW'));
 assert.ok(codes(buildFiscalReview(reviewBasis({model:'65'}))).includes('NFCE_OPERATION_UNREVIEWED'));
});
test('filled operation nature obeys the local natOp TString and sixty-character boundary without rewriting text',async()=>{
 const xsd=await readFile(new URL('../../fiscal-schema/schemas/pl010f-v1.04/leiauteNFe_v4.00.xsd',import.meta.url),'utf8');
 const node=xsd.slice(xsd.indexOf('name="natOp"'));const type=node.slice(0,node.indexOf('</xs:element>'));
 assert.match(type,/<xs:restriction base="TString">/);assert.match(type,/<xs:maxLength value="60"/);
 for(const [text,expected]of [['Venda 😀','TEXT_CHARACTERS_OUTSIDE_SCHEMA'],[' Venda','TEXT_CHARACTERS_OUTSIDE_SCHEMA'],['X'.repeat(61),'OPERATION_NATURE_LIMIT'],['X'.repeat(60),null]]){
  const basis=reviewBasis();basis.draft.record.preparation.operation_nature=text;
  const result=buildFiscalReview(basis),findings=result.report.findings.filter(f=>f.field==='operation_nature');
  assert.equal(result.basis.draft.record.preparation.operation_nature,text);
  assert.equal(expected===null?findings.length===0:findings.some(f=>f.code===expected),true);
 }
 const missing=reviewBasis();missing.draft.record.preparation.operation_nature=null;
 const findings=buildFiscalReview(missing).report.findings.filter(f=>f.field==='operation_nature');
 assert.deepEqual(findings.map(f=>f.code),['OPERATION_NATURE_MISSING']);
});
test('catalog identity/version and response context are exact; changed/inactive/missing data remain separate',()=>{
 const basis=reviewBasis();basis.catalog[0].record.version=2;basis.catalog[0].record.ncm='12345678';basis.catalog[0].record.active=false;
 const result=buildFiscalReview(basis);assert.ok(codes(result).includes('CATALOG_CHANGED'));assert.ok(codes(result).includes('CATALOG_INACTIVE'));assert.equal(result.basis.draft.record.snapshot.items[0].product.ncm,'00000000');
 const missing=reviewBasis();missing.catalog[0].record=null;assert.ok(codes(buildFiscalReview(missing)).includes('CATALOG_UNAVAILABLE'));
 for(const mutate of[b=>b.catalog[0].product_id=reviewIds.contact,b=>b.catalog.push(b.catalog[0]),b=>b.catalog=[],b=>b.catalog[0].record.ncm='11111111',b=>b.draft.record.environment='1',b=>b.draft.record.snapshot.items[0].total='1.00']){
  const invalid=reviewBasis();mutate(invalid);assert.throws(()=>buildFiscalReview(invalid));
 }
});
test('history and cancellation never become current readiness, while report forgery is rejected and extras stripped',()=>{
 const basis=reviewBasis();basis.draft.current={...basis.draft.current,version:2,status:'archived',source_document_version:2,source_status:'cancelled',source_changed:true};
 basis.draft.record.secret='PRIVATE';basis.catalog[0].record.secret='PRIVATE';
 const result=buildFiscalReview(basis);
 for(const code of['DRAFT_ARCHIVED','HISTORICAL_REVISION','SOURCE_CHANGED','SOURCE_CANCELLED'])assert.ok(codes(result).includes(code));
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
 assert.deepEqual(validateFiscalReview(result,reviewIds.draft,1),result);
 for(const mutate of[v=>v.can_emit=true,v=>v.report.findings=[],v=>v.report.summary.blocking=0,v=>v.report.items[0].quantity_lexical='999',v=>v.basis.draft.record.id=reviewIds.order]){
  const bad=structuredClone(result);mutate(bad);assert.throws(()=>validateFiscalReview(bad,reviewIds.draft,1));
 }
});
test('review handles 250 distinct lines without duplicating the shared current product, and refuses 251',()=>{
 const basis=reviewBasis({itemCount:250}),result=buildFiscalReview(basis);
 assert.equal(result.report.summary.items,250);assert.equal(result.basis.catalog.length,1);
 assert.equal(new Set(result.report.items.map(item=>item.item_id)).size,250);
 assert.equal(result.report.items[249].position,250);
 assert.ok(JSON.stringify(result).length<4*1024*1024);
 basis.draft.record.snapshot.items.push({...basis.draft.record.snapshot.items[249],id:'e0000000-0000-4000-8000-000000000251',position:251});
 assert.throws(()=>buildFiscalReview(basis));
});
