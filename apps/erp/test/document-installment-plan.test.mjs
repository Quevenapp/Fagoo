import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlyDocumentPlan,applyMonthlyDocumentPlan} from '../src/lib/document-installment-plan.ts';
import {normalizeDocument} from '../../../packages/erp-domain/src/index.mjs';
import {input} from './helpers/document-commercial-fixtures.mjs';
const value=(total='100.00',date='2027-01-01')=>({...input(),date,items:[{description:'Produto sintético',unit:'UN',quantity:'1',unit_price:total}],installments:[]});
const cents=rows=>rows.reduce((sum,row)=>sum+BigInt(row.amount.replace('.','')),0n);

test('monthly dates preserve the chosen day across short months, leap years and year rollover',()=>{
 for(const [first,expected] of [
  ['2027-01-31',['2027-01-31','2027-02-28','2027-03-31']],
  ['2028-01-31',['2028-01-31','2028-02-29','2028-03-31']],
  ['2027-12-31',['2027-12-31','2028-01-31','2028-02-29']],
  ['2028-02-29',['2028-02-29','2028-03-29','2028-04-29']],
 ]){
  const plan=monthlyDocumentPlan('source',value(),'3',first);
  assert.deepEqual(plan.installments.map(row=>row.due_date),expected);
  assert.deepEqual(plan.installments.map(row=>row.amount),['33.34','33.33','33.33']);
  assert.equal(cents(plan.installments),10000n);
 }
});
test('current commercial total includes line/global discounts, freight and other expenses, with exact cents',()=>{
 const data={...value(),items:[{description:'Peça',unit:'UN',quantity:'3',unit_price:'19.99',discount_percent:'10'}],discount_mode:'percent',discount_value:'10',freight:'8.36',other_expenses:'0.08'};
 const plan=monthlyDocumentPlan('source',data,'3','2027-01-31');
 assert.equal(plan.total,'57.01');assert.deepEqual(plan.installments.map(row=>row.amount),['19.01','19.00','19.00']);
 const amount=monthlyDocumentPlan('source',{...data,discount_mode:'amount',discount_value:'5.40'},'3','2027-01-31');assert.deepEqual(amount.installments,plan.installments);
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders'])assert.equal(normalizeDocument(kind,{...data,installments:plan.installments}).totals.total,plan.total);
});
test('ten decimal unit prices use existing document rounding once, before cent distribution',()=>{
 const data={...value(),items:[{description:'Peça',unit:'UN',quantity:'1.234567',unit_price:'12.1234567891'}]};
 const plan=monthlyDocumentPlan('source',data,'2','2027-01-31');assert.equal(plan.total,'14.97');assert.deepEqual(plan.installments.map(row=>row.amount),['7.49','7.48']);assert.equal(data.items[0].unit_price,'12.1234567891');
});
test('quantity/date are explicit and invalid limits, cent underflow and document year overflow are refused',()=>{
 for(const count of ['', '0','01','1.5','121','-1','abc'])assert.throws(()=>monthlyDocumentPlan('source',value(),count,'2027-01-31'));
 for(const due of ['', '2026-12-31','2027-02-29','2027-13-01','2100-01-01'])assert.throws(()=>monthlyDocumentPlan('source',value(),'3',due));
 assert.throws(()=>monthlyDocumentPlan('source',value('0.00'),'1','2027-01-31'));
 assert.throws(()=>monthlyDocumentPlan('source',value('0.02'),'3','2027-01-31'));
 assert.throws(()=>monthlyDocumentPlan('source',value('1.00','2099-12-01'),'2','2099-12-31'),/2099/);
 assert.throws(()=>monthlyDocumentPlan('source',value('1.00','2027-02-29'),'1','2027-03-01'));
 assert.throws(()=>monthlyDocumentPlan('source',{...value(),discount_value:'101.00'},'3','2027-01-31'));
});
test('120 installments stay positive and sum exactly, including the maximum document total',()=>{
 const tiny=monthlyDocumentPlan('s',value('1.20'),'120','2027-01-31');assert.ok(tiny.installments.every(row=>row.amount==='0.01'));assert.equal(cents(tiny.installments),120n);
 const large={...value(),items:[{description:'Peça',unit:'UN',quantity:'100',unit_price:'9999999999.9999'}]};
 const plan=monthlyDocumentPlan('s',large,'120','2027-01-31');assert.equal(plan.total,'999999999999.99');assert.equal(cents(plan.installments),99999999999999n);
});
test('apply changes only planned rows and rejects stale date, values, source and old parcel metadata',()=>{
 const data={...input(),payment_terms:'Texto livre preservado'},before=structuredClone(data),plan=monthlyDocumentPlan('source:v1',data,'3','2026-10-31');
 assert.deepEqual(data,before);
 const rows=applyMonthlyDocumentPlan('source:v1',data,plan);
 assert.ok(rows.every(row=>row.method===null&&row.note===null&&row.payment_reference===null));assert.deepEqual(data,before);
 for(const change of [x=>x.date='2026-10-17',x=>x.freight='1',x=>x.items[0].unit_price='12.51',x=>x.installments[0].note='Outra observação',x=>x.payment_terms='Outro texto']){const next=structuredClone(data);change(next);assert.throws(()=>applyMonthlyDocumentPlan('source:v1',next,plan),/mudou/);}
 assert.throws(()=>applyMonthlyDocumentPlan('source:v2',data,plan),/mudou/);
 rows[0].amount='0.01';assert.equal(applyMonthlyDocumentPlan('source:v1',data,plan)[0].amount,'4.17');
});
