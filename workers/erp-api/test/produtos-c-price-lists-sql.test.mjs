import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosFixture, fails } from './helpers/produtos-c-fixture.mjs';

// Listas de preços, onda C (migration 154): Vendedor e Forma de pagamento, a lista criada com os produtos da seleção, o período
// "Cadastrada em" e a consulta do preço da lista para os documentos. PGlite, dados sintéticos.
const base = { name: 'Atacado', category: 'other', list_type: 'rates', factor: '10', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: [] };

test('154 grants and the new link tables', async () => {
  const f = await produtosFixture();
  try {
    for (const name of ['erp_pricing_lists', 'erp_pricing_list_save', 'erp_pricing_list_clone', 'erp_pricing_list_prices']) {
      const rows = await f.rows(`select p.prosecdef d,p.proconfig c,has_function_privilege('authenticated',p.oid,'execute') a,has_function_privilege('service_role',p.oid,'execute') s
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
      assert.equal(rows.length, 1, `${name} has one signature`);
      assert.deepEqual([rows[0].d, rows[0].c, rows[0].a, rows[0].s], [true, ['search_path=pg_catalog'], false, true], name);
    }
    for (const table of ['price_list_seller', 'price_list_payment_method']) assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_pricing.${table}','select') v`), false, table);
  } finally { await f.close(); }
});

test('154 Vendedor and Forma de pagamento: up to 30 links, only for their category, copied by Clonar lista', async () => {
  const f = await produtosFixture();
  const save = (data, { id = null, version = 0, command = randomUUID(), user = f.users.admin } = {}) => f.rpc('erp_pricing_list_save', { p_user_id: user, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  try {
    const sellerContact = await f.contact({ name: 'Vendedora Sintética' });
    const seller = await f.scalar('insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id v', [sellerContact.id, f.users.admin]);
    const method = await f.scalar(`insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values('Boleto sintético','15','contas','recebimentos',$1,$1) returning id v`, [f.users.admin]);
    const bySeller = await save({ ...base, category: 'seller', sellers: [seller] });
    assert.deepEqual([bySeller.saved, bySeller.list.category, bySeller.list.sellers], [true, 'seller', [{ id: seller, name: 'Vendedora Sintética' }]]);
    const byMethod = await save({ ...base, name: 'Boleto', category: 'payment_method', payment_methods: [method] });
    assert.deepEqual(byMethod.list.payment_methods, [{ id: method, name: 'Boleto sintético' }]);
    for (const bad of [{ category: 'other', sellers: [seller] }, { category: 'seller', payment_methods: [method] }, { category: 'seller', sellers: [randomUUID()] }, { category: 'seller', sellers: [seller, seller] },
      { category: 'payment_method', payment_methods: Array.from({ length: 31 }, () => randomUUID()) }, { category: 'store' }])
      await fails(assert, save({ ...base, name: 'Inválida', ...bad }), '22023');
    const moved = await save({ ...base, category: 'payment_method', payment_methods: [method] }, { id: bySeller.list.id, version: 1 });
    assert.deepEqual([moved.list.version, moved.list.sellers, moved.list.payment_methods.length], [2, [], 1], 'changing the category replaces the links');
    const clone = await f.rpc('erp_pricing_list_clone', { p_user_id: f.users.admin, p_id: byMethod.list.id, p_command_id: randomUUID(), p_name: 'Boleto 2' });
    assert.deepEqual(clone.list.payment_methods, [{ id: method, name: 'Boleto sintético' }]);
    // A 121 body (without the new keys) keeps working.
    assert.equal((await save({ ...base, name: 'Antiga' })).list.sellers.length, 0);
    const listing = await f.rpc('erp_pricing_lists', { p_user_id: f.users.consulta, p_category: 'payment_method' });
    assert.deepEqual(listing.items.map(item => item.name).sort(), ['Atacado', 'Boleto', 'Boleto 2']);
    assert.equal(Object.hasOwn(listing.items[0], 'payment_methods'), false, 'the listing stays lean');
  } finally { await f.close(); }
});

test('154 a new list with the selected products (one command); deleted products and an edit with add_products are refused', async () => {
  const f = await produtosFixture();
  const save = (data, { id = null, version = 0, command = randomUUID() } = {}) => f.rpc('erp_pricing_list_save', { p_user_id: f.users.admin, p_id: id, p_expected_version: version, p_command_id: command, p_data: data });
  try {
    const a = await f.product({ name: 'Parafuso', price: '10.1250' }), b = await f.product({ name: 'Porca', price: '0.50' });
    const command = randomUUID();
    const created = await save({ ...base, add_products: [a.id, b.id] }, { command });
    assert.deepEqual([created.list.products, created.list.version], [2, 1]);
    assert.deepEqual(await save({ ...base, add_products: [a.id, b.id] }, { command }), { ...created, replayed: true });
    const detail = await f.rpc('erp_pricing_list_get', { p_user_id: f.users.admin, p_id: created.list.id });
    assert.deepEqual(detail.items.map(item => [item.name, item.list_price]), [['Parafuso', '9.11'], ['Porca', '0.45']]);
    assert.equal((await f.rows("select after_data->>'added_products' v from erp_pricing.audit where list_id=$1", [created.list.id]))[0].v, '2');
    const gone = await f.product({ name: 'Excluído', price: '1' });
    await f.rpc('erp_catalog_product_set_deleted', { p_user_id: f.users.admin, p_id: gone.id, p_expected_version: gone.version, p_command_id: randomUUID(), p_deleted: true });
    await fails(assert, save({ ...base, name: 'Com excluído', add_products: [gone.id] }), '22023');
    await fails(assert, save({ ...base, name: 'Repetido', add_products: [a.id, a.id] }), '22023');
    await fails(assert, save({ ...base, add_products: [b.id] }, { id: created.list.id, version: 1 }), '22023');
  } finally { await f.close(); }
});

test('154 the period filter "Cadastrada em" uses São Paulo dates; the list prices of a product set follow the list and its validity', async () => {
  const f = await produtosFixture();
  const save = data => f.rpc('erp_pricing_list_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data });
  try {
    const a = await f.product({ name: 'Parafuso', price: '10' }), b = await f.product({ name: 'Arruela', price: '2' }), free = await f.product({ name: 'Sem preço' });
    const old = (await save({ ...base, name: 'Antiga', add_products: [a.id] })).list;
    const recent = (await save({ ...base, name: 'Recente', factor: '1', factor_unit: 'amount', direction: 'increase', add_products: [a.id, free.id] })).list;
    // 2026-10-01 02:30 UTC is still 30/09 in São Paulo.
    await f.db.query("update erp_pricing.price_list set created_at='2026-10-01T02:30:00Z' where id=$1", [old.id]);
    const names = async (from, to) => (await f.rpc('erp_pricing_lists', { p_user_id: f.users.admin, p_from: from, p_to: to })).items.map(item => item.name);
    assert.deepEqual(await names('2026-09-30', '2026-09-30'), ['Antiga']);
    assert.deepEqual(await names('2026-10-01', null), ['Recente']);
    await fails(assert, f.rpc('erp_pricing_lists', { p_user_id: f.users.admin, p_from: '2026-10-02', p_to: '2026-10-01' }), '22023');
    const prices = await f.rpc('erp_pricing_list_prices', { p_user_id: f.users.vendas, p_id: recent.id, p_product_ids: [a.id, b.id, free.id] });
    assert.deepEqual(prices.items.map(item => [item.in_list, item.list_price]), [[true, '11.00'], [false, null], [true, null]]);
    assert.deepEqual([prices.list.rule, prices.list.valid_now], ['Acréscimo R$ 1,00', true]);
    const expired = (await save({ ...base, name: 'Expirada', list_type: 'period', starts_on: '2020-01-01', ends_on: '2020-01-31', add_products: [a.id] })).list;
    assert.equal((await f.rpc('erp_pricing_list_prices', { p_user_id: f.users.admin, p_id: expired.id, p_product_ids: [a.id] })).list.valid_now, false);
    await fails(assert, f.rpc('erp_pricing_list_prices', { p_user_id: f.users.admin, p_id: recent.id, p_product_ids: [a.id, a.id] }), '22023');
    await fails(assert, f.rpc('erp_pricing_list_prices', { p_user_id: f.users.admin, p_id: randomUUID(), p_product_ids: [a.id] }), 'P0002');
    await fails(assert, f.rpc('erp_pricing_list_prices', { p_user_id: f.users.financeiro, p_id: recent.id, p_product_ids: [a.id] }), '42501');
  } finally { await f.close(); }
});
