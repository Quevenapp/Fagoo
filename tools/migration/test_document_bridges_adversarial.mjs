import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseDocumentStockRoute, executeDocumentStockRoute } from '../../workers/erp-api/src/document-stock.mjs';

// Independent bridge regression probes. Local synthetic database only.
// PGlite is a single-session engine: these tests do not prove concurrent
// PostgreSQL interleavings. Lock order is also reviewed statically.
let db, contact, product, warehouse;
const users = {};
const code = expected => error => error.code === expected;
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
async function rpc(name, args) {
  const entries = Object.entries(args);
  await db.exec('SET ROLE service_role');
  try {
    return await scalar(`SELECT public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(',')}) AS value`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
  } finally { await db.exec('RESET ROLE'); }
}
const execute = (action, data) => rpc('erp_finance_execute', { p_user_id: users.admin, p_command_id: randomUUID(), p_action: action, p_data: data });
const transition = (doc, status, command = randomUUID()) => rpc('erp_document_transition', { p_user_id: users.admin, p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: command, p_status: status, p_reason: 'Conferência sintética' });
async function document() {
  const data = { date: '2026-10-16', contact_id: contact.id, items: [{ description: 'Item fictício', unit: 'UN', quantity: '2', unit_price: '1.005' }], installments: [{ due_date: '2026-11-01', amount: '1.00' }, { due_date: '2026-12-01', amount: '1.01' }] };
  let row = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: data })).document;
  row = (await transition(row, 'open')).document;
  return (await transition(row, 'verified')).document;
}
async function post(doc) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: doc.version };
  const { preview } = await rpc('erp_document_finance_preview', scope);
  const input = { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash };
  return { input, result: await rpc('erp_document_finance_post', input) };
}
async function reverse(doc, result) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: result.document_version, p_posting_id: result.posting.id, p_posting_version: result.posting.version };
  const { preview } = await rpc('erp_document_finance_reverse_preview', scope);
  const input = { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_title_versions: preview.titles.map(row => ({ id: row.id, version: row.version })), p_reason: 'Estorno sintético revisado' };
  return { input, result: await rpc('erp_document_finance_reverse', input) };
}
before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name)); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
  for (const name of ['202610160001_origin_sync.sql', '202610160002_origin_quotes_nfce.sql', '202610160004_erp_access.sql', '202610160006_erp_catalog.sql', '202610160008_erp_documents.sql', '202610160009_erp_stock.sql', '202610160010_erp_finance.sql', '202610160011_catalog_stock_lock_order.sql', '202610160014_erp_cnab.sql', '202610160017_document_finance.sql', '202610160018_document_stock.sql', '202610160019_document_effect_flags.sql']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  for (const role of ['admin', 'financeiro', 'consulta', 'vendas', 'estoque']) {
    users[role] = randomUUID();
    await db.query('INSERT INTO auth.users VALUES ($1)', [users[role]]);
    await db.query('INSERT INTO erp_access.membership(user_id,role) VALUES ($1,$2)', [users[role], role]);
  }
  contact = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Contato fictício adversarial' } })).record;
  product = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Produto fictício adversarial', unit: 'UN', kind: 'P' } })).record;
  warehouse = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'warehouses', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Depósito fictício adversarial' } })).record;
});
after(async () => db?.close());

test('finance post and reverse replays cannot resurrect a reversed effect or reverse a newer effect', async () => {
  const doc = await document(), first = await post(doc), undone = await reverse(doc, first.result);
  assert.equal(undone.result.posting.state, 'reversed');
  const oldPost = await rpc('erp_document_finance_post', first.input);
  assert.equal(oldPost.replayed, true);
  assert.equal(await scalar("SELECT count(*)::int value FROM erp_finance.document_posting WHERE document_id=$1 AND state='active'", [doc.id]), 0);
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.document_title WHERE posting_id=$1', [first.result.posting.id]), 2);
  assert.equal(await scalar('SELECT bool_and(cancelled) value FROM erp_finance.title WHERE group_id=$1', [first.result.posting.group_id]), true);
  const second = await post({ ...doc, version: undone.result.document_version });
  assert.notEqual(second.result.posting.id, first.result.posting.id);
  const oldReverse = await rpc('erp_document_finance_reverse', undone.input);
  assert.equal(oldReverse.replayed, true);
  assert.equal(await scalar("SELECT id value FROM erp_finance.document_posting WHERE document_id=$1 AND state='active'", [doc.id]), second.result.posting.id);
  assert.equal(await scalar('SELECT bool_and(NOT cancelled) value FROM erp_finance.title WHERE group_id=$1', [second.result.posting.group_id]), true);
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.movement'), 0);
});

test('active finance protects document and item economics; one cancelled title does not unlock the source', async () => {
  const doc = await document(), posted = await post(doc), title = posted.result.titles[0];
  await assert.rejects(() => db.query("UPDATE erp_documents.document SET total=1 WHERE id=$1", [doc.id]), code('40001'));
  await assert.rejects(() => db.query("UPDATE erp_documents.item SET quantity=1 WHERE document_id=$1", [doc.id]), code('40001'));
  await assert.rejects(() => db.query("DELETE FROM erp_documents.item WHERE document_id=$1", [doc.id]), code('40001'));
  await assert.rejects(() => execute('title_update', { id: title.id, expected_version: title.version, amount_cents: '99' }), code('40001'));
  await execute('title_cancel', { id: title.id, expected_version: title.version, note: 'Cancelamento individual fictício' });
  await assert.rejects(() => transition({ ...doc, version: posted.result.document_version }, 'open'), code('40001'));
  assert.equal(await scalar("SELECT state value FROM erp_finance.document_posting WHERE id=$1", [posted.result.posting.id]), 'active');
  const undone = await reverse(doc, posted.result);
  assert.equal(undone.result.posting.state, 'reversed');
  assert.ok(undone.result.titles.every(row => row.cancelled));
});

test('replay rechecks current membership and role instead of treating a command identifier as authority', async () => {
  const doc = await document(), posted = await post(doc);
  await db.query("UPDATE erp_access.membership SET role='vendas' WHERE user_id=$1", [users.admin]);
  try { await assert.rejects(() => rpc('erp_document_finance_post', posted.input), code('42501')); }
  finally { await db.query("UPDATE erp_access.membership SET role='admin' WHERE user_id=$1", [users.admin]); }
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1', [users.admin]);
  try { await assert.rejects(() => rpc('erp_document_finance_post', posted.input), code('42501')); }
  finally { await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1', [users.admin]); }
  for (const role of ['vendas', 'estoque']) await assert.rejects(() => rpc('erp_document_finance_get', { p_user_id: users[role], p_kind: doc.kind, p_document_id: doc.id, p_posting_id: posted.result.posting.id }), code('42501'));
});

async function purchase() {
  const data = { date: '2026-10-16', contact_id: contact.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, description: 'Item fictício', unit: 'UN', quantity: '0.123456', unit_price: '100' }, { product_id: product.id, description: 'Mesmo produto', unit: 'UN', quantity: '0.876544', unit_price: '100' }], installments: [{ due_date: '2026-11-01', amount: '100.00' }], internal_notes: 'DO_NOT_PROJECT_INTERNAL', payment_terms: 'DO_NOT_PROJECT_TERMS' };
  const row = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'purchase_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: data })).document;
  return (await transition(row, 'in_progress')).document;
}
async function stockPost(doc) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: doc.version, p_occurred_on: '2026-10-16', p_reason: 'Estoque sintético' };
  const { preview } = await rpc('erp_document_stock_preview', scope);
  const input = { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: preview.ignored.map(row => row.id) };
  return { input, preview, result: await rpc('erp_document_stock_post', input) };
}
async function stockReverse(doc, result) {
  const scope = { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: result.document_version, p_posting_id: result.posting.id, p_posting_version: result.posting.version, p_occurred_on: '2026-10-16', p_reason: 'Estorno estoque sintético' };
  const { preview } = await rpc('erp_document_stock_reverse_preview', scope);
  const input = { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash };
  return { input, result: await rpc('erp_document_stock_reverse', input) };
}
test('stock and financial guards coexist: reversing one effect never unlocks the other', async () => {
  const doc = await purchase(), finance = await post(doc), stock = await stockPost({ ...doc, version: finance.result.document_version });
  assert.equal(stock.preview.positions.length, 1);
  assert.equal(stock.preview.positions[0].quantity, '1.000000');
  assert.equal(stock.preview.positions[0].sources.length, 2);
  assert.doesNotMatch(JSON.stringify(stock.preview), /DO_NOT_PROJECT|unit_price|installments|contact_id|contact_snapshot/);
  const undoneFinance = await reverse(doc, { ...finance.result, document_version: stock.result.document_version });
  await assert.rejects(() => transition({ ...doc, version: undoneFinance.result.document_version }, 'cancelled'), code('40001'));
  const undoneStock = await stockReverse(doc, { ...stock.result, document_version: undoneFinance.result.document_version });
  const reopened = await transition({ ...doc, version: undoneStock.result.document_version }, 'cancelled');
  assert.equal(reopened.document.status, 'cancelled');
  assert.equal(await scalar('SELECT quantity::text value FROM erp_stock.balance WHERE product_id=$1 AND warehouse_id=$2', [product.id, warehouse.id]), '0.000000');
});

test('stock replay after reversal cannot resurrect balances or reverse a newer posting; legacy reversal is blocked', async () => {
  const doc = await purchase(), first = await stockPost(doc);
  const versions = first.preview.positions.map(row => ({ product_id: row.product_id, warehouse_id: row.warehouse_id, expected_version: row.expected_version + 1 }));
  await assert.rejects(() => rpc('erp_stock_reverse', { p_user_id: users.admin, p_movement_id: first.result.posting.movement_id, p_command_id: randomUUID(), p_occurred_on: '2026-10-16', p_reason: 'Via antiga não permitida', p_versions: versions }), code('40001'));
  const undone = await stockReverse(doc, first.result);
  assert.equal((await rpc('erp_document_stock_post', first.input)).replayed, true);
  assert.equal(await scalar('SELECT quantity::text value FROM erp_stock.balance WHERE product_id=$1 AND warehouse_id=$2', [product.id, warehouse.id]), '0.000000');
  const second = await stockPost({ ...doc, version: undone.result.document_version });
  assert.equal((await rpc('erp_document_stock_reverse', undone.input)).replayed, true);
  assert.equal(await scalar("SELECT id value FROM erp_stock.document_posting WHERE document_id=$1 AND state='active'", [doc.id]), second.result.posting.id);
  assert.equal(await scalar('SELECT quantity::text value FROM erp_stock.balance WHERE product_id=$1 AND warehouse_id=$2', [product.id, warehouse.id]), '1.000000');
  await stockReverse(doc, second.result);
});

test('stock-only projection excludes commercial fields and revoked or unrelated roles cannot replay', async () => {
  const doc = await purchase(), posted = await stockPost(doc);
  const view = await rpc('erp_document_stock_get', { p_user_id: users.estoque, p_kind: doc.kind, p_document_id: doc.id });
  assert.doesNotMatch(JSON.stringify(view), /DO_NOT_PROJECT|unit_price|installments|contact_id|contact_snapshot|total|price/);
  for (const role of ['vendas', 'financeiro', 'consulta']) {
    await db.query('UPDATE erp_access.membership SET role=$2 WHERE user_id=$1', [users.admin, role]);
    try { await assert.rejects(() => rpc('erp_document_stock_post', posted.input), code('42501')); }
    finally { await db.query("UPDATE erp_access.membership SET role='admin' WHERE user_id=$1", [users.admin]); }
  }
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1', [users.admin]);
  try { await assert.rejects(() => rpc('erp_document_stock_post', posted.input), code('42501')); }
  finally { await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1', [users.admin]); }
});

test('stock overflow is rejected as validation before numeric typmod casting, without effects', async () => {
  const limitProduct = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: 'Produto limite fictício', unit: 'UN', kind: 'P' } })).record;
  await rpc('erp_stock_post', { p_user_id: users.admin, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: '2026-10-16', p_reason: 'Saldo máximo sintético', p_items: [{ product_id: limitProduct.id, warehouse_id: warehouse.id, quantity: '999999999999.999999', expected_version: 0 }] });
  const data = { date: '2026-10-16', contact_id: contact.id, warehouse_id: warehouse.id, items: [{ product_id: limitProduct.id, description: 'Item limite fictício', unit: 'UN', quantity: '0.000001', unit_price: '1' }] };
  let doc = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: 'purchase_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: data })).document;
  doc = (await transition(doc, 'in_progress')).document;
  await assert.rejects(() => rpc('erp_document_stock_preview', { p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, p_expected_version: doc.version, p_occurred_on: '2026-10-16', p_reason: 'Excesso sintético' }), code('22023'));
  assert.equal(await scalar('SELECT quantity::text value FROM erp_stock.balance WHERE product_id=$1 AND warehouse_id=$2', [limitProduct.id, warehouse.id]), '999999999999.999999');
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_stock.document_posting WHERE document_id=$1', [doc.id]), 0);
});

test('stock HTTP mutation binds response scope, direction and date to the requested operation', async () => {
  const doc = await purchase(), posted = await stockPost(doc);
  const route = { operation: 'post', rpc: 'erp_document_stock_post', args: posted.input };
  const invoke = result => executeDocumentStockRoute(route, { userId: users.admin, rpc: async () => result });
  assert.equal((await invoke(posted.result)).posting.direction, 'receipt');
  const wrongDocument = structuredClone(posted.result);
  wrongDocument.document_id = randomUUID(); wrongDocument.posting.document_id = wrongDocument.document_id;
  await assert.rejects(() => invoke(wrongDocument), error => error.status === 502);
  const wrongDirection = structuredClone(posted.result);
  wrongDirection.posting.direction = 'issue'; wrongDirection.movement.kind = 'issue';
  await assert.rejects(() => invoke(wrongDirection), error => error.status === 502);
  const wrongDate = structuredClone(posted.result); wrongDate.movement.occurred_on = '2000-01-01';
  await assert.rejects(() => invoke(wrongDate), error => error.status === 502);
  const uppercase = await parseDocumentStockRoute(new Request(`https://example.test/v1/documentos-estoque/${doc.kind}/${doc.id.toUpperCase()}`));
  assert.equal(uppercase.args.p_document_id, doc.id);
});
