import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveFFixture, migrationText } from './helpers/fiscal-wave-f-fixture.mjs';

// 202610200275 on PGlite over every migration applied in production, through the real Worker handler (synthetic data only): "Vincular à
// pedido de compra" item a item, the summary of the items linked and still to link, "Desvincular pedido compra" and the Vinculação.
let f, buy, supplier, a, b, order;
let numbers = 830000;
before(async () => {
  f = await fiscalWaveFFixture({ upto: '202610200275' });
  await f.company();
  buy = await f.nature({ description: 'Compra item a item', direction: '0', crt: '1', presence: '9' });
  supplier = await f.catalog('contacts', { name: 'Fornecedor item a item', person_type: 'J', document: '12345678000195', state: 'SP' });
  a = await f.catalog('products', { name: 'Parafuso A', code: 'IA-A', unit: 'UN', kind: 'P', format: 'S', price: '2' });
  b = await f.catalog('products', { name: 'Porca B', code: 'IA-B', unit: 'UN', kind: 'P', format: 'S', price: '1' });
  order = (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'purchase_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: '2026-10-15', contact_id: supplier.id, items: [{ product_id: a.id, description: 'Parafuso A', unit: 'UN', quantity: '10', unit_price: '2' }, { description: 'Frete embalado', unit: 'UN', quantity: '2', unit_price: '1' }] } })).document;
});
after(() => f?.close());
const entry = (items) => f.invoice({ model: '55', direction: '0', issue_type: 'T', number: String(++numbers), series: '1', nature_id: buy.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', final_consumer: false,
  recipient: { contact_id: supplier.id, name: 'Fornecedor item a item', person_type: 'J', document: '12345678000195', state: 'SP' }, items, payment: { installments: [] } });
const line = (product, quantity, description = product?.name ?? 'Livre') => ({ product_id: product?.id ?? null, description, code: product?.code ?? 'LIVRE', unit: 'UN', quantity, unit_price: '1' });
const link = (invoice, body, user = f.users.fiscal) => f.call(`/v1/notas-fiscais/${invoice.id}/pedidos`, 'POST', { command_id: randomUUID(), expected_version: invoice.version, action: 'link', document_id: order.id, ...body }, user);
const items = (invoice, user = f.users.fiscal) => f.call(`/v1/notas-fiscais/${invoice.id}/pedidos/${order.id}`, 'GET', undefined, user);
const state = async () => (await f.call('/v1/notas-fiscais/vinculos', 'POST', { document_ids: [order.id] }, f.users.admin)).value.items[0].state;
const itemA = () => order.items.find(i => i.product_id === a.id).id, itemFree = () => order.items.find(i => !i.product_id).id;

test('275: entry points keep SECURITY DEFINER with search_path and service_role only; helpers and the table stay closed; the replaced bodies were hash-checked', async () => {
  for (const sig of ['public.erp_fiscal_invoice_link(uuid,uuid,jsonb)', 'public.erp_fiscal_invoice_order_link_states(uuid,jsonb)', 'public.erp_fiscal_invoice_order_items(uuid,uuid,uuid)']) {
    assert.deepEqual((await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] }, sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  }
  for (const helper of ['erp_fiscal_invoices.order_item_links(uuid)', 'erp_fiscal_invoices.order_link_state(uuid)', 'erp_fiscal_invoices.order_item_rows(uuid,uuid)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [helper]), false, helper);
  assert.equal(await f.scalar("select has_table_privilege('service_role','erp_fiscal_invoices.invoice_order_item','SELECT') v"), false);
  assert.match(await migrationText('202610200275_fiscal_purchase_order_item_links.sql'), /fiscal_order_items_275_previous_definition_changed/);
  assert.ok(order.items.every(i => typeof i.id === 'string'), 'the items of the pedido carry their ids');
});

test('275: item a item, total or partial, with the summary of the items linked and still to link, and the Vinculação', async () => {
  assert.equal(await state(), 'none');
  const first = await entry([line(a, '6'), line(a, '4'), line(null, '2', 'Frete embalado'), line(b, '1')]);
  const answer = await link(first, { items: [{ position: 1, document_item_id: itemA(), quantity: '6' }] });
  assert.equal(answer.status, 200, JSON.stringify(answer.value));
  assert.deepEqual(answer.value.items.map(i => [i.invoice_position, i.document_item_id, i.quantity, i.counted, i.valid]), [[1, itemA(), '6.0000', '6.0000', true]]);
  assert.equal(answer.value.removed_items, 0);
  assert.equal(await state(), 'partial', '6 of the 10 of the product');
  const second = await entry([line(a, '4'), line(null, '2', 'Frete embalado')]);
  const summary = await items(second);
  assert.deepEqual([summary.status, summary.value.linked, summary.value.state], [200, false, 'partial']);
  assert.deepEqual(summary.value.others, [{ document_item_id: itemA(), quantity: '6.0000' }], 'what the other notes link of each item of the pedido');
  // More than what is left of the item of the pedido (all notes) is refused with the reason, nothing is written.
  const over = await link(second, { items: [{ position: 1, document_item_id: itemA(), quantity: '4.0001' }] });
  assert.deepEqual([over.status, over.value.error.field], [400, 'link_item_exceeds']);
  const done = await link(second, { items: [{ position: 1, document_item_id: itemA(), quantity: '4' }] });
  assert.equal(done.status, 200);
  assert.equal(await state(), 'partial', 'the item without product of a pedido with item links still waits');
  const third = await entry([line(null, '2', 'Frete embalado')]);
  assert.equal((await link(third, { items: [{ position: 1, document_item_id: itemFree(), quantity: '2' }] })).status, 200);
  assert.equal(await state(), 'linked');
});

test('275: product of another item, positions that do not exist, the note item limit and the unlink with its items', async () => {
  const note = await entry([line(b, '1'), line(a, '1')]);
  const mismatch = await link(note, { items: [{ position: 1, document_item_id: itemA(), quantity: '1' }] });
  assert.deepEqual([mismatch.status, mismatch.value.error.field], [400, 'link_item_product']);
  assert.equal((await link(note, { items: [{ position: 9, document_item_id: itemA(), quantity: '1' }] })).status, 400);
  assert.equal((await link(note, { items: [{ position: 2, document_item_id: randomUUID(), quantity: '1' }] })).status, 400);
  // The Worker refuses broken bodies before the database.
  for (const bad of [{ items: [] }, { items: [{ position: 1, document_item_id: itemA(), quantity: '0' }] }, { items: [{ position: 1, document_item_id: itemA(), quantity: '1.23456' }] },
    { items: [{ position: 1, document_item_id: itemA(), quantity: '1' }, { position: 1, document_item_id: itemA(), quantity: '1' }] }, { items: [{ position: 1, document_item_id: itemA(), quantity: '1', extra: 1 }] }])
    assert.equal((await link(note, bad)).status, 400, JSON.stringify(bad));
  const unlinkWithItems = await f.call(`/v1/notas-fiscais/${note.id}/pedidos`, 'POST', { command_id: randomUUID(), expected_version: note.version, action: 'unlink', document_id: order.id, items: [{ position: 1, document_item_id: itemA(), quantity: '1' }] });
  assert.equal(unlinkWithItems.status, 400);
  const own = await entry([line(a, '3')]);
  const linked = await link(own, { items: [{ position: 1, document_item_id: itemA(), quantity: '3' }] });
  assert.equal(linked.status, 400, 'the item of the pedido is already fully linked by the notes of the test before');
  // Whole-pedido link (no items) keeps working as before.
  const whole = await link(own, {});
  assert.equal(whole.status, 200); assert.deepEqual([whole.value.items, whole.value.removed_items], [[], 0]);
  const again = (await f.call(`/v1/notas-fiscais/${own.id}`)).value.invoice;
  const unlink = await f.call(`/v1/notas-fiscais/${own.id}/pedidos`, 'POST', { command_id: randomUUID(), expected_version: again.version, action: 'unlink', document_id: order.id });
  assert.equal(unlink.status, 200); assert.deepEqual([unlink.value.items, unlink.value.removed_items], [[], 0]);
  assert.match(await f.scalar("select reason v from erp_fiscal_invoices.audit where entity_id=$1 and action='unlink_order' order by id desc limit 1", [own.id]), new RegExp(order.id));
});

test('275: a link stops counting when the item of the note changes its product, and the unlink removes the items with the audit', async () => {
  const fresh = (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'purchase_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: '2026-10-16', contact_id: supplier.id, items: [{ product_id: a.id, description: 'Parafuso A', unit: 'UN', quantity: '5', unit_price: '2' }] } })).document;
  const freshItem = fresh.items[0].id;
  const note = await entry([line(a, '5')]);
  const answer = await f.call(`/v1/notas-fiscais/${note.id}/pedidos`, 'POST', { command_id: randomUUID(), expected_version: note.version, action: 'link', document_id: fresh.id, items: [{ position: 1, document_item_id: freshItem, quantity: '5' }] });
  assert.equal(answer.status, 200);
  const states = async () => (await f.call('/v1/notas-fiscais/vinculos', 'POST', { document_ids: [fresh.id] }, f.users.admin)).value.items[0].state;
  assert.equal(await states(), 'linked');
  // The item of the note becomes another product (an edit of the note): the link no longer counts and is shown so.
  await f.db.query("update erp_fiscal_invoices.invoice_item set product_id=$1 where invoice_id=$2 and position=1", [b.id, note.id]);
  const shown = (await f.call(`/v1/notas-fiscais/${note.id}/pedidos/${fresh.id}`)).value;
  assert.deepEqual(shown.items.map(i => [i.valid, i.counted]), [[false, '0.0000']]); assert.equal(shown.state, 'partial', 'a note linked by items counts only its valid links (not its items as a whole)');
  await f.db.query("update erp_fiscal_invoices.invoice_item set product_id=$1 where invoice_id=$2 and position=1", [a.id, note.id]);
  const current = (await f.call(`/v1/notas-fiscais/${note.id}`)).value.invoice;
  const unlink = await f.call(`/v1/notas-fiscais/${note.id}/pedidos`, 'POST', { command_id: randomUUID(), expected_version: current.version, action: 'unlink', document_id: fresh.id });
  assert.deepEqual([unlink.status, unlink.value.removed_items, unlink.value.items], [200, 1, []]);
  assert.equal(await states(), 'none');
  assert.match(await f.scalar("select reason v from erp_fiscal_invoices.audit where entity_id=$1 and action='unlink_order' order by id desc limit 1", [note.id]), /itens removidos:1/);
  // Only the profiles that write notes read the summary.
  assert.equal((await f.call(`/v1/notas-fiscais/${note.id}/pedidos/${fresh.id}`, 'GET', undefined, f.users.consulta)).status, 403);
});

// Review of wave F: one link alone above the item of the pedido is refused (the sums count each link only up to the item), an item already
// above after an edit of the pedido never blocks the other items, and an old item link of a pedido the note lost never comes back.
test('275: one link above the item of the pedido is refused; old links of a pedido the note lost are dropped when it is linked again', async () => {
  const pedido = (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'purchase_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: '2026-10-17', contact_id: supplier.id, items: [{ product_id: a.id, description: 'Parafuso A', unit: 'UN', quantity: '5', unit_price: '2' }, { product_id: b.id, description: 'Porca B', unit: 'UN', quantity: '3', unit_price: '1' }] } })).document;
  const [itemOfA, itemOfB] = [pedido.items.find(i => i.product_id === a.id).id, pedido.items.find(i => i.product_id === b.id).id];
  const send = (invoice, body) => f.call(`/v1/notas-fiscais/${invoice.id}/pedidos`, 'POST', { command_id: randomUUID(), expected_version: invoice.version, action: 'link', document_id: pedido.id, ...body });
  const note = await entry([line(a, '10'), line(b, '3')]);
  const over = await send(note, { items: [{ position: 1, document_item_id: itemOfA, quantity: '8' }] });
  assert.deepEqual([over.status, over.value.error?.field], [400, 'link_item_exceeds'], '8 of an item of 5 of the pedido');
  assert.equal(await f.scalar('select count(*)::integer v from erp_fiscal_invoices.invoice_order_item where document_id=$1', [pedido.id]), 0, 'nothing is written');
  const linked = await send(note, { items: [{ position: 1, document_item_id: itemOfA, quantity: '5' }] });
  assert.equal(linked.status, 200, JSON.stringify(linked.value));
  // The pedido loses an item quantity after the link (an edit of the pedido): the other item of the pedido still links.
  await f.db.query("update erp_documents.item set quantity=4 where id=$1", [itemOfA]);
  const other = await entry([line(b, '3')]);
  const second = await send(other, { items: [{ position: 1, document_item_id: itemOfB, quantity: '3' }] });
  assert.equal(second.status, 200, JSON.stringify(second.value));
  // A save of the note without the pedido (store_orders) leaves its item links out of the sums; linking the pedido again starts clean.
  const current = (await f.call(`/v1/notas-fiscais/${note.id}`)).value.invoice;
  await f.db.query('delete from erp_fiscal_invoices.invoice_order where invoice_id=$1 and document_id=$2', [note.id, pedido.id]);
  const whole = await send(current, {});
  assert.equal(whole.status, 200, JSON.stringify(whole.value));
  assert.deepEqual([whole.value.items, whole.value.removed_items], [[], 0], 'the old item link of that pedido does not come back');
  assert.equal(await f.scalar('select count(*)::integer v from erp_fiscal_invoices.invoice_order_item where invoice_id=$1', [note.id]), 0);
});
