import test from 'node:test';import assert from 'node:assert/strict';
import {purchaseObservedDecimal as decimal,purchaseReadinessDay as day,purchaseReadinessMoment as moment,purchaseObserved,purchaseSituation,parsePurchaseReadinessPage,parsePurchaseReadinessDetail} from '../src/lib/origin-purchase-readiness-model.ts';
import {page,detail,observed} from './helpers/purchase-readiness-fixtures.mjs';
test('observed quantities and prices preserve significant decimals and distinguish null from zero without arithmetic',()=>{
 assert.equal(decimal('1234.1234567891',true),'R$ 1.234,1234567891');assert.equal(decimal('0.0000000001',true),'R$ 0,0000000001');assert.equal(decimal('999999999.123456'),'999.999.999,123456');assert.equal(decimal('0.00',true),'R$ 0,00');assert.equal(decimal(null,true),'Não informado');assert.equal(decimal('9007199254740993.0001'),'9.007.199.254.740.993,0001');
 for(const value of [0,1.2,'1e-10','01.2','NaN','<script>','1\n','1\r', '1'.repeat(257)])assert.throws(()=>decimal(value));
});
test('source day is literal while observation time is explicitly São Paulo',()=>{assert.equal(day('2024-02-29'),'29/02/2024');assert.equal(day(null),'Não informada');assert.match(moment('2026-10-17T01:55:30Z'),/16\/10\/2026.*22:55:30/);assert.equal(moment(null),'Não informada');});
test('missing, null, invalid, empty and zero remain different observed states',()=>{
 const values=[observed(undefined),observed(null),{state:'invalid',value:null},observed(''),observed('0')].map(v=>purchaseObserved(v));assert.equal(new Set(values).size,5);
 assert.equal(purchaseObserved(observed('0000-00-00'),'date'),'0000-00-00');assert.equal(purchaseObserved(observed('2024-02-29'),'date'),'29/02/2024');assert.equal(purchaseSituation(observed('0')),'Em aberto');assert.match(purchaseSituation(observed('99')),/não classificada/);
});
test('UI consumes the closed shared DTO without promoting capture, binding, history or monetary values',()=>{
 const raw=detail(),safe=parsePurchaseReadinessDetail(raw,{sourceId:raw.source.source_id});raw.items[0].unit_price.value='1';assert.equal(safe.items[0].unit_price.value,'12.1234567891');assert.ok(Object.isFrozen(safe.items[0]));
 for(const patch of [v=>v.items[0].unit_price.value=12.12,v=>v.items[0].quantity.value='1e2',v=>v.history.comparison='matched',v=>v.history.current_capture_is_history=true,v=>v.native_effects=true,v=>v.supplier.active=false]){const v=detail();patch(v);assert.throws(()=>parsePurchaseReadinessDetail(v,{sourceId:'100000'}));}
 assert.throws(()=>parsePurchaseReadinessDetail(detail(),{sourceId:'100001'}));assert.throws(()=>parsePurchaseReadinessPage(page(['2','10']),{limit:25,after:null}));
});
