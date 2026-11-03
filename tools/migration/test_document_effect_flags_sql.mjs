import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { documentsResponse, documentsOperation, documentsRoute } from '../../workers/erp-api/src/documents.mjs';
import { executeFinanceRoute, parseFinanceRoute } from '../../workers/erp-api/src/finance.mjs';

// Synthetic, local-only regression coverage. PGlite does not model concurrent sessions.
let db, contact, product, warehouse, legacy, legacyConversion, legacyTitleCommand, legacyGroupCommand;
const users = {};
const code = expected => error => error.code === expected;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
async function rpc(name, args) {
  const entries = Object.entries(args);
  await db.exec('SET ROLE service_role');
  try { return await scalar(`SELECT public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(',')}) AS value`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value)); }
  finally { await db.exec('RESET ROLE'); }
}
const execute = (action, data, command = randomUUID()) => rpc('erp_finance_execute', { p_user_id: users.admin, p_command_id: command, p_action: action, p_data: data });
const get = (doc, actor = users.admin) => rpc('erp_document_get', { p_user_id: actor, p_kind: doc.kind, p_id: doc.id });
const transition = (doc, status) => rpc('erp_document_transition', { p_user_id: users.admin, p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Conferência sintética' });
async function document(kind = 'purchase_orders') {
  const body = { date: '2026-10-16', contact_id: contact.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, description: 'Item fictício', unit: 'UN', quantity: '2', unit_price: '5' }], installments: [{ due_date: '2026-11-01', amount: '10.00' }] };
  const input = { p_user_id: users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body };
  const saved = await rpc('erp_document_save', input);
  let doc = saved.document;
  if (kind === 'purchase_orders') doc = (await transition(doc, 'in_progress')).document;
  else if (kind === 'sales_orders') { doc = (await transition(doc, 'open')).document; doc = (await transition(doc, 'verified')).document; }
  return { input, saved, doc };
}
async function post(doc) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: doc.version };
  const { preview } = await rpc('erp_document_finance_preview', scope);
  return rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash });
}
async function reverse(doc, posting) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: (await get(doc)).document.version, p_posting_id: posting.id, p_posting_version: posting.version };
  const { preview } = await rpc('erp_document_finance_reverse_preview', scope);
  return rpc('erp_document_finance_reverse', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_title_versions: preview.titles.map(row => ({ id: row.id, version: row.version })), p_reason: 'Estorno sintético revisado' });
}
async function stockPost(doc) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: (await get(doc)).document.version, p_occurred_on: '2026-10-16', p_reason: 'Estoque sintético' };
  const { preview } = await rpc('erp_document_stock_preview', scope);
  return rpc('erp_document_stock_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: preview.ignored.map(row => row.id) });
}
async function stockReverse(doc, posting) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: (await get(doc)).document.version, p_posting_id: posting.id, p_posting_version: posting.version, p_occurred_on: '2026-10-16', p_reason: 'Estorno estoque sintético' };
  const { preview } = await rpc('erp_document_stock_reverse_preview', scope);
  return rpc('erp_document_stock_reverse', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash });
}
before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name)); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  for (const name of ['202610160001_origin_sync.sql', '202610160002_origin_quotes_nfce.sql', '202610160004_erp_access.sql', '202610160006_erp_catalog.sql', '202610160008_erp_documents.sql', '202610160009_erp_stock.sql', '202610160010_erp_finance.sql', '202610160011_catalog_stock_lock_order.sql', '202610160014_erp_cnab.sql', '202610160017_document_finance.sql', '202610160018_document_stock.sql']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  for (const role of ['admin', 'financeiro', 'consulta', 'vendas', 'estoque']) {
    users[role] = randomUUID(); await db.query('INSERT INTO auth.users VALUES ($1)', [users[role]]);
    await db.query('INSERT INTO erp_access.membership(user_id,role) VALUES ($1,$2)', [users[role], role]);
  }
  const catalog = async (entity, data) => (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
  contact = await catalog('contacts', { name: 'Contato fictício 019' }); product = await catalog('products', { name: 'Produto fictício 019', unit: 'UN', kind: 'P' }); warehouse = await catalog('warehouses', { name: 'Depósito fictício 019' });
  // Capture real pre-019 ledgers; do not fake or rewrite an immutable command.
  legacy = await document(); legacy.finance = await post(legacy.doc);
  legacyTitleCommand = { command: randomUUID(), data: { id: legacy.finance.titles[0].id, expected_version: 1, description: 'Correção sintética anterior à 019' } };
  legacyTitleCommand.result = await execute('title_update', legacyTitleCommand.data, legacyTitleCommand.command);
  legacyGroupCommand = { command: randomUUID(), data: { kind: 'receivable', contact_id: contact.id, description: 'Título avulso fictício', issued_on: '2026-10-16', total_cents: '100', installments: [{ amount_cents: '100', due_on: '2026-11-01' }] } };
  legacyGroupCommand.result = await execute('title_create_group', legacyGroupCommand.data, legacyGroupCommand.command);
  const proposal = await document('sales_proposals');
  const approved = (await transition((await transition(proposal.doc, 'open')).document, 'approved')).document;
  legacyConversion = { input: { p_user_id: users.admin, p_id: approved.id, p_expected_version: approved.version, p_command_id: randomUUID() } };
  legacyConversion.result = await rpc('erp_proposal_convert', legacyConversion.input);
  assert.equal(legacy.saved.document.effect_flags, undefined);
  assert.equal(legacyTitleCommand.result.record.document_linked, undefined);
  await db.exec(await readFile(new URL('../../supabase/migrations/202610160019_document_effect_flags.sql', import.meta.url), 'utf8'));
});
after(async () => db?.close());

test('current document flags reflect independent effects and only expose two booleans', async () => {
  const { doc } = await document();
  assert.deepEqual((await get(doc)).document.effect_flags, { finance_active: false, stock_active: false });
  const finance = await post(doc), stock = await stockPost(doc);
  assert.deepEqual((await get(doc, users.estoque)).document.effect_flags, { finance_active: true, stock_active: true });
  await reverse(doc, finance.posting);
  assert.deepEqual((await get(doc)).document.effect_flags, { finance_active: false, stock_active: true });
  await stockReverse(doc, stock.posting);
  assert.deepEqual((await get(doc)).document.effect_flags, { finance_active: false, stock_active: false });
  await assert.rejects(() => rpc('erp_document_finance_get', { p_user_id: users.estoque, p_kind: doc.kind, p_document_id: doc.id, p_posting_id: finance.posting.id }), code('42501'));
  const sale = (await document('sales_orders')).doc; await post(sale);
  assert.deepEqual((await get(sale, users.vendas)).document.effect_flags, { finance_active: true, stock_active: false });
  await assert.rejects(() => rpc('erp_finance_get', { p_user_id: users.vendas, p_entity: 'titles', p_id: finance.titles[0].id }), code('42501'));
});

test('pre-migration document replay refreshes only flags while preserving its original data and immutable ledger', async () => {
  const stored = await scalar('SELECT result value FROM erp_documents.command WHERE command_id=$1', [legacy.input.p_command_id]);
  const counts = await scalar("SELECT jsonb_build_array((SELECT count(*) FROM erp_finance.title),(SELECT count(*) FROM erp_documents.command),(SELECT count(*) FROM erp_documents.audit)) value");
  const first = await rpc('erp_document_save', legacy.input);
  assert.equal(first.replayed, true);
  assert.deepEqual(first.document.effect_flags, { finance_active: true, stock_active: false });
  const { effect_flags, ...historical } = first.document;
  assert.deepEqual(historical, legacy.saved.document);
  assert.deepEqual(await scalar('SELECT result value FROM erp_documents.command WHERE command_id=$1', [legacy.input.p_command_id]), stored);
  assert.deepEqual(await scalar("SELECT jsonb_build_array((SELECT count(*) FROM erp_finance.title),(SELECT count(*) FROM erp_documents.command),(SELECT count(*) FROM erp_documents.audit)) value"), counts);
  await reverse(legacy.doc, legacy.finance.posting);
  const later = await rpc('erp_document_save', legacy.input);
  assert.deepEqual(later.document.effect_flags, { finance_active: false, stock_active: false });
  assert.equal(later.document.version, legacy.saved.document.version);
  assert.deepEqual(await scalar('SELECT result value FROM erp_documents.command WHERE command_id=$1', [legacy.input.p_command_id]), stored);
});

test('title links remain true after cancellation and source reversal; manual source annotations never create links', async () => {
  const replay = await execute('title_update', legacyTitleCommand.data, legacyTitleCommand.command);
  assert.equal(replay.record.document_linked, true); assert.equal(replay.replayed, true);
  const current = await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: legacyTitleCommand.data.id });
  assert.equal(current.record.document_linked, true); assert.equal(current.record.cancelled, true);
  assert.equal(replay.record.cancelled, false); // Original command data remains historical.
  const { document_linked, ...historical } = replay.record;
  assert.deepEqual(historical, legacyTitleCommand.result.record);
  assert.deepEqual(await scalar('SELECT result value FROM erp_finance.command WHERE id=$1', [legacyTitleCommand.command]), legacyTitleCommand.result);
  await assert.rejects(() => execute('title_update', { id: current.record.id, expected_version: current.record.version, amount_cents: '2000' }), code('40001'));
  const group = await execute('title_create_group', legacyGroupCommand.data, legacyGroupCommand.command);
  assert.equal(group.items[0].document_linked, false);
  assert.deepEqual(group.items.map(({ document_linked, ...row }) => row), legacyGroupCommand.result.items);
  const manual = await execute('title_update', { id: group.items[0].id, expected_version: 1, source_reference: legacy.doc.id });
  assert.equal(manual.record.document_linked, false);
  const list = await rpc('erp_finance_list', { p_user_id: users.consulta, p_entity: 'titles' });
  assert.ok(list.items.every(row => typeof row.document_linked === 'boolean'));
});

test('old proposal conversion returns current flags for both documents without creating another sale', async () => {
  let sale = legacyConversion.result.sale;
  sale = (await transition((await transition(sale, 'open')).document, 'verified')).document;
  await post(sale);
  const replay = await rpc('erp_proposal_convert', legacyConversion.input);
  assert.deepEqual(replay.proposal.effect_flags, { finance_active: false, stock_active: false });
  assert.deepEqual(replay.sale.effect_flags, { finance_active: true, stock_active: false });
  assert.equal(replay.sale.version, legacyConversion.result.sale.version);
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_documents.document WHERE source_proposal_id=$1', [replay.proposal.id]), 1);
  assert.deepEqual(await scalar('SELECT result value FROM erp_documents.command WHERE command_id=$1', [legacyConversion.input.p_command_id]), legacyConversion.result);
});

test('new private projection helpers and replays do not bypass current authorization', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) for (const fn of ['erp_documents.effect_flags(uuid)', 'erp_documents.project_result_flags(jsonb)', 'erp_finance.project_result_link(jsonb)']) assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') value", [role, fn]), false);
  for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($1,'public.erp_finance_execute(uuid,uuid,text,jsonb)','EXECUTE') value", [role]), false);
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1', [users.admin]);
  try {
    await assert.rejects(() => rpc('erp_document_save', legacy.input), code('42501'));
    await assert.rejects(() => execute('title_update', legacyTitleCommand.data, legacyTitleCommand.command), code('42501'));
  } finally { await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1', [users.admin]); }
});

test('HTTP accepts exact boolean flags and rejects missing, malformed or excessive effect metadata', async () => {
  const value = await get(legacy.doc), route = documentsRoute(`/v1/documentos/${legacy.doc.kind}/${legacy.doc.id}`), operation = { type: 'document' };
  assert.deepEqual(documentsResponse(value, route, operation).document.effect_flags, value.document.effect_flags);
  for (const flags of [undefined, null, [], {}, { finance_active: 'false', stock_active: false }, { finance_active: false, stock_active: 0 }, { finance_active: false, stock_active: false, amount_cents: '1000' }]) {
    assert.throws(() => documentsResponse({ ...value, document: { ...value.document, effect_flags: flags } }, route, operation), error => error.status === 502);
  }
  const request = new Request(`https://api.example.test/v1/documentos/${legacy.doc.kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), data: { ...legacy.input.p_body, effect_flags: { finance_active: false, stock_active: false } } }) });
  await assert.rejects(() => documentsOperation(request, documentsRoute(new URL(request.url).pathname), new URLSearchParams()), error => error.status === 400);
  const titleRoute = await parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/titles/${legacyTitleCommand.data.id}`));
  const title = await rpc('erp_finance_get', { p_user_id: users.consulta, p_entity: 'titles', p_id: legacyTitleCommand.data.id });
  const projected = await executeFinanceRoute(titleRoute, { userId: users.consulta, rpc: async () => ({ ...title, record: { ...title.record, private_posting: 'not projected' } }) });
  assert.equal(projected.record.document_linked, true); assert.equal(projected.record.private_posting, undefined);
  for (const flag of [undefined, null, 'true', 1, {}]) await assert.rejects(() => executeFinanceRoute(titleRoute, { userId: users.consulta, rpc: async () => ({ ...title, record: { ...title.record, document_linked: flag } }) }), error => error.status === 502);
  const bad = new Request('https://api.example.test/v1/financeiro/actions/title_update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), data: { id: legacyTitleCommand.data.id, expected_version: 1, document_linked: false } }) });
  await assert.rejects(() => parseFinanceRoute(bad), error => error.status === 400);
});

test('finance execution replacement changes only replay projection, not mutation or locking logic', async () => {
  const original = await readFile(new URL('../../supabase/migrations/202610160010_erp_finance.sql', import.meta.url), 'utf8');
  const current = await readFile(new URL('../../supabase/migrations/202610160019_document_effect_flags.sql', import.meta.url), 'utf8');
  const extract = (source, prefix) => { const start = source.indexOf(`${prefix} public.erp_finance_execute(`); return source.slice(start, source.indexOf('\nend $$;', start) + '\nend $$;'.length); };
  assert.equal(extract(current, 'create or replace function'), extract(original, 'create function').replace('create function', 'create or replace function').replace("return v_command.result||jsonb_build_object('replayed',true);", "return erp_finance.project_result_link(v_command.result)||jsonb_build_object('replayed',true);"));
});
