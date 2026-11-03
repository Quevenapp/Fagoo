import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';

// 202610200166 ("Exportar para a planilha" dos pedidos de compra, com os itens) on PGlite through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsCFixture({ upto: '202610200166' }); });
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };

test('166 grants', async () => {
  const fn = 'public.erp_document_export(uuid,text,text,text,integer)';
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
});

test('the month of pedidos de compra with every item, in pages of 25, in date and number order', async () => {
  const docs = [];
  for (let n = 0; n < 27; n++) docs.push((await ok('/v1/documentos/purchase_orders', 'POST', { command_id: randomUUID(), data: f.data('purchase_orders', { date: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}`, order_reference: `OC-${n}`,
    items: [f.line({ code: `C${n}`, description: `Item ${n}`, quantity: '2', unit_price: '1.25' }), f.line({ description: 'Segundo item', unit_price: '0.1' })] }) })).document);
  await ok('/v1/documentos/purchase_orders', 'POST', { command_id: randomUUID(), data: f.data('purchase_orders', { date: '2026-10-01' }) });
  const first = await ok('/v1/documentos/purchase_orders/exportacao?from=2026-09-01&to=2026-09-30&page=1', 'GET', undefined, f.users.estoque);
  assert.deepEqual([first.total_count, first.items.length, first.has_more, first.size], [27, 25, true, 25]);
  assert.equal(first.items[0].date, '2026-09-01');
  const row = first.items.find(item => item.order_reference === 'OC-0');
  assert.deepEqual(row.items.map(line => [line.position, line.code, line.description, line.quantity, line.unit_price, line.total]), [[1, 'C0', 'Item 0', '2.000000', '1.2500', '2.50'], [2, null, 'Segundo item', '1.000000', '0.1000', '0.10']]);
  assert.equal(row.total, '2.60'); assert.equal(row.situation_name, 'Em aberto');
  const second = await ok('/v1/documentos/purchase_orders/exportacao?from=2026-09-01&to=2026-09-30&page=2', 'GET', undefined, f.users.estoque);
  assert.deepEqual([second.items.length, second.has_more], [2, false]);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 27);
  for (const query of ['from=2026-09-30&to=2026-09-01', 'from=2025-01-01&to=2026-09-30', 'from=2026-09-01&to=2026-09-30&page=0', 'from=2026-09-01', 'from=2026-09-01&to=2026-09-30&x=1'])
    assert.equal((await f.call(`/v1/documentos/purchase_orders/exportacao?${query}`)).status, 400, query);
  assert.equal((await f.call('/v1/documentos/purchase_orders/exportacao?from=2026-09-01&to=2026-09-30', 'GET', undefined, f.users.vendas)).status, 403);
});
