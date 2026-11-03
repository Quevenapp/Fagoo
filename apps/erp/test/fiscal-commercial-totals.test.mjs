import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewBasis} from '../../../packages/fiscal-core/test/review-fixtures.mjs';
import {emptyCompletion} from '../src/lib/fiscal-completion-model.ts';
import {commercialTotals,commercialTotalsReplaceValues,withCommercialTotals,compareDeclaredPayments} from '../src/lib/fiscal-commercial-totals.ts';

const fixture=()=>{const draft=reviewBasis().draft;draft.record.snapshot.totals={gross:'100.01',line_discount:'10.01',subtotal:'90.00',discount:'5.01',freight:'2.02',other_expenses:'3.03',total:'90.04'};return draft;};
const form=()=>emptyCompletion(fixture().record.snapshot.items.map(item=>item.id));
test('commercial totals use only five snapshot amounts, exact combined discount and preserve all other fields',()=>{
 const draft=fixture(),source=commercialTotals(draft),before=form();before.totals.vICMS='4.03';before.items[0].allocations.freight='9.00';before.payments.items=[{type:'15',timing:'1',amount:'99.01'}];
 const frozen=structuredClone(before),after=withCommercialTotals(before,source);
 assert.deepEqual(source.totals,{vProd:'100.01',vDesc:'15.02',vFrete:'2.02',vOutro:'3.03',vNF:'90.04'});
 assert.deepEqual({...after,totals:before.totals},before);assert.equal(after.totals.vICMS,'4.03');assert.equal(after.totals.vPIS,null);assert.deepEqual(before,frozen);
 assert.equal(commercialTotalsReplaceValues(before,source),false);assert.equal(commercialTotalsReplaceValues(after,source),false);after.totals.vFrete='0.00';assert.equal(commercialTotalsReplaceValues(after,source),true);after.totals.vFrete='2.0';assert.equal(commercialTotalsReplaceValues(after,source),true);
 assert.equal(Object.isFrozen(source),true);assert.equal(Object.isFrozen(source.totals),true);
});
test('commercial totals reject incomplete, noncanonical, inconsistent, stale and historical snapshots without rounding',()=>{
 for(const mutate of[d=>delete d.record.snapshot.totals.freight,d=>d.record.snapshot.totals.total=null,d=>d.record.snapshot.totals.total='90.040',d=>d.record.snapshot.totals.total=90.04,d=>d.record.snapshot.totals.total='9e1',d=>d.record.snapshot.totals.total='090.04',d=>d.record.snapshot.totals.subtotal='90.01',d=>d.record.snapshot.totals.discount='90.01',d=>d.record.snapshot.totals.total='90.05',d=>d.current.source_changed=true,d=>d.current.company_changed=true,d=>d.current.version++,d=>d.current.source_document_version++,d=>d.current.source_status='cancelled',d=>d.record.snapshot.document_version++,d=>d.record.status='archived']){const d=fixture();mutate(d);assert.throws(()=>commercialTotals(d));}
});
test('largest commercial amounts and discounts stay exact without Number conversion',()=>{
 const d=fixture();d.record.snapshot.totals={gross:'9999999999999.99',line_discount:'9999999999999.97',subtotal:'0.02',discount:'0.01',freight:'0.01',other_expenses:'0.01',total:'0.03'};
 assert.deepEqual(commercialTotals(d).totals,{vProd:'9999999999999.99',vDesc:'9999999999999.98',vFrete:'0.01',vOutro:'0.01',vNF:'0.03'});
});
test('payment comparison never treats missing or transient values as zero or fills payment choices',()=>{
 const f=form();f.totals.vNF='0.00';f.payments.change='0.00';assert.equal(compareDeclaredPayments(f).state,'incomplete');f.payments.items=[{type:null,timing:null,amount:null}];
 for(const amount of[null,'','0','0.0','0.000',0,'-0.01','1e2']){f.payments.items[0].amount=amount;assert.equal(compareDeclaredPayments(f).state,'incomplete');}
 f.payments.items[0].amount='0.00';for(const change of[null,'0.0']){f.payments.change=change;assert.equal(compareDeclaredPayments(f).state,'incomplete');}
 f.payments.change='0.00';const before=structuredClone(f);assert.equal(compareDeclaredPayments(f).direction,'equal');assert.deepEqual(f,before);assert.equal(f.payments.items[0].type,null);
});
test('payment comparison exposes short/excess/equal after explicit change and sums100 maximum values exactly',()=>{
 const f=form();f.totals.vNF='10.00';f.payments={items:[{type:'01',timing:'0',amount:'12.00'}],change:'2.00'};
 assert.deepEqual(compareDeclaredPayments(f),{state:'compared',declared:'12.00',change:'2.00',total:'10.00',difference:'0.00',direction:'equal'});
 f.payments.change='2.01';assert.equal(compareDeclaredPayments(f).direction,'short');assert.equal(compareDeclaredPayments(f).difference,'0.01');f.payments.change='1.99';assert.equal(compareDeclaredPayments(f).direction,'excess');
 f.payments={items:Array.from({length:100},()=>({type:'15',timing:'1',amount:'9999999999999.99'})),change:'0.00'};f.totals.vNF='9999999999999.99';
 assert.deepEqual(compareDeclaredPayments(f),{state:'compared',declared:'999999999999999.00',change:'0.00',total:'9999999999999.99',difference:'989999999999999.01',direction:'excess'});
});
