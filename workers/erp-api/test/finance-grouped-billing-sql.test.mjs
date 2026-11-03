import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 174: Faturamento agrupado (pedidos por cliente, GERAR CONTAS pela condição, travas e exclusão) e as
// preferências de lançamento de contas dos documentos (número do documento e data atual das OS).
let env; let db; let users; let scalar; let rpc; let alfa; let beta;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDays = (value, days) => { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const savePreferences = async (pageId, changes) => {
  const current = await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: pageId });
  return rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: pageId, p_changes: JSON.stringify(Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(item => item.key === key).version, value }))) });
};
async function order(contact, price, { kind = 'sales_orders', date = today, installments } = {}) {
  const body = { date, contact_id: contact.id, items: [{ description: 'Item sintético', unit: 'UN', quantity: '1', unit_price: price, discount_percent: '0' }], installments: installments ?? [] };
  let document = (await rpc('erp_document_save', { p_user_id: users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body })).document;
  const path = kind === 'service_orders' ? (document.status === 'draft' ? ['open', 'approved'] : ['approved']) : (document.status === 'draft' ? ['open', 'verified'] : ['verified']);
  for (const status of path) document = (await rpc('erp_document_transition', { p_user_id: users.admin, p_kind: kind, p_id: document.id, p_expected_version: document.version, p_command_id: randomUUID(), p_status: status, p_reason: 'Teste sintético' })).document;
  return document;
}

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' }); beta = await env.contact({ name: 'Beta Sintética' });
});
after(async () => db?.close());

test('174 RPCs are service-only security definer functions; tables closed; vendas cannot bill', async () => {
  for (const name of ['erp_finance_grouped_billing_candidates', 'erp_finance_grouped_billing_documents', 'erp_finance_grouped_billing_page', 'erp_finance_grouped_billing_execute']) {
    const fn = (await db.query("SELECT p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name])).rows[0];
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']]);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [fn.signature, role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const table of ['erp_finance.grouped_billing', 'erp_finance.grouped_billing_document', 'erp_finance.grouped_billing_title']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => call(`/v1/financeiro/faturamento-agrupado?from=${today}&to=${today}`, {}, users[role]), http(403));
});

test('174 GERAR CONTAS groups the pedidos of each cliente by the Condição; the pedidos are locked until Excluir', async () => {
  const a1 = await order(alfa, '100'), a2 = await order(alfa, '50.01'), b1 = await order(beta, '30');
  const candidates = await call(`/v1/financeiro/faturamento-agrupado?from=${today}&to=${today}`, {}, users.consulta);
  assert.deepEqual(candidates.items.map(item => [item.contact_name, item.documents, item.total_cents]), [['Alfa Sintética', 2, '15001'], ['Beta Sintética', 1, '3000']]);
  const documents = await call(`/v1/financeiro/faturamento-agrupado/documentos?contact=${alfa.id}&from=${today}&to=${today}`, {}, users.consulta);
  assert.deepEqual(documents.items.map(item => item.number), [String(a1.number), String(a2.number)]);
  const item = { contact_id: alfa.id, document_ids: [a1.id, a2.id], total_cents: '15001', condition: '30 60', days: [30, 60] };
  await assert.rejects(() => act('grouped_billing_generate', { items: [{ ...item, total_cents: '15000' }] }), http(409), 'the total read is the CAS');
  await assert.rejects(() => act('grouped_billing_generate', { items: [{ ...item, document_ids: [a1.id, b1.id], total_cents: '13000' }] }), http(409), 'a pedido of another cliente');
  await assert.rejects(() => act('grouped_billing_generate', { items: [{ ...item, days: [60, 30] }] }), http(400));
  const command = randomUUID();
  const generated = await act('grouped_billing_generate', { items: [item, { contact_id: beta.id, document_ids: [b1.id], total_cents: '3000', condition: '0', days: [0] }] }, users.financeiro, command);
  assert.equal((await act('grouped_billing_generate', { items: [item, { contact_id: beta.id, document_ids: [b1.id], total_cents: '3000', condition: '0', days: [0] }] }, users.financeiro, command)).replayed, true);
  const [alfaBilling] = generated.items;
  assert.deepEqual(alfaBilling.titles.map(title => [title.position, title.due_on, title.amount_cents]), [[1, addDays(today, 30), '7501'], [2, addDays(today, 60), '7500']]);
  const title = (await db.query('SELECT description,kind,contact_id,installments FROM erp_finance.title WHERE id=$1', [alfaBilling.titles[0].id])).rows[0];
  assert.deepEqual([title.kind, title.contact_id, title.installments], ['receivable', alfa.id, 2]);
  assert.equal(title.description, `Faturamento agrupado: pedidos nº ${a1.number}, ${a2.number}`);
  // The pedidos left the candidates, cannot be lançados again nor edited.
  assert.equal((await call(`/v1/financeiro/faturamento-agrupado?from=${today}&to=${today}`, {}, users.consulta)).total, 0);
  await assert.rejects(() => rpc('erp_document_finance_preview', { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: a1.id, p_expected_version: a1.version }), error => error.code === '40001');
  await assert.rejects(() => db.query("UPDATE erp_documents.document SET total=1 WHERE id=$1", [a1.id]), error => error.code === '40001');
  await assert.rejects(() => db.query('UPDATE erp_finance.title SET amount_cents=1 WHERE id=$1', [alfaBilling.titles[0].id]), error => error.code === '40001', 'the contas keep cliente and valor');
  await assert.rejects(() => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_delete', p_data: { id: alfaBilling.titles[0].id, expected_version: 1 } }), error => error.code === '40001', 'a conta leaves only with its faturamento');
  assert.equal(await scalar("SELECT erp_finance.dto('titles',$1)->>'grouped_billing_id' AS value", [alfaBilling.titles[0].id]), alfaBilling.id, 'the conta knows its faturamento (175)');
  const listed = await call('/v1/financeiro/faturamento-agrupado/gerados', {}, users.consulta);
  assert.deepEqual(listed.items.map(row => [row.contact_name, row.deletable]).sort(), [['Alfa Sintética', true], ['Beta Sintética', true]]);
  // A baixa keeps the faturamento; without it Excluir cancels the contas and frees the pedidos.
  const betaBilling = generated.items[1];
  const account = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa', start_on: '2020-01-01', opening_cents: '0' } })).record;
  await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle', p_data: { id: betaBilling.titles[0].id, expected_version: 1, account_id: account.id, posted_on: today, principal_cents: '1000' } });
  await assert.rejects(() => act('grouped_billing_delete', { id: betaBilling.id, expected_version: betaBilling.version }), http(409));
  await assert.rejects(() => act('grouped_billing_delete', { id: alfaBilling.id, expected_version: 9 }), http(409));
  const removed = await act('grouped_billing_delete', { id: alfaBilling.id, expected_version: alfaBilling.version });
  assert.equal(removed.record.deleted, true);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.title WHERE group_id=$1 AND cancelled AND deleted_at IS NOT NULL', [alfaBilling.id]), 2);
  assert.equal((await call(`/v1/financeiro/faturamento-agrupado?from=${today}&to=${today}`, {}, users.consulta)).items[0].documents, 2, 'the pedidos are free again');
  const selected = await call(`/v1/financeiro/faturamento-agrupado?documents=${a1.id},${a2.id}`, {}, users.consulta);
  assert.deepEqual([selected.selected, selected.items[0].total_cents], [true, '15001'], 'Faturar pedidos selecionados reads only those pedidos');
});

test('174 Preferências: número da venda/OS no Nº documento and "Utilizar data atual" in the contas of an OS', async () => {
  await savePreferences('vendas-vendas', { 'vendas.numero_documento_conta': true });
  const sale = await order(alfa, '20', { installments: [{ due_date: addDays(today, 10), amount: '20.00' }] });
  const scope = { p_user_id: users.admin, p_kind: 'sales_orders', p_document_id: sale.id, p_expected_version: sale.version };
  const preview = await rpc('erp_document_finance_preview', scope);
  const posted = await rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  assert.equal(await scalar('SELECT source_reference AS value FROM erp_finance.title WHERE id=$1', [posted.titles[0].id]), String(sale.number));
  await savePreferences('servicos-os', { 'os.data_contas': 'recalcular', 'os.numero_documento_conta': true });
  const past = addDays(today, -20);
  const os = await order(alfa, '40', { kind: 'service_orders', date: past, installments: [{ due_date: addDays(past, 10), amount: '20.00' }, { due_date: addDays(past, 40), amount: '20.00' }] });
  const osScope = { p_user_id: users.admin, p_kind: 'service_orders', p_document_id: os.id, p_expected_version: os.version };
  const osPreview = await rpc('erp_document_finance_preview', osScope);
  assert.deepEqual([osPreview.preview.issued_on, osPreview.preview.installments.map(part => part.due_on)], [today, [addDays(today, 10), addDays(today, 40)]], 'recalcular keeps the distance to the OS date from today');
  await savePreferences('servicos-os', { 'os.data_contas': 'data_atual' });
  const current = await rpc('erp_document_finance_preview', osScope);
  assert.deepEqual(current.preview.installments.map(part => part.due_on), [today, today]);
  const osPosted = await rpc('erp_document_finance_post', { ...osScope, p_command_id: randomUUID(), p_preview_hash: current.preview.preview_hash });
  assert.equal(await scalar('SELECT source_reference AS value FROM erp_finance.title WHERE id=$1', [osPosted.titles[0].id]), String(os.number));
  await savePreferences('servicos-os', { 'os.data_contas': 'nao', 'os.numero_documento_conta': false });
  await savePreferences('vendas-vendas', { 'vendas.numero_documento_conta': false });
});
