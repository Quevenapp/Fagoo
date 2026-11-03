import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_MIRROR_FILTERS, parseStockMirrorPage, stockMirrorNegative, stockMirrorQuantity, stockMirrorQuery } from '../src/lib/stock-origin-mirror-model.ts';
import { mirrorPage, mirrorPosition, mirrorProduct, otherMirrorProduct } from './helpers/stock-origin-mirror-fixture.mjs';

test('mirror balances remain exact decimal text and unknown, invalid and recorded zero remain distinct', () => {
  const raw = mirrorPage({ items: [mirrorPosition(1, { physical: '999999999999999999.123456' }), mirrorPosition(2, { physical: null, physical_state: 'null' }), mirrorPosition(3, { physical: null, physical_state: 'invalid' }), mirrorPosition(4, { physical: '0.000000' })] });
  const page = parseStockMirrorPage(raw, null);
  assert.equal(stockMirrorQuantity(page.items[0].physical), '999.999.999.999.999.999,123456');
  assert.equal(stockMirrorQuantity(page.items[1].physical, page.items[1].physical_state), 'Não informado (nulo)');
  assert.equal(stockMirrorQuantity(page.items[2].physical, page.items[2].physical_state), 'Valor inválido na fonte');
  assert.equal(stockMirrorQuantity(page.items[3].physical), '0');
  assert.equal(stockMirrorQuantity(null), 'Não observado');
  assert.equal(stockMirrorNegative('-0.000000'), false); assert.equal(stockMirrorNegative('-0.000001'), true);
});

test('only read-only Origin identities are accepted; native responses, mismatched product and broken pagination fail closed', () => {
  for (const patch of [{ origin: 'brufap' }, { read_only: false }, { physical: 2 }, { physical: '1e3' }, { physical: null }, { product_id: otherMirrorProduct }, { observed_at: '2026-10-22 14:20:30' }]) {
    assert.throws(() => parseStockMirrorPage(mirrorPage({ items: [mirrorPosition(1, patch)] }), mirrorProduct));
  }
  assert.throws(() => parseStockMirrorPage({ ...mirrorPage(), data_mode: 'erp_native' }, null));
  assert.throws(() => parseStockMirrorPage(mirrorPage({ items: [mirrorPosition(1), mirrorPosition(1)] }), null));
  assert.throws(() => parseStockMirrorPage(mirrorPage({ has_more: true, next_after: 2 }), null));
  assert.throws(() => parseStockMirrorPage(mirrorPage(), null, 1));
  const diagnostic = parseStockMirrorPage(mirrorPage({ items: [mirrorPosition(1, { warehouse_source_id: null, warehouse_name: 'Não informado', physical: null, physical_state: 'absent', virtual: null, virtual_state: 'absent', reserved: null })] }), null);
  assert.equal(diagnostic.items[0].warehouse_source_id, null);
});

test('cursor query keeps source depot identity separate from native product UUID, and encodes search safely', () => {
  const path = stockMirrorQuery({ query: ' peça & cabo ', warehouse: '123', state: 'negative' }, mirrorProduct, 50), url = new URL(path, 'https://example.invalid');
  assert.equal(url.pathname, '/v1/estoque/espelho'); assert.equal(url.searchParams.get('q'), 'peça & cabo');
  assert.equal(url.searchParams.get('warehouse_source_id'), '123'); assert.equal(url.searchParams.get('product_id'), mirrorProduct);
  assert.equal(url.searchParams.get('state'), 'negative'); assert.equal(url.searchParams.get('after'), '50');
  for (const filters of [{ warehouse: mirrorProduct }, { query: 'x'.repeat(121) }, { state: 'write' }]) assert.throws(() => stockMirrorQuery({ ...EMPTY_MIRROR_FILTERS, ...filters }, null));
});
