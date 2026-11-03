import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { produtosFixture, fails } from './helpers/produtos-c-fixture.mjs';

// Ferramentas de preço (migration 155): reajuste de preços com prévia, informações de compra e "Atualizar preços" da nota de
// entrada. PGlite, dados sintéticos.
const RPCS = ['erp_catalog_product_price_preview', 'erp_catalog_product_price_adjust', 'erp_catalog_product_purchase_info', 'erp_catalog_product_prices_update'];

test('155 grants: SECURITY DEFINER, fixed search_path, service_role only', async () => {
  const f = await produtosFixture();
  try {
    for (const name of RPCS) {
      const rows = await f.rows(`select p.prosecdef d,p.proconfig c,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('service_role',p.oid,'execute') s
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name]);
      assert.deepEqual([rows.length, rows[0].d, rows[0].c, rows[0].a, rows[0].s], [1, true, ['search_path=pg_catalog'], false, true], name);
    }
  } finally { await f.close(); }
});

test('155 reajuste: exact preview, selected products with their versions, the filtered set, replay, audit and the reasons left out', async () => {
  const f = await produtosFixture();
  const adjust = (args, user = f.users.admin) => f.rpc('erp_catalog_product_price_adjust', { p_user_id: user, p_command_id: randomUUID(), p_rule: { action: 'increase', unit: 'percent', value: '10' }, p_items: null, p_filters: null, ...args });
  try {
    const a = await f.product({ name: 'Parafuso', price: '10' }), b = await f.product({ name: 'Porca', price: '0.3333' }), c = await f.product({ name: 'Sem preço' });
    const gone = await f.product({ name: 'Excluído', price: '5' });
    await f.rpc('erp_catalog_product_set_deleted', { p_user_id: f.users.admin, p_id: gone.id, p_expected_version: gone.version, p_command_id: randomUUID(), p_deleted: true });
    const preview = await f.rpc('erp_catalog_product_price_preview', { p_user_id: f.users.consulta, p_rule: { action: 'increase', unit: 'percent', value: '10' }, p_ids: [a.id, b.id, c.id, gone.id] });
    assert.deepEqual(preview.items.map(item => [item.price, item.status, item.new_price]), [['10.0000', 'ok', '11.0000'], ['0.3333', 'ok', '0.3700'], [null, 'no_price', null], ['5.0000', 'deleted', null]]);
    const fix = await f.rpc('erp_catalog_product_price_preview', { p_user_id: f.users.admin, p_rule: { action: 'fix', unit: 'amount', value: '10' }, p_ids: [a.id, c.id] });
    assert.deepEqual(fix.items.map(item => [item.status, item.new_price]), [['unchanged', '10.0000'], ['ok', '10.0000']], 'Fixar also prices a product without price');
    for (const rule of [{ action: 'fix', unit: 'percent', value: '1' }, { action: 'discount', unit: 'percent', value: '101' }, { action: 'increase', unit: 'amount', value: '1,5' }, { action: 'copy', unit: 'amount', value: '1' }])
      await fails(assert, f.rpc('erp_catalog_product_price_preview', { p_user_id: f.users.admin, p_rule: rule, p_ids: [a.id] }), '22023');
    const command = randomUUID();
    const selected = await adjust({ p_command_id: command, p_items: [{ id: a.id, expected_version: a.version }, { id: b.id, expected_version: b.version + 7 }, { id: c.id, expected_version: c.version }] });
    // The products are locked (and reported) in UUID order, which is random here: compare the skipped set sorted by name.
    assert.deepEqual([selected.applied, selected.skipped_total, selected.skipped.map(item => [item.name, item.reason]).sort()], [1, 2, [['Porca', 'conflict'], ['Sem preço', 'no_price']]]);
    assert.equal((await f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: command, p_rule: { action: 'increase', unit: 'percent', value: '10' },
      p_items: [{ id: a.id, expected_version: a.version }, { id: b.id, expected_version: b.version + 7 }, { id: c.id, expected_version: c.version }], p_filters: null })).replayed, true);
    await fails(assert, f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: command, p_rule: { action: 'increase', unit: 'percent', value: '11' }, p_items: [{ id: a.id, expected_version: a.version }], p_filters: null }), '40001');
    const afterA = (await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: a.id })).record;
    assert.deepEqual([afterA.price, afterA.version], ['11.0000', a.version + 1]);
    assert.deepEqual((await f.rows("select before_data->>'price' b,after_data->>'price' a from erp_catalog.audit where record_id=$1 and action='price_adjust'", [a.id])).map(row => [row.b, row.a]), [['10.0000', '11.0000']]);
    const filtered = await adjust({ p_rule: { action: 'discount', unit: 'amount', value: '1' }, p_filters: { situation: 'latest', query: 'por' } });
    assert.deepEqual([filtered.total, filtered.applied, filtered.skipped[0].reason], [1, 0, 'negative'], 'Porca would go below zero');
    const all = await adjust({ p_rule: { action: 'discount', unit: 'percent', value: '50' }, p_filters: { situation: 'active' } });
    assert.deepEqual([all.total, all.applied, all.skipped_total], [3, 2, 1], 'the deleted product is never in the filtered set');
    assert.equal((await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: b.id })).record.price, '0.1700', 'percent rounds to two places');
    await fails(assert, adjust({ p_filters: { situation: 'deleted' } }), '22023');
    await fails(assert, adjust({ p_filters: { situation: 'latest', stock: 'zero' } }, f.users.vendas), '42501');
    await fails(assert, adjust({ p_items: [{ id: a.id, expected_version: 2 }], p_filters: { situation: 'latest' } }), '22023');
    await fails(assert, adjust({ p_items: [{ id: a.id, expected_version: 2 }] }, f.users.consulta), '42501');
  } finally { await f.close(); }
});

test('155 purchase information: default supplier, the supplier of the order, the last purchase and the suggested price of the preference', async () => {
  const f = await produtosFixture();
  try {
    const supplierA = await f.contact({ name: 'Fornecedor A' }), supplierB = await f.contact({ name: 'Fornecedor B' });
    const product = await f.product({ name: 'Parafuso', price: '20', suppliers: [
      { supplier_id: supplierA.id, description: null, code: 'A-1', purchase_price: '8.5', cost_price: '9.25', warranty_months: null, is_default: true },
      { supplier_id: supplierB.id, description: 'No B', code: 'B-1', purchase_price: '7', cost_price: null, warranty_months: null, is_default: false }] });
    const info = async supplier => (await f.rpc('erp_catalog_product_purchase_info', { p_user_id: f.users.estoque, p_product_ids: [product.id], p_supplier_id: supplier })).items[0];
    let row = await info(null);
    assert.deepEqual([row.default_supplier.name, row.supplier, row.last_purchase_price, row.suggested_price], ['Fornecedor A', null, null, '8.5000'], 'no purchase yet: the purchase price of the default supplier');
    row = await info(supplierB.id);
    assert.deepEqual([row.supplier.code, row.supplier.purchase_price, row.suggested_price], ['B-1', '7.0000', '7.0000']);
    await f.db.query(`insert into erp_documents.document(kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by) values('purchase_orders',901,'open',$1,'{"name":"Fornecedor A"}','{"date":"2026-10-10"}',30,$2,$2)`, [supplierA.id, f.users.admin]);
    await f.db.query(`insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,discount_percent,total,data) select gen_random_uuid(),id,1,$1,3,6.75,0,20.25,'{}' from erp_documents.document where number=901 and kind='purchase_orders'`, [product.id]);
    row = await info(supplierB.id);
    assert.deepEqual([row.last_purchase_price, row.suggested_price], ['6.7500', '6.7500'], 'preference off: the last purchase');
    const seller = (await f.rpc('erp_catalog_product_purchase_info', { p_user_id: f.users.vendas, p_product_ids: [product.id], p_supplier_id: supplierB.id })).items[0];
    assert.deepEqual([seller.last_purchase_price, seller.suggested_price], [null, '7.0000'], 'Vendas does not read purchase orders: no last purchase price');
    await f.preference('suprimentos-compras', 'compras.preco_padrao', true);
    const result = await f.rpc('erp_catalog_product_purchase_info', { p_user_id: f.users.estoque, p_product_ids: [product.id], p_supplier_id: supplierA.id });
    assert.deepEqual([result.mode, result.items[0].suggested_price], ['cost', '9.2500']);
    assert.equal((await info(supplierB.id)).suggested_price, '7.0000', 'no cost price for B: the purchase price');
    await f.preference('suprimentos-compras', 'compras.preco_padrao_tipo', 'compra');
    assert.equal((await info(supplierA.id)).suggested_price, '8.5000');
    await fails(assert, f.rpc('erp_catalog_product_purchase_info', { p_user_id: f.users.financeiro, p_product_ids: [product.id], p_supplier_id: null }), '42501');
    await fails(assert, f.rpc('erp_catalog_product_purchase_info', { p_user_id: f.users.admin, p_product_ids: [product.id, product.id], p_supplier_id: null }), '22023');
  } finally { await f.close(); }
});

test('155 Atualizar preços: sale and cost price with the version of each product, the supplier row created when missing, all or nothing', async () => {
  const f = await produtosFixture();
  const update = (items, { command = randomUUID(), supplier = null, user = f.users.admin } = {}) => f.rpc('erp_catalog_product_prices_update', { p_user_id: user, p_command_id: command, p_supplier_id: supplier, p_items: items });
  try {
    const supplier = await f.contact({ name: 'Fornecedor da nota' }), other = await f.contact({ name: 'Outro' });
    const a = await f.product({ name: 'Parafuso', price: '10', suppliers: [{ supplier_id: other.id, description: null, code: null, purchase_price: null, cost_price: '1', warranty_months: null, is_default: true }] });
    const b = await f.product({ name: 'Porca', price: '2' });
    const command = randomUUID();
    const result = await update([{ product_id: a.id, expected_version: a.version, price: '13.55', cost_price: '10.0000' }, { product_id: b.id, expected_version: b.version, price: '2.5' }], { command, supplier: supplier.id });
    assert.deepEqual(result.items.map(item => [item.price, item.cost_price, item.version]).sort(), [['13.5500', '10.0000', a.version + 1], ['2.5000', null, b.version + 1]].sort());
    assert.equal((await update([{ product_id: a.id, expected_version: a.version, price: '13.55', cost_price: '10.0000' }, { product_id: b.id, expected_version: b.version, price: '2.5' }], { command, supplier: supplier.id })).replayed, true);
    const suppliers = (await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: a.id })).record.suppliers;
    assert.deepEqual(suppliers.map(row => [row.supplier_name, row.cost_price, row.is_default]), [['Outro', '1.0000', true], ['Fornecedor da nota', '10.0000', false]], 'the note supplier is added, the default stays');
    await fails(assert, update([{ product_id: a.id, expected_version: a.version + 1, price: '14' }, { product_id: b.id, expected_version: b.version, price: '9' }]), '40001');
    assert.equal((await f.rpc('erp_catalog_product_get', { p_user_id: f.users.admin, p_id: b.id })).record.price, '2.5000', 'nothing is written when one product changed meanwhile');
    await fails(assert, update([{ product_id: b.id, expected_version: b.version + 1, cost_price: '1' }]), '22023');
    await fails(assert, update([{ product_id: b.id, expected_version: b.version + 1, price: '-1' }]), '22023');
    await fails(assert, update([{ product_id: b.id, expected_version: b.version + 1, price: '1' }], { user: f.users.fiscal }), '42501');
    assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where action='prices_update'"), 2);
  } finally { await f.close(); }
});
