import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { stockOperation, stockResponse, stockRoute } from '../../workers/erp-api/src/stock.mjs';

// Local, synthetic SQL tests. PGlite serializes queries: these do not claim to
// exercise two PostgreSQL sessions or real advisory/row-lock contention.
let db;
const users = { admin: randomUUID(), stock: randomUUID() };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const sqlError = code => error => error.code === code;
const catalog = async (entity, data) => (await scalar(
  'select public.erp_catalog_save($1::uuid,$2,null,0,$3::uuid,$4::jsonb) value',
  [users.admin, entity, randomUUID(), JSON.stringify(data)],
)).record;
const balances = (product, warehouse) => scalar(
  'select public.erp_stock_balances($1::uuid,$2::uuid,$3::uuid) value', [users.stock, product, warehouse],
);
const post = (items, { command = randomUUID(), actor = users.stock, kind = 'receipt' } = {}) => scalar(
  'select public.erp_stock_post($1::uuid,$2::uuid,$3,$4::date,$5,$6::jsonb,null) value',
  [actor, command, kind, '2024-10-15', 'Lançamento sintético adversarial', JSON.stringify(items)],
);
const reverse = (movement, versions, command = randomUUID()) => scalar(
  'select public.erp_stock_reverse($1::uuid,$2::uuid,$3::uuid,$4::date,$5,$6::jsonb) value',
  [users.stock, movement, command, '2024-10-16', 'Estorno sintético adversarial', JSON.stringify(versions)],
);
const line = (f, quantity, expected_version = 0, warehouse = f.warehouse) => ({ product_id: f.product, warehouse_id: warehouse, quantity, expected_version });
const version = (f, expected_version, warehouse = f.warehouse) => ({ product_id: f.product, warehouse_id: warehouse, expected_version });
async function fixture() {
  const product = await catalog('products', { name: 'Produto fictício adversarial', unit: 'UN', kind: 'P' });
  const warehouse = await catalog('warehouses', { name: 'Depósito fictício adversarial' });
  const destination = await catalog('warehouses', { name: 'Destino fictício adversarial' });
  return { product: product.id, warehouse: warehouse.id, destination: destination.id };
}
before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
  for (const suffix of ['0001_origin_sync', '0002_origin_quotes_nfce', '0004_erp_access', '0005_origin_auxiliary_catalogs', '0006_erp_catalog', '0009_erp_stock']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`, import.meta.url), 'utf8'));
  }
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1)', [id]);
    await db.query('insert into erp_access.membership(user_id,role) values($1,$2)', [id, name === 'admin' ? 'admin' : 'estoque']);
  }
});
after(async () => db?.close());

test('decimal upper bound stays exact through SQL and HTTP projection; excess leaves no command', async () => {
  const f = await fixture();
  const created = await post([line(f, '999999999999.999999')]);
  assert.equal(created.movement.items[0].balance_after, '999999999999.999999');
  assert.equal(stockResponse(created, { type: 'movements' }, { type: 'mutation' }).movement.items[0].quantity, '999999999999.999999');
  const rejected = randomUUID();
  await assert.rejects(() => post([line(f, '0.000001', 1)], { command: rejected }), sqlError('22023'));
  assert.equal(await scalar('select count(*)::int value from erp_stock.command where id=$1', [rejected]), 0);
  await post([line(f, '-999999999999.999998', 1)], { kind: 'issue' });
  assert.equal((await balances(f.product, f.warehouse)).items[0].quantity, '0.000001');
  assert.equal(await scalar('select sum(quantity)::text value from erp_stock.entry where product_id=$1', [f.product]), '0.000001');
});

test('a later-line failure rolls back earlier lines and the command ID can be retried with corrected input', async () => {
  const f = await fixture();
  // Force the failing position after the successful one in the database order.
  const [first, last] = [f.warehouse, f.destination].sort();
  const command = randomUUID();
  await assert.rejects(() => post([line(f, '1', 0, first), line(f, '-1', 0, last)], { kind: 'adjustment', command }), sqlError('22023'));
  assert.equal(await scalar('select count(*)::int value from erp_stock.balance where product_id=$1', [f.product]), 0);
  assert.equal(await scalar('select count(*)::int value from erp_stock.movement where command_id=$1', [command]), 0);
  assert.equal(await scalar('select count(*)::int value from erp_stock.command where id=$1', [command]), 0);
  const corrected = await post([line(f, '1', 0, first), line(f, '1', 0, last)], { kind: 'adjustment', command });
  assert.equal(corrected.replayed, false);
  assert.equal(corrected.movement.items.length, 2);
  assert.ok(corrected.movement.items.every(item => item.balance_after === '1.000000' && item.balance_version === 1));
});

test('another authorized actor cannot replay or take over an existing command', async () => {
  const f = await fixture(), command = randomUUID();
  const first = await post([line(f, '1')], { command });
  await assert.rejects(() => post([line(f, '1')], { command, actor: users.admin }), sqlError('40001'));
  assert.equal((await post([line(f, '1')], { command })).movement.id, first.movement.id);
  assert.equal((await balances(f.product, f.warehouse)).items[0].version, 1);
});

test('mixed-case duplicate positions cannot bypass SQL or HTTP uniqueness', async () => {
  const f = await fixture();
  const items = [line(f, '1'), { ...line(f, '1'), product_id: f.product.toUpperCase(), warehouse_id: f.warehouse.toUpperCase() }];
  await assert.rejects(() => post(items), sqlError('22023'));
  const url = new URL('https://api.example.test/v1/estoque/movimentos');
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), kind: 'receipt', occurred_on: '2024-10-15', reason: 'Entrada sintética', items }) });
  await assert.rejects(() => stockOperation(request, stockRoute(url.pathname), url.searchParams), error => error.status === 400);
});

test('reversal requires every original position exactly once and preserves conservation after recovery', async () => {
  const f = await fixture();
  await post([line(f, '1.000001')]);
  const transfer = await post([line(f, '-1.000001', 1), line(f, '1.000001', 0, f.destination)], { kind: 'transfer' });
  const good = [version(f, 2), version(f, 1, f.destination)];
  for (const versions of [[good[0]], [good[0], good[0]], [good[0], { ...good[1], expected_version: null }], [good[0], { ...good[1], product_id: randomUUID() }]]) {
    await assert.rejects(() => reverse(transfer.movement.id, versions), sqlError('22023'));
  }
  assert.equal((await balances(f.product, f.warehouse)).items[0].quantity, '0.000000');
  assert.equal((await balances(f.product, f.destination)).items[0].quantity, '1.000001');
  const reversed = await reverse(transfer.movement.id, good);
  assert.equal(reversed.movement.items.reduce((sum, item) => sum + BigInt(item.quantity.replace('.', '')), 0n), 0n);
  assert.equal((await balances(f.product, f.warehouse)).items[0].quantity, '1.000001');
  assert.equal((await balances(f.product, f.destination)).items[0].quantity, '0.000000');
  assert.equal(await scalar('select sum(quantity)::text value from erp_stock.entry where product_id=$1', [f.product]), '1.000001');
});

test('internal stock functions cannot be invoked with service_role while the allowlisted wrappers can', async () => {
  const rows = (await db.query("select p.oid::regprocedure::text signature,has_function_privilege('service_role',p.oid,'EXECUTE') executable from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_stock'")).rows;
  assert.ok(rows.length >= 4);
  assert.ok(rows.every(row => row.executable === false), JSON.stringify(rows.filter(row => row.executable)));
  for (const signature of ['public.erp_stock_post(uuid,uuid,text,date,text,jsonb,text)', 'public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)', 'public.erp_stock_balances(uuid,uuid,uuid)', 'public.erp_stock_movements(uuid,uuid,integer,uuid)']) {
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') value', [role, signature]), false);
  }
});
