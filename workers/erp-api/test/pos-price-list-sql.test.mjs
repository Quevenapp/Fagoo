// Frente de caixa, documentos lane wave E (migration 242): the Lista de preço of the sale is saved in the pedido de venda too.
// PGlite with every migration and the real Worker. Synthetic data only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { posFixture, today } from './helpers/pos-fixture.mjs';

let f, list, expired;
before(async () => {
  f = await posFixture();
  await f.receive(f.product.id, '20');
  list = (await f.db.query("insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction) values('Atacado sintético PDV','other','custom',null,'percent','discount') returning id")).rows[0].id;
  expired = (await f.db.query("insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction,starts_on,ends_on) values('Lista vencida PDV','other','custom',null,'percent','discount','2020-01-01','2020-01-31') returning id")).rows[0].id;
});
after(async () => f?.close());
const item = (product, quantity = '1', price = '10') => ({ id: randomUUID(), product_id: product.id, description: product.name, code: product.code ?? null, unit: 'UN', quantity, unit_price: price, discount_percent: '0', detailed_description: null });
const sale = (extra = {}) => ({ sale_id: null, expected_version: 0, document_version: null, kind: 'balcao', table_number: null, account_id: f.store.id, cash_session_id: null, contact_id: f.contact.id, price_list_id: null,
  document: { date: today(), warehouse_id: f.warehouse.id, items: [item(f.product, '1')], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', notes: null, internal_notes: null, seller_id: null, category_id: null },
  payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1000', note: null }], destination_account_id: null, to_ledger: false, cash_received_cents: null, ...extra });
const act = (action, data, user = f.users.admin) => f.call(`/v1/frente-caixa/actions/${action}`, 'POST', { command_id: randomUUID(), data }, user);

test('the chosen Lista de preço reaches the pedido de venda (body and read), none stays none', async () => {
  const done = await act('sale_finish', sale({ price_list_id: list }));
  assert.equal(done.status, 200, JSON.stringify(done.value));
  const document = done.value.record.document_id;
  assert.equal(await f.scalar("select body->>'price_list_id' v from erp_documents.document where id=$1", [document]), list);
  const read = await f.call(`/v1/documentos/sales_orders/${document}`);
  assert.equal(read.status, 200); assert.deepEqual([read.value.document.price_list_id, read.value.document.price_list_name], [list, 'Atacado sintético PDV']);
  const plain = await act('sale_finish', sale());
  assert.equal(plain.status, 200);
  assert.equal(await f.scalar("select body->'price_list_id' v from erp_documents.document where id=$1", [plain.value.record.document_id]), null);
  // A list that is no longer valid is refused by the documents rule (196) with the PDV wording.
  const refused = await act('sale_finish', sale({ price_list_id: expired }));
  assert.equal(refused.status, 400); assert.equal(refused.value.error.field, 'price_list_unavailable');
});

test('with "Situação para aprovação de descontos" the PDV sale above the limit of the vendedor stays refused (no pedido for approval)', async () => {
  const contact = await f.catalog('contacts', { name: 'Vendedora com limite', roles: ['customer'] });
  await f.db.query("insert into erp_catalog.seller(contact_id,user_id,modules,discount_limit,allow_unregistered_products,created_by,updated_by) values($1,$2,$3,5,true,$4,$4)",
    [contact.id, f.users.vendedor, JSON.stringify({ frente_caixa: true, pdv_registro_itens: true }), f.users.admin]);
  const situation = (await f.rpc('erp_preferences_situation_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: 'sales_orders', p_situation: null, p_expected_version: 0,
    p_data: { active: true, base_status: 'draft', color: '#123456', name: 'Aguardando aprovação' } })).receipt.target;
  const configured = await f.call('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: randomUUID(), expected_version: 0, situations: [situation] });
  assert.equal(configured.status, 200, JSON.stringify(configured.value));
  const before = await f.scalar("select count(*)::int v from erp_documents.document where kind='sales_orders'");
  const discounted = { ...sale({ payments: [] }), document: { ...sale().document, items: [{ ...item(f.product, '1', '10'), discount_percent: '10' }] } };
  const refused = await act('sale_save', discounted, f.users.vendedor);
  assert.equal(refused.status, 400, JSON.stringify(refused.value)); assert.equal(refused.value.error.field, 'seller_discount_limit');
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.document where kind='sales_orders'"), before, 'nothing was saved');
  // Within the limit the pré-venda is saved as before.
  const within = { ...sale({ payments: [] }), document: { ...sale().document, items: [{ ...item(f.product, '1', '10'), discount_percent: '5' }] } };
  assert.equal((await act('sale_save', within, f.users.vendedor)).status, 200);
});
