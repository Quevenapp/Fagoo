import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { bootstrap } from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import { produtosEFixture, fails, migrationSql, productionMigrations } from './helpers/produtos-e-fixture.mjs';

// SQL of the produtos lane, wave E, part 1 (migration 234): the "Componente" filter of the Tipo "Produtos com composição", the
// export with the stock of the default warehouse and the list stock without the warehouses whose balance is disregarded.
// PGlite with every migration up to 233 (production) plus this lane. Synthetic data only.
const NEW = ['public.erp_catalog_product_page_v3(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,jsonb,uuid)',
  'public.erp_catalog_product_export_v2(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean,uuid)',
  'public.erp_catalog_product_export(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean)'];
const page = (f, args = {}, user = f.users.admin) => f.rpc('erp_catalog_product_page_v3', { p_user_id: user, p_page: 1, p_size: 100, p_situation: 'latest', ...args });
const pageV2 = (f, args = {}, user = f.users.admin) => f.rpc('erp_catalog_product_page_v2', { p_user_id: user, p_page: 1, p_size: 100, p_situation: 'latest', ...args });
const exportV2 = (f, args = {}, user = f.users.admin) => f.rpc('erp_catalog_product_export_v2', { p_user_id: user, p_offset: 0, p_limit: 250, ...args });
const names = result => result.items.map(item => item.name).sort();

test('234 functions are SECURITY DEFINER with a fixed search_path and run only for service_role', async () => {
  const f = await produtosEFixture();
  try {
    for (const signature of NEW) {
      for (const role of ['public', 'anon', 'authenticated']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`, [signature]), false, `${role} ${signature}`);
      assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true);
      assert.deepEqual(await f.scalar('select jsonb_build_object(\'definer\',prosecdef,\'config\',proconfig) v from pg_proc where oid=$1::regprocedure', [signature]), { definer: true, config: ['search_path=pg_catalog'] });
    }
    for (const internal of ['erp_catalog.product_component_filter(uuid)', 'erp_catalog.product_component_valid(text,uuid)', 'erp_catalog.stock_summary(uuid[],uuid)'])
      assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [internal]), false, internal);
    await fails(assert, page(f, {}, f.users.financeiro), '42501');
  } finally { await f.close(); }
});

test('234 refuses to replace a function whose published body changed', async () => {
  const db = new PGlite();
  try {
    await db.exec(bootstrap);
    await db.exec("alter table auth.users add column email text,add column created_at timestamptz not null default clock_timestamp(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean not null default false;"
      + "create table auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz,updated_at timestamptz,refreshed_at timestamp,user_agent text,ip inet,aal text,not_after timestamptz);"
      + "create table auth.mfa_factors(id uuid primary key,user_id uuid not null,friendly_name text,factor_type text,status text,created_at timestamptz,updated_at timestamptz,secret text);"
      + "create table auth.mfa_challenges(id uuid primary key,factor_id uuid not null,created_at timestamptz,verified_at timestamptz,ip_address inet,otp_code text);");
    for (const name of await productionMigrations()) await db.exec(await migrationSql(name));
    await db.exec("create or replace function erp_catalog.stock_summary(p_ids uuid[],p_warehouse_id uuid) returns table(product_id uuid,state text,quantity numeric,warehouse_state text,warehouse_quantity numeric) language sql stable set search_path=pg_catalog as $$ select null::uuid,null,null::numeric,null,null::numeric where false $$");
    await assert.rejects(db.exec(await migrationSql('202610200234_product_list_component_stock.sql')), /product_list_234_previous_definition_changed/);
  } finally { await db.close(); }
});

test('234 Componente: the compositions whose current structure uses the product, only with the Tipo "Produtos com composição"', async () => {
  const f = await produtosEFixture();
  try {
    const a = await f.product({ name: 'Parafuso sintético', price: '1' }), b = await f.product({ name: 'Porca sintética', price: '2' }), lone = await f.product({ name: 'Arruela sintética' });
    const k1 = (await f.compose(null, [[a, '2']], { data: { name: 'Kit A sintético' } })).record, k2 = (await f.compose(null, [[b, '1']], { data: { name: 'Kit B sintético' } })).record;
    const k3 = (await f.compose(null, [[a, '1'], [b, '3']], { data: { name: 'Kit AB sintético' } })).record;
    assert.deepEqual(names(await page(f, { p_product_type: 'composition', p_component_id: a.id })), ['Kit A sintético', 'Kit AB sintético']);
    assert.deepEqual(names(await page(f, { p_product_type: 'composition', p_component_id: b.id })), ['Kit AB sintético', 'Kit B sintético']);
    assert.deepEqual(names(await page(f, { p_product_type: 'composition', p_component_id: lone.id })), []);
    // Without the Componente the v3 page is the v2 page; with the Tipo of a composition only the kits come back.
    assert.deepEqual(await page(f, { p_product_type: 'composition' }), await pageV2(f, { p_product_type: 'composition' }));
    assert.equal((await page(f, { p_product_type: 'composition' })).total, 3);
    // A new structure version replaces the old one: K1 stops using A.
    await f.compose(k1.id, [[b, '2']]);
    assert.deepEqual(names(await page(f, { p_product_type: 'composition', p_component_id: a.id })), ['Kit AB sintético']);
    // Refused: Componente without the Tipo, with another Tipo, or an id that is not a product.
    await fails(assert, page(f, { p_component_id: a.id }), '22023');
    await fails(assert, page(f, { p_product_type: 'simple', p_component_id: a.id }), '22023');
    await fails(assert, page(f, { p_product_type: 'composition', p_component_id: randomUUID() }), '22023');
    // Combined with the search and with the Campos customizados filter of 191.
    assert.deepEqual(names(await page(f, { p_product_type: 'composition', p_component_id: b.id, p_query: 'AB' })), ['Kit AB sintético']);
    const field = (await f.rpc('erp_catalog_custom_field_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { field_type: 'text', name: 'Linha sintética' } })).field;
    await f.productSave({ custom_values: { [field.id]: 'Premium' } }, { id: k2.id, version: await f.version(k2.id) });
    assert.deepEqual(names(await page(f, { p_product_type: 'composition', p_component_id: b.id, p_custom: [{ field_id: field.id, value: 'premium' }] })), ['Kit B sintético']);
    // The export and the "Produtos filtrados" of the price adjust take the same Componente.
    assert.deepEqual(names(await exportV2(f, { p_product_type: 'composition', p_component_id: b.id })), ['Kit A sintético', 'Kit AB sintético', 'Kit B sintético']);
    await fails(assert, exportV2(f, { p_component_id: b.id }), '22023');
    const adjusted = await f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_rule: { action: 'fix', unit: 'amount', value: '50' }, p_items: null,
      p_filters: { situation: 'latest', product_type: 'composition', component_id: a.id } });
    assert.deepEqual([adjusted.total, adjusted.applied], [1, 1]);
    assert.equal(await f.scalar('select price=50 v from erp_catalog.product where record_id=$1', [k3.id]), true);
    await fails(assert, f.rpc('erp_catalog_product_price_adjust', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_rule: { action: 'fix', unit: 'amount', value: '50' }, p_items: null,
      p_filters: { situation: 'latest', component_id: a.id } }), '22023');
  } finally { await f.close(); }
});

test('234 list stock: a warehouse with "Desconsiderar saldo deste depósito" stays out of the total, not out of its own column', async () => {
  const f = await produtosEFixture();
  try {
    const main = await f.warehouse('Principal sintético'), ignored = await f.warehouse('Desconsiderado sintético', true);
    const both = await f.product({ name: 'Nos dois sintético' }), onlyIgnored = await f.product({ name: 'Só desconsiderado sintético' }), none = await f.product({ name: 'Sem lançamento sintético' });
    await f.launch(both.id, main.id, 'receipt', '5'); await f.launch(both.id, ignored.id, 'receipt', '7'); await f.launch(onlyIgnored.id, ignored.id, 'receipt', '3');
    const stock = async (args = {}) => Object.fromEntries((await pageV2(f, args)).items.map(item => [item.name, item.stock]));
    const all = await stock();
    assert.deepEqual(all['Nos dois sintético'], { state: 'recorded', quantity: '5.000000', warehouse: null });
    assert.deepEqual(all['Só desconsiderado sintético'], { state: 'recorded', quantity: '0.000000', warehouse: null }, 'positions only in a disregarded warehouse total zero');
    assert.deepEqual(all['Sem lançamento sintético'], { state: 'no_movements', quantity: null, warehouse: null });
    const selected = await stock({ p_warehouse_id: ignored.id });
    assert.deepEqual(selected['Nos dois sintético'].warehouse, { id: ignored.id, state: 'recorded', quantity: '7.000000' }, 'the chosen warehouse keeps its own balance');
    // The Estoque filter follows the same total.
    assert.deepEqual(names(await pageV2(f, { p_stock: 'positive' })), ['Nos dois sintético']);
    assert.deepEqual(names(await pageV2(f, { p_stock: 'zero' })), ['Só desconsiderado sintético']);
    assert.deepEqual(names(await pageV2(f, { p_stock: 'positive', p_warehouse_id: ignored.id })), ['Nos dois sintético', 'Só desconsiderado sintético']);
    assert.ok(none);
  } finally { await f.close(); }
});

test('234 export: the stock of the default warehouse, or the considered warehouses without one; the 120 export answers the same', async () => {
  const f = await produtosEFixture();
  try {
    const main = await f.warehouse('Principal sintético'), other = await f.warehouse('Filial sintética'), ignored = await f.warehouse('Desconsiderado sintético', true);
    const item = await f.product({ name: 'Exportado sintético' });
    await f.launch(item.id, main.id, 'receipt', '5'); await f.launch(item.id, other.id, 'receipt', '2'); await f.launch(item.id, ignored.id, 'receipt', '9');
    const without = await exportV2(f);
    assert.deepEqual([without.stock_scope, without.stock_warehouse, without.items[0].stock], ['considered_warehouses', null, '7.000000']);
    await f.setDefault(other.id);
    const withDefault = await exportV2(f);
    assert.deepEqual([withDefault.stock_scope, withDefault.stock_warehouse, withDefault.items[0].stock], ['default_warehouse', { id: other.id, name: 'Filial sintética' }, '2.000000']);
    // The 120 signature (the Worker before 234 and every export without Componente) answers through the v2.
    const old = await f.rpc('erp_catalog_product_export', { p_user_id: f.users.admin, p_offset: 0, p_limit: 250 });
    assert.deepEqual(old, withDefault);
    // A default warehouse without a position of the product exports no stock (as "sem lançamentos").
    await f.setDefault(ignored.id);
    assert.equal((await exportV2(f)).items[0].stock, '9.000000', 'the default warehouse is exported even when its balance is disregarded in the totals');
    const empty = await f.warehouse('Vazio sintético'); await f.setDefault(empty.id);
    assert.equal((await exportV2(f)).items[0].stock, null);
    // Every profile that reads products also reads the stock (009), so each one gets the same answer.
    assert.deepEqual(await exportV2(f, {}, f.users.vendas), await exportV2(f));
  } finally { await f.close(); }
});
