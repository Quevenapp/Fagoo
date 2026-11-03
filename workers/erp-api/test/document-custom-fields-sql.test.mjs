// Synthetic data only. 202610200288: campos customizados of the OS (definitions), the lots offered by Informar lotes, the commission
// rule of the vendedor (aba Comissões) and the search of the Descrição of a line without the item types that are not sold. PGlite with
// every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f;
before(async () => { f = await documentsEFixture(); });
after(async () => f?.close());
const BASE = '/v1/documentos/service_orders/campos-customizados';
const field = (extra = {}) => ({ field_type: 'text', name: 'Placa do veículo', hint: 'Ex: ABC1D23', info: null, required: false, min_length: null, max_length: 10, width: 'medium', options: [], active: true, ...extra });
const save = (data, { id = null, version = 0, user = f.users.admin, command = randomUUID() } = {}) => f.call(id ? `${BASE}/${id}` : BASE, 'POST', { command_id: command, expected_version: version, data }, user);
const product = async (name, detail = {}) => { const p = await f.catalog('products', { name, unit: 'UN', kind: 'P', format: 'S', price: '10' });
  if (Object.keys(detail).length) await f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: p.id, p_expected_version: await f.recordVersion(p.id), p_command_id: randomUUID(), p_data: { name, ...detail }, p_acknowledged: null });
  return p; };

test('privileges: the RPCs of 288 run only for service_role and the helpers for nobody', async () => {
  for (const sig of ['public.erp_document_custom_fields(uuid,text)', 'public.erp_document_custom_field_save(uuid,text,uuid,integer,uuid,jsonb)', 'public.erp_document_custom_field_delete(uuid,text,uuid,integer,uuid)',
    'public.erp_document_lot_products(uuid,text,uuid[])', 'public.erp_document_lot_options(uuid,text,uuid,uuid)', 'public.erp_document_seller_commission(uuid,text,uuid)', 'public.erp_document_product_search(uuid,text,text,integer)']) {
    const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
    assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']], sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false, `${role} ${sig}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true, sig);
  }
  for (const fn of ['erp_documents.custom_field_item(uuid,boolean)', 'erp_documents.custom_field_input(jsonb,erp_documents.custom_field)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, `${role} ${fn}`);
});

test('Campos customizados da OS: the administrador adds, edits and deletes with command, version and audit; the readers only read', async () => {
  const command = randomUUID();
  const created = await save(field(), { command });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const placa = created.value.field;
  assert.deepEqual([placa.field_type, placa.name, placa.max_length, placa.version, placa.documents, created.value.replayed], ['text', 'Placa do veículo', 10, 1, 0, false]);
  assert.equal((await save(field(), { command })).value.replayed, true, 'Conferir resultado: the same command answers the same field');
  assert.equal((await save(field({ name: 'outra' }), { command })).status, 409, 'the same command with another body conflicts');
  assert.equal((await save(field({ name: 'PLACA DO VEÍCULO' }))).value.error?.code, 'ERP_DOCUMENT_CUSTOM_FIELD_DUPLICATE');
  assert.equal((await save(field({ name: 'Outro' }), { user: f.users.vendas })).status, 403);
  const list = await save(field({ field_type: 'list', name: 'Tipo de entrega', hint: null, max_length: null, options: [{ id: null, label: 'Balcão' }, { id: null, label: 'Domicílio' }] }));
  assert.equal(list.status, 200, JSON.stringify(list.value));
  const [balcao, domicilio] = list.value.field.options;
  // The readers of OS read the fields; only the administrador sees how many OS use each one.
  const read = (await f.call(BASE, 'GET', undefined, f.users.vendas)).value;
  assert.deepEqual([read.can_manage, read.items.map(item => item.name), read.items.map(item => item.documents)], [false, ['Placa do veículo', 'Tipo de entrega'], [null, null]]);
  assert.equal((await f.call(BASE, 'GET', undefined, f.users.estoque)).status, 403, 'estoque does not read OS');
  // An OS with values; the type is fixed, a used option is not removed and a field with values is not deleted.
  const os = await f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), data: f.data('service_orders', { custom_fields: { [placa.id]: 'ABC1D23', [list.value.field.id]: balcao.id } }) });
  assert.equal(os.status, 200, JSON.stringify(os.value));
  assert.equal((await save(field({ field_type: 'long_text' }), { id: placa.id, version: 1 })).status, 400);
  const kept = await save(field({ field_type: 'list', name: 'Tipo de entrega', hint: null, max_length: null, options: [{ id: balcao.id, label: 'Retirada no balcão' }] }), { id: list.value.field.id, version: 1 });
  assert.equal(kept.status, 200, JSON.stringify(kept.value)); assert.deepEqual(kept.value.field.options, [{ id: balcao.id, label: 'Retirada no balcão' }]);
  assert.equal((await save(field({ field_type: 'list', name: 'Tipo de entrega', hint: null, max_length: null, options: [{ id: domicilio.id, label: 'Domicílio' }] }), { id: list.value.field.id, version: 2 })).status, 400, 'a removed option id never comes back');
  assert.equal((await save(field({ field_type: 'list', name: 'Tipo de entrega', hint: null, max_length: null, options: [{ id: null, label: 'Domicílio' }] }), { id: list.value.field.id, version: 2 })).value.error?.code, 'ERP_DOCUMENT_CUSTOM_FIELD_OPTION_IN_USE');
  const del = id => f.call(`${BASE}/${id}/exclusao`, 'POST', { command_id: randomUUID(), expected_version: 1 });
  assert.equal((await del(placa.id)).value.error?.code, 'ERP_DOCUMENT_CUSTOM_FIELD_IN_USE');
  assert.equal((await f.call(BASE)).value.items.find(item => item.id === placa.id).documents, 1);
  // Inactive: the OS keeps its value; a new field can then be deleted.
  const off = await save(field({ active: false }), { id: placa.id, version: 1 });
  assert.deepEqual([off.status, off.value.field.active, off.value.field.version], [200, false, 2]);
  const spare = (await save(field({ name: 'Sem uso' }))).value.field;
  const deleted = await del(spare.id);
  assert.deepEqual([deleted.status, deleted.value.deleted], [200, spare.id]);
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.custom_field_audit where field_id=$1", [spare.id]), 2);
  await assert.rejects(() => f.db.query('delete from erp_documents.custom_field_audit'), /erp_document_custom_field_audit_immutable/);
  // Strict Worker body.
  for (const bad of [{ ...field(), extra: 1 }, field({ field_type: 'cor' }), field({ min_length: 5, max_length: 2 }), field({ field_type: 'boolean', max_length: 3 }), field({ field_type: 'list', options: [] }),
    field({ field_type: 'list', max_length: null, options: [{ id: null, label: 'A' }, { id: null, label: 'a' }] })])
    assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
});

test('Informar lotes: Controle de lote of the products and the lots of one product with the quantity of the depósito', async () => {
  const leite = await product('Leite G288', { lot_control: true }), agua = await product('Água G288');
  const lot = (await f.rpc('erp_stock_lot_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_product_id: leite.id, p_lot_id: null, p_expected_version: 0, p_code: 'L-288', p_expires_on: '2027-01-31' })).lot;
  const flags = await f.call(`/v1/documentos/sales_orders/lotes?produtos=${leite.id},${agua.id}`, 'GET', undefined, f.users.vendas);
  assert.equal(flags.status, 200, JSON.stringify(flags.value));
  assert.deepEqual(Object.fromEntries(flags.value.items.map(item => [item.product_id, item.lot_control])), { [leite.id]: true, [agua.id]: false });
  const options = await f.call(`/v1/documentos/sales_orders/lotes/${leite.id}`, 'GET', undefined, f.users.vendas);
  assert.equal(options.status, 200, JSON.stringify(options.value));
  assert.deepEqual(options.value.items.map(item => [item.id, item.code, item.expires_on, item.quantity, item.active]), [[lot.id, 'L-288', '2027-01-31', '0.000000', true]]);
  // Review fix: reading the lots writes nothing, so a reader of the pedido and of the stock (Consulta, a locked document) sees them;
  // a profile without the stock (Financeiro) does not.
  assert.equal((await f.call(`/v1/documentos/sales_orders/lotes/${leite.id}`, 'GET', undefined, f.users.consulta)).status, 200, 'a reader of the pedido and of the stock');
  assert.equal((await f.call(`/v1/documentos/sales_orders/lotes/${leite.id}`, 'GET', undefined, f.users.financeiro)).status, 403, 'no stock read');
  assert.equal((await f.call(`/v1/documentos/purchase_orders/lotes?produtos=${leite.id}`)).status, 404);
  assert.equal((await f.call(`/v1/documentos/sales_orders/lotes?produtos=${leite.id},${leite.id}`)).status, 400);
});

test('Aba Comissões: the rule of the vendedor and the Adicionais da base, read-only', async () => {
  const seller = await f.seller(f.users.vendas2, { name: 'Vendedor comissão G' });
  await f.db.query("update erp_catalog.seller set commission_mode='descontos',commission_rate=3,commission_bands='[{\"discount_up_to\":\"5.0000\",\"rate\":\"4.0000\"},{\"discount_up_to\":\"10.0000\",\"rate\":\"2.5000\"}]' where id=$1", [seller]);
  await f.setPreference('vendas-vendas', 'vendas.base_comissao', ['frete']);
  const read = await f.call(`/v1/documentos/service_orders/comissao?vendedor=${seller}`, 'GET', undefined, f.users.vendas);
  assert.equal(read.status, 200, JSON.stringify(read.value));
  assert.deepEqual([read.value.mode, read.value.rate, read.value.bands, read.value.additions], ['descontos', '3.0000', [{ discount_up_to: '5.0000', rate: '4.0000' }, { discount_up_to: '10.0000', rate: '2.5000' }], ['frete']]);
  assert.equal((await f.call(`/v1/documentos/service_orders/comissao?vendedor=${randomUUID()}`)).status, 400);
  assert.equal((await f.call(`/v1/documentos/sales_proposals/comissao?vendedor=${seller}`)).status, 404);
});

test('Descrição da linha: the products of the search, without matéria-prima, produto em processo, uso e consumo and ativo imobilizado', async () => {
  const sold = await product('Parafuso G288 venda', { item_type: '00' }), raw = await product('Parafuso G288 matéria', { item_type: '01' });
  const asset = await product('Parafuso G288 ativo', { item_type: '08' }), untyped = await product('Parafuso G288 sem tipo');
  const found = await f.call('/v1/documentos/sales_orders/produtos?q=parafuso%20g288&limit=10', 'GET', undefined, f.users.vendas);
  assert.equal(found.status, 200, JSON.stringify(found.value));
  const ids = found.value.items.map(item => item.id);
  assert.ok(ids.includes(sold.id) && ids.includes(untyped.id)); assert.ok(!ids.includes(raw.id) && !ids.includes(asset.id));
  assert.equal(found.value.items.find(item => item.id === sold.id).name, 'Parafuso G288 venda');
  for (const bad of ['?q=p', '?q=parafuso&limit=26', '?q=parafuso&other=1']) assert.equal((await f.call(`/v1/documentos/sales_orders/produtos${bad}`)).status, 400, bad);
  assert.equal((await f.call('/v1/documentos/purchase_orders/produtos?q=parafuso')).status, 404, 'the pedido de compra buys every type');
});
