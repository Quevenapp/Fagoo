import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentMirrorFixture } from './helpers/document-mirror-fixture.mjs';
import { productStockMirrorResponse } from '../src/product-stock-mirror.mjs';
export const PRODUCT_LIST_ORIGIN_STOCK_MIGRATION = '202610220008_product_list_origin_stock.sql';
// Synthetic data only: the real chain through 007, then 008. Each product is identified by its Origin ID, never by name or SKU.
let f, ids = {};
const effects = async () => (await f.db.query(`select (select count(*) from erp_stock.movement)::int movements,(select count(*) from erp_stock.balance)::int balances,
  (select count(*) from erp_stock.entry)::int entries,(select count(*) from erp_stock_mirror.observation)::int observations,(select count(*) from erp_stock_mirror.pending)::int pending,
  (select count(*) from erp_stock_mirror.applied)::int applied`)).rows[0];
const pgArray = list => list === null ? null : `{${list.join(',')}}`;
const summary = ({ p_product_ids = Object.values(ids.products), ...args } = {}) => f.rpc('erp_stock_mirror_product_summary', { p_user_id: f.users.consulta, p_product_ids: pgArray(p_product_ids), p_warehouse_id: null, ...args });
const byId = value => Object.fromEntries(value.items.map(item => [Object.entries(ids.products).find(([, id]) => id === item.product_id)[0], item]));
const page = (args = {}) => f.rpc('erp_catalog_product_page_v2', { p_user_id: f.users.consulta, p_page: 1, p_size: 100, p_sort: 'name_asc', p_situation: 'latest', ...args });
const names = value => value.items.map(item => item.name);
test.before(async () => {
  f = await documentMirrorFixture({ guards: true });
  await f.migrate(PRODUCT_LIST_ORIGIN_STOCK_MIGRATION);
  const linked = async (id, name) => { await f.stage('products', id, { id, nome: name, codigo: 'P-' + id, unidade: 'UN', situacao: 'A' });
    const record = await f.catalog('products', { name, code: 'P-' + id, unit: 'UN', kind: 'P', format: 'S', price: '2' });
    await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='products'and source_id=$1", [id]);
    await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='products'and source_id=$1", [id, record.id]);
    return record.id; };
  ids.w1 = (await f.catalog('warehouses', { name: 'Geral' })).id; ids.w2 = (await f.catalog('warehouses', { name: 'Loja' })).id;
  await f.db.exec('set session_replication_role=replica');
  await f.db.query(`insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)
    values('900',$1,$2,repeat('a',64),1,'2026-10-22T12:00:00Z','{}','{}','{}')`, [ids.w1, randomUUID()]);
  await f.db.exec('set session_replication_role=origin');
  ids.products = {
    A: await linked('201', 'A positivo'), B: await linked('202', 'B zero'), C: await linked('203', 'C negativo'), D: await linked('204', 'D nulo e inválido'),
    E: await linked('205', 'E sem posição'), F: (await f.catalog('products', { name: 'F nativo', code: 'N-1', unit: 'UN', kind: 'P', format: 'S', price: '2' })).id,
    G: await linked('206', 'G nativo e Origin'), H: await linked('207', 'H excluído'), I: await linked('208', 'I dois depósitos'), J: await linked('209', 'J decimal'),
  };
  // Same SKU and name on the Origin side for an unlinked observation: it must never reach F.
  await f.observe('999', [{ id: '900', saldoFisico: 55, saldoVirtual: 55 }], {}, { produto: { id: '999', codigo: 'N-1', nome: 'F nativo' } });
  await f.observe('201', [{ id: '900', saldoFisico: 10, saldoVirtual: 8 }]); await f.observe('202', [{ id: '900', saldoFisico: 0, saldoVirtual: 0 }]);
  await f.observe('203', [{ id: '900', saldoFisico: -3, saldoVirtual: -5 }]); await f.observe('204', [{ id: '900', saldoFisico: null, saldoVirtual: 'bad' }]);
  await f.observe('206', [{ id: '900', saldoFisico: 7, saldoVirtual: 7 }]); await f.observe('207', [{ id: '900', saldoFisico: 3, saldoVirtual: 3 }]);
  await f.observe('208', [{ id: '900', saldoFisico: 4, saldoVirtual: 4 }, { id: '901', saldoFisico: 6, saldoVirtual: 1 }]);
  await f.observe('209', [{ id: '900', saldoFisico: '900719925474099.123456', saldoVirtual: '900719925474099.123455' }]);
  await f.project(); await f.observe('207', [], {}, { _brufap_source: { deleted: true } }); await f.project();
  for (const [product, quantity] of [[ids.products.F, '4'], [ids.products.G, '2']])
    await f.rpc('erp_stock_post', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: '2026-10-20', p_reason: 'Entrada sintética 008', p_items: [{ product_id: product, warehouse_id: ids.w1, quantity, expected_version: 0 }] });
});
test.after(async () => f?.close());

test('summary shows the observed Origin position with exact decimals; absence, unlinked and deletion never become zero', async () => {
  const value = await summary(), s = byId(value);
  assert.equal(value.scope, 'product_stock_mirror'); assert.equal(value.origin, 'origin'); assert.equal(value.read_only, true); assert.equal(value.warehouse, null);
  assert.deepEqual(value.items.map(item => item.product_id), Object.values(ids.products));
  assert.deepEqual([s.A.state, s.A.physical, s.A.virtual, s.A.warehouse_source_id, s.A.product_source_id], ['observed', '10', '8', '900', '201']);
  assert.ok(Number.isFinite(Date.parse(s.A.observed_at))); assert.equal(s.A.source_version, 1);
  assert.deepEqual([s.B.physical, s.B.virtual], ['0', '0']); assert.deepEqual([s.C.physical, s.C.virtual], ['-3', '-5']);
  assert.deepEqual([s.D.state, s.D.physical, s.D.physical_state, s.D.virtual, s.D.virtual_state], ['observed', null, 'null', null, 'invalid']);
  assert.deepEqual([s.E.state, s.E.physical, s.E.observed_at], ['not_observed', null, null]);
  assert.deepEqual([s.F.state, s.F.product_source_id, s.F.physical], ['unlinked', null, null]);
  assert.deepEqual([s.H.state, s.H.physical], ['source_deleted', null]);
  assert.deepEqual([s.I.state, s.I.positions, s.I.physical], ['multiple_warehouses', 2, null]);
  assert.deepEqual([s.J.physical, s.J.virtual], ['900719925474099.123456', '900719925474099.123455']);
});

test('real RPC responses pass the API validator with and without a warehouse', async () => {
  const all = Object.values(ids.products);
  for (const warehouse of [null, ids.w1, ids.w2]) {
    const result = productStockMirrorResponse(await summary({ p_warehouse_id: warehouse }), all, warehouse);
    assert.equal(result.items.size, all.length); assert.equal(result.summary.status, 'ok');
  }
  assert.equal(productStockMirrorResponse(await summary(), all, null).items.get(ids.products.J).physical, '900719925474099.123456');
});

test('native stock and the Origin mirror stay separate on the same product', async () => {
  const s = byId(await summary()), items = Object.fromEntries((await page()).items.map(item => [item.name, item.stock]));
  assert.equal(s.G.physical, '7'); assert.deepEqual(items['G nativo e Origin'], { state: 'recorded', quantity: '2.000000', warehouse: null });
  assert.deepEqual(items['A positivo'], { state: 'no_movements', quantity: null, warehouse: null });
  assert.deepEqual(items['F nativo'], { state: 'recorded', quantity: '4.000000', warehouse: null });
});

test('warehouse selection relates only by the proven Origin binding', async () => {
  const one = await summary({ p_warehouse_id: ids.w1 }), s = byId(one);
  assert.deepEqual(one.warehouse, { id: ids.w1, source_id: '900', linked: true });
  assert.deepEqual([s.I.state, s.I.physical, s.I.warehouse_source_id], ['observed', '4', '900']);
  const other = await summary({ p_warehouse_id: ids.w2 }), o = byId(other);
  assert.deepEqual(other.warehouse, { id: ids.w2, source_id: null, linked: false });
  assert.deepEqual([o.A.state, o.A.physical, o.F.state], ['warehouse_unlinked', null, 'unlinked']);
  await assert.rejects(summary({ p_warehouse_id: randomUUID() }), e => e.code === 'P0002');
});

test('stock filters use the same origin and balance as the list cell; native filters do not change', async () => {
  assert.deepEqual(names(await page({ p_stock: 'origin_positive' })), ['A positivo', 'G nativo e Origin', 'J decimal']);
  assert.deepEqual(names(await page({ p_stock: 'origin_positive', p_warehouse_id: ids.w1 })), ['A positivo', 'G nativo e Origin', 'I dois depósitos', 'J decimal']);
  assert.deepEqual(names(await page({ p_stock: 'origin_positive', p_warehouse_id: ids.w2 })), []);
  assert.deepEqual(names(await page({ p_stock: 'origin_zero' })), ['B zero']);
  assert.deepEqual(names(await page({ p_stock: 'origin_negative' })), ['C negativo']);
  assert.deepEqual(names(await page({ p_stock: 'origin_not_observed' })), ['E sem posição']);
  assert.deepEqual(names(await page({ p_stock: 'origin_unlinked' })), ['F nativo']);
  assert.deepEqual(names(await page({ p_stock: 'positive' })), ['F nativo', 'G nativo e Origin']);
  const first = await page({ p_stock: 'origin_positive', p_size: 2 }), second = await page({ p_stock: 'origin_positive', p_size: 2, p_page: 2 });
  assert.equal(first.total, 3); assert.deepEqual([...names(first), ...names(second)], ['A positivo', 'G nativo e Origin', 'J decimal']);
  await assert.rejects(page({ p_stock: 'origin_other' }), e => e.code === '22023');
  const exported = await f.rpc('erp_catalog_product_export_v2', { p_user_id: f.users.consulta, p_offset: 0, p_limit: 250, p_sort: 'name_asc', p_situation: 'latest', p_stock: 'origin_negative' });
  assert.deepEqual(exported.items.map(item => item.name), ['C negativo']);
});

test('only profiles that read stock see the mirror summary or use the Origin filters', async () => {
  for (const role of ['admin', 'consulta', 'estoque', 'vendas', 'fiscal']) assert.equal((await summary({ p_user_id: f.users[role] })).items.length, 10);
  for (const role of ['financeiro', 'inactive']) {
    await assert.rejects(summary({ p_user_id: f.users[role] }), e => e.code === '42501');
    await assert.rejects(page({ p_user_id: f.users[role], p_stock: 'origin_positive' }), e => e.code === '42501');
  }
  await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by)values($1,'normal',false,'[]','{}',1,clock_timestamp(),$2)", [f.users.vendas, f.users.admin]);
  await assert.rejects(summary({ p_user_id: f.users.vendas }), e => e.code === '42501');
  await assert.rejects(page({ p_user_id: f.users.vendas, p_stock: 'origin_positive' }), e => e.code === '42501');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_stock_mirror_product_summary(uuid,uuid[],uuid)','execute')v", [role]), role === 'service_role');
    assert.equal(await f.scalar("select has_function_privilege($1,'erp_stock_mirror.product_summary(uuid[],uuid)','execute')v", [role]), false);
  }
});

test('summary input is bounded and reading creates no movement, reservation, balance or projection', async () => {
  for (const p_product_ids of [null, [ids.products.A, ids.products.A], Array.from({ length: 251 }, () => randomUUID())])
    await assert.rejects(summary({ p_product_ids }), e => e.code === '22023');
  assert.equal((await summary({ p_product_ids: [] })).items.length, 0);
  const before = await effects();
  await summary(); await summary({ p_warehouse_id: ids.w1 }); await page({ p_stock: 'origin_positive' }); await page();
  assert.deepEqual(await effects(), before);
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.reservation'), 0);
});

test('replacement is locked to the published definitions and a batch of 100 linked products stays cheap', async () => {
  const sql = (await import('node:fs/promises')).readFile(new URL('../../../supabase/migrations/' + PRODUCT_LIST_ORIGIN_STOCK_MIGRATION, import.meta.url), 'utf8');
  assert.match(await sql, /product_list_origin_stock_previous_definition_changed/);
  await assert.rejects(f.migrate(PRODUCT_LIST_ORIGIN_STOCK_MIGRATION), e => /previous_definition_changed|already exists/.test(e.message));
  await f.db.exec('rollback');
  const extra = [];
  for (let n = 0; n < 90; n++) { const id = String(3000 + n); await f.stage('products', id, { id, nome: 'Lote ' + id, unidade: 'UN', situacao: 'A' });
    const record = await f.catalog('products', { name: 'Lote ' + id, code: 'L-' + id, unit: 'UN', kind: 'P', format: 'S', price: '1' });
    await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='products'and source_id=$1", [id]);
    await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='products'and source_id=$1", [id, record.id]);
    await f.observe(id, [{ id: '900', saldoFisico: n, saldoVirtual: n }]); extra.push(record.id); }
  await f.project();
  const started = performance.now(), value = await summary({ p_product_ids: [...Object.values(ids.products), ...extra] }), elapsed = performance.now() - started;
  assert.equal(value.items.length, 100); console.log(`summary of 100 products: ${elapsed.toFixed(1)} ms (PGlite, synthetic)`);
  const filterStarted = performance.now(); await page({ p_stock: 'origin_positive' }); console.log(`page with Origin filter: ${(performance.now() - filterStarted).toFixed(1)} ms (PGlite, synthetic)`);
});
