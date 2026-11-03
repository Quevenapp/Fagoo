import test from 'node:test';
import assert from 'node:assert/strict';
import { belowListPrice, discountText, parseDiscountText, quantitySum, registeredAt } from '../src/lib/document-editor-totals.ts';
import { conditionDays, conditionInstallments, daysFrom, dueFromDays } from '../src/lib/document-payment-condition.ts';
import { missingRequired, requiredMessage } from '../src/lib/document-required.ts';
import { quickContactPayload } from '../src/lib/document-editor-pickers.ts';
import { freshDocument } from '../src/lib/real-documents-model.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Origin form helpers of the vendas editor (synthetic values only).
const contact = 'c0000000-0000-4000-8000-000000000102';
const line = (quantity, unit_price, extra = {}) => ({ id: null, product_id: null, description: 'Item sintético', code: null, unit: 'UN', quantity, unit_price, discount_percent: '0', detailed_description: null, ...extra });
const doc = (items, extra = {}) => ({ date: '2026-10-20', contact_id: contact, items, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [], ...extra });

test('Soma das quantidades is an exact six-decimal sum; a line being typed shows no total', () => {
  assert.equal(quantitySum([{ quantity: '1.5' }, { quantity: '2.25' }]), '3.75');
  assert.equal(quantitySum([{ quantity: '999999999.999999' }, { quantity: '0.000001' }]), '1000000000');
  assert.equal(quantitySum([]), '0');
  assert.equal(quantitySum([{ quantity: '1.' }]), null);
});

test('single Desconto field understands “10%” and “3,00” like Origin', () => {
  assert.deepEqual(parseDiscountText('10%'), { discount_mode: 'percent', discount_value: '10' });
  assert.deepEqual(parseDiscountText(' 2,5 % '), { discount_mode: 'percent', discount_value: '2.5' });
  assert.deepEqual(parseDiscountText('3,00'), { discount_mode: 'amount', discount_value: '3.00' });
  assert.deepEqual(parseDiscountText(''), { discount_mode: 'amount', discount_value: '0' });
  assert.equal(discountText({ discount_mode: 'percent', discount_value: '10.0000' }), '10,0000%');
  assert.equal(discountText({ discount_mode: 'amount', discount_value: '3.00' }), '3,00');
  assert.equal(discountText({ discount_mode: 'amount', discount_value: '0.00' }), '', 'zero shows the “Ex: 3,00 ou 10%” hint');
});

test('price below the catalog price is detected exactly; missing or invalid prices never warn', () => {
  assert.equal(belowListPrice('9.9999999999', '10.0000'), true);
  assert.equal(belowListPrice('10', '10.0000'), false);
  assert.equal(belowListPrice('10.5', '10.0000'), false);
  assert.equal(belowListPrice('1', null), false); assert.equal(belowListPrice('1,', '2.0000'), false);
});

test('Cadastrada em uses the São Paulo clock', () => {
  assert.equal(registeredAt('2026-10-16T12:00:00Z'), '16/10/2026 09:00:00');
  assert.equal(registeredAt('2026-10-20T02:59:59.999Z'), '19/10/2026 23:59:59');
  assert.equal(registeredAt('inválida'), '');
});

test('payment condition: terms, Nx and “D +Nx” become installments in exact cents', () => {
  assert.deepEqual(conditionDays('30'), [30]);
  assert.deepEqual(conditionDays(' 30 60  90 '), [30, 60, 90]);
  assert.deepEqual(conditionDays('30,60/90;120'), [30, 60, 90, 120]);
  assert.deepEqual(conditionDays('3x'), [30, 60, 90]);
  assert.deepEqual(conditionDays('3X'), [30, 60, 90]);
  assert.deepEqual(conditionDays('15 +2x'), [15, 45, 75]);
  assert.deepEqual(conditionDays('0'), [0]);
  for (const bad of ['', 'trinta', '60 30', '121x', '0x', '30 -60', '9999']) assert.throws(() => conditionDays(bad), Error, bad);
  const installments = conditionInstallments(doc([line('1', '100')]), '30 60 90', '2026-10-20');
  assert.deepEqual(installments.map(row => [row.due_date, row.amount]), [['2026-11-19', '33.34'], ['2026-12-19', '33.33'], ['2027-01-18', '33.33']]);
  assert.doesNotThrow(() => normalizeDocument('sales_orders', { ...doc([line('1', '100')]), installments }), 'the plan matches the document total');
  assert.throws(() => conditionInstallments(doc([line('1', '0.02')]), '3x', '2026-10-20'), /pelo menos R\$ 0,01/);
  assert.throws(() => conditionInstallments(doc([line('1', '10')]), '30', '2099-12-15'), /31\/12\/2099/);
  assert.throws(() => conditionInstallments(doc([line('1', '10')]), '30', ''), /data do documento/);
});

test('Dias column converts between days and due dates from the document date', () => {
  assert.equal(daysFrom('2026-10-20', '2026-11-19'), '30'); assert.equal(daysFrom('2026-10-20', '2026-10-01'), '-19'); assert.equal(daysFrom('', '2026-10-01'), '');
  assert.equal(dueFromDays('2026-10-20', '45'), '2026-12-04'); assert.equal(dueFromDays('2026-10-20', 'x'), null); assert.equal(dueFromDays('2099-12-30', '5'), null);
});

test('required fields use the Origin message and point at each field', () => {
  const missing = missingRequired('sales_orders', { ...doc([line('', '', { description: ' ', unit: '' })]), contact_id: '', date: '', installments: [{ due_date: '', amount: '' }] });
  assert.deepEqual(missing.map(requiredMessage), ['O campo Data da venda é obrigatório', 'O campo Cliente é obrigatório', 'O campo Descrição é obrigatório', 'O campo Un é obrigatório', 'O campo Quantidade é obrigatório', 'O campo Preço un é obrigatório', 'O campo Data (parcela 1) é obrigatório', 'O campo Valor (parcela 1) é obrigatório']);
  assert.deepEqual(missing.map(field => field.id).slice(0, 3), ['doc-date', 'doc-contact', 'doc-item-description-0']);
  assert.equal(missingRequired('purchase_orders', { ...doc([line('1', '1')]), contact_id: '' })[0].label, 'Fornecedor');
  assert.match(missingRequired('sales_orders', doc([line('1', '1'), line('1', '1', { description: '' })]))[0].label, /Descrição \(item 2\)/);
});

test('Contato rápido sends the Origin address block through the catalog validation', () => {
  const values = { name: 'Cliente endereço sintético', person_type: 'J', document: '', phone: '', mobile: '', email: '', roles: ['customer'], code: 'C-1', trade_name: 'Fantasia sintética', ie: 'ISENTO', postal_code: '13400-000', state: 'sp', city: 'Piracicaba', district: 'Centro', street: 'Rua Sintética', number: '10', complement: 'Sala 2' };
  const { data } = quickContactPayload('sales_orders', values);
  assert.deepEqual([data.code, data.trade_name, data.ie, data.postal_code, data.state, data.city, data.district, data.street, data.number, data.complement], ['C-1', 'Fantasia sintética', 'ISENTO', '13400-000', 'SP', 'Piracicaba', 'Centro', 'Rua Sintética', '10', 'Sala 2']);
  assert.throws(() => quickContactPayload('sales_orders', { ...values, state: 'XX' }), error => error.field === 'state');
  assert.throws(() => quickContactPayload('sales_orders', { ...values, postal_code: '1340' }), error => error.field === 'postal_code');
});

test('a new pedido starts with frete por conta do remetente (CIF) and stays valid', () => {
  const order = freshDocument('sales_orders', '2026-10-20');
  assert.equal(order.commercial.transport.freight_mode, '0');
  assert.doesNotThrow(() => normalizeDocument('sales_orders', { ...order, contact_id: contact, items: [line('1', '1')] }));
  assert.equal(freshDocument('sales_proposals', '2026-10-20').commercial, null);
});
