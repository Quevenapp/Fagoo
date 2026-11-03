import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsFixture } from './helpers/documents-b-fixture.mjs';

// 202610200132 "Ao clonar o pedido de compra, utilizar … a data do pedido clonado", through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsFixture({ upto: '202610200132' }); });
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };

test('the copy preview keeps the date of the pedido de compra only with the preference; other kinds keep today', async () => {
  const today = await f.scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date)::text v");
  const purchase = (await ok('/v1/documentos/purchase_orders', 'POST', { command_id: randomUUID(), data: f.data('purchase_orders', { date: '2026-09-15' }) }, f.users.estoque)).document;
  const sale = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { date: '2026-09-15' }) })).document;
  let preview = await ok(`/v1/duplicacao-documentos/purchase_orders/${purchase.id}/preview`, 'GET', undefined, f.users.estoque);
  assert.deepEqual([preview.data.date, preview.reset_fields[0]], [today, 'date'], 'default: Data atual');
  await f.setPreference('suprimentos-compras', 'compras.clonagem_data', 'data_original');
  preview = await ok(`/v1/duplicacao-documentos/purchase_orders/${purchase.id}/preview`, 'GET', undefined, f.users.estoque);
  assert.equal(preview.data.date, '2026-09-15'); assert.equal(preview.reset_fields.includes('date'), false);
  const copy = await ok(`/v1/duplicacao-documentos/purchase_orders/${purchase.id}`, 'POST', { command_id: randomUUID(), expected_source_version: purchase.version, data: preview.data }, f.users.estoque);
  assert.deepEqual([copy.document.date, copy.document.status], ['2026-09-15', 'open']);
  assert.equal((await ok(`/v1/duplicacao-documentos/sales_orders/${sale.id}/preview`)).data.date, today, 'the preference is only for pedidos de compra');
});
