import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';

// 202610200163 (Gerenciador de transições adotado pelos documentos) on PGlite through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsCFixture({ upto: '202610200163' }); });
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const status = (kind, doc, target, user, reason = null, command = randomUUID()) => f.call(`/v1/documentos/${kind}/${doc.id}/status`, 'POST', { command_id: command, expected_version: doc.version, status: target, reason }, user);
const read = async (kind, id) => (await ok(`/v1/documentos/${kind}/${id}`)).document;
const row = async (kind, id, q = '') => (await ok(`/v1/documentos/${kind}?page=1${q}`)).items.find(item => item.id === id);

test('163 grants, adoption and private helpers', async () => {
  assert.deepEqual((await f.db.query('select kind,migration from erp_preferences.situation_adoption order by kind')).rows,
    [{ kind: 'purchase_orders', migration: '202610200163' }, { kind: 'sales_orders', migration: '202610200163' }, { kind: 'service_orders', migration: '202610200163' }]);
  for (const fn of ['public.erp_document_situations(uuid,text)', 'public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)',
    'public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, `${role} ${fn}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
    assert.equal(await f.scalar("select proconfig::text v from pg_proc where oid=$1::regprocedure", [fn]), '{search_path=pg_catalog}');
  }
  for (const fn of ['erp_documents.transition_action(uuid,text,uuid,uuid,text,text)', 'erp_documents.situation_json(text,text,uuid)', 'erp_documents.document_view(uuid)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  assert.equal(await f.scalar("select relrowsecurity v from pg_class where oid='erp_documents.document_situation'::regclass"), true);
  assert.equal(await f.scalar("select has_table_privilege('service_role','erp_documents.document_situation','SELECT') v"), false);
  // The old 27-argument list is gone, so named calls are never ambiguous.
  assert.equal(await f.scalar("select count(*)::int v from pg_proc where proname='erp_document_list' and pronamespace='public'::regnamespace"), 1);
});

test('situações page for document readers, custom situação reached only through a configured transition', async () => {
  const custom = await f.situation('sales_orders', 'open', 'Aguardando pagamento', '#ff8800');
  const page = await ok('/v1/documentos/sales_orders/situacoes', 'GET', undefined, f.users.vendas);
  assert.equal(page.adopted, true);
  assert.deepEqual(page.situations.find(item => item.key === custom), { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false, active: true });
  assert.equal(page.situations.find(item => item.key === 'open').name, 'Em aberto');
  assert.equal(page.occurrence_date_editable, false);
  assert.equal((await f.call('/v1/documentos/sales_orders/situacoes', 'GET', undefined, f.users.estoque)).status, 200);
  assert.equal((await f.call('/v1/documentos/purchase_orders/situacoes', 'GET', undefined, f.users.vendas)).status, 403);
  const proposals = await ok('/v1/documentos/sales_proposals/situacoes');
  assert.deepEqual([proposals.adopted, proposals.situations, proposals.transitions], [false, [], []]);

  const doc = await f.create('sales_orders');
  assert.deepEqual((await row('sales_orders', doc.id)).situation, { key: 'open', base_status: 'open', name: 'Em aberto', color: '#e6a700', default: true });
  // Not configured yet: refused, nothing changes.
  assert.equal((await status('sales_orders', doc, custom, f.users.vendas)).status, 400);
  await f.transition('sales_orders', 'open', custom);
  const moved = await ok(`/v1/documentos/sales_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: custom, reason: null }, f.users.vendas);
  assert.equal(moved.document.status, 'open');
  assert.equal(moved.document.situation.key, custom);
  assert.deepEqual(moved.effects, []);
  const listed = await row('sales_orders', doc.id);
  assert.deepEqual([listed.status, listed.situation.name, listed.situation.default], ['open', 'Aguardando pagamento', false]);
  // Exact situações filter; the status filter still groups by the situação-base.
  assert.ok(await row('sales_orders', doc.id, `&situation=${custom}`));
  assert.equal(await row('sales_orders', doc.id, '&situation=open'), undefined);
  assert.ok(await row('sales_orders', doc.id, '&status=open'));
  assert.equal((await f.call(`/v1/documentos/sales_orders?page=1&situation=${custom}&status=open`)).status, 400);
  assert.equal((await f.call(`/v1/documentos/sales_proposals?page=1&situation=open`)).status, 400);
  assert.equal((await f.call(`/v1/documentos/sales_orders?page=1&situation=${randomUUID()}`)).status, 400);
  // The occurrence keeps the situação of the moment.
  const occurrences = await ok(`/v1/documentos/sales_orders/${doc.id}/ocorrencias`);
  assert.equal(occurrences.document.situation.key, custom);
  assert.deepEqual([occurrences.items[0].status_before, occurrences.items[0].status_after, occurrences.items[0].situation_before.name, occurrences.items[0].situation_after.name], ['open', null, 'Em aberto', 'Aguardando pagamento']);
  // Back to the default needs its own configured transition.
  const current = await read('sales_orders', doc.id);
  assert.equal((await status('sales_orders', current, 'open', f.users.vendas)).status, 400);
  // The default pairs follow the document rule from the custom one only when configured.
  await f.transition('sales_orders', custom, 'verified');
  const verified = await ok(`/v1/documentos/sales_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: current.version, status: 'verified', reason: null });
  assert.deepEqual([verified.document.status, verified.document.situation.key], ['verified', 'verified']);
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.document_situation where document_id=$1', [doc.id]), 0);
});

test('deactivated transitions and situações are refused; the reason rule follows the situação-base', async () => {
  const doc = await f.create('service_orders');
  await f.transition('service_orders', 'open', 'quoted', { active: false, actions: [] });
  assert.equal((await status('service_orders', doc, 'quoted')).status, 400);
  assert.equal((await status('service_orders', doc, 'cancelled')).status, 400); // reason required
  const cancelled = await ok(`/v1/documentos/service_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: 'cancelled', reason: 'Cliente desistiu' });
  assert.equal(cancelled.document.status, 'cancelled');
  // An inactive target situação.
  const custom = await f.situation('service_orders', 'open', 'Retorno agendado');
  await f.transition('service_orders', 'cancelled', custom);
  await f.rpc('erp_preferences_situation_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_kind: 'service_orders', p_situation: custom, p_expected_version: 1, p_data: { active: false, base_status: 'open', color: '#123456', name: 'Retorno agendado' } });
  assert.equal((await status('service_orders', cancelled.document, custom, undefined, 'Reabrindo')).status, 400);
  // Same command repeated: the server replays it.
  const again = await ok(`/v1/documentos/service_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: cancelled.document.version, status: 'open', reason: 'Reaberta' });
  assert.equal(again.document.status, 'open');
});

test('a status changed by another path returns the document to the situação padrão', async () => {
  const custom = await f.situation('purchase_orders', 'open', 'Cotação enviada');
  await f.transition('purchase_orders', 'open', custom);
  const doc = await f.create('purchase_orders', { items: [f.line({ product_id: f.product.id, description: 'Produto sintético C' })] });
  const moved = await ok(`/v1/documentos/purchase_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: custom, reason: null });
  assert.equal(moved.document.situation.key, custom);
  await f.db.query("update erp_documents.document set status='in_progress',version=version+1 where id=$1", [doc.id]);
  assert.deepEqual((await read('purchase_orders', doc.id)).situation, { key: 'in_progress', base_status: 'in_progress', name: 'Em andamento', color: '#1e88e5', default: true });
});

test('transition actions run with the user profile: Lançar/Estornar estoque e contas in the same transaction', async () => {
  const warehouse = (await f.catalog('warehouses', { name: 'Depósito sintético C' })).id;
  const category = (await f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'payable', name: 'Compras sintéticas' } })).record.id;
  const doc = await f.create('purchase_orders', { warehouse_id: warehouse, items: [f.line({ product_id: f.product.id, description: 'Produto sintético C', quantity: '3' })], installments: [{ due_date: '2026-11-20', amount: '30.00', method: null }] });
  await f.transition('purchase_orders', 'open', 'in_progress', { active: true, actions: ['post_finance', 'post_stock'] });
  // Without the Padrão compra category the change is refused and nothing is posted.
  assert.equal((await status('purchase_orders', doc, 'in_progress')).status, 400);
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.document_posting where document_id=$1', [doc.id]), 0);
  const defaults = await f.scalar("select version v from erp_finance.category_default where key='purchase'");
  await f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'category_set_default', p_data: { key: 'purchase', category_id: category, expected_version: defaults } });
  // The estoque profile cannot post contas: the whole change is refused.
  assert.equal((await status('purchase_orders', doc, 'in_progress', f.users.estoque)).status, 403);
  assert.equal((await read('purchase_orders', doc.id)).status, 'open');
  const command = randomUUID();
  const posted = await ok(`/v1/documentos/purchase_orders/${doc.id}/status`, 'POST', { command_id: command, expected_version: doc.version, status: 'in_progress', reason: null });
  assert.deepEqual(posted.effects.map(item => `${item.action}:${item.outcome}`), ['post_stock:done', 'post_finance:done']);
  assert.equal(posted.document.status, 'in_progress');
  assert.equal(await f.scalar("select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2", [f.product.id, warehouse]), '3.000000');
  assert.equal(await f.scalar("select count(*)::int v from erp_finance.title t join erp_finance.document_title l on l.title_id=t.id join erp_finance.document_posting p on p.id=l.posting_id where p.document_id=$1 and t.category_id=$2", [doc.id, category]), 1);
  // Replaying the same command returns the original answer without posting twice.
  const replay = await ok(`/v1/documentos/purchase_orders/${doc.id}/status`, 'POST', { command_id: command, expected_version: doc.version, status: 'in_progress', reason: null });
  assert.equal(replay.replayed, true);
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.document_posting where document_id=$1', [doc.id]), 1);
  // Estornos run before the change of situação.
  await f.transition('purchase_orders', 'in_progress', 'cancelled', { active: true, actions: ['reverse_finance', 'reverse_stock'] });
  const current = await read('purchase_orders', doc.id);
  const reversed = await ok(`/v1/documentos/purchase_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: current.version, status: 'cancelled', reason: 'Fornecedor cancelou' });
  assert.deepEqual(reversed.effects.map(item => `${item.action}:${item.outcome}`), ['reverse_stock:done', 'reverse_finance:done']);
  assert.equal(await f.scalar("select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2", [f.product.id, warehouse]), '0.000000');
  assert.equal(await f.scalar("select count(*)::int v from erp_finance.document_posting where document_id=$1 and state='active'", [doc.id]), 0);
  // Nothing active to reverse: skipped, the change still happens.
  await f.transition('purchase_orders', 'cancelled', 'open', { active: true, actions: ['reverse_stock'] });
  const reopened = await ok(`/v1/documentos/purchase_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: reversed.document.version, status: 'open', reason: 'Reaberto' });
  assert.deepEqual(reopened.effects, [{ action: 'reverse_stock', outcome: 'skipped' }]);
});

test('Permite a edição da data e hora das ocorrências: off keeps the current moment, on accepts up to now', async () => {
  const doc = await f.create('sales_orders');
  const add = (body, user) => f.call(`/v1/documentos/sales_orders/${doc.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: doc.version, text: 'Contato com o cliente', ...body }, user);
  const off = await add({ occurred_on: '2026-01-01', occurred_time: '08:00' });
  assert.equal(off.status, 200);
  assert.notEqual(off.value.occurrence.occurred_on, '2026-01-01');
  await f.setPreference('empresa-geral', 'empresa.editar_data_ocorrencia', true);
  assert.equal((await ok(`/v1/documentos/sales_orders/${doc.id}/ocorrencias`)).date_editable, true);
  const on = await add({ occurred_on: '2026-01-01', occurred_time: '08:00' });
  assert.deepEqual([on.value.occurrence.occurred_on, on.value.occurrence.occurred_time], ['2026-01-01', '08:00']);
  assert.equal((await add({ occurred_on: '2099-01-01', occurred_time: '08:00' })).status, 400);
  await f.setPreference('empresa-geral', 'empresa.editar_data_ocorrencia', false);
});

test('Tornar padrão accepts custom situações of the kind; the worker refuses keys of other kinds', async () => {
  const custom = await f.situation('service_orders', 'quoted', 'Orçamento enviado');
  const view = await ok('/v1/documentos/service_orders/preferencias-listagem');
  const saved = await ok('/v1/documentos/service_orders/preferencias-listagem', 'POST', { command_id: randomUUID(), expected_version: view.version, custom_view: false, columns: [], default_statuses: ['open', custom] });
  assert.deepEqual(saved.default_statuses, ['open', custom]);
  const proposal = await ok('/v1/documentos/sales_proposals/preferencias-listagem');
  assert.equal((await f.call('/v1/documentos/sales_proposals/preferencias-listagem', 'POST', { command_id: randomUUID(), expected_version: proposal.version, custom_view: false, columns: [], default_statuses: [custom] })).status, 400);
  const other = await f.situation('sales_orders', 'open', 'Outra situação');
  const again = await ok('/v1/documentos/service_orders/preferencias-listagem');
  assert.equal((await f.call('/v1/documentos/service_orders/preferencias-listagem', 'POST', { command_id: randomUUID(), expected_version: again.version, custom_view: false, columns: [], default_statuses: [other] })).status, 400);
});

test('propostas keep the 103 transitions and the nota vinculada flag reaches every profile', async () => {
  const proposal = await f.create('sales_proposals');
  assert.equal((await status('sales_proposals', proposal, randomUUID())).status, 400);
  const moved = await ok(`/v1/documentos/sales_proposals/${proposal.id}/status`, 'POST', { command_id: randomUUID(), expected_version: proposal.version, status: 'open', reason: null });
  assert.equal(moved.document.status, 'open');
  assert.equal(moved.effects, undefined);
  const listed = await row('sales_proposals', proposal.id);
  assert.deepEqual([listed.situation, listed.invoice_linked], [null, false]);
  const order = await f.create('sales_orders');
  for (const user of [f.users.vendas, f.users.consulta]) assert.equal((await ok(`/v1/documentos/sales_orders?page=1`, 'GET', undefined, user)).items.find(item => item.id === order.id).invoice_linked, false);
});
