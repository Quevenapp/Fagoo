import test from 'node:test';
import assert from 'node:assert/strict';
import { stockMirrorFixture } from '../../../workers/erp-api/test/helpers/stock-mirror-fixture.mjs';
import { stockMirrorOperation, stockMirrorResponse } from '../../../workers/erp-api/src/stock-mirror.mjs';
import { parseStockMirrorPage, stockMirrorQuantity } from '../src/lib/stock-origin-mirror-model.ts';

test('real SQL → HTTP projection → UI parser preserves identities, partial stock, tombstones, exact decimals and cursor filters', async () => {
  const f = await stockMirrorFixture();
  try {
    const linked = await f.linked('210');
    await f.observe('210', [{ id: '900', saldoFisico: -4, saldoVirtual: -5 }, { id: '901', saldoFisico: '0.000000', saldoVirtual: '0.000000' }]);
    await f.observe('211', [{ id: '900', saldoFisico: '999999999999999999999999.123456789012', saldoVirtual: '999999999999999999999999.123456789011' }]);
    await f.observe('212', [{ id: null, saldoFisico: 8 }]);
    await f.observe('215', [{ id: '900', saldoFisico: '999999999999999999999999999999.12345678901234567890', saldoVirtual: null }]);
    await f.observe('213', [{ id: '900', saldoFisico: 5, saldoVirtual: 4 }]); await f.project();
    await f.observe('213', [], {}, { _brufap_source: { deleted: true } });
    await f.observe('214', Array.from({ length: 55 }, (_, index) => ({ id: String(1000 + index), saldoFisico: index, saldoVirtual: index })));
    await f.project();
    async function read(query = '') {
      const operation = stockMirrorOperation(new URLSearchParams(`limit=50${query ? `&${query}` : ''}`));
      const sql = await f.list(operation.args), http = stockMirrorResponse(sql, operation);
      return parseStockMirrorPage(http, operation.args.p_product_id, operation.args.p_after);
    }
    const known = await read(`product_id=${linked.id}`); assert.equal(known.items.length, 2); assert.ok(known.items.every(row => row.product_id === linked.id));
    const unknown = await read('q=211'); assert.equal(unknown.items[0].product_id, null);
    assert.equal(stockMirrorQuantity(unknown.items[0].physical), '999.999.999.999.999.999.999.999,123456789012');
    assert.equal(unknown.items[0].reserved, '0.000000000001');
    const excessive = await read('q=215'); assert.equal(excessive.items[0].physical_state, 'invalid'); assert.equal(excessive.items[0].physical, null); assert.equal(excessive.items[0].virtual_state, 'null');
    const malformed = await read('q=212'); assert.equal(malformed.items[0].warehouse_source_id, null); assert.equal(malformed.items[0].physical_state, 'invalid');
    assert.equal(malformed.items[0].physical, null); assert.ok(malformed.coverage.partial);
    const deleted = await read('state=deleted'); assert.ok(deleted.items.length); assert.ok(deleted.items.every(row => row.source_deleted)); assert.equal(deleted.items[0].physical, null);
    const negative = await read('state=negative&warehouse_source_id=900'); assert.equal(negative.items.length, 1); assert.equal(negative.items[0].product_source_id, '210');
    const pending = await read('state=pending'); assert.ok(pending.items.every(row => row.issues.length));
    const first = await read(), second = await read(`after=${first.next_after}`); assert.equal(first.has_more, true); assert.equal(first.items.length, 50);
    assert.ok(second.items.length); assert.ok(second.items.every(row => row.id > first.next_after)); assert.ok([...first.items, ...second.items].every(row => !row.source_deleted));
    assert.deepEqual(first.native, { positions: 0, movements: 0 });
  } finally { await f.close(); }
});
