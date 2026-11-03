import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATE, LEGACY_TRANSITIONS, TRANSITIONS, checkTransition, documentNumber, normalizeDocument, transitionReasonRequired } from '../src/index.mjs';

// 202610200129 (synthetic values): Editar número, Ordem de compra, situações do pedido de compra e pedido novo Em aberto.
const contact = 'c0000000-0000-4000-8000-000000000129';
const body = extra => ({ date: '2026-10-20', contact_id: contact, items: [{ description: 'Item', unit: 'UN', quantity: '1', unit_price: '1' }], ...extra });

test('a requested number is validated and never becomes part of the normalized body', () => {
  for (const value of ['1', '42', '9999999999']) { assert.equal(documentNumber(value), true, value); assert.equal(Object.hasOwn(normalizeDocument('sales_orders', body({ number: value })), 'number'), false); }
  for (const value of ['0', '01', '10000000000', 1, '', ' 1', '1.0', null]) {
    assert.equal(documentNumber(value), false, String(value));
    assert.throws(() => normalizeDocument('purchase_orders', body({ number: value })), /NUMBER_INVALID/, String(value));
  }
});

test('Ordem de compra keeps up to 100 characters on one line', () => {
  assert.equal(normalizeDocument('purchase_orders', body({ order_reference: '  OC 2026/15 ' })).order_reference, 'OC 2026/15');
  assert.equal(normalizeDocument('purchase_orders', body({ order_reference: null })).order_reference, null);
  assert.throws(() => normalizeDocument('purchase_orders', body({ order_reference: 'x'.repeat(101) })), /TEXT_INVALID/);
  assert.throws(() => normalizeDocument('purchase_orders', body({ order_reference: 'linha\nnova' })), /TEXT_INVALID/);
});

test('pedido de compra goes between the four Origin situações, Atendido parcialmente keeps 008 and reasons follow the rule', () => {
  const main = ['open', 'in_progress', 'fulfilled', 'cancelled'];
  for (const from of main) for (const to of main) if (from !== to) assert.ok(TRANSITIONS.purchase_orders[from].includes(to), `${from}→${to}`);
  assert.deepEqual(TRANSITIONS.purchase_orders.partially_fulfilled, LEGACY_TRANSITIONS.purchase_orders.partially_fulfilled);
  assert.equal(transitionReasonRequired('purchase_orders', 'open', 'fulfilled'), false, 'open is editable: no reason to close');
  assert.equal(transitionReasonRequired('purchase_orders', 'fulfilled', 'in_progress'), true, 'leaving a closed situação');
  assert.equal(transitionReasonRequired('purchase_orders', 'cancelled', 'open'), true, '008 reopening');
  assert.throws(() => checkTransition('purchase_orders', 'fulfilled', 'in_progress', 'x'), /REASON_REQUIRED/);
  assert.equal(checkTransition('purchase_orders', 'fulfilled', 'in_progress', 'Faltou receber'), true);
});

test('the new pedido de venda starts Em aberto', () => {
  assert.equal(INITIAL_STATE.sales_orders, 'open');
  assert.deepEqual({ ...INITIAL_STATE, sales_orders: undefined }, { sales_proposals: 'draft', sales_orders: undefined, purchase_orders: 'open', service_orders: 'open' });
});
