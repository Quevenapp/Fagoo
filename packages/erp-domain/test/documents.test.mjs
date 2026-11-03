import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateDocument, normalizeDocument, checkTransition, canEdit, decimal, format, DocumentError } from '../src/index.mjs';

const contact = '11111111-1111-4111-8111-111111111111';
export const body = () => ({ date: '2026-10-16', contact_id: contact,
  items: [{ description: 'Item sintético', unit: 'UN', quantity: '3', unit_price: '1.005', discount_percent: '10' }],
  discount_mode: 'percent', discount_value: '5', freight: '1.20', other_expenses: '0.30' });

test('line and global discounts round half up on the same cent bases', () => {
  const totals = calculateDocument(body());
  assert.deepEqual(totals, { items: [{ gross: '3.02', discount: '0.30', total: '2.72' }],
    gross: '3.02', line_discount: '0.30', subtotal: '2.72', discount: '0.14', freight: '1.20', other_expenses: '0.30', total: '4.08' });
  assert.equal(calculateDocument({ items: [{ quantity: '1', unit_price: '0.005', discount_percent: '0' }] }).total, '0.01');
  assert.equal(calculateDocument({ items: [{ quantity: '1', unit_price: '0.01', discount_percent: '50' }] }).total, '0.00');
});
test('canonical decimals retain precision and reject numeric, scientific and localized inputs', () => {
  assert.equal(format(decimal('999999999.999999', 6, 9), 6), '999999999.999999');
  for (const value of [1.1, '1e3', '-1', '01', '1,20', '1.0000001', null]) assert.throws(() => decimal(value, 6, 9));
  assert.throws(() => calculateDocument({ items: [{ quantity: '999999999', unit_price: '9999999999' }] }), /TOTAL_LIMIT/);
  assert.throws(() => calculateDocument({ items: [{ quantity: '1', unit_price: '1' }], discount_value: '1.01' }), /DISCOUNT_EXCEEDS/);
  assert.throws(() => calculateDocument({ items: [{ quantity: '0', unit_price: '1' }] }), /QUANTITY_INVALID/);
});
test('057 document prices retain ten effective places and cents use the complete price before rounding', () => {
  for (const [quantity,price,total] of [['100000000','0.0000000001','0.01'],['1','0.0049999999','0.00'],['1','0.0050000001','0.01'],['3','0.0050000001','0.02']]) {
    const input={date:'2026-10-16',contact_id:contact,items:[{description:'Preço exato',unit:'UN',quantity,unit_price:price}]},before=structuredClone(input);
    const doc=normalizeDocument('sales_orders',input);
    assert.equal(doc.items[0].unit_price,price);assert.equal(doc.totals.total,total);assert.deepEqual(input,before);
  }
  const input=body();input.items[0].unit_price='1.00500000000000';
  assert.deepEqual(normalizeDocument('sales_proposals',input),normalizeDocument('sales_proposals',body()));
  input.items[0].unit_price='0.0050000001';input.items[0].discount_percent='50';
  Object.assign(input,{discount_mode:'percent',discount_value:'50',freight:'0.01',other_expenses:'0.02'});
  assert.deepEqual(calculateDocument(input),{items:[{gross:'0.02',discount:'0.01',total:'0.01'}],gross:'0.02',line_discount:'0.01',subtotal:'0.01',discount:'0.01',freight:'0.01',other_expenses:'0.02',total:'0.03'});
});
test('057 changes only unit-price precision and preserves the document error contract', () => {
  for(const price of ['1.00000000001','10000000000','01','1e-10',0.1,'1.'+'0'.repeat(79)]){
    const input=body();input.items[0].unit_price=price;
    assert.throws(()=>normalizeDocument('sales_proposals',input),e=>e instanceof DocumentError&&e.code==='DOCUMENT_DECIMAL_INVALID');
  }
  for(const mutate of [v=>v.items[0].quantity='1.0000001',v=>v.items[0].discount_percent='1.00001',v=>v.freight='0.001',v=>v.discount_value='0.00001']){
    const input=body();mutate(input);assert.throws(()=>normalizeDocument('sales_proposals',input),e=>e instanceof DocumentError&&e.code==='DOCUMENT_DECIMAL_INVALID');
  }
});
test('planned installments are exact and never imply financial posting', () => {
  const input = { ...body(), installments: [{ due_date: '2026-11-01', amount: '2.04', method: 'Boleto planejado' }, { due_date: '2026-12-01', amount: '2.04' }] };
  const doc = normalizeDocument('sales_proposals', input);
  assert.equal(doc.installments[1].amount, '2.04');
  assert.equal(doc.items[0].quantity, '3.000000');
  input.installments[1].amount = '2.03';
  assert.throws(() => normalizeDocument('sales_proposals', input), /INSTALLMENT_TOTAL/);
});
test('strict document shape, dates, templates, IDs and service fields prevent hidden changes', () => {
  assert.throws(() => normalizeDocument('sales_orders', { ...body(), total: '1' }), /FIELD_INVALID/);
  assert.throws(() => normalizeDocument('sales_orders', { ...body(), template: true }), /TEMPLATE_INVALID/);
  assert.throws(() => normalizeDocument('sales_orders', { ...body(), equipment: 'Equipamento' }), /SERVICE_FIELD/);
  assert.throws(() => normalizeDocument('sales_orders', { ...body(), date: '2026-02-30' }), /DATE_INVALID/);
  assert.equal(normalizeDocument('service_orders', { ...body(), equipment: 'Equipamento', defect: 'Linha1\nLinha2' }).defect, 'Linha1\nLinha2');
  assert.equal(normalizeDocument('service_orders', {date:'2026-10-16',contact_id:contact,items:[],equipment:'Recepção para diagnóstico'}).totals.total,'0.00');
  const duplicate = { ...body(), items: [1, 2].map(() => ({ ...body().items[0], id: contact })) };
  assert.throws(() => normalizeDocument('sales_orders', duplicate), /ID_DUPLICATE/);
});
test('transitions require reasons for cancellation/reopening and completed quotes have no cycle', () => {
  assert.equal(checkTransition('sales_orders', 'draft', 'open'), true);
  assert.throws(() => checkTransition('sales_orders', 'open', 'cancelled'), /REASON_REQUIRED/);
  assert.equal(checkTransition('sales_orders', 'open', 'cancelled', 'Pedido desistido'), true);
  assert.throws(() => checkTransition('sales_proposals', 'completed', 'open', 'Tentar novamente'), /TRANSITION_INVALID/);
  assert.equal(canEdit('sales_proposals', 'approved'), false);
  assert.equal(canEdit('service_orders', 'in_progress'), true);
  assert.equal(checkTransition('service_orders', 'approved', 'in_progress'), true);
  assert.equal(checkTransition('service_orders', 'service_done', 'finalized'), true);
});
