import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

let db, grantsBefore;
const user = randomUUID();
const stockUser = randomUUID();
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const errorIs = code => error => error.code === code;
const signature = 'public.erp_catalog_import_origin(uuid,text,jsonb,uuid,boolean)';
const grants = () => scalar("select proacl::text value from pg_proc where oid=$1::regprocedure", [signature]);
const importRows = (items, { dry = false, command = randomUUID(), actor = user, entity = 'products' } = {}) => scalar(
  'select public.erp_catalog_import_origin($1::uuid,$2,$3::jsonb,$4::uuid,$5) value',
  [actor, entity, JSON.stringify(items), command, dry],
);
const get = id => scalar("select public.erp_catalog_get($1::uuid,'products',$2::uuid) value", [user, id]);
const payload = name => ({ nome: name, codigo: name, situacao: 'A', tipo: 'P', formato: 'S', unidade: 'UN', preco: '10.0000' });
async function seed(id, data, entity = 'products') {
  const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  await db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)
    values($1,'lock_order_test',$2,$3::jsonb,$4) on conflict(entity,source_id) do update
    set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1`,
  [entity, id, JSON.stringify(data), hash]);
  return { source_id: id, source_hash: hash };
}
async function stockedProduct() {
  const sourceId = randomUUID(), original = payload(`Fictício ${sourceId}`);
  const source = await seed(sourceId, original);
  const applied = await importRows([source]);
  const id = applied.items[0].record_id;
  const warehouse = (await scalar("select public.erp_catalog_save($1::uuid,'warehouses',null,0,$2::uuid,$3::jsonb) value", [user, randomUUID(), JSON.stringify({ name: 'Depósito fictício' })])).record.id;
  await scalar("select public.erp_stock_post($1::uuid,$2::uuid,'receipt','2024-10-15'::date,'Entrada fictícia',$3::jsonb,null) value", [stockUser, randomUUID(), JSON.stringify([{ product_id: id, warehouse_id: warehouse, quantity: '12.345678', expected_version: 0 }])]);
  return { id, sourceId, original, source, warehouse };
}
before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
  for (const suffix of ['0001_origin_sync', '0002_origin_quotes_nfce', '0004_erp_access', '0005_origin_auxiliary_catalogs', '0006_erp_catalog', '0009_erp_stock']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`, import.meta.url), 'utf8'));
  }
  grantsBefore = await grants();
  await db.exec(await readFile(new URL('../../supabase/migrations/202610160011_catalog_stock_lock_order.sql', import.meta.url), 'utf8'));
  await db.query('insert into auth.users values($1),($2)', [user, stockUser]);
  await db.query("insert into erp_access.membership(user_id,role) values($1,'admin'),($2,'estoque')", [user, stockUser]);
  await db.exec("insert into origin_sync.resource_state(resource) values('lock_order_test')");
});
after(async () => db?.close());

test('replacement preserves service-only grants and places the ordered prelock before every source action', async () => {
  assert.equal(await grants(), grantsBefore);
  const sql = await scalar('select pg_get_functiondef($1::regprocedure) value', [signature]);
  const lock = sql.indexOf('perform r.id');
  const sourceLoop = sql.indexOf('for v_item in select value');
  assert.ok(lock > sql.indexOf('if not p_dry_run then') && lock < sourceLoop);
  assert.match(sql.slice(lock, sourceLoop), /order by r\.id\s+for update of r;\s+end if;/);
  assert.equal((sql.match(/for update/gi) || []).length, 1, 'No additional per-source lock may restore input-order locking');
  for (const role of ['anon', 'authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') value', [role, signature]), false);
  assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
  // Structural guard only: PGlite is a single-session engine. A two-connection
  // PostgreSQL stress run remains separate from these deterministic SQL tests.
});

test('dry run over an existing imported product works in a read-only transaction and writes nothing', async () => {
  const f = await stockedProduct();
  const changed = await seed(f.sourceId, { ...f.original, unidade: 'KG' });
  const before = await scalar('select count(*)::int value from erp_catalog.source_snapshot');
  await db.exec('begin read only');
  try {
    const result = await importRows([changed], { dry: true });
    assert.equal(result.items[0].action, 'pending_human_review');
    assert.equal(result.operational_effects, false);
  } finally { await db.exec('rollback'); }
  assert.equal(await scalar('select count(*)::int value from erp_catalog.source_snapshot'), before);
  assert.equal((await get(f.id)).record.unit, 'UN');
  assert.equal((await get(f.id)).record.source.latest_hash, f.source.source_hash);
});

test('unit/type change with stock becomes a preserved candidate without aborting unaffected rows', async () => {
  const f = await stockedProduct();
  const otherId = randomUUID();
  const other = await seed(otherId, payload('Outro produto fictício'));
  const otherRecord = (await importRows([other])).items[0].record_id;
  const changed = await seed(f.sourceId, { ...f.original, nome: 'Nome candidato', unidade: 'KG', preco: '20.0000' });
  const otherChanged = await seed(otherId, { ...payload('Outro produto fictício'), unidade: 'CX', preco: '22.0000' });
  const command = randomUUID();
  const applied = await importRows([otherChanged, changed], { command });
  assert.deepEqual(applied.items.map(item => item.action), ['update', 'pending_human_review']);
  const record = (await get(f.id)).record;
  assert.equal(record.unit, 'UN');
  assert.equal(record.name, f.original.nome);
  assert.equal(record.price, '10.0000');
  assert.equal(record.source.applied_hash, f.source.source_hash);
  assert.equal(record.source.latest_hash, changed.source_hash);
  assert.equal(record.source.state, 'source_changed');
  assert.equal(record.source.candidate, undefined, 'Candidates stay private');
  const candidate = await scalar('select candidate value from erp_catalog.origin where record_id=$1', [f.id]);
  assert.equal(candidate.data.unit, 'KG');
  assert.equal(candidate.data.name, 'Nome candidato');
  assert.equal((await get(otherRecord)).record.unit, 'CX');
  assert.equal((await get(otherRecord)).record.price, '22.0000');
  assert.equal((await importRows([otherChanged, changed], { command })).replayed, true);
  assert.equal(await scalar('select quantity::text value from erp_stock.balance where product_id=$1', [f.id]), '12.345678');
  for (const kind of ['S', 'N', null]) {
    const changedKind = await seed(f.sourceId, { ...f.original, tipo: kind });
    assert.equal((await importRows([changedKind])).items[0].action, 'pending_human_review');
    assert.equal((await get(f.id)).record.kind, 'P');
  }
  const validChange = await seed(f.sourceId, { ...f.original, preco: '15.0000' });
  assert.equal((await importRows([validChange])).items[0].action, 'update');
  assert.equal((await get(f.id)).record.price, '15.0000');
  assert.equal(await scalar('select candidate value from erp_catalog.origin where record_id=$1', [f.id]), null);
});

test('freshness conflict remains atomic, command replay remains actor-bound and import stays admin-only', async () => {
  const oneId = randomUUID(), twoId = randomUUID();
  const one = await seed(oneId, payload('Primeiro fictício'));
  const two = await seed(twoId, payload('Segundo fictício'));
  const first = await importRows([one, two]);
  const changed = await seed(oneId, { ...payload('Primeiro fictício'), preco: '15.0000' });
  const command = randomUUID();
  await assert.rejects(() => importRows([changed, { ...two, source_hash: '0'.repeat(64) }], { command }), errorIs('40001'));
  assert.equal((await get(first.items[0].record_id)).record.price, '10.0000');
  assert.equal(await scalar('select count(*)::int value from erp_catalog.command where command_id=$1', [command]), 0);
  assert.equal((await importRows([changed, two], { command })).replayed, false);
  await assert.rejects(() => importRows([changed, two], { actor: stockUser, command }), errorIs('42501'));
  await db.query('update erp_access.membership set active=false where user_id=$1', [user]);
  try { await assert.rejects(() => importRows([changed, two], { command }), errorIs('42501')); }
  finally { await db.query('update erp_access.membership set active=true where user_id=$1', [user]); }
});
