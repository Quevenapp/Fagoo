import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {validateTaxDecisions,resolveTaxItems,TAX_PREPARATION_FLAGS,TAX_MONEY,TAX_RATE} from '../src/tax-preparation.mjs';
const id=randomUUID(),product=randomUUID();
const basis=()=>[{item_id:id,position:1,product_id:product,identifiers:{ncm:'82055900',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}}];
const choice=(patch={})=>({item_id:id,cfop:null,icms:null,pis:null,cofins:null,review_note:null,...patch});
const other=(patch={})=>({cst:'49',base:null,rate:null,amount:null,...patch});
const sn500=()=>({csosn:'500',retention:{base:null,rate:null,substitute_icms:null,retained_icms:null},fcp:{base:null,rate:null,amount:null},effective:{reduction_rate:null,base:null,rate:null,amount:null}});
const resolve=(decisions,model='55',items=basis())=>resolveTaxItems({model,items,decisions});
test('040 explicit decisions preserve null and exact decimals without performing calculations or choosing classifications',()=>{
 const unreviewed=resolve([])[0];assert.equal(unreviewed.decisions.cfop,null);assert.equal(unreviewed.decisions.icms,null);assert.equal(unreviewed.provenance.icms,'unreviewed');assert.ok(unreviewed.pending.includes('ICMS_UNPREPARED'));
 const decisions=[choice({cfop:'5102',icms:{csosn:'101',credit_rate:'4.7900',credit_period:'2026-10',credit_evidence:'Declaração sintética a revisar'},pis:other({base:'9999999999999.99',rate:'0.0000',amount:'0.00'}),cofins:other()})];
 const before=structuredClone(decisions),items=basis(),oldItems=structuredClone(items),r=resolve(decisions,'55',items)[0];
 assert.deepEqual(decisions,before);assert.deepEqual(items,oldItems);assert.equal(r.decisions.icms.credit_rate,'4.7900');assert.equal(r.decisions.pis.amount,'0.00');assert.equal(r.decisions.cofins.amount,null);
 assert.ok(r.pending.includes('CREDIT_ENTITLEMENT_UNVERIFIED'));assert.ok(r.pending.includes('CREDIT_AMOUNT_NOT_CALCULATED'));assert.ok(r.pending.includes('ACCOUNTING_REVIEW_REQUIRED'));assert.ok(Object.values(TAX_PREPARATION_FLAGS).every(x=>x===false));
 r.decisions.icms.credit_rate='9.00';assert.equal(decisions[0].icms.credit_rate,'4.7900');
});
test('040 typed supported branches remain explicit and unsupported branches/foreign items cannot be silently converted',()=>{
 for(const icms of[{csosn:'102'},sn500()])for(const model of['55','65'])assert.equal(resolve([choice({icms})],model)[0].decisions.icms.csosn,icms.csosn);
 assert.throws(()=>resolve([choice({icms:{csosn:'101',credit_rate:null,credit_period:null,credit_evidence:null}})],'65'),{code:'FISCAL_TAX_UNSUPPORTED_BRANCH'});
 for(const patch of[{cfop:'6102'},{cfop:5102},{icms:{csosn:'900'}},{icms:{csosn:'102',base:'0.00'}},{pis:{cst:'01',base:'0.00',rate:'0.00',amount:'0.00'}},{item_id:randomUUID()},{item_id:[id]},{unit_price:'0.00'}])assert.throws(()=>resolve([choice(patch)]));
 assert.throws(()=>resolve([choice(),choice()]));assert.throws(()=>resolve([choice({icms:{csosn:'101',credit_rate:null,credit_period:'2026-13',credit_evidence:null}})]));
});
test('040 decimal notation is an exact subset of pinned XSD types and rejects coercion, overflow and malformed precision',async()=>{
 const xml=await readFile(new URL('../../fiscal-schema/schemas/pl010f-v1.04/tiposBasico_v4.00.xsd',import.meta.url),'utf8');
 const pattern=name=>new RegExp('^(?:'+xml.split(`<xs:simpleType name="${name}">`)[1].split('</xs:simpleType>')[0].match(/<xs:pattern value="([^"]+)"/)[1]+')$');
 for(const [kind,values,regex,xsd]of[['money',['0.00','9999999999999.99','10000000000000.00','01.00','1','1.0','1.000','-1.00','1e2','NaN',0],TAX_MONEY,pattern('TDec_1302')],['rate',['0.00','0.0000','999.9999','1000.00','4.79','04.79','4.7','4.79000','4,79',4.79],TAX_RATE,pattern('TDec_0302a04')]])for(const value of values){
  const valid=typeof value==='string'&&regex.test(value);if(valid)assert.ok(xsd.test(value));
  const d=choice({pis:other({[kind==='money'?'base':'rate']:value})});if(valid)assert.doesNotThrow(()=>validateTaxDecisions([d]));else assert.throws(()=>validateTaxDecisions([d]));
 }
});
test('040 notes and item identities reject ambiguous input, preserve Unicode and enforce the 250-item bound',()=>{
 for(const note of['ação fiscal pendente','é'.repeat(1000),'😀'.repeat(1000)])assert.equal(resolve([choice({review_note:note})])[0].decisions.review_note,note);
 for(const note of['ab','   ','\u00a0'.repeat(3),'\u2003'.repeat(3),'x\ny','é'.repeat(1001),3])assert.throws(()=>resolve([choice({review_note:note})]));
 const items=Array.from({length:250},(_,n)=>({...basis()[0],item_id:randomUUID(),position:n+1,product_id:n===249?null:product}));const output=resolve([],'55',items);assert.equal(output.length,250);assert.ok(output[249].pending.includes('FREE_ITEM_REQUIRES_REVIEW'));assert.deepEqual(output.map(x=>x.item_id),items.map(x=>x.item_id));
 assert.throws(()=>resolve([],'55',[...items,{...items[0],item_id:randomUUID(),position:251}]));assert.throws(()=>resolve([],'55',[null]));assert.throws(()=>resolve([],'55',[{...items[0],position:2}]));
});
