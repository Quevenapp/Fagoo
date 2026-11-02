import test from 'node:test';
import assert from 'node:assert/strict';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {PRICE_VECTORS} from '../../fiscal-core/test/unit-price-fixtures.mjs';
import {resolveBusinessDocument} from '../../fiscal-core/src/business-document.mjs';
import {fiscalExactDecimal} from '../../fiscal-core/src/review.mjs';
import {buildBusinessXml} from '../src/business-builder.mjs';
import {parseStrict} from '../src/xml.mjs';

test('fiscal q4 × p10 keeps exact price, half-cent boundaries and large products in both models',()=>{
 for(const model of ['55','65'])for(const {gross,...vector} of PRICE_VECTORS){
  const input=businessFixture({model,...vector}),resolved=resolveBusinessDocument(input),result=buildBusinessXml(input),doc=parseStrict(result.unsignedXml);
  const value=name=>doc.getElementsByTagName(name)[0].textContent;
  assert.equal(input.draft.record.snapshot.items[0].unit_price,vector.unit_price);
  assert.equal(input.draft.record.snapshot.totals.gross,gross);
  assert.equal(resolved.totals.vProd,gross);
  assert.equal(value('vUnCom'),fiscalExactDecimal(vector.unit_price,10,11));
  assert.equal(value('vUnTrib'),value('vUnCom'));
  assert.equal(value('qCom'),fiscalExactDecimal(vector.quantity,4,11));
  assert.equal(value('vProd'),gross);assert.equal(value('vNF'),gross);assert.equal(value('vPag'),gross);
  assert.equal(result.xsd_validated,false);assert.equal(result.signature_verified,false);assert.equal(result.can_transmit,false);
 }
});

test('commercial cents and explicit allocations/payments agree without changing the price or calculating tax',()=>{
 for(const model of ['55','65']){
  const input=businessFixture({model,count:2,quantity:'2.000000',unit_price:'10.1234567891',discount:'0.03',freight:'1.01',other:'0.02'}),result=buildBusinessXml(input),doc=parseStrict(result.unsignedXml);
  const {items,...totals}=input.draft.record.snapshot.totals;
  assert.deepEqual(totals,{gross:'40.50',line_discount:'0.00',subtotal:'40.50',discount:'0.03',freight:'1.01',other_expenses:'0.02',total:'41.50'});
  assert.deepEqual(items,[{gross:'20.25',discount:'0.00',total:'20.25'},{gross:'20.25',discount:'0.00',total:'20.25'}]);
  assert.equal(doc.getElementsByTagName('vNF')[0].textContent,'41.50');assert.equal(doc.getElementsByTagName('vPag')[0].textContent,'41.50');
  assert.equal(doc.getElementsByTagName('vUnCom')[1].textContent,'10.1234567891');
  assert.equal(result.tax_rules_validated,false);
 }
});

test('price extension does not round fiscal quantities or accept an extra significant price digit',()=>{
 const input=businessFixture({quantity:'0.000001',unit_price:'10000.1234567891'});
 assert.equal(input.draft.record.snapshot.totals.total,'0.01');
 assert.throws(()=>buildBusinessXml(input),e=>e.code==='BUSINESS_QUANTITY_PRECISION');
 for(const unit_price of ['0.12345678901','10000000000.0000000001'])assert.throws(()=>businessFixture({unit_price}));
 const tributary=businessFixture({unit_price:'10.1234567891'});tributary.completion.items[0].tributary.unit_price='10.12345678911';
 assert.throws(()=>buildBusinessXml(tributary));
});
