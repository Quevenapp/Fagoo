import test from 'node:test';
import assert from 'node:assert/strict';
import {planItau109NetCredit as plan} from '../src/itau-net-credit.mjs';
const category={id:'11111111-1111-4111-8111-111111111111',version:2,name:'Tarifas fictícias',kind:'payable',active:true};
const input=()=>({bank:'341',wallet:'109',nominal_cents:'10000',credited_cents:'9750',adjustments:{fee:'250',iof:'0',abatement:'0',discount:'0',interest:'0',otherCredits:'0'},fee_category:{...category},expected_fee_category_version:2});
test('net credit preserves principal and emits exactly the gross and fee legs, without inferring any charge',()=>{
 const source=input(),copy=structuredClone(source),p=plan(source);assert.deepEqual(source,copy);assert.deepEqual(p.issues,[]);
 assert.deepEqual(p.posting.legs,[{kind:'payment',delta_cents:'10000'},{kind:'bank_fee',delta_cents:'-250'}]);assert.equal(p.posting.net_cash_cents,'9750');assert.equal(p.posting.interest_cents,'0');assert.equal(p.posting.penalty_cents,'0');assert.ok(Object.isFrozen(p.posting.fee_category));
 source.fee_category.name='Changed';source.adjustments.fee='1';assert.equal(p.posting.fee_category.name,category.name);assert.equal(p.posting.fee_cents,'250');
});
test('a single cent mismatch, unsupported adjustments and aggregated mora/multa stay blocked',()=>{
 for(const field of ['iof','discount','abatement','otherCredits','interest']){const x=input();x.adjustments[field]='1';const p=plan(x);assert.equal(p.posting,null);assert.ok(p.issues.includes(field==='interest'?'MORA_PENALTY_UNSUPPORTED':'NET_CREDIT_ADJUSTMENTS_UNSUPPORTED'));}
 const x=input();x.credited_cents='9751';assert.deepEqual(plan(x).issues,['NET_CREDIT_EQUATION_DIFFERS']);
});
test('explicit versioned expense category, positive net and fee and exact bank/wallet are required',()=>{
 const cases=[{fee_category:null},{fee_category:{...category,active:false}},{fee_category:{...category,kind:'receivable'}},{expected_fee_category_version:1},{bank:'077',wallet:'110',adjustments:null},{wallet:'112'},{credited_cents:'0'}, {credited_cents:'10000',adjustments:{...input().adjustments,fee:'0'}}];
 for(const change of cases)assert.equal(plan({...input(),...change}).posting,null);
});
test('bigint maximum and one-cent fee are exact; decimals, leading zeros, numbers and getters are refused',()=>{
 const x=input();x.nominal_cents='999999999999999';x.credited_cents='999999999999998';x.adjustments.fee='1';assert.equal(plan(x).posting.net_cash_cents,'999999999999998');
 for(const bad of [10000,'01','1.00','1e2','1000000000000000'])assert.throws(()=>plan({...input(),nominal_cents:bad}),/INPUT_INVALID/);
 let invoked=0;const getter=input();Object.defineProperty(getter,'credited_cents',{enumerable:true,get(){invoked++;return '9750';}});assert.throws(()=>plan(getter),/INPUT_INVALID/);assert.equal(invoked,0);
});
