import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 094: Origin-style numbered title page, vencimento order, filters and totals of the whole filtered set.
let db; const users = {}; const titles = {}; let origin; let category;
const code = expected => error => error.code === expected;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const literal = value => Array.isArray(value) ? `{${value.join(',')}}` : value && typeof value === 'object' ? JSON.stringify(value) : value;
async function rpc(name, args) {
  const pairs = Object.entries(args); await db.exec('SET ROLE service_role');
  try { return await scalar(`SELECT public.${name}(${pairs.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) AS value`, pairs.map(([, value]) => literal(value))); }
  finally { await db.exec('RESET ROLE'); }
}
const execute = (action, data, user = users.financeiro) => rpc('erp_finance_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: action, p_data: data });
const page = (args = {}, user = users.consulta) => rpc('erp_finance_title_page', { p_user_id: user, p_kind: 'receivable', p_limit: 100, ...args });
const descriptions = result => result.items.map(item => item.description);
async function contact(data) { return (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { roles: ['customer', 'supplier'], ...data } })).record; }
async function create(key, contactId, description, issued, parts, extra = {}, kind = 'receivable') {
  const total = parts.reduce((sum, [amount]) => sum + BigInt(amount), 0n).toString();
  const result = await execute('title_create_group', { kind, contact_id: contactId, description, issued_on: issued, total_cents: total, installments: parts.map(([amount_cents, due_on]) => ({ amount_cents, due_on })), ...extra });
  titles[key] = result.items; return result.items;
}

before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name)); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  for (const file of ['202610160001_origin_sync.sql', '202610160002_origin_quotes_nfce.sql', '202610160004_erp_access.sql', '202610160006_erp_catalog.sql', '202610160008_erp_documents.sql', '202610160009_erp_stock.sql', '202610160010_erp_finance.sql', '202610160011_catalog_stock_lock_order.sql', '202610160014_erp_cnab.sql', '202610160017_document_finance.sql', '202610160018_document_stock.sql', '202610160019_document_effect_flags.sql', '202610190094_finance_title_list_parity.sql'])
    await db.exec(await readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  for (const role of ['admin', 'financeiro', 'consulta', 'vendas', 'estoque', 'fiscal', 'inactive']) {
    users[role] = randomUUID(); await db.query('INSERT INTO auth.users(id) VALUES($1)', [users[role]]);
    await db.query('INSERT INTO erp_access.membership(user_id,role,active) VALUES($1,$2,$3)', [users[role], role === 'inactive' ? 'admin' : role, role !== 'inactive']);
  }
  const alfa = await contact({ name: 'Alfa Comércio Sintético', trade_name: 'Fantasia Alfa', document: '12.345.678/0001-90', email: 'cobranca@alfa.example' });
  const beta = await contact({ name: 'Beta Serviços Sintéticos', document: '98765432100', email: 'beta@example.test' });
  const gama = await contact({ name: 'Gama Fornecedor Sintético' });
  category = (await execute('category_save', { expected_version: 0, name: 'Categoria sintética', kind: 'receivable' })).record;
  const account = (await execute('account_save', { expected_version: 0, name: 'Conta sintética', kind: 'bank' })).record;
  await create('t1', alfa.id, 'Mensalidade alfa', '2020-01-01', [['10000', '2020-02-10']], { source_reference: 'NF 1001' });
  await create('t2', alfa.id, 'Parcelado alfa', '2020-01-01', [['3000', '2020-02-10'], ['3000', '2020-03-10']]);
  await create('t3', beta.id, 'Serviço beta', '2020-01-15', [['5000', '2099-01-10']], { category_id: category.id });
  await create('t4', beta.id, 'Quitado beta', '2020-01-01', [['2500', '2020-04-01']]);
  await create('t5', alfa.id, 'Cancelado alfa', '2020-01-01', [['700', '2099-02-01']]);
  await create('t6', beta.id, 'Estornado beta', '2020-01-01', [['1200', '2020-05-01']]);
  await create('p1', gama.id, 'Fornecedor gama', '2020-01-01', [['900', '2020-02-10']], {}, 'payable');
  await execute('settle', { id: titles.t3[0].id, expected_version: 1, account_id: account.id, posted_on: '2020-03-10', principal_cents: '2000' });
  await execute('settle', { id: titles.t4[0].id, expected_version: 1, account_id: account.id, posted_on: '2020-04-02', principal_cents: '2500' });
  await execute('title_cancel', { id: titles.t5[0].id, expected_version: 1, note: 'Cancelamento sintético' });
  const paid = await execute('settle', { id: titles.t6[0].id, expected_version: 1, account_id: account.id, posted_on: '2020-05-05', principal_cents: '1200' });
  await execute('reverse', { id: titles.t6[0].id, expected_version: 2, settlement_id: paid.settlement.id, posted_on: '2020-05-06', note: 'Estorno sintético' });
  // A sales order whose receivable comes from the document finance posting (017), so the title has an origin.
  const body = { date: '2026-10-16', contact_id: alfa.id, items: [{ description: 'Linha sintética', unit: 'UN', quantity: '1', unit_price: '40', discount_percent: '0' }], installments: [{ due_date: '2099-03-01', amount: '40.00' }] };
  let document = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  for (const status of ['open', 'verified']) document = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: document.id, p_expected_version: document.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
  const preview = await rpc('erp_document_finance_preview', scope);
  const posted = await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  origin = { document_id: document.id, kind: 'sales_orders', number: String(document.number) };
  assert.ok(posted);
  titles.d1 = [await scalar("SELECT erp_finance.dto('titles',l.title_id) AS value FROM erp_finance.document_title l JOIN erp_finance.document_posting p ON p.id=l.posting_id WHERE p.document_id=$1", [document.id])];
});
after(async () => db?.close());

test('094 is a service-only security definer read; roles are rechecked in SQL and nothing is written', async () => {
  const fn = (await db.query("SELECT p.prosecdef,p.proconfig,p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erp_finance_title_page'")).rows;
  assert.equal(fn.length, 1); assert.equal(fn[0].prosecdef, true); assert.deepEqual(fn[0].proconfig, ['search_path=pg_catalog']); assert.equal(fn[0].provolatile, 's');
  const signature = 'public.erp_finance_title_page(uuid,text,integer,integer,text,text,text[],text,date,date,text,bigint,bigint,text)';
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, signature]), false);
    assert.equal(await scalar("SELECT has_function_privilege($1,'public.erp_finance_get(uuid,text,uuid)','EXECUTE') AS value", [role]), false);
  }
  assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($1,'erp_finance.title_origin(uuid)','EXECUTE') AS value", [role]), false);
  for (const role of ['admin', 'financeiro', 'consulta']) assert.equal((await page({}, users[role])).total, 8);
  for (const role of ['vendas', 'estoque', 'fiscal', 'inactive']) await assert.rejects(() => page({}, users[role]), code('42501'));
  await assert.rejects(() => page({}, randomUUID()), code('42501'));
  const before = await scalar('SELECT (SELECT count(*) FROM erp_finance.command)+(SELECT count(*) FROM erp_finance.audit) AS value');
  await page({ p_query: 'alfa', p_statuses: ['open'] });
  assert.equal(await scalar('SELECT (SELECT count(*) FROM erp_finance.command)+(SELECT count(*) FROM erp_finance.audit) AS value'), before);
});

test('094 orders by vencimento with a stable id tiebreak, pages by number and totals the whole filtered set in exact cents', async () => {
  const all = await page();
  assert.deepEqual(descriptions(all).slice(0, 2).sort(), ['Mensalidade alfa', 'Parcelado alfa']);
  assert.deepEqual(descriptions(all).slice(2, 7), ['Parcelado alfa', 'Quitado beta', 'Estornado beta', 'Serviço beta', 'Cancelado alfa']);
  assert.equal(all.items[7].id, titles.d1[0].id);
  const tied = all.items.slice(0, 2).map(item => item.id); assert.deepEqual(tied, [...tied].sort(), 'same vencimento falls back to the id');
  assert.deepEqual(all.totals, { count: 8, amount_cents: '29400', balance_cents: '24200' }); assert.equal(all.total, 8);
  assert.deepEqual([all.page, all.limit, all.order, all.kind, all.entity, all.data_mode], [1, 100, 'due_asc', 'receivable', 'titles', 'erp_native']);
  const keys = all.items.map(item => `${item.due_on}:${item.id}`); assert.deepEqual(keys, [...keys].sort());
  const reverse = await page({ p_order: 'due_desc' }); assert.deepEqual(reverse.items.map(item => item.id), all.items.map(item => item.id).reverse());
  const pages = []; for (let number = 1; number <= 4; number++) pages.push(await page({ p_page: number, p_limit: 3 }));
  assert.deepEqual(pages.map(value => value.items.length), [3, 3, 2, 0]);
  assert.ok(pages.every(value => value.total === 8 && value.totals.amount_cents === '29400'));
  assert.deepEqual(pages.flatMap(value => value.items.map(item => item.id)), all.items.map(item => item.id));
  assert.equal((await page({ p_kind: 'payable' })).total, 1);
  const overdue = all.items.filter(item => item.overdue).map(item => item.description).sort(); assert.deepEqual(overdue, ['Estornado beta', 'Mensalidade alfa', 'Parcelado alfa', 'Parcelado alfa']);
});

test('094 situação is a multi-selection; dates filter vencimento, emissão or effective liquidação', async () => {
  const count = async args => (await page(args)).total;
  assert.equal(await count({ p_statuses: ['open'] }), 5); assert.equal(await count({ p_statuses: ['partial'] }), 1); assert.equal(await count({ p_statuses: ['paid'] }), 1);
  assert.equal(await count({ p_statuses: ['cancelled'] }), 1); assert.equal(await count({ p_statuses: ['overdue'] }), 4); assert.equal(await count({ p_statuses: ['paid', 'cancelled'] }), 2);
  const open = await page({ p_statuses: ['overdue', 'partial'] }); assert.deepEqual(open.totals, { count: 5, amount_cents: '22200', balance_cents: '20200' });
  assert.deepEqual(descriptions(await page({ p_from: '2020-02-01', p_to: '2020-03-31' })).sort(), ['Mensalidade alfa', 'Parcelado alfa', 'Parcelado alfa']);
  assert.deepEqual(descriptions(await page({ p_date_field: 'issued', p_from: '2020-01-10', p_to: '2020-01-20' })), ['Serviço beta']);
  assert.deepEqual(descriptions(await page({ p_date_field: 'settled', p_from: '2020-03-01', p_to: '2020-03-31' })), ['Serviço beta']);
  assert.deepEqual(descriptions(await page({ p_date_field: 'settled', p_from: '2020-04-01' })), ['Quitado beta']);
  assert.equal(await count({ p_date_field: 'settled', p_from: '2020-05-01', p_to: '2020-05-31' }), 0, 'a reversed baixa is not a liquidação');
  assert.equal(await count({ p_date_field: 'settled' }), 8, 'the date type alone does not filter');
});

test('094 categoria, valor, número do documento and search by name, fantasia, e-mail and CPF/CNPJ with or without mask', async () => {
  const count = async args => (await page(args)).total;
  assert.deepEqual(descriptions(await page({ p_category: category.id })), ['Serviço beta']); assert.equal(await count({ p_category: category.id.toUpperCase() }), 1);
  assert.equal(await count({ p_category: 'none' }), 7);
  assert.deepEqual((await page({ p_min_cents: '3000', p_max_cents: '5000' })).totals, { count: 4, amount_cents: '15000', balance_cents: '13000' });
  assert.equal(await count({ p_min_cents: '10000' }), 1); assert.equal(await count({ p_max_cents: '700' }), 1);
  assert.deepEqual(descriptions(await page({ p_document: 'nf 1001' })), ['Mensalidade alfa']);
  assert.deepEqual((await page({ p_document: origin.number })).items.map(item => item.id).includes(titles.d1[0].id), true);
  for (const query of ['fantasia alfa', 'COBRANCA@ALFA', '12345678000190', '12.345.678/0001-90', '345.678', 'Alfa Comércio']) assert.equal(await count({ p_query: query }), 5, query);
  for (const query of ['beta@example', '987.654.321-00', '98765432100']) assert.equal(await count({ p_query: query }), 3, query);
  assert.deepEqual(descriptions(await page({ p_query: 'mensalidade' })), ['Mensalidade alfa']);
  assert.deepEqual(descriptions(await page({ p_query: 'NF 1001' })), ['Mensalidade alfa']);
  assert.equal(await count({ p_query: 'sem correspondência' }), 0);
  assert.equal(await count({ p_query: 'alfa', p_statuses: ['open'], p_from: '2020-01-01', p_to: '2020-12-31' }), 3);
});

test('094 exposes only the origin document id, kind and number, in the page and in the title read', async () => {
  const linked = (await page()).items.find(item => item.id === titles.d1[0].id);
  assert.deepEqual(linked.origin, origin); assert.equal(linked.document_linked, true);
  assert.ok((await page()).items.filter(item => item.id !== titles.d1[0].id).every(item => item.origin === null && item.document_linked === false));
  const read = await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: titles.d1[0].id }); assert.deepEqual(read.origin, origin);
  assert.equal((await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: titles.t1[0].id })).origin, null);
  assert.equal(Object.hasOwn(await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'categories', p_id: category.id }), 'origin'), false);
  await assert.rejects(() => rpc('erp_finance_get', { p_user_id: users.vendas, p_entity: 'titles', p_id: titles.d1[0].id }), code('42501'));
});

test('094 rejects every out-of-contract parameter before reading', async () => {
  for (const args of [{ p_kind: 'both' }, { p_kind: null }, { p_page: 0 }, { p_page: 100001 }, { p_limit: 0 }, { p_limit: 101 }, { p_order: 'name' }, { p_order: null },
    { p_statuses: [] }, { p_statuses: ['open', 'open'] }, { p_statuses: ['outstanding'] }, { p_statuses: ['open', 'partial', 'paid', 'cancelled', 'overdue', 'open'] },
    { p_date_field: 'competence' }, { p_from: '2020-02-01', p_to: '2020-01-01' }, { p_from: '1899-12-31' }, { p_to: '2101-01-01' },
    { p_category: 'nenhuma' }, { p_min_cents: '-1' }, { p_max_cents: '1000000000000000' }, { p_min_cents: '2', p_max_cents: '1' },
    { p_query: 'x'.repeat(121) }, { p_query: 'a\nb' }, { p_document: 'x'.repeat(61) },
    { p_statuses: '{open,NULL}' }, { p_statuses: '{{open},{paid}}' }, { p_document: 'a\u0001b' }, { p_category: '' }, { p_date_field: null }, { p_page: null }, { p_limit: null }])
    await assert.rejects(() => page(args), code('22023'), JSON.stringify(args));
});

test('094 keeps the 010 cursor list unchanged for the other callers', async () => {
  const legacy = await rpc('erp_finance_list', { p_user_id: users.consulta, p_entity: 'titles', p_limit: 2, p_kind: 'receivable', p_status: 'open' });
  assert.equal(legacy.items.length, 2); assert.equal(legacy.has_more, true); assert.ok(legacy.items[0].id < legacy.items[1].id); assert.equal(Object.hasOwn(legacy, 'total'), false);
  const next = await rpc('erp_finance_list', { p_user_id: users.consulta, p_entity: 'titles', p_limit: 25, p_after: legacy.next_cursor, p_kind: 'receivable', p_status: 'open' });
  assert.equal(next.items.length, 3); assert.equal(next.has_more, false);
});

// The numbered page route now reads the 109 RPC (finance-title-page-v2-sql.test.mjs); the title read keeps the 094 origin.
test('094 API title read executes against real SQL and refuses an inconsistent origin', async () => {
  const api = async (path, rpcPort = rpc) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`)), { userId: users.consulta, rpc: rpcPort });
  const read = await api(`/v1/financeiro/titles/${titles.d1[0].id}`); assert.deepEqual(read.origin, origin);
  assert.equal(Object.hasOwn(await api(`/v1/financeiro/titles/${titles.t1[0].id}`), 'origin'), true);
  const tamper = mutate => async (name, args) => { const result = await rpc(name, args); mutate(result); return result; };
  await assert.rejects(() => api(`/v1/financeiro/titles/${titles.d1[0].id}`, tamper(v => { v.origin = null; })), error => error.status === 502);
  await assert.rejects(() => api(`/v1/financeiro/titles/${titles.d1[0].id}`, tamper(v => { v.origin.kind = 'purchase_orders'; })), error => error.status === 502);
});
