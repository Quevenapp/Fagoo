import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../src/index.mjs';

// 202610200104 (configurações por usuário da listagem) on PGlite, through the real Worker. Synthetic data only.
let db, handler;
const admin = randomUUID(), viewer = randomUUID(), seller = randomUUID(), stock = randomUUID();
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].v;
const migration = async name => db.exec(await readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
async function rpc(name, args) { const fields = Object.entries(args); await db.exec('set role service_role'); try { return await scalar(`select public.${name}(${fields.map(([k], i) => `${k}=>$${i + 1}${Array.isArray(args[k]) ? '::text[]' : ''}`).join(',')})v`, fields.map(([, v]) => Array.isArray(v) ? `{${v.join(',')}}` : v && typeof v === 'object' ? JSON.stringify(v) : v)); } finally { await db.exec('reset role'); } }
async function call(path, method = 'GET', body, user = admin) { const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return { status: response.status, value: await response.json() }; }
const view = (kind, user) => call(`/v1/documentos/${kind}/preferencias-listagem`, 'GET', undefined, user);
const save = (kind, body, user) => call(`/v1/documentos/${kind}/preferencias-listagem`, 'POST', { command_id: randomUUID(), expected_version: 0, custom_view: false, columns: [], default_statuses: [], ...body }, user);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  for (const suffix of ['0001_origin_sync', '0002_origin_quotes_nfce', '0004_erp_access', '0006_erp_catalog', '0008_erp_documents', '0009_erp_stock', '0010_erp_finance', '0011_catalog_stock_lock_order', '0013_catalog_import_review', '0014_erp_cnab', '0017_document_finance', '0018_document_stock', '0019_document_effect_flags']) await migration(`20261016${suffix}`);
  await migration('202610200104_document_list_view');
  for (const [id, role] of [[admin, 'admin'], [viewer, 'consulta'], [seller, 'vendas'], [stock, 'estoque']]) { await db.query('insert into auth.users values($1)', [id]); await db.query('insert into erp_access.membership(user_id,role)values($1,$2)', [id, role]); }
  handler = createHandler({ fetchImpl: async (url, options) => { if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) }); try { const body = JSON.parse(options.body); return Response.json(await rpc(new URL(url).pathname.split('/').at(-1), body)); } catch (e) { return Response.json({ code: e.code, message: 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); } } });
});
after(() => db?.close());

test('104 grants and the Origin defaults: Em aberto (propostas group the open ones) and the standard columns', async () => {
  for (const fn of ['public.erp_document_list_view_get(uuid,text)', 'public.erp_document_list_view_save(uuid,text,integer,uuid,boolean,text[],text[])']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false);
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
    assert.equal(await scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
  }
  assert.equal(await scalar("select has_table_privilege('service_role','erp_documents.list_view','SELECT') v"), false);
  assert.equal(await scalar("select relrowsecurity v from pg_class where oid='erp_documents.list_view'::regclass"), true);
  const orders = (await view('sales_orders')).value;
  assert.deepEqual([orders.custom_view, orders.columns, orders.default_statuses, orders.statuses_saved, orders.version, orders.column_limit], [false, ['date', 'contact', 'total'], ['draft', 'open'], false, 0, 8], 'pedidos: Em aberto also shows Em digitação, where a new Brufap order starts');
  assert.deepEqual(orders.available_columns, ['date', 'contact', 'total', 'customer_po_number', 'address', 'ship_date', 'contact_email', 'contact_phone', 'contact_document', 'carrier_name']);
  assert.deepEqual((await view('sales_proposals')).value.default_statuses, ['draft', 'open', 'pending', 'waiting']);
  assert.deepEqual((await view('service_orders')).value.columns, []);
  assert.equal((await view('purchase_orders')).status, 404, 'compras keep their own list');
  assert.equal((await view('sales_proposals', stock)).status, 403, 'estoque does not read proposals');
});

test('each user saves their own Tornar padrão and columns with CAS and the same command on retry', async () => {
  const body = { command_id: randomUUID(), expected_version: 0, custom_view: true, columns: ['date', 'contact', 'customer_po_number', 'total'], default_statuses: ['open', 'in_progress'] };
  const first = await call('/v1/documentos/sales_orders/preferencias-listagem', 'POST', body, seller);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.deepEqual([first.value.version, first.value.custom_view, first.value.columns, first.value.default_statuses, first.value.statuses_saved, first.value.replayed], [1, true, body.columns, body.default_statuses, true, false]);
  const replay = await call('/v1/documentos/sales_orders/preferencias-listagem', 'POST', body, seller);
  assert.equal(replay.value.replayed, true); assert.equal(replay.value.version, 1);
  assert.equal((await call('/v1/documentos/sales_orders/preferencias-listagem', 'POST', { ...body, columns: ['date'] }, seller)).status, 409, 'same command, other body');
  assert.equal((await save('sales_orders', { expected_version: 0, default_statuses: ['open'] }, seller)).status, 409, 'stale version');
  const second = await save('sales_orders', { expected_version: 1, default_statuses: [] }, seller);
  assert.deepEqual([second.value.version, second.value.default_statuses, second.value.statuses_saved, second.value.custom_view], [2, [], true, false], 'an empty selection is a saved "Todas"');
  assert.deepEqual((await view('sales_orders', admin)).value.default_statuses, ['draft', 'open'], 'another user keeps the Origin default');
  assert.equal((await save('service_orders', { default_statuses: ['quoted'] }, viewer)).status, 200, 'consulta keeps its own settings too');
});

test('invalid settings are refused by the Worker and by the database', async () => {
  for (const body of [{ columns: ['unknown'] }, { columns: ['date', 'date'] }, { custom_view: true, columns: [] }, { columns: Array(9).fill('date') }, { default_statuses: ['fulfilled', 'fulfilled'] }, { default_statuses: ['approved'] }, { custom_view: 'sim' }, { expected_version: -1 }, { extra: 1 }])
    assert.equal((await save('sales_orders', body)).status, 400, JSON.stringify(body));
  assert.equal((await save('sales_proposals', { custom_view: true, columns: ['date'] })).status, 400, 'propostas have no custom list');
  await assert.rejects(() => rpc('erp_document_list_view_save', { p_user_id: admin, p_kind: 'sales_orders', p_expected_version: 0, p_command_id: randomUUID(), p_custom_view: false, p_columns: ['date', 'secret'], p_default_statuses: ['open'] }), error => error.code === '22023');
  assert.equal((await call('/v1/documentos/sales_orders/preferencias-listagem?x=1')).status, 400);
});
