import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { preferencesFixture } from './helpers/preferences-fixture.mjs';
import { laneUpTo } from './helpers/fiscal-lane.mjs';
import { invoiceRecord } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// 142 on PGlite (published chain + this lane), synthetic data only: linking notes to orders and the edit lock
// "Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda". Nothing here posts effects itself.
const LANE = laneUpTo('202610200142');
const code = expected => error => error.code === expected;
let f, sale, purchase, product, warehouse, contact, saleNature, buyNature;
const catalog = async (entity, data) => (await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
const order = async (kind, statuses) => {
  let d = (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-15', contact_id: contact.id, warehouse_id: warehouse.id,
    items: [{ product_id: product.id, description: 'Peça sintética', unit: 'UN', quantity: '2', unit_price: '10' }] } })).document;
  for (const s of statuses) d = (await f.rpc('erp_document_transition', { p_user_id: f.users.admin, p_kind: kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: s, p_reason: 'Transição sintética' })).document;
  return d;
};
const savePrefs = async changes => {
  const current = await f.rpc('erp_preferences_page', { p_user_id: f.users.admin, p_page: 'notas-nfe' });
  return f.rpc('erp_preferences_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: 'notas-nfe', p_changes: Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(i => i.key === key).version, value })) });
};
const invoice = (direction, over = {}) => ({ model: '55', direction, issue_type: 'N', series: '1', nature_id: direction === '1' ? saleNature.id : buyNature.id, issue_date: '2026-10-20', crt: '1', purpose: '1',
  presence: direction === '1' ? '1' : '9', final_consumer: false, recipient: { name: 'Contato sintético', person_type: 'J', document: '12345678000190', state: 'SP' },
  items: [{ product_id: product.id, description: 'Peça sintética', quantity: '2', unit_price: '10' }], payment: { installments: [{ date: '2026-11-20', amount: '20.00' }] }, ...over });
const create = async (data, orders = []) => (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: data, orders } })).invoice;
const link = (data, { user = f.users.fiscal, command = randomUUID() } = {}) => f.rpc('erp_fiscal_invoice_link', { p_user_id: user, p_command_id: command, p_data: data });
const get = id => f.rpc('erp_fiscal_invoice_get', { p_user_id: f.users.admin, p_id: id });

before(async () => {
  const base = await preferencesFixture({ lane: LANE });
  f = { ...base, scalar: async (text, args = []) => (await base.db.query(text, args)).rows[0]?.value };
  product = await catalog('products', { name: 'Peça sintética', code: 'P-142', unit: 'UN', kind: 'P', format: 'S', price: '10' });
  contact = await catalog('contacts', { name: 'Contato sintético 142' });
  warehouse = await catalog('warehouses', { name: 'Depósito 142' });
  await f.rpc('erp_stock_post', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: '2026-10-15', p_reason: 'Entrada sintética 142', p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: '10', expected_version: 0 }] });
  sale = await order('sales_orders', ['open', 'verified']); purchase = await order('purchase_orders', ['in_progress']);
  const nature = async data => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  saleNature = await nature({ description: 'Venda 142', direction: '1', crt: '1' }); buyNature = await nature({ description: 'Compra 142', direction: '0', crt: '1', presence: '9' });
});
after(() => f?.close());

test('142 entry points are SECURITY DEFINER for service_role only; the lock helpers are private', async () => {
  for (const signature of ['public.erp_fiscal_invoice_link(uuid,uuid,jsonb)', 'public.erp_fiscal_invoice_get(uuid,uuid)', 'public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
  }
  for (const helper of ['erp_fiscal_invoices.order_effects(uuid)', 'erp_fiscal_invoices.edit_locks(uuid)', 'erp_fiscal_invoices.items_signature(jsonb)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
});

test('142 "Vincular à pedido de compra": one order per command, CAS, idempotent, audited, and only the order kind of the direction', async () => {
  const entry = await create(invoice('0'));
  await assert.rejects(() => link({ invoice_id: entry.id, expected_version: 1, action: 'link', document_id: sale.id }), code('22023'), 'entry notes link purchase orders');
  await assert.rejects(() => link({ invoice_id: entry.id, expected_version: 1, action: 'link', document_id: purchase.id }, { user: f.users.consulta }), code('42501'));
  await assert.rejects(() => link({ invoice_id: entry.id, expected_version: 2, action: 'link', document_id: purchase.id }), code('40001'));
  await assert.rejects(() => link({ invoice_id: entry.id, expected_version: 1, action: 'move', document_id: purchase.id }), code('22023'));
  const command = randomUUID(), out = await link({ invoice_id: entry.id, expected_version: 1, action: 'link', document_id: purchase.id }, { command });
  const record = invoiceRecord(out.invoice);
  assert.equal(out.action, 'link_order'); assert.equal(out.document_id, purchase.id); assert.equal(record.version, 2); assert.deepEqual(record.orders.map(o => [o.id, o.kind, o.number]), [[purchase.id, 'purchase_orders', purchase.number]]);
  assert.equal((await link({ invoice_id: entry.id, expected_version: 1, action: 'link', document_id: purchase.id }, { command })).replayed, true);
  await assert.rejects(() => link({ invoice_id: entry.id, expected_version: 2, action: 'link', document_id: purchase.id }), code('40001'), 'already linked');
  const listed = await f.rpc('erp_fiscal_invoice_list', { p_user_id: f.users.admin, p_origin: 'brufap', p_model: '55', p_direction: '0', p_order_number: purchase.number });
  assert.deepEqual(listed.items.map(r => r.id), [entry.id], 'Nº pedido filter and the V letter see the link');
  const unlinked = invoiceRecord((await link({ invoice_id: entry.id, expected_version: 2, action: 'unlink', document_id: purchase.id })).invoice);
  assert.equal(unlinked.version, 3); assert.deepEqual(unlinked.orders, []);
  await assert.rejects(() => link({ invoice_id: entry.id, expected_version: 3, action: 'unlink', document_id: purchase.id }), code('40001'), 'not linked');
  assert.deepEqual((await f.db.query("select action,reason from erp_fiscal_invoices.audit where entity_id=$1 order by id", [entry.id])).rows.map(r => r.action), ['create', 'link_order', 'unlink_order']);
  assert.equal(await f.scalar('select count(*)::integer value from erp_fiscal_invoices.invoice_revision where invoice_id=$1', [entry.id]), 3);
});

test('142 the edit lock follows the preferences and the effects already posted by the linked sales order', async () => {
  const exit = await create(invoice('1'), [sale.id]);
  assert.deepEqual((await get(exit.id)).locks, { items: false, installments: false });
  const p = (await f.rpc('erp_document_stock_preview', { p_user_id: f.users.estoque, p_kind: 'sales_orders', p_document_id: sale.id, p_expected_version: sale.version, p_occurred_on: '2026-10-16', p_reason: 'Venda sintética' })).preview;
  await f.rpc('erp_document_stock_post', { p_user_id: f.users.estoque, p_kind: 'sales_orders', p_document_id: sale.id, p_expected_version: sale.version, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_occurred_on: '2026-10-16', p_reason: 'Venda sintética', p_ignored_item_ids: [] });
  assert.deepEqual((await get(exit.id)).locks, { items: false, installments: false }, 'posted, but the preference is off');
  await savePrefs({ 'nfe.bloquear_edicao_estoque': true, 'nfe.bloquear_edicao_contas': true });
  assert.deepEqual((await get(exit.id)).locks, { items: true, installments: false });
  const update = (data, version, orders = [sale.id]) => f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'update', p_data: { id: exit.id, expected_version: version, invoice: data, orders } });
  await assert.rejects(() => update(invoice('1', { items: [{ product_id: product.id, description: 'Peça sintética', quantity: '3', unit_price: '10' }] }), 1), code('40001'), 'quantity locked');
  await assert.rejects(() => update(invoice('1'), 1, []), code('40001'), 'the order link is locked too');
  await assert.rejects(() => link({ invoice_id: exit.id, expected_version: 1, action: 'unlink', document_id: sale.id }), code('40001'));
  const ok = await update(invoice('1', { additional_info: 'Texto livre', items: [{ product_id: product.id, description: 'Peça sintética (descrição)', quantity: '2.0000', unit_price: '10' }] }), 1);
  assert.equal(ok.invoice.version, 2, 'other fields stay editable');
  await f.db.query("insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id) values($1,$2,$3,'{}'::jsonb,$4,$5,$6)",
    [sale.id, sale.version, randomUUID(), 'a'.repeat(64), f.users.admin, randomUUID()]);
  assert.deepEqual((await get(exit.id)).locks, { items: true, installments: true });
  await assert.rejects(() => update(invoice('1', { payment: { installments: [{ date: '2026-11-21', amount: '20.00' }] } }), 2), code('40001'), 'parcels locked');
  await savePrefs({ 'nfe.bloquear_edicao_estoque': false, 'nfe.bloquear_edicao_contas': false });
  assert.equal((await update(invoice('1', { payment: { installments: [{ date: '2026-11-21', amount: '20.00' }] } }), 2)).invoice.version, 3, 'unlocked again with the preferences off');
});

test('142 a deleted nature stays on the notes that carry it, but no note takes it anew', async () => {
  const natureCmd = (action, data) => f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: action, p_data: data });
  const doomed = (await natureCmd('create', { nature: { description: 'Venda a excluir 142', direction: '1', crt: '1' } })).nature;
  const kept = await create(invoice('1', { nature_id: doomed.id }));
  const withItem = await create(invoice('1', { items: [{ product_id: product.id, description: 'Peça sintética', quantity: '2', unit_price: '10', nature_id: doomed.id }] }));
  await natureCmd('delete', { id: doomed.id, expected_version: 1 });
  await assert.rejects(() => create(invoice('1', { nature_id: doomed.id })), code('22023'), 'a new note cannot take the deleted nature');
  await assert.rejects(() => create(invoice('1', { items: [{ product_id: product.id, description: 'Peça sintética', quantity: '2', unit_price: '10', nature_id: doomed.id }] })), code('22023'), 'not even on an item');
  const update = (note, data, version = 1) => f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'update', p_data: { id: note.id, expected_version: version, invoice: data } });
  assert.equal((await update(kept, invoice('1', { nature_id: doomed.id, additional_info: 'Rascunho antigo' }))).invoice.version, 2, 'a note that already carries it stays editable');
  assert.equal((await update(withItem, invoice('1', { items: [{ product_id: product.id, description: 'Peça sintética', quantity: '2', unit_price: '10', nature_id: doomed.id }], additional_info: 'Item antigo' }))).invoice.version, 2);
  const other = await create(invoice('1'));
  await assert.rejects(() => update(other, invoice('1', { nature_id: doomed.id })), code('22023'), 'switching to the deleted nature is refused');
});
