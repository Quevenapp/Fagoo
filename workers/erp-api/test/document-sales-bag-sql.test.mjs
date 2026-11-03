import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsDFixture } from './helpers/documents-d-fixture.mjs';

// 202610200197 Sacola de vendas on PGlite through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsDFixture(); });
after(() => f?.close());
const bag = user => f.call('/v1/documentos/sacola-vendas', 'GET', undefined, user);
const change = (body, user) => f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: randomUUID(), ...body }, user);

test('197 grants', async () => {
  for (const fn of ['public.erp_document_sales_bag(uuid)', 'public.erp_document_sales_bag_change(uuid,uuid,text,uuid,text)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, fn);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true, fn);
  }
  assert.equal(await f.scalar("select has_table_privilege('service_role','erp_documents.sales_bag_item','SELECT') v"), false);
});

test('the bag belongs to the user: add sums, set replaces, remove and clear; commands are idempotent', async () => {
  assert.deepEqual((await bag(f.users.vendas)).value.items, []);
  const command = randomUUID();
  const added = await f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: command, action: 'add', product_id: f.product.id, quantity: '1.5' }, f.users.vendas);
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.deepEqual(added.value.items.map(i => [i.name, i.quantity, i.price]), [['Produto sintético D', '1.500000', '10.0000']]);
  const replay = await f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: command, action: 'add', product_id: f.product.id, quantity: '1.5' }, f.users.vendas);
  assert.deepEqual([replay.value.replayed, replay.value.items[0].quantity], [true, '1.500000'], 'a replay never adds again');
  assert.equal((await f.call('/v1/documentos/sacola-vendas', 'POST', { command_id: command, action: 'add', product_id: f.product.id, quantity: '2' }, f.users.vendas)).status, 409);
  assert.equal((await change({ action: 'add', product_id: f.product.id, quantity: '0.5' }, f.users.vendas)).value.items[0].quantity, '2.000000');
  assert.equal((await change({ action: 'add', product_id: f.other.id, quantity: '3' }, f.users.vendas)).value.count, 2);
  assert.equal((await change({ action: 'set', product_id: f.product.id, quantity: '7.25' }, f.users.vendas)).value.items[0].quantity, '7.250000');
  assert.deepEqual((await bag(f.users.admin)).value.items, [], 'another user has another bag');
  assert.equal((await change({ action: 'remove', product_id: f.other.id }, f.users.vendas)).value.count, 1);
  assert.equal((await change({ action: 'clear' }, f.users.vendas)).value.count, 0);
});

test('only who includes pedidos de venda; invalid quantities and inactive products are refused', async () => {
  assert.equal((await bag(f.users.estoque)).status, 403);
  assert.equal((await change({ action: 'add', product_id: f.product.id, quantity: '1' }, f.users.consulta)).status, 403);
  for (const body of [{ action: 'add', product_id: f.product.id, quantity: '0' }, { action: 'add', product_id: f.product.id, quantity: '1,5' }, { action: 'add', product_id: f.product.id, quantity: '1.1234567' },
    { action: 'add', product_id: f.product.id }, { action: 'clear', product_id: f.product.id }, { action: 'drop', product_id: f.product.id }])
    assert.equal((await change(body, f.users.vendas)).status, 400, JSON.stringify(body));
  const inactive = await f.catalog('products', { name: 'Produto inativo', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  await f.db.query('update erp_catalog.record set active=false where id=$1', [inactive.id]);
  assert.equal((await change({ action: 'add', product_id: inactive.id, quantity: '1' }, f.users.vendas)).status, 400);
});
