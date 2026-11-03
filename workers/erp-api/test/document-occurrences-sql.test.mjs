import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../src/index.mjs';

// 202610200103 (ocorrências e situações) on PGlite after the document chain and 102, through the real Worker. Synthetic data only.
let db, handler, contact;
const admin = randomUUID(), viewer = randomUUID(), seller = randomUUID();
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].v;
const migration = async name => db.exec(await readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
async function rpc(name, args) { const fields = Object.entries(args); await db.exec('set role service_role'); try { return await scalar(`select public.${name}(${fields.map(([k], i) => `${k}=>$${i + 1}`).join(',')})v`, fields.map(([, v]) => v && typeof v === 'object' ? JSON.stringify(v) : v)); } finally { await db.exec('reset role'); } }
async function call(path, method = 'GET', body, user = admin) { const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return { status: response.status, value: await response.json() }; }
async function ok(path, method = 'GET', body, user) { const r = await call(path, method, body, user); assert.equal(r.status, 200, `${path} ${JSON.stringify(r.value)}`); return r.value; }
const data = (extra = {}) => ({ date: '2026-10-16', contact_id: contact, items: [{ product_id: null, description: 'Item 103', detailed_description: null, code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0' }], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [], commercial: null, ...extra });
const create = (kind, extra) => ok(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: kind === 'service_orders' ? data({ items: [], ...extra }) : data(extra) }).then(r => r.document);
const status = (doc, target, reason = null, user) => call(`/v1/documentos/${doc.kind}/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: target, reason }, user);
const occurrences = (doc, user) => ok(`/v1/documentos/${doc.kind}/${doc.id}/ocorrencias`, 'GET', undefined, user);
const add = (doc, body, user) => call(`/v1/documentos/${doc.kind}/${doc.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: doc.version, occurred_on: '2026-10-20', occurred_time: '09:15', ...body }, user);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  for (const suffix of ['0001_origin_sync', '0002_origin_quotes_nfce', '0003_origin_backup_staging', '0004_erp_access', '0005_origin_auxiliary_catalogs', '0006_erp_catalog', '0008_erp_documents', '0009_erp_stock', '0010_erp_finance', '0011_catalog_stock_lock_order', '0013_catalog_import_review', '0014_erp_cnab', '0015_document_filters', '0017_document_finance', '0018_document_stock', '0019_document_effect_flags', '0020_cutover_readiness', '0023_product_details', '0032_proposal_service_conversion', '0034_document_copy', '0044_catalog_ncm_format', '0052_origin_proposal_import', '0054_document_commercial', '0055_origin_proposal_import_v2', '0057_unit_price_precision', '0016_company', '0022_fiscal_drafts', '0025_stock_positions', '0070_stock_reservations', '0090_purchase_receipts']) await migration(`20261016${suffix}`);
  for (const name of ['202610190095_document_list_parity', '202610200102_document_sales_fields', '202610200103_document_occurrences']) await migration(name);
  for (const [id, role] of [[admin, 'admin'], [viewer, 'consulta'], [seller, 'vendas']]) { await db.query('insert into auth.users values($1)', [id]); await db.query('insert into erp_access.membership(user_id,role)values($1,$2)', [id, role]); }
  handler = createHandler({ fetchImpl: async (url, options) => { if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) }); try { return Response.json(await rpc(new URL(url).pathname.split('/').at(-1), JSON.parse(options.body))); } catch (e) { return Response.json({ code: e.code, message: 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); } } });
  contact = (await rpc('erp_catalog_save', { p_user_id: admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Cliente Ocorrência 103' } })).record.id;
});
after(() => db?.close());

test('103 grants: occurrence RPCs only for service_role, private helpers, immutable rows behind RLS', async () => {
  for (const fn of ['public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text)', 'public.erp_document_occurrence_list(uuid,text,uuid)', 'public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, `${role} ${fn}`);
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
    assert.equal(await scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
  }
  for (const fn of ['erp_documents.record_occurrence(uuid,uuid,uuid,integer,text,text,text)', 'erp_documents.transition_reason_required(text,text,text)', 'erp_documents.legacy_transitions()'])
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  assert.equal(await scalar("select relrowsecurity v from pg_class where oid='erp_documents.occurrence'::regclass"), true);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await scalar("select has_table_privilege('service_role','erp_documents.occurrence',$1) v", [privilege]), false, privilege);
  const order = await create('sales_orders');
  assert.equal((await status(order, 'open')).status, 200);
  await assert.rejects(() => db.query('update erp_documents.occurrence set text=$1', ['alterado']), /immutable/);
  await assert.rejects(() => db.query('delete from erp_documents.occurrence'), /immutable/);
});

test('every status change writes one occurrence; the list is newest first and tells who may write', async () => {
  let order = await create('sales_orders');
  order = (await status(order, 'open')).value.document;
  order = (await status(order, 'cancelled', 'Cliente desistiu')).value.document;
  const listed = await occurrences(order);
  assert.deepEqual(listed.items.map(item => [item.sequence, item.status_before, item.status_after, item.text]), [[2, 'open', 'cancelled', 'Cliente desistiu'], [1, 'draft', 'open', null]]);
  assert.match(listed.items[0].occurred_on, /^\d{4}-\d{2}-\d{2}$/); assert.match(listed.items[0].occurred_time, /^\d{2}:\d{2}$/);
  assert.equal(listed.items[0].actor_id, admin); assert.equal(listed.items[0].actor_role, 'admin'); assert.equal(listed.items[0].document_version, order.version);
  assert.deepEqual([listed.document.status, listed.can_write, listed.has_more], ['cancelled', true, false]);
  assert.equal((await occurrences(order, viewer)).can_write, false, 'consulta reads but does not write');
  assert.equal((await add(order, { text: 'Tentativa da consulta' }, viewer)).status, 403);
});

test('an occurrence with text only keeps the version; with another situação it moves the document once, with the typed date, time and text', async () => {
  let order = await create('sales_orders');
  const body = { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-19', occurred_time: '18:40', text: 'Cliente pediu retorno amanhã' };
  const first = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', body, seller);
  assert.equal(first.document.version, order.version); assert.equal(first.replayed, false);
  assert.deepEqual([first.occurrence.occurred_on, first.occurrence.occurred_time, first.occurrence.text, first.occurrence.status_after, first.occurrence.actor_role], ['2026-10-19', '18:40', 'Cliente pediu retorno amanhã', null, 'vendas']);
  const replay = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', body, seller);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.occurrence, first.occurrence);
  assert.equal((await call(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { ...body, text: 'Outro texto' }, seller)).status, 409, 'same command with another body');
  const moved = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-20', occurred_time: '08:05', text: 'Separado no estoque', status: 'in_progress' });
  assert.equal(moved.document.status, 'in_progress'); assert.equal(moved.document.version, order.version + 1);
  assert.deepEqual([moved.occurrence.sequence, moved.occurrence.status_before, moved.occurrence.status_after, moved.occurrence.text, moved.occurrence.occurred_on, moved.occurrence.occurred_time], [2, 'draft', 'in_progress', 'Separado no estoque', '2026-10-20', '08:05']);
  assert.equal((await occurrences(moved.document)).items.length, 2, 'one occurrence for the change, not two');
  assert.equal(await scalar("select count(*)::int v from erp_documents.audit where document_id=$1 and action='transition'", [order.id]), 1);
  order = moved.document;
  assert.equal((await add(order, { text: 'Versão antiga', status: 'open' }, admin)).status, 200);
  assert.equal((await add(order, { text: 'Versão antiga de novo' })).status, 409, 'expected_version is checked');
  const later = (await ok(`/v1/documentos/sales_orders/${order.id}`)).document;
  assert.equal((await add(later, { status: 'cancelled', text: 'ok' })).status, 400, 'the text is the cancel reason and needs three characters');
  assert.equal((await add(later, { status: 'cancelled', text: 'Sem estoque' })).status, 200);
});

test('situações go from any to any, keeping the reasons of 008 and asking a reason to leave a closed situação', async () => {
  let order = await create('sales_orders');
  order = (await status(order, 'fulfilled')).value.document;
  assert.equal(order.status, 'fulfilled', 'Em digitação → Atendido directly, as in Origin');
  assert.equal((await status(order, 'in_progress')).status, 400, 'leaving Atendido needs a reason');
  order = (await status(order, 'in_progress', 'Faltou entregar')).value.document;
  assert.equal((await status(order, 'partially_fulfilled')).status, 200);
  let os = await create('service_orders');
  os = (await status(os, 'approved')).value.document;
  os = (await status(os, 'in_progress')).value.document;
  assert.equal(os.status, 'in_progress', '008 forward move keeps working without a reason');
  const quoted = await create('service_orders').then(doc => status(doc, 'approved')).then(r => r.value.document);
  assert.equal((await status(quoted, 'quoted')).status, 400, 'a new move out of Aprovada needs a reason');
  assert.equal((await status(quoted, 'quoted', 'Refazer orçamento')).status, 200);
  const proposal = await create('sales_proposals', { template: true });
  assert.equal((await status(proposal, 'approved')).status, 400, 'a model is never approved');
  assert.equal((await status(proposal, 'pending')).status, 200);
  const done = await create('sales_proposals');
  assert.equal((await status(done, 'completed')).status, 400, 'Concluído comes only from the conversion');
  assert.equal(await scalar("select (erp_documents.transitions()->'purchase_orders')=(erp_documents.legacy_transitions()->'purchase_orders') v"), true, 'purchase orders keep 008');
});

test('proposal occurrence updates the próximo contato; the Worker refuses invalid occurrences before the database', async () => {
  const proposal = await create('sales_proposals');
  const saved = await ok(`/v1/documentos/sales_proposals/${proposal.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: proposal.version, occurred_on: '2026-10-20', occurred_time: '10:00', text: 'Ligar de novo', next_contact: '2026-10-27' });
  assert.equal(saved.document.next_contact, '2026-10-27'); assert.equal(saved.occurrence.next_contact, '2026-10-27');
  assert.equal(saved.document.version, proposal.version + 1);
  const order = await create('sales_orders');
  for (const body of [{ text: 'x', next_contact: '2026-10-27' }, { text: 'x', occurred_time: '9:00' }, { text: 'x', occurred_on: '2026-02-30' }, { text: 'linha\u0007' }, { text: '   ' }, {}, { text: 'x', status: 'unknown' }, { text: 'x', extra: true }, { text: 'x'.repeat(1001) }])
    assert.equal((await add(order, body)).status, 400, JSON.stringify(body));
  assert.equal((await call(`/v1/documentos/purchase_orders/${order.id}/ocorrencias`)).status, 404);
  assert.equal((await call(`/v1/documentos/sales_orders/${order.id}/ocorrencias?x=1`)).status, 400);
  assert.equal((await call(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'PATCH', {})).status, 405);
  assert.equal((await add(order, { text: 'Linha 1\nLinha 2' })).status, 200, 'line breaks are kept');
});

test('a multi-line description with a cancel keeps the lines in the occurrence and is a valid single-line reason', async () => {
  const order = await create('sales_orders');
  const result = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-20', occurred_time: '11:00', text: 'Cliente desistiu\nligou às 10h', status: 'cancelled' });
  assert.equal(result.document.status, 'cancelled'); assert.equal(result.occurrence.text, 'Cliente desistiu\nligou às 10h');
  assert.equal(await scalar("select reason v from erp_documents.audit where document_id=$1 and action='transition'", [order.id]), 'Cliente desistiu ligou às 10h');
});
