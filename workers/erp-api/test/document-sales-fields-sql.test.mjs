import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../src/index.mjs';

// 202610200102 on PGlite after the document chain (008…095), through the real Worker. Synthetic data only.
let db, handler, contact, other, product;
const admin = randomUUID(), viewer = randomUUID(), seller = randomUUID();
const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].v;
const file = name => new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url);
const migration = async name => db.exec(await readFile(file(name), 'utf8'));
async function rpc(name, args) { const fields = Object.entries(args); await db.exec('set role service_role'); try { return await scalar(`select public.${name}(${fields.map(([k], i) => `${k}=>$${i + 1}`).join(',')})v`, fields.map(([, v]) => v && typeof v === 'object' ? JSON.stringify(v) : v)); } finally { await db.exec('reset role'); } }
async function call(path, method = 'GET', body, user = admin) { const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return { status: response.status, value: await response.json() }; }
async function ok(path, method = 'GET', body, user) { const r = await call(path, method, body, user); assert.equal(r.status, 200, `${path} ${JSON.stringify(r.value)}`); return r.value; }
const line = () => ({ product_id: null, description: 'Item sintético 102', detailed_description: null, code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0' });
const data = (extra = {}) => ({ date: '2026-10-16', contact_id: contact, items: [line()], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [], commercial: null, ...extra });
const create = (kind, extra) => ok(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: data(extra) }).then(r => r.document);
const list = (kind, query = '') => ok(`/v1/documentos/${kind}?limit=100&page=1${query}`);
const address = (extra = {}) => ({ name: 'Recebedor sintético', postal_code: '13400-123', state: 'sp', city: 'Piracicaba', district: 'Centro Sintético', street: 'Rua de Entrega', number: '10', complement: null, country: 'Brasil', ...extra });

before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  for (const suffix of ['0001_origin_sync', '0002_origin_quotes_nfce', '0003_origin_backup_staging', '0004_erp_access', '0005_origin_auxiliary_catalogs', '0006_erp_catalog', '0008_erp_documents', '0009_erp_stock', '0010_erp_finance', '0011_catalog_stock_lock_order', '0013_catalog_import_review', '0014_erp_cnab', '0015_document_filters', '0017_document_finance', '0018_document_stock', '0019_document_effect_flags', '0020_cutover_readiness', '0023_product_details', '0032_proposal_service_conversion', '0034_document_copy', '0044_catalog_ncm_format', '0052_origin_proposal_import', '0054_document_commercial', '0055_origin_proposal_import_v2', '0057_unit_price_precision', '0016_company', '0022_fiscal_drafts', '0025_stock_positions', '0070_stock_reservations', '0090_purchase_receipts']) await migration(`20261016${suffix}`);
  await migration('202610190095_document_list_parity');
  await migration('202610200102_document_sales_fields');
  for (const [id, role] of [[admin, 'admin'], [viewer, 'consulta'], [seller, 'vendas']]) { await db.query('insert into auth.users values($1)', [id]); await db.query('insert into erp_access.membership(user_id,role)values($1,$2)', [id, role]); }
  handler = createHandler({ fetchImpl: async (url, options) => { if (url.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) }); try { return Response.json(await rpc(new URL(url).pathname.split('/').at(-1), JSON.parse(options.body))); } catch (e) { return Response.json({ code: e.code, message: 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); } } });
  const save = async fields => (await rpc('erp_catalog_save', { p_user_id: admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: fields })).record.id;
  contact = await save({ name: 'Cliente Endereço 102', email: 'compras@cliente102.invalid', phone: '(19) 3400-0000', document: '12.345.678/0001-90', street: 'Rua do Cadastro', number: '5', district: 'Vila Cadastro', city: 'Limeira', state: 'SP', postal_code: '13480-000' });
  other = await save({ name: 'Cliente Sem Endereço 102' });
  product = (await rpc('erp_catalog_save', { p_user_id: admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Produto 102', unit: 'UN', kind: 'P', format: 'S' } })).record.id;
});
after(() => db?.close());

test('102 keeps one private list overload, a wrapped normalizer and a read-only next-number RPC for writers only', async () => {
  assert.equal(await scalar("select count(*)::int v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='erp_document_list'"), 1);
  assert.equal(await scalar("select to_regprocedure('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text)') is null v"), true);
  const signature = 'public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean)';
  for (const fn of [signature, 'public.erp_document_next_number(uuid,text)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, `${role} ${fn}`);
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
    assert.equal(await scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
    assert.deepEqual(await scalar('select proconfig v from pg_proc where oid=$1::regprocedure', [fn]), ['search_path=pg_catalog']);
  }
  for (const fn of ['erp_documents.normalize(text,jsonb)', 'erp_documents.normalize_core(text,jsonb)', 'erp_documents.extension_data(jsonb)', 'erp_documents.delivery_address(jsonb)', 'erp_documents.list_row(uuid,boolean,boolean)', 'erp_documents.require_commercial_input(jsonb,jsonb)'])
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  const before = (await ok('/v1/documentos/sales_orders/proximo-numero')).next_number;
  assert.equal((await ok('/v1/documentos/sales_orders/proximo-numero')).next_number, before, 'reading does not reserve the number');
  const saved = await create('sales_orders');
  assert.equal(saved.number, before); assert.equal((await ok('/v1/documentos/sales_orders/proximo-numero')).next_number, String(Number(before) + 1));
  assert.equal((await call('/v1/documentos/sales_orders/proximo-numero', 'GET', undefined, viewer)).status, 403, 'consulta does not create documents');
  assert.equal((await call('/v1/documentos/purchase_orders/proximo-numero', 'GET', undefined, seller)).status, 403);
  assert.equal((await call('/v1/documentos/sales_orders/proximo-numero?x=1')).status, 400);
  // 202610200129 adds POST ("Próximo número" of Preferências); an incomplete body is refused before the database.
  assert.equal((await call('/v1/documentos/sales_orders/proximo-numero', 'POST', {})).status, 400);
  assert.equal((await call('/v1/documentos/sales_orders/proximo-numero', 'PATCH', {})).status, 405);
});

test('new Origin fields are validated, normalized and returned by the Worker; legacy bodies keep their exact shape', async () => {
  const order = await create('sales_orders', { ship_date: '2026-10-17', customer_po_number: ' PC-2026/77 ', delivery_address: address() });
  assert.equal(order.ship_date, '2026-10-17'); assert.equal(order.customer_po_number, 'PC-2026/77');
  assert.deepEqual(order.delivery_address, { name: 'Recebedor sintético', postal_code: '13400123', state: 'SP', city: 'Piracicaba', district: 'Centro Sintético', street: 'Rua de Entrega', number: '10', complement: null, country: 'Brasil' });
  assert.deepEqual((await ok(`/v1/documentos/sales_orders/${order.id}`)).document, order);
  const os = await create('service_orders', { finish_date: '2026-10-18', ship_date: '2026-10-19', start_time: '08:30', end_time: '17:05', quote_requested: true, quoted: false, warranty_days: '90', warranty_info: 'Garantia sintética\nsegunda linha', reception_notes: 'Recebido com capa' });
  assert.deepEqual([os.finish_date, os.start_time, os.end_time, os.quote_requested, os.quoted, os.warranty_days, os.warranty_info, os.reception_notes], ['2026-10-18', '08:30', '17:05', true, false, '90', 'Garantia sintética\nsegunda linha', 'Recebido com capa']);
  const proposal = await create('sales_proposals', { template: true, template_name: 'Modelo sintético', warranty_months: '12' });
  assert.deepEqual([proposal.template_name, proposal.warranty_months], ['Modelo sintético', '12']);
  const legacy = await create('purchase_orders');
  for (const key of ['ship_date', 'delivery_address', 'template_name']) assert.equal(Object.hasOwn(legacy, key), false, `${key} absent stays absent`);
  for (const [field, value] of [['start_time', '24:00'], ['start_time', '8:30'], ['warranty_days', '01'], ['warranty_days', '10000'], ['warranty_months', 12], ['quoted', 'true'], ['customer_po_number', 'x'.repeat(61)], ['ship_date', '2026-02-30'],
    ['delivery_address', address({ postal_code: '1340' })], ['delivery_address', address({ state: 'XX' })], ['delivery_address', address({ street: null })], ['delivery_address', { ...address(), extra: 'x' }], ['delivery_address', address({ street: 'x'.repeat(101) })]]) {
    const r = await call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: data({ [field]: value }) });
    assert.equal(r.status, 400, `${field}=${JSON.stringify(value)}`);
  }
  // The database refuses the same values even without the Worker.
  await assert.rejects(() => rpc('erp_document_save', { p_user_id: admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: data({ end_time: '25:00' }) }), error => error.code === '22023');
  await assert.rejects(() => rpc('erp_document_save', { p_user_id: admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: data({ delivery_address: address({ city: null }) }) }), error => error.code === '22023');
});

test('an older client that omits a filled new field is refused (409); an explicit null clears it; copies send the fields', async () => {
  const order = await create('sales_orders', { ship_date: '2026-10-17', customer_po_number: 'PC-1' });
  const patch = (current, body) => call(`/v1/documentos/sales_orders/${current.id}`, 'PATCH', { command_id: randomUUID(), expected_version: current.version, data: body });
  const { ship_date, customer_po_number, ...withoutFields } = data({ ship_date: '2026-10-17', customer_po_number: 'PC-1' });
  assert.equal((await patch(order, withoutFields)).status, 409);
  const cleared = await patch(order, { ...withoutFields, ship_date: null, customer_po_number: null });
  assert.equal(cleared.status, 200); assert.equal(cleared.value.document.ship_date, null); assert.equal(cleared.value.document.customer_po_number, null);
  const source = await create('sales_orders', { ship_date: '2026-10-20' });
  const preview = await ok(`/v1/duplicacao-documentos/sales_orders/${source.id}/preview`);
  assert.equal(Object.hasOwn(preview.data, 'ship_date'), false, 'the copy preview resets the new fields');
  const copyBody = body => call(`/v1/duplicacao-documentos/sales_orders/${source.id}`, 'POST', { command_id: randomUUID(), expected_source_version: source.version, data: body });
  assert.equal((await copyBody(preview.data)).status, 409, 'an old client copy would drop the field silently');
  const copied = await copyBody({ ...preview.data, ship_date: null, customer_po_number: null, delivery_address: null, finish_date: null, start_time: null, end_time: null, quote_requested: null, quoted: null, warranty_days: null, warranty_months: null, warranty_info: null, reception_notes: null, template_name: null });
  assert.equal(copied.status, 200, JSON.stringify(copied.value)); assert.equal(copied.value.document.ship_date, null);
});

test('list columns, 1ª venda and the Origin filters (CEP, bairro, rastreio, transportador, pedido de compra, modelos, e-mail, datas)', async () => {
  const transport = { freight_mode: '0', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: { system: 'origin', source_id: '901', label: 'Transportadora Sintética' }, service_reference: null, tracking_code: 'BR123RASTREIO' };
  const commercial = { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null, transport };
  const first = await create('sales_orders', { contact_id: other, date: '2026-09-01' });
  const second = await create('sales_orders', { contact_id: other, date: '2026-09-02', ship_date: '2026-09-05', customer_po_number: 'OC-9901', commercial, delivery_address: address({ postal_code: '13401000', district: 'Bairro Entrega' }) });
  const rows = (await list('sales_orders', `&q=${encodeURIComponent('Sem Endereço')}`)).items;
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(byId[first.id].first_sale, true); assert.equal(byId[second.id].first_sale, false);
  assert.deepEqual([byId[second.id].customer_po_number, byId[second.id].ship_date, byId[second.id].carrier_name], ['OC-9901', '2026-09-05', 'Transportadora Sintética']);
  assert.equal(byId[second.id].address, 'Rua de Entrega, 10 - Bairro Entrega - Piracicaba/SP - CEP 13401000', 'the delivery address has priority');
  const withContact = (await list('sales_orders', `&q=${encodeURIComponent('Cliente Endereço 102')}`)).items[0];
  assert.deepEqual([withContact.contact_email, withContact.contact_phone, withContact.contact_document, withContact.address], ['compras@cliente102.invalid', '(19) 3400-0000', '12.345.678/0001-90', 'Rua do Cadastro, 5 - Vila Cadastro - Limeira/SP - CEP 13480-000']);
  const ids = page => page.items.map(row => row.id);
  assert.deepEqual(ids(await list('sales_orders', '&postal_code=13401')), [second.id], 'CEP prefix on the delivery address');
  assert.ok(ids(await list('sales_orders', '&postal_code=13480')).includes(withContact.id), 'CEP of the contact');
  assert.deepEqual(ids(await list('sales_orders', `&district=${encodeURIComponent('bairro entrega')}`)), [second.id]);
  assert.deepEqual(ids(await list('sales_orders', '&tracking_code=123rastr')), [second.id]);
  assert.deepEqual(ids(await list('sales_orders', '&carrier=sint%C3%A9tica')), [second.id]);
  assert.deepEqual(ids(await list('sales_orders', '&customer_po_number=oc-99')), [second.id]);
  assert.deepEqual(ids(await list('sales_orders', '&date_type=ship_date&date_from=2026-09-05&date_to=2026-09-05')), [second.id]);
  const model = await create('sales_proposals', { template: true, template_name: 'Modelo lista' }), plain = await create('sales_proposals', { contact_id: other });
  const proposals = await list('sales_proposals', '&template=true');
  assert.ok(ids(proposals).includes(model.id)); assert.equal(ids(proposals).includes(plain.id), false); assert.ok(proposals.items.every(row => row.template));
  assert.equal(ids(await list('sales_proposals', '&template=false')).includes(model.id), false);
  assert.ok(ids(await list('sales_proposals', '&contact_email=cliente102')).includes(model.id));
  const os = await create('service_orders', { date: '2026-08-01', finish_date: '2026-08-10', ship_date: '2026-08-11', warranty_days: '30' });
  assert.deepEqual(ids(await list('service_orders', '&date_type=finish_date&date_from=2026-08-10&date_to=2026-08-10')), [os.id]);
  assert.deepEqual(ids(await list('service_orders', '&date_type=warranty_until&date_from=2026-09-10&date_to=2026-09-10')), [os.id], 'garantia = saída + 30 dias');
  assert.ok(ids(await list('service_orders', '&q=13480-000')).includes(os.id), 'OS search finds the client CEP');
  for (const [kind, query] of [['sales_proposals', '&postal_code=1'], ['sales_orders', '&template=true'], ['sales_orders', '&date_type=finish_date'], ['sales_orders', '&contact_email=x'], ['purchase_orders', '&date_type=ship_date']]) assert.equal((await call(`/v1/documentos/${kind}?limit=100&page=1${query}`)).status, 400, `${kind}${query}`);
  for (const query of ['&postal_code=13400-000', '&postal_code=123456789', '&tracking_code=%0A', '&carrier=' + 'x'.repeat(201)]) assert.equal((await call(`/v1/documentos/sales_orders?limit=100&page=1${query}`)).status, 400, query);
  assert.equal((await call('/v1/documentos/sales_proposals?limit=100&page=1&template=sim')).status, 400);
  assert.equal((await call('/v1/documentos/service_orders?limit=100&page=1&date_type=ship_date&date_from=2026-08-11')).status, 200);
});

test('proposal conversion carries the new fields without breaking the Worker checks', async () => {
  const proposal = await create('sales_proposals', { warranty_months: '6', delivery_address: address() });
  const approve = async (doc, status) => (await ok(`/v1/documentos/sales_proposals/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status, reason: null })).document;
  const approved = await approve(await approve(proposal, 'open'), 'approved');
  const converted = await ok(`/v1/documentos/sales_proposals/${approved.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: approved.version });
  assert.equal(converted.sale.warranty_months, '6'); assert.equal(converted.sale.delivery_address.city, 'Piracicaba');
  const other = await create('sales_proposals', { warranty_months: '3' });
  const ready = await approve(await approve(other, 'open'), 'approved');
  const service = await ok(`/v1/documentos/sales_proposals/${ready.id}/convert-service`, 'POST', { command_id: randomUUID(), expected_version: ready.version });
  assert.equal(service.service_order.warranty_months, '3');
});
