import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveEFixture } from './helpers/fiscal-wave-e-fixture.mjs';

// Publication window of the wave E of the notas fiscais lane (synthetic data only): the new Worker over the production database
// (every migration through 202610200233, none of 251-254). The documented answers: "Gerar nota fiscal" (v3, 254) and the P mark
// (252) answer 502 until their migrations exist, so the database goes first; the item history of 218 keeps answering.
test('wave E publication: the new Worker over the production database answers the documented 502 and keeps the old routes', async () => {
  const f = await fiscalWaveEFixture({ upto: '0' });
  try {
    await f.company();
    for (const name of ['erp_fiscal_invoice_order_source_v3', 'erp_fiscal_invoice_pricing_states', 'erp_fiscal_invoice_pricing_record'])
      assert.equal(await f.scalar("select count(*)::int v from pg_proc where proname=$1", [name]), 0, `${name} is not published yet`);
    const contact = await f.catalog('contacts', { name: 'Cliente sintético da publicação', person_type: 'J', document: '12345678000190', state: 'SP' });
    const product = await f.catalog('products', { name: 'Peça sintética da publicação', code: 'PUB-1', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '84714900' });
    const order = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: { date: '2026-10-20', contact_id: contact.id, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', commercial: null,
      items: [{ product_id: product.id, description: 'Peça sintética da publicação', detailed_description: null, code: 'PUB-1', unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0' }], installments: [] } });
    assert.equal(order.status, 200, JSON.stringify(order.value));
    const source = await f.call(`/v1/notas-fiscais/pedido/${order.value.document.id}?model=55`, 'GET', undefined, f.users.fiscal);
    assert.deepEqual([source.status, source.value.error?.code ?? source.value.code], [502, 'ERP_UPSTREAM_UNAVAILABLE']);
    const note = randomUUID();
    assert.equal((await f.call(`/v1/notas-fiscais/precos?ids=${note}`, 'GET', undefined, f.users.fiscal)).status, 502);
    assert.equal((await f.call(`/v1/notas-fiscais/${note}/precos`, 'POST', { catalog_command_id: randomUUID() }, f.users.fiscal)).status, 502);
    // 218 already answers the item history; 253 only makes it bounded.
    const history = await f.call(`/v1/notas-fiscais/historico-item?${new URLSearchParams({ contact_id: contact.id, product_id: product.id, direction: '1' })}`, 'GET', undefined, f.users.fiscal);
    assert.equal(history.status, 200, JSON.stringify(history.value));
    assert.deepEqual(history.value.items, []);
  } finally { await f.close(); }
});
