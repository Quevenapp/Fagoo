import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../src/index.mjs';
import { findProductByCode, productStockLabels, quickContactPayload, quickContactRecord } from '../../../apps/erp/src/lib/document-editor-pickers.ts';
import { EMPTY_POSITION_FILTERS, positionParams, stockPositionPage } from '../../../apps/erp/src/lib/stock-positions-model.ts';

// The document editor reuses existing endpoints only. This test sends the exact requests the
// editor builds through the real Worker and migrations, so the UI contract cannot drift silently.
const MIGRATIONS = ['0001_origin_sync', '0002_origin_quotes_nfce', '0004_erp_access', '0006_erp_catalog', '0008_erp_documents', '0009_erp_stock', '0010_erp_finance', '0011_catalog_stock_lock_order', '0013_catalog_import_review', '0014_erp_cnab', '0017_document_finance', '0018_document_stock', '0023_product_details', '0025_stock_positions'];

test('editor quick contact, code/GTIN entry and picker stock use the existing HTTP contracts and database role checks', async () => {
  const db = new PGlite(), users = {};
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: '' };
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
    for (const name of MIGRATIONS) await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`, import.meta.url), 'utf8'));
    for (const role of ['admin', 'vendas', 'estoque', 'financeiro', 'consulta']) { users[role] = randomUUID(); await db.query('insert into auth.users values($1)', [users[role]]); await db.query('insert into erp_access.membership(user_id,role) values($1,$2)', [users[role], role]); }
    const rpc = async (name, args) => {
      const pairs = Object.entries(args); await db.exec('set role service_role');
      try { return (await db.query(`select public.${name}(${pairs.map(([key], index) => `${key}=>$${index + 1}`).join(',')}) as v`, pairs.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].v; }
      finally { await db.exec('reset role'); }
    };
    const handler = createHandler({ fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: users[options.headers.Authorization.replace('Bearer synthetic-', '')] }));
      const name = new URL(url).pathname.split('/').at(-1);
      try { return new Response(JSON.stringify(await rpc(name, JSON.parse(options.body)))); }
      catch (error) { return new Response(JSON.stringify({ code: error.code, message: 'private SQL details' }), { status: 400 }); }
    } });
    const call = async (path, role, { method = 'GET', body, signal } = {}) => {
      const response = await handler(new Request(`https://api.example.test${path}`, { method, signal, headers: { Authorization: `Bearer synthetic-${role}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
      return { status: response.status, data: await response.json() };
    };
    const ok = async (...args) => { const result = await call(...args); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };

    // The editor shows “Adicionar novo” only when the access summary allows writing contacts (and the role is a writer).
    const access = async role => { const data = await ok('/v1/cadastros', role); return { read: data.read, write: data.write }; };
    assert.deepEqual(await access('vendas'), { read: ['contacts', 'products'], write: ['contacts'] }, 'vendas creates contacts but does not read depósitos');
    assert.deepEqual(await access('estoque'), { read: ['contacts', 'products', 'warehouses'], write: ['products', 'warehouses'] });
    assert.deepEqual((await access('consulta')).write, []);
    assert.deepEqual((await access('financeiro')).write, ['contacts']);

    // Contato rápido: vendas creates a customer with command replay and a fresh read.
    const values = { name: 'Cliente rápido sintético', person_type: 'F', document: '529.982.247-25', phone: '(11) 0000-0000', mobile: '', email: 'cliente@example.invalid', roles: ['customer'] };
    const body = { ...quickContactPayload('sales_orders', values), command_id: randomUUID() };
    const created = quickContactRecord(await ok('/v1/cadastros/contacts', 'vendas', { method: 'POST', body }));
    assert.equal(created.active, true); assert.deepEqual(created.roles, ['customer']); assert.equal(created.document, '529.982.247-25');
    const replay = await ok('/v1/cadastros/contacts', 'vendas', { method: 'POST', body }); assert.equal(replay.replayed, true); assert.equal(replay.record.id, created.id);
    assert.equal(quickContactRecord(await ok(`/v1/cadastros/contacts/${created.id}`, 'vendas'), created.id).name, 'Cliente rápido sintético');
    const search = await ok('/v1/cadastros/contacts?limit=25&active=true&q=529.982.247-25', 'vendas'); assert.deepEqual(search.items.map(item => item.id), [created.id]);
    // estoque writes purchase orders but not contacts: the editor hides the form and the database refuses it.
    const supplier = { ...quickContactPayload('purchase_orders', { ...values, name: 'Fornecedor sintético', document: '11.222.333/0001-81', person_type: 'J', roles: ['supplier'] }), command_id: randomUUID() };
    assert.equal((await call('/v1/cadastros/contacts', 'estoque', { method: 'POST', body: supplier })).status, 403);
    assert.equal((await call('/v1/cadastros/contacts', 'consulta', { method: 'POST', body: { ...supplier, command_id: randomUUID() } })).status, 403);
    assert.equal((await call('/v1/cadastros/contacts', 'vendas', { method: 'POST', body: { ...body, command_id: randomUUID(), data: { ...body.data, roles: ['customer', 'admin'] } } })).status, 400, 'roles outside the catalog contract are refused');
    assert.deepEqual((await ok('/v1/cadastros/contacts', 'admin', { method: 'POST', body: supplier })).record.roles, ['supplier']);

    // Code/GTIN entry reads the existing product search, including inactive products only to explain them.
    const product = async data => (await ok('/v1/cadastros/products', 'admin', { method: 'POST', body: { command_id: randomUUID(), data: { unit: 'UN', kind: 'P', format: 'S', ...data } } })).record;
    const scanned = await product({ name: 'Produto lido sintético', code: 'LIDO-1', gtin: '7890000000017', price: '2.5' });
    await product({ name: 'Produto parecido sintético', code: 'LIDO-10' });
    const old = await product({ name: 'Produto antigo sintético', code: 'VELHO-1' });
    await ok(`/v1/cadastros/products/${old.id}/active`, 'admin', { method: 'PATCH', body: { command_id: randomUUID(), expected_version: 1, active: false } });
    const lookup = code => findProductByCode(async (path, options) => { const result = await call(path, 'vendas', options); if (result.status !== 200) throw Object.assign(new Error('HTTP'), { status: result.status }); return result.data; }, code, new AbortController().signal);
    for (const code of ['7890000000017', 'lido-1', ' LIDO-1 ']) { const outcome = await lookup(code); assert.equal(outcome.kind, 'add', code); assert.equal(outcome.row.id, scanned.id); assert.equal(outcome.row.price, '2.5000'); }
    assert.equal((await lookup('VELHO-1')).kind, 'inactive');
    assert.equal((await lookup('LIDO')).kind, 'missing', 'a partial code is never guessed');
    assert.equal((await lookup('NADA-999')).kind, 'missing');

    // Picker stock: same text and active filter as the product search; absence of entries is not zero.
    const warehouse = (await ok('/v1/cadastros/warehouses', 'admin', { method: 'POST', body: { command_id: randomUUID(), data: { name: 'Depósito sintético' } } })).record;
    const positions = async (filters, role = 'vendas') => { const result = await call(`/v1/posicoes-estoque?${positionParams(filters)}`, role); return result.status === 200 ? productStockLabels(stockPositionPage(result.data, filters)) : result.status; };
    const all = { ...EMPTY_POSITION_FILTERS, q: 'LIDO', active: 'true' }, scoped = { ...all, warehouse_id: warehouse.id };
    assert.equal((await positions(all)).get(scanned.id), 'Estoque total: sem lançamentos');
    assert.equal((await positions(scoped)).get(scanned.id), 'Estoque: sem lançamentos');
    await rpc('erp_stock_post', { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: '2026-10-19', p_reason: 'Entrada sintética', p_items: [{ product_id: scanned.id, warehouse_id: warehouse.id, quantity: '3.5', expected_version: 0 }] });
    assert.equal((await positions(scoped)).get(scanned.id), 'Estoque: 3,5 UN');
    const listed = await ok('/v1/cadastros/products?limit=25&active=true&q=LIDO', 'vendas'), labels = await positions(scoped);
    assert.ok(listed.items.every(item => labels.has(item.id)), 'the stock page covers every product option of the same search');
    assert.equal(await positions(scoped, 'financeiro'), 403, 'roles without stock read get no balance, as the editor hides it');
  } finally { await db.close(); }
});
