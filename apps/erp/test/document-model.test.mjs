import test from 'node:test';
import assert from 'node:assert/strict';
import { itemTotal, itemsTotal, documentTotal, netUnitPrice, validateDemoForm } from '../src/lib/document-model.ts';
import { proposalToOrder } from '../src/lib/demo-model.ts';

const item = changes => ({ id: 'demo-item', description: 'Item fictício', quantity: 1, unit: 'UN', unitPrice: 1, discount: 0, ...changes });

test('decimal item totals and global adjustments reconcile in integer cents', () => {
  const items = [item({ id: '1', unitPrice: 0.1 }), item({ id: '2', unitPrice: 0.2 })];
  assert.equal(itemsTotal(items), 0.3);
  assert.equal(documentTotal(items, { id: 'demo', discount: 0.1, freight: 0.2, otherExpenses: 0.1 }), 0.5);
  assert.equal(itemTotal(item({ quantity: 3, unitPrice: 19.9, discount: 10 })), 53.73);
});

test('list price and percentage determine the displayed net unit price and final document total', () => {
  const discounted = item({ quantity: 3, listPrice: 10, unitPrice: 0, discount: 10 });
  assert.equal(netUnitPrice(discounted), 9);
  assert.equal(itemTotal(discounted), 27);
  assert.equal(documentTotal([discounted], { id: 'demo', freight: 5, discount: 2 }), 30);
});

test('nonfinite values and discounts outside 0–100 cannot be saved or converted', () => {
  for (const changes of [{ unitPrice: Infinity }, { quantity: NaN }, { discount: 101 }, { discount: -1 }, { quantity: 0 }, { unitPrice: Number.MAX_VALUE }]) {
    assert.ok(validateDemoForm([], { id: 'demo' }, [item(changes)]));
  }
  for (const total of [NaN, Infinity, -1, Number.MAX_VALUE]) {
    assert.throws(() => proposalToOrder({ id: 'proposal', total }, [], 'order', '2026-10-16'));
  }
  for (const adjustment of ['discount', 'freight', 'otherExpenses']) {
    assert.ok(Number.isNaN(documentTotal([item({})], { id: 'demo', [adjustment]: NaN })));
  }
});

test('required whitespace, oversized money and negative document totals are rejected', () => {
  assert.ok(validateDemoForm([{ key: 'customer', label: 'Cliente', required: true }], { id: 'demo', customer: '  ' }));
  assert.ok(validateDemoForm([{ key: 'total', label: 'Valor', type: 'money' }], { id: 'demo', total: Infinity }));
  assert.ok(validateDemoForm([], { id: 'demo', discount: 2 }, [item({ unitPrice: 1 })]));
  assert.equal(validateDemoForm([], { id: 'demo', discount: 0.1, freight: 0.2 }, [item({ unitPrice: 0.3 })]), null);
});
