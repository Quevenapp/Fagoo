import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {prepareFiscalItems,gtinCheckDigitMatches,ITEM_PREPARATION_FIELDS,ITEM_PREPARATION_ORIGINS,ItemPreparationError} from '../src/item-preparation.mjs';
import {reviewBasis,reviewIds} from './review-fixtures.mjs';
const manual=value=>({source:'manual',value});
const catalog=(expected_version=1,expected_product_id=reviewIds.product)=>({source:'catalog',expected_product_id,expected_version});
const input=(basis=reviewBasis(),fields={},item_id=reviewIds.item)=>({basis,expected:{draft_id:basis.draft.record.id,draft_version:basis.draft.record.version,snapshot_hash:basis.draft.record.snapshot_hash},decisions:Object.keys(fields).length?[{item_id,fields}]:[]});
const row=value=>value.items[0];
const rejects=(value,code)=>assert.throws(()=>prepareFiscalItems(value),error=>error instanceof ItemPreparationError&&error.code===code);
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};

test('no field is inferred from either the historical product or the current catalog',()=>{
 const source=input(),result=prepareFiscalItems(source);
 for(const name of ITEM_PREPARATION_FIELDS)assert.deepEqual(row(result).fields[name],{value:null,provenance:{source:'unreviewed'},check_digit_verified:false});
 for(const code of ['NCM_NOT_PREPARED','ORIGIN_NOT_PREPARED','CEST_NOT_PREPARED','GTIN_NOT_PREPARED','TRIBUTARY_GTIN_NOT_PREPARED'])assert.ok(row(result).pending.includes(code));
 assert.equal(result.commercial.number,source.basis.draft.record.snapshot.number);
 assert.equal(result.commercial.items[0].quantity,'1.230000');assert.equal(result.commercial.items[0].unit_price,'10.0000');
 for(const[key,value]of Object.entries(result.commercial.totals))assert.equal(value,source.basis.draft.record.snapshot.totals[key]);
});

test('manual and confirmed catalog decisions retain distinct field provenance',()=>{
 const result=prepareFiscalItems(input(reviewBasis(),{ncm:manual('00000000'),origin:catalog(),cest:manual('1234567'),gtin:manual('SEM GTIN'),gtin_tax:catalog()}));
 assert.deepEqual(row(result).fields.ncm,{value:'00000000',provenance:{source:'manual'},check_digit_verified:false});
 assert.deepEqual(row(result).fields.origin,{value:'0',provenance:{source:'catalog',product_id:reviewIds.product,product_version:1,active:true},check_digit_verified:false});
 assert.equal(row(result).fields.gtin.value,'SEM GTIN');assert.equal(row(result).fields.gtin_tax.value,'SEM GTIN');
 assert.equal(row(result).fields.gtin.check_digit_verified,false);
 assert.ok(row(result).pending.includes('NCM_CLASSIFICATION_UNVERIFIED'));assert.ok(row(result).pending.includes('CEST_APPLICABILITY_UNREVIEWED'));
});

test('a catalog update is copied only after the exact new product version was explicitly chosen',()=>{
 const basis=reviewBasis();basis.catalog[0].record.version=2;basis.catalog[0].record.ncm='12345678';
 const original=structuredClone(basis),result=prepareFiscalItems(input(basis,{ncm:catalog(2)}));
 assert.equal(row(result).fields.ncm.value,'12345678');assert.equal(row(result).fields.ncm.provenance.product_version,2);
 assert.equal(basis.draft.record.snapshot.items[0].product.ncm,'00000000');assert.deepEqual(basis,original);
 assert.ok(result.snapshot_findings.some(finding=>finding.code==='CATALOG_CHANGED'));
 rejects(input(basis,{ncm:catalog(1)}),'ITEM_PREPARATION_CATALOG_CONFLICT');
});

test('unavailable/foreign catalog and item IDs cannot fall back to names, historical values or another product',()=>{
 const basis=reviewBasis();basis.catalog[0].record=null;
 rejects(input(basis,{ncm:catalog()}),'ITEM_PREPARATION_CATALOG_UNAVAILABLE');
 rejects(input(reviewBasis(),{ncm:catalog(1,reviewIds.contact)}),'ITEM_PREPARATION_PRODUCT_MISMATCH');
 rejects(input(reviewBasis(),{ncm:manual('12345678')},reviewIds.contact),'ITEM_PREPARATION_FOREIGN_ITEM');
 const repeated=input(reviewBasis(),{origin:manual('0')});repeated.decisions.push(structuredClone(repeated.decisions[0]));rejects(repeated,'ITEM_PREPARATION_DUPLICATE_ITEM');
});

test('free items accept manual identification only and remain explicitly pending review',()=>{
 const basis=reviewBasis({free:true}),result=prepareFiscalItems(input(basis,{ncm:manual('12345678'),origin:manual('2'),gtin:manual('SEM GTIN')}));
 assert.equal(row(result).product_id,null);assert.ok(row(result).pending.includes('FREE_ITEM_REQUIRES_REVIEW'));
 rejects(input(basis,{origin:catalog()}),'ITEM_PREPARATION_PRODUCT_MISMATCH');
});

test('draft identity, version and hash must all match the selected immutable snapshot',()=>{
 for(const[field,value]of [['draft_id',reviewIds.contact],['draft_version',2],['snapshot_hash','b'.repeat(64)]]){
  const request=input();request.expected[field]=value;rejects(request,'ITEM_PREPARATION_BINDING_CONFLICT');
 }
 for(const[field,value]of [['draft_id',reviewIds.draft.toUpperCase()],['draft_version','1'],['snapshot_hash','invalid']]){
  const request=input();request.expected[field]=value;rejects(request,'ITEM_PREPARATION_INVALID_BINDING');
 }
 const production=input();production.basis.draft.record.environment='1';rejects(production,'ITEM_PREPARATION_INVALID_BASIS');
});

test('commercial numbers and tax decisions cannot enter the editable fields or extra command fields',()=>{
 for(const name of ['number','quantity','unit_price','discount_percent','total','model','cfop','cst','csosn','rate','regime'])rejects(input(reviewBasis(),{[name]:manual('1')}),'ITEM_PREPARATION_INVALID_FIELDS');
 const extra=input();extra.number='99';rejects(extra,'ITEM_PREPARATION_INVALID_INPUT');
 rejects(input(reviewBasis(),{ncm:{...manual('12345678'),price:'1.00'}}),'ITEM_PREPARATION_INVALID_CHOICE');
 rejects(input(reviewBasis(),{ncm:{...catalog(),value:'12345678'}}),'ITEM_PREPARATION_INVALID_CHOICE');
 const bad=input();bad.basis.draft.record.snapshot.items[0].total='99.00';rejects(bad,'ITEM_PREPARATION_INVALID_BASIS');
 const badNumber=input();badNumber.basis.draft.record.snapshot.number={private:'unvalidated'};rejects(badNumber,'ITEM_PREPARATION_INVALID_BASIS');
});

test('GTIN checks use GS1 modulo10 for the supported lengths and never strip leading zeros',()=>{
 //6291041500213 is the worked GTIN13 example in the official GS1 reference.
 for(const value of ['12345670','012345678905','6291041500213','00012345678905']){
  assert.equal(gtinCheckDigitMatches(value),true);
  const result=prepareFiscalItems(input(reviewBasis(),{gtin:manual(value),gtin_tax:manual(value)}));
  assert.equal(row(result).fields.gtin.value,value);assert.equal(row(result).fields.gtin.check_digit_verified,true);
  const wrong=value.slice(0,-1)+(value.at(-1)==='9'?'0':String(Number(value.at(-1))+1));assert.equal(gtinCheckDigitMatches(wrong),false);
  rejects(input(reviewBasis(),{gtin:manual(wrong)}),'ITEM_PREPARATION_GTIN_CHECK_DIGIT');
 }
 for(const value of [null,12345670,'1234567','123456789','12345678901','123456789012345',' SEM GTIN','sem gtin','１２３４５６７０'])assert.equal(gtinCheckDigitMatches(value),false);
 assert.equal(prepareFiscalItems(input(reviewBasis(),{gtin:manual('00000000')})).catalog_registry_verified,false);
});

test('catalog GTINs are checked as strictly as manual values; numeric data are never coerced',()=>{
 const basis=reviewBasis({product:{gtin:'12345671'}});rejects(input(basis,{gtin:catalog()}),'ITEM_PREPARATION_GTIN_CHECK_DIGIT');
 for(const value of [12345670,'','1234567',' 12345670','12345670 ','1234\n5670'])rejects(input(reviewBasis(),{gtin:manual(value)}),typeof value==='string'?'ITEM_PREPARATION_INVALID_GTIN':'ITEM_PREPARATION_INVALID_VALUE');
});

test('NCM preserves both pinned XSD shapes without claiming classification or applying a two-digit exception',()=>{
 for(const value of ['00','12','00000000','12345678']){
  const result=prepareFiscalItems(input(reviewBasis(),{ncm:manual(value)}));assert.equal(row(result).fields.ncm.value,value);
  assert.equal(row(result).pending.includes('NCM_EXCEPTION_REQUIRES_REVIEW'),value.length===2);assert.ok(row(result).pending.includes('NCM_CLASSIFICATION_UNVERIFIED'));
 }
 for(const value of ['','1','123','1234567','123456789','12.345.678','１２３４５６７８','12345678\n'])rejects(input(reviewBasis(),{ncm:manual(value)}),'ITEM_PREPARATION_INVALID_NCM');
});

test('origin is only the versioned Torig enum, with no default or description-based inference',()=>{
 assert.deepEqual(ITEM_PREPARATION_ORIGINS,['0','1','2','3','4','5','6','7','8']);
 for(const value of ITEM_PREPARATION_ORIGINS)assert.equal(row(prepareFiscalItems(input(reviewBasis(),{origin:manual(value)}))).fields.origin.value,value);
 for(const value of ['9','00','BR','Nacional',' 0','0 '])rejects(input(reviewBasis(),{origin:manual(value)}),'ITEM_PREPARATION_INVALID_ORIGIN');
 rejects(input(reviewBasis(),{origin:manual(0)}),'ITEM_PREPARATION_INVALID_VALUE');
});

test('null/omitted CEST never asserts inapplicability, and no missing GTIN becomes SEM GTIN',()=>{
 const omitted=prepareFiscalItems(input()),cleared=prepareFiscalItems(input(reviewBasis(),{cest:manual(null),gtin:manual(null)}));
 assert.equal(row(omitted).fields.cest.provenance.source,'unreviewed');assert.equal(row(cleared).fields.cest.provenance.source,'manual');
 for(const result of [omitted,cleared]){assert.equal(row(result).fields.cest.value,null);assert.equal(row(result).fields.gtin.value,null);assert.ok(row(result).pending.includes('CEST_APPLICABILITY_UNREVIEWED'));}
 for(const value of ['','123456','12345678','12.345.67','não se aplica'])rejects(input(reviewBasis(),{cest:manual(value)}),'ITEM_PREPARATION_INVALID_CEST');
 rejects(input(reviewBasis(),{cest:{source:'not_applicable',value:null}}),'ITEM_PREPARATION_INVALID_CHOICE');
});

test('250 lines are bounded, keep commercial order, remain exact and never mutate frozen input',()=>{
 const basis=reviewBasis({itemCount:250,item:{unit:'ÇX',quantity:'1.230000',unit_price:'10.0000'}}),request=input(basis);
 request.decisions=basis.draft.record.snapshot.items.map(item=>({item_id:item.id,fields:{origin:manual('0')}})).reverse();
 const before=JSON.stringify(request),result=prepareFiscalItems(freeze(request));assert.equal(result.items.length,250);assert.equal(JSON.stringify(request),before);
 assert.deepEqual(result.items.map(item=>item.item_id),basis.draft.record.snapshot.items.map(item=>item.id));assert.equal(result.commercial.items[0].unit,'ÇX');
 for(const item of result.commercial.items){assert.equal(item.quantity,'1.230000');assert.equal(item.unit_price,'10.0000');}
 result.commercial.totals.total='99';assert.equal(JSON.stringify(request),before);
 const tooMany=input();tooMany.decisions=Array(251).fill({item_id:reviewIds.item,fields:{origin:manual('0')}});rejects(tooMany,'ITEM_PREPARATION_INVALID_DECISIONS');
});

test('decision order has no effect, including multiple items referencing the same product',()=>{
 const basis=reviewBasis({itemCount:3}),request=input(basis);request.decisions=basis.draft.record.snapshot.items.map((item,index)=>({item_id:item.id,fields:{origin:manual(String(index)),ncm:catalog()}}));
 const expected=prepareFiscalItems(request);request.decisions.reverse();assert.deepEqual(prepareFiscalItems(request),expected);
 assert.deepEqual(expected.items.map(item=>item.fields.origin.value),['0','1','2']);
});

test('historical and archived bindings stay historical; current catalog never rewrites022 or suppresses029 findings',()=>{
 const basis=reviewBasis();basis.draft.current.version=3;basis.draft.current.status='archived';basis.draft.current.source_document_version=2;basis.draft.current.source_changed=true;
 basis.draft.pending.push('DRAFT_ARCHIVED','SOURCE_DOCUMENT_CHANGED');
 const result=prepareFiscalItems(input(basis,{origin:catalog()}));assert.equal(result.binding.draft_version,1);assert.equal(result.binding.source_document_version,1);
 assert.ok(result.pending.includes('DRAFT_ARCHIVED'));assert.ok(result.pending.includes('HISTORICAL_DRAFT_REVISION'));assert.ok(result.pending.includes('SOURCE_DOCUMENT_CHANGED'));
 assert.ok(result.snapshot_findings.some(row=>row.code==='ITEM_ORIGIN_NOT_CAPTURED'));assert.equal(result.items[0].fields.origin.value,'0');
 assert.equal(result.can_emit,false);assert.equal(result.emission_enabled,false);
});

test('preparation exposes no readiness or tax defaults even when all five identifiers are supplied',()=>{
 const result=prepareFiscalItems(input(reviewBasis({model:'65'}),{ncm:manual('12345678'),origin:manual('8'),cest:manual('1234567'),gtin:manual('SEM GTIN'),gtin_tax:manual('SEM GTIN')}));
 for(const key of ['operational_effects','emission_enabled','can_emit','tax_rules_validated','xsd_validated','catalog_registry_verified'])assert.equal(result[key],false);
 assert.equal(result.binding.model,'65');assert.equal(result.binding.environment,'2');
 for(const code of ['CFOP_UNPREPARED','CST_CSOSN_UNPREPARED','TAX_GROUPS_UNPREPARED','TRIBUTARY_UNIT_QUANTITY_PRICE_UNPREPARED'])assert.ok(row(result).pending.includes(code));
 assert.ok(result.pending.includes('XML_NOT_BUILT'));assert.ok(result.pending.includes('TAX_RULES_UNREVIEWED'));
});

test('invalid/sparse structures reject deterministically and errors never echo arbitrary inputs',()=>{
 for(const change of [v=>v.decisions=Array(1),v=>v.decisions=[null],v=>v.decisions=[{item_id:reviewIds.item,fields:{}}],v=>v.decisions=[{item_id:reviewIds.item,fields:{origin:undefined}}]]){
  const value=input();change(value);assert.throws(()=>prepareFiscalItems(value),e=>e instanceof ItemPreparationError);
 }
 try{prepareFiscalItems(input(reviewBasis(),{ncm:manual('PRIVATE_VALUE_DO_NOT_ECHO')}));assert.fail('must reject');}catch(error){assert.equal(error.item_id,reviewIds.item);assert.equal(error.field,'ncm');assert.doesNotMatch(JSON.stringify(error)+error.message,/PRIVATE_VALUE/);}
 const privateInput=input();privateInput.basis.private='DO_NOT_COPY';privateInput.basis.catalog[0].record.internal_cost='DO_NOT_COPY';
 assert.doesNotMatch(JSON.stringify(prepareFiscalItems(privateInput)),/DO_NOT_COPY|internal_cost/);
});

test('the pinned official XSD still declares the exact enum and identifier shapes used by this profile',async()=>{
 const xsd=await readFile(new URL('../../fiscal-schema/schemas/pl010f-v1.04/leiauteNFe_v4.00.xsd',import.meta.url),'utf8');
 const origin=xsd.match(/<xs:simpleType name="Torig">([\s\S]*?)<\/xs:simpleType>/)?.[1];
 assert.deepEqual([...origin.matchAll(/<xs:enumeration value="([0-9])"/g)].map(match=>match[1]),ITEM_PREPARATION_ORIGINS);
 for(const[name,pattern]of [['NCM','[0-9]{2}|[0-9]{8}'],['CEST','[0-9]{7}'],['cEAN','SEM GTIN|[0-9]{0}|[0-9]{8}|[0-9]{12,14}'],['cEANTrib','SEM GTIN|[0-9]{0}|[0-9]{8}|[0-9]{12,14}']]){
  const element=xsd.slice(xsd.indexOf(`<xs:element name="${name}"`));const simple=element.slice(0,element.indexOf('</xs:simpleType>'));assert.ok(simple.includes(`value="${pattern}"`),name);
 }
});
