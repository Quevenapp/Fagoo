import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { posFixture, today } from './helpers/pos-fixture.mjs';
import { parsePosRoute, executePosRoute, posRoute, posRefusal } from '../src/pos.mjs';

// Synthetic data only. 202610200204-206: Frente de caixa (PDV) — contexto, configurações, favoritos, venda finalizada com estoque,
// contas e baixa no caixa, pré-venda e mesa, cancelamento, devolução e o resumo do caixa, sempre pelo Worker real.
let f;
before(async () => {
  f = await posFixture();
  await f.receive(f.product.id, '50'); await f.receive(f.other.id, '5');
});
after(async () => f?.close());

const item = (product, quantity = '1', price, extra = {}) => ({ id: randomUUID(), product_id: product.id, description: product.name, code: product.code ?? null, unit: 'UN', quantity,
  unit_price: price ?? String(Number(product.price ?? '0')), discount_percent: '0', detailed_description: null, ...extra });
const sale = (extra = {}, document = {}) => ({ sale_id: null, expected_version: 0, document_version: null, kind: 'balcao', table_number: null, account_id: f.store.id, cash_session_id: null, contact_id: null, price_list_id: null,
  document: { date: today(), warehouse_id: f.warehouse.id, items: [item(f.product, '2', '10')], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', notes: null, internal_notes: null,
    seller_id: null, category_id: null, ...document },
  payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '2000', note: null }], destination_account_id: null, to_ledger: false, cash_received_cents: null, ...extra });
const act = (action, data, user = f.users.admin, command = randomUUID()) => f.call(`/v1/frente-caixa/actions/${action}`, 'POST', { command_id: command, data }, user);
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; };
const refused = (response, status, field) => { assert.equal(response.status, status, JSON.stringify(response.value)); if (field) assert.equal(response.value.error.field, field); assert.doesNotMatch(JSON.stringify(response.value), /erp_|SYNTHETIC_SQL/); };
const openSession = async (user = f.users.admin, account = f.store.id, change = '5000') => (await f.rpc('erp_finance_cash_session_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: 'session_open', p_data: { account_id: account, change_cents: change } })).record;
const closeSession = async session => { const current = (await f.rpc('erp_finance_cash_session_get', { p_user_id: f.users.admin, p_id: session.id })).record;
  return f.rpc('erp_finance_cash_session_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'session_close', p_data: { id: session.id, expected_version: current.version, values: [] } }); };
const settingsVersion = async () => Number(await f.scalar('select version v from erp_pos.settings'));
const setConsumer = async contact => ok(await act('settings_save', { expected_version: await settingsVersion(), consumer_contact_id: contact, pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null }));

test('PDV RPCs are service-only security definer functions; the erp_pos tables and internal functions are closed', async () => {
  const fns = (await f.db.query("select p.proname,p.prosecdef,p.proconfig,p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'erp_pos_%'")).rows;
  assert.deepEqual(fns.map(row => row.proname).sort(), ['erp_pos_cash_summary', 'erp_pos_context', 'erp_pos_favorites', 'erp_pos_order', 'erp_pos_return_execute', 'erp_pos_sale_execute', 'erp_pos_sale_get', 'erp_pos_sales', 'erp_pos_settings_execute']);
  for (const fn of fns) {
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']], fn.sig);
    for (const role of ['anon', 'authenticated']) assert.equal((await f.db.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn.sig])).rows[0].v, false);
    assert.equal((await f.db.query("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn.sig])).rows[0].v, true);
  }
  for (const table of ['settings', 'favorite', 'sale', 'sale_payment', 'sale_return', 'command', 'audit']) for (const role of ['anon', 'authenticated', 'service_role'])
    assert.equal((await f.db.query("select has_table_privilege($1,$2,'SELECT') v", [role, `erp_pos.${table}`])).rows[0].v, false);
  const internal = (await f.db.query("select p.oid::regprocedure::text sig,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_pos'")).rows;
  assert.ok(internal.length > 10);
  for (const fn of internal) { assert.deepEqual(fn.proconfig, ['search_path=pg_catalog'], fn.sig); assert.equal((await f.db.query("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn.sig])).rows[0].v, false, fn.sig); }
});

test('PDV context: lojas, formas de pagamento, depósitos, preferências and the certificate state, by role', async () => {
  const context = ok(await f.call('/v1/frente-caixa'));
  assert.deepEqual(context.stores.map(row => row.name), ['Caixa loja sintética']);
  assert.deepEqual(context.methods.map(row => row.description).sort(), ['Cartão de crédito', 'Dinheiro', 'Pix']);
  assert.deepEqual([context.settings.cash_control, context.settings.tables, context.settings.receipt_order, context.settings.shortcuts.finalizar, context.certificate], [false, false, 'insercao', 'S', 'missing']);
  assert.deepEqual(context.effects, { cash: true, contacts: true, finance: true, fiscal: true, settings: true, stock: true });
  const vendas = ok(await f.call('/v1/frente-caixa', 'GET', undefined, f.users.vendas));
  assert.deepEqual([vendas.effects.stock, vendas.effects.finance, vendas.effects.cash, vendas.permissions.finish], [false, false, false, true]);
  for (const role of ['consulta', 'financeiro']) assert.equal(ok(await f.call('/v1/frente-caixa', 'GET', undefined, f.users[role])).permissions.operate, false);
  for (const role of ['estoque', 'fiscal', 'inactive']) refused(await f.call('/v1/frente-caixa', 'GET', undefined, f.users[role]), 403);
  refused(await act('favorite_add', { product_id: f.product.id }, f.users.consulta), 403, 'access_denied');
  refused(await f.call('/v1/frente-caixa?x=1'), 400);
  assert.equal((await f.call('/v1/frente-caixa/vendas/1')).status, 404);
});

test('Configurações do PDV: cliente padrão and chave Pix only by the administrador, with CAS and idempotency', async () => {
  const command = randomUUID(), data = { expected_version: await settingsVersion(), consumer_contact_id: f.consumer.id, pix_key_type: 'email', pix_key: 'pix@sintetico.test', pix_merchant_name: 'BRUFAP SINTETICA', pix_merchant_city: 'SAO PAULO' };
  refused(await act('settings_save', data, f.users.vendas), 403, 'access_denied');
  const saved = ok(await act('settings_save', data, f.users.admin, command));
  assert.equal(ok(await act('settings_save', data, f.users.admin, command)).replayed, true);
  refused(await act('settings_save', { ...data, pix_key: 'outra@sintetico.test' }, f.users.admin, command), 409);
  refused(await act('settings_save', data), 409, 'version_conflict');
  refused(await act('settings_save', { ...data, expected_version: saved.record.version, pix_key_type: 'cpf', pix_key: '123' }), 400, 'pix_key_invalid');
  refused(await act('settings_save', { ...data, expected_version: saved.record.version, pix_merchant_name: 'Nome com acentuação' }), 400);
  const context = ok(await f.call('/v1/frente-caixa', 'GET', undefined, f.users.vendas));
  assert.deepEqual([context.consumer.name, context.pix.key, context.pix.merchant_city], ['Consumidor final', 'pix@sintetico.test', 'SAO PAULO']);
});

test('Ver favoritos: any operator adds and removes; the list brings the stock of the chosen depósito', async () => {
  ok(await act('favorite_add', { product_id: f.product.id }, f.users.vendas));
  ok(await act('favorite_add', { product_id: f.other.id }, f.users.vendas));
  let list = ok(await f.call(`/v1/frente-caixa/favoritos?warehouse=${f.warehouse.id}`, 'GET', undefined, f.users.vendas));
  assert.deepEqual(list.items.map(row => [row.name, row.code, row.unit]), [['Caderno sintético', 'CAD-01', 'UN'], ['Caneta sintética', 'CAN-01', 'UN']]);
  assert.match(list.items[1].stock, /^\d+\.000000$/);
  ok(await act('favorite_remove', { product_id: f.other.id }));
  list = ok(await f.call('/v1/frente-caixa/favoritos', 'GET', undefined, f.users.consulta));
  assert.deepEqual(list.items.map(row => row.name), ['Caneta sintética']);
  refused(await act('favorite_add', { product_id: randomUUID() }), 400);
});

test('Finalizar venda (administrador): pedido Atendido, estoque, contas, baixa à vista no caixa, troco and replay', async () => {
  await setConsumer(f.consumer.id);
  const before = { stock: await f.stock(f.product.id), store: await f.balance(f.store.id), bank: await f.balance(f.bank.id) };
  const data = sale({ cash_received_cents: '5000', payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1500', note: null },
    { payment_method_id: f.methods.pix, days: 0, amount_cents: '1000', note: null }, { payment_method_id: f.methods.cartao, days: 30, amount_cents: '1550', note: 'Cartão em 30 dias' }] },
  { items: [item(f.product, '2', '10'), item(f.service, '1', '5'), item(f.other, '1', '25.50')], discount_value: '10.00' });
  const command = randomUUID(), done = ok(await act('sale_finish', data, f.users.admin, command)).record;
  assert.deepEqual([done.state, done.status, done.total_cents, done.change_cents, done.contact_name, done.customer_identified], ['finished', 'fulfilled', '4050', '3500', 'Consumidor final', false]);
  assert.deepEqual(done.effects, { stock: 'posted', finance: 'posted', settled_cents: '2500', open_cents: '1550' });
  assert.equal(Number(await f.stock(f.product.id)), Number(before.stock) - 2, 'the service item does not move the stock');
  assert.equal(Number(await f.balance(f.store.id)) - Number(before.store), 1500, 'Dinheiro is received in the loja');
  assert.equal(Number(await f.balance(f.bank.id)) - Number(before.bank), 1000, 'Pix is received in the conta of the forma');
  const titles = (await f.db.query('select t.amount_cents::text a,t.settled_cents::text s,t.due_on::text d from erp_finance.title t join erp_pos.sale_payment p on p.title_id=t.id where p.sale_id=$1 order by p.position', [done.id])).rows;
  assert.deepEqual(titles.map(row => [row.a, row.s]), [['1500', '1500'], ['1000', '1000'], ['1550', '0']]);
  assert.equal(done.payments[2].due_on, titles[2].d);
  const replay = ok(await act('sale_finish', data, f.users.admin, command));
  assert.deepEqual([replay.replayed, replay.record.id], [true, done.id]);
  refused(await act('sale_finish', { ...data, cash_received_cents: '6000' }, f.users.admin, command), 409);
  assert.equal(Number(await f.scalar('select count(*) v from erp_pos.audit where command_id=$1', [command])), 1);
  const read = ok(await f.call(`/v1/frente-caixa/vendas/${done.id}`, 'GET', undefined, f.users.consulta)).record;
  assert.deepEqual(read.items.map(row => [row.description, row.quantity, row.total]), [['Caneta sintética', '2.000000', '20.00'], ['Embalagem para presente', '1.000000', '5.00'], ['Caderno sintético', '1.000000', '25.50']]);
  assert.deepEqual([read.totals.discount, read.totals.total, read.payments.length, read.returns.length], ['10.00', '40.50', 3, 0]);
  const pedido = await f.rpc('erp_document_get', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: done.document_id });
  assert.deepEqual([pedido.document.status, pedido.document.installments.map(row => row.method)], ['fulfilled', ['Dinheiro', 'Pix', 'Cartão de crédito']]);
});

test('Validação: cliente padrão, troco, pagamentos, datas and the strict Worker body', async () => {
  await setConsumer(null);
  refused(await act('sale_finish', sale()), 400, 'consumer_required');
  ok(await act('sale_finish', sale({ contact_id: f.contact.id })));
  await setConsumer(f.consumer.id);
  refused(await act('sale_finish', sale({ cash_received_cents: '1000' })), 400, 'cash_received_invalid');
  refused(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.cartao, days: 0, amount_cents: '2000', note: null }], cash_received_cents: '2000' })), 400, 'cash_received_invalid');
  refused(await act('sale_finish', sale({ payments: [] })), 400, 'payments_required');
  refused(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1999', note: null }] })), 400);
  refused(await act('sale_finish', sale({}, { date: '2026-01-01' })), 400, 'date_invalid');
  refused(await act('sale_finish', { ...sale(), extra: true }), 400);
  refused(await act('sale_finish', sale({}, { items: [item(f.product, '0', '10')] })), 400);
  refused(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: 2000, note: null }] })), 400);
  refused(await f.call('/v1/frente-caixa/actions/sale_finish?x=1', 'POST', { command_id: randomUUID(), data: sale() }), 400);
  refused(await f.call('/v1/frente-caixa/actions/sale_unknown', 'POST', { command_id: randomUUID(), data: sale() }), 404);
  assert.equal((await f.call('/v1/frente-caixa/actions/sale_finish', 'GET')).status, 405);
});

test('Perfil vendas finaliza sem lançar estoque nem contas: os efeitos ficam pendentes no pedido', async () => {
  const stock = await f.stock(f.product.id), store = await f.balance(f.store.id);
  const done = ok(await act('sale_finish', sale(), f.users.vendas)).record;
  assert.deepEqual([done.status, done.effects.stock, done.effects.finance, done.payments[0].title_id], ['fulfilled', 'pending', 'pending', null]);
  assert.deepEqual([await f.stock(f.product.id), await f.balance(f.store.id)], [stock, store]);
  refused(await act('sale_cancel', { sale_id: done.id, expected_version: done.version, reason: 'Teste' }, f.users.consulta), 403);
  const cancelled = ok(await act('sale_cancel', { sale_id: done.id, expected_version: done.version, reason: 'Venda de teste' }, f.users.vendas)).record;
  assert.deepEqual([cancelled.state, cancelled.status, cancelled.effects.stock], ['cancelled', 'cancelled', 'pending']);
});

test('Utilizar controle de caixa: a venda só finaliza num caixa aberto; Usuários com caixas únicos usam o próprio caixa', async () => {
  await f.setPreference('vendas-frente-caixa', 'pdv.controle_caixa', true);
  try {
    refused(await act('sale_finish', sale()), 409, 'cash_session_required');
    const session = await openSession(f.users.admin);
    refused(await act('sale_finish', sale({ cash_session_id: session.id, account_id: null })), 400, 'store_invalid');
    const done = ok(await act('sale_finish', sale({ cash_session_id: session.id }))).record;
    assert.equal(done.cash_session_id, session.id);
    // Shared caixa: the vendas operator sells in the caixa opened by the administrador.
    const shared = ok(await f.call('/v1/frente-caixa', 'GET', undefined, f.users.vendas));
    assert.deepEqual(shared.cash_sessions.map(row => [row.id, row.own]), [[session.id, false]]);
    ok(await act('sale_finish', sale({ cash_session_id: session.id }), f.users.vendas));
    await f.setPreference('vendas-frente-caixa', 'pdv.usuarios_caixa_unico', [f.users.vendas].sort());
    assert.deepEqual(ok(await f.call('/v1/frente-caixa', 'GET', undefined, f.users.vendas)).cash_sessions, []);
    refused(await act('sale_finish', sale({ cash_session_id: session.id }), f.users.vendas), 409, 'cash_session_unavailable');
    const summary = ok(await f.call(`/v1/frente-caixa/caixas/${session.id}/resumo`, 'GET', undefined, f.users.financeiro));
    assert.deepEqual([summary.sales_count, summary.total_cents, summary.methods.map(row => [row.name, row.registered_cents, row.sales])], [2, '4000', [['Dinheiro', '4000', 2]]]);
    await closeSession(session);
    refused(await act('sale_finish', sale({ cash_session_id: session.id })), 409, 'cash_session_unavailable');
  } finally {
    await f.setPreference('vendas-frente-caixa', 'pdv.controle_caixa', false);
    await f.setPreference('vendas-frente-caixa', 'pdv.usuarios_caixa_unico', []);
  }
});

test('Estoque: sem estoque negativo, sem passar do saldo; quantidade zero bloqueada; a política geral ainda vale no lançamento', async () => {
  refused(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '100000', note: null }] }, { items: [item(f.product, '100', '10')] })), 400, 'stock_insufficient');
  await f.setPreference('vendas-frente-caixa', 'pdv.estoque_negativo', true);
  try {
    // 202610200267: the general policy still refuses the Lançar estoque, but the sale is finished and the stock stays pending in the
    // pedido with the reason (before, the whole sale was refused).
    const stock = await f.stock(f.product.id);
    const pending = ok(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '100000', note: null }] }, { items: [item(f.product, '100', '10')] }))).record;
    assert.deepEqual([pending.state, pending.status, pending.effects.stock, pending.effects.stock_reason, pending.effects.finance, pending.effects.finance_reason], ['finished', 'fulfilled', 'pending', 'stock_policy', 'posted', undefined]);
    assert.equal(await f.stock(f.product.id), stock);
    ok(await act('sale_cancel', { sale_id: pending.id, expected_version: pending.version, reason: 'Venda de teste' }));
    await f.setPreference('vendas-frente-caixa', 'pdv.bloquear_quantidade_zero', true);
    const empty = await f.catalog('products', { name: 'Produto sem saldo', code: 'ZERO-01', unit: 'UN', kind: 'P', format: 'S', price: '1' });
    refused(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '100', note: null }] }, { items: [item(empty, '1', '1')] })), 400, 'stock_zero');
  } finally {
    await f.setPreference('vendas-frente-caixa', 'pdv.estoque_negativo', false);
    await f.setPreference('vendas-frente-caixa', 'pdv.bloquear_quantidade_zero', false);
  }
});

test('Vendedor vinculado: módulos Frente de Caixa conferidos no banco (pagamento, fechamento, preço, forma e exclusão)', async () => {
  const contact = await f.catalog('contacts', { name: 'Vendedora sintética', roles: ['customer'] });
  await f.db.query("insert into erp_catalog.seller(contact_id,user_id,modules,created_by,updated_by) values($1,$2,'{}',$3,$3)", [contact.id, f.users.vendedor, f.users.admin]);
  const modules = value => f.db.query('update erp_catalog.seller set modules=$1 where user_id=$2', [JSON.stringify(value), f.users.vendedor]);
  refused(await act('sale_save', sale({ payments: [] }), f.users.vendedor), 403, 'access_denied');
  await modules({ frente_caixa: true, pdv_registro_itens: true });
  const context = ok(await f.call('/v1/frente-caixa', 'GET', undefined, f.users.vendedor));
  assert.deepEqual([context.permissions.items, context.permissions.payments, context.permissions.finish, context.seller.name], [true, false, false, 'Vendedora sintética']);
  refused(await act('sale_finish', sale(), f.users.vendedor), 403);
  refused(await act('sale_save', sale(), f.users.vendedor), 403, 'payments_denied');
  // "Enviar pré-venda": the vendedor saves the items; the caixa (administrador) registers the payment and finishes.
  const items = [item(f.product, '2', '10'), item(f.other, '1', '25.50')];
  refused(await act('sale_save', sale({ payments: [] }, { items: [item(f.product, '2', '9')] }), f.users.vendedor), 403, 'edit_price_denied');
  const pre = ok(await act('sale_save', sale({ payments: [] }, { items }), f.users.vendedor)).record;
  assert.deepEqual([pre.state, pre.status, pre.total_cents], ['open', 'open', '4550']);
  refused(await act('sale_save', sale({ sale_id: pre.id, expected_version: pre.version, document_version: pre.document_version, payments: [] }, { items: [items[0]] }), f.users.vendedor), 403, 'remove_items_denied');
  await modules({ frente_caixa: true, pdv_registro_itens: true, pdv_registro_pagamento: true, pdv_fechamento: true });
  refused(await act('sale_finish', sale({ sale_id: pre.id, expected_version: pre.version, document_version: pre.document_version, payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '2550', note: null },
    { payment_method_id: f.methods.pix, days: 0, amount_cents: '2000', note: null }] }, { items }), f.users.vendedor), 403, 'change_method_denied');
  const listed = ok(await f.call('/v1/frente-caixa/vendas?state=open', 'GET', undefined, f.users.admin));
  assert.ok(listed.items.some(row => row.id === pre.id));
  const done = ok(await act('sale_finish', sale({ sale_id: pre.id, expected_version: pre.version, document_version: pre.document_version, payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '4550', note: null }] }, { items }))).record;
  assert.deepEqual([done.id, done.state, done.effects.stock, done.operator_id], [pre.id, 'finished', 'posted', f.users.vendedor]);
  refused(await act('sale_save', sale({ sale_id: pre.id, expected_version: done.version, document_version: done.document_version, payments: [] }, { items })), 409, 'sale_state');
});

test('Controle de mesas: comanda aberta por mesa, transferir mesa e finalizar', async () => {
  refused(await act('sale_save', sale({ kind: 'mesa', table_number: 5, payments: [] })), 400, 'tables_disabled');
  await f.setPreference('vendas-frente-caixa', 'pdv.controle_mesas', true);
  try {
    const table = ok(await act('sale_save', sale({ kind: 'mesa', table_number: 5, payments: [] }))).record;
    assert.deepEqual([table.kind, table.table_number, table.state], ['mesa', 5, 'open']);
    refused(await act('sale_save', sale({ kind: 'mesa', table_number: 5, payments: [] })), 409);
    const other = ok(await act('sale_save', sale({ kind: 'mesa', table_number: 6, payments: [] }))).record;
    refused(await act('sale_transfer', { sale_id: table.id, expected_version: table.version, table_number: 6 }), 409, 'table_busy');
    const moved = ok(await act('sale_transfer', { sale_id: table.id, expected_version: table.version, table_number: 7 })).record;
    assert.equal(moved.table_number, 7);
    const found = ok(await f.call('/v1/frente-caixa/vendas?state=open&q=7')).items;
    assert.ok(found.some(row => row.id === table.id && row.table_number === 7));
    const done = ok(await act('sale_finish', sale({ sale_id: table.id, expected_version: moved.version, document_version: moved.document_version, kind: 'mesa', table_number: 7 }))).record;
    assert.equal(done.state, 'finished');
    // "Nº da mesa" of the pedido generated by the Frente de caixa (pedido form).
    const order = ok(await f.call(`/v1/frente-caixa/pedidos/${done.document_id}`, 'GET', undefined, f.users.consulta));
    assert.deepEqual([order.record.kind, order.record.table_number, order.record.state, order.record.account_name], ['mesa', 7, 'finished', 'Caixa loja sintética']);
    assert.equal(ok(await f.call(`/v1/frente-caixa/pedidos/${randomUUID()}`)).record, null);
    refused(await f.call(`/v1/frente-caixa/pedidos/${done.document_id}`, 'GET', undefined, f.users.estoque), 403);
    ok(await act('sale_cancel', { sale_id: other.id, expected_version: other.version, reason: 'Mesa liberada' }));
  } finally { await f.setPreference('vendas-frente-caixa', 'pdv.controle_mesas', false); }
});

test('Cancelar venda finalizada estorna baixa, contas e estoque e cancela o pedido com o motivo', async () => {
  const stock = await f.stock(f.product.id), store = await f.balance(f.store.id);
  const done = ok(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1000', note: null }, { payment_method_id: f.methods.cartao, days: 30, amount_cents: '1000', note: null }] }))).record;
  assert.notEqual(await f.stock(f.product.id), stock);
  refused(await act('sale_cancel', { sale_id: done.id, expected_version: done.version, reason: 'ab' }), 400);
  refused(await act('sale_cancel', { sale_id: done.id, expected_version: done.version, reason: 'Desistência' }, f.users.vendas), 403, 'reverse_stock_denied');
  const cancelled = ok(await act('sale_cancel', { sale_id: done.id, expected_version: done.version, reason: 'Cliente desistiu da compra' })).record;
  assert.deepEqual([cancelled.state, cancelled.status, cancelled.effects.stock, cancelled.effects.finance], ['cancelled', 'cancelled', 'reversed', 'reversed']);
  assert.deepEqual([await f.stock(f.product.id), await f.balance(f.store.id)], [stock, store]);
  assert.equal(Number(await f.scalar('select count(*) v from erp_finance.title t join erp_pos.sale_payment p on p.title_id=t.id where p.sale_id=$1 and not t.cancelled', [done.id])), 0);
  const occurrence = await f.scalar("select reason v from erp_documents.audit where document_id=$1 and action='transition' order by id desc limit 1", [done.document_id]);
  assert.equal(occurrence, 'Cliente desistiu da compra');
  refused(await act('sale_cancel', { sale_id: done.id, expected_version: cancelled.version, reason: 'De novo' }), 409, 'sale_state');
});

test('Gerar devolução: itens voltam ao estoque e o dinheiro sai do caixa, ligados à venda; limite pela quantidade vendida', async () => {
  const session = await openSession(f.users.admin, f.store.id, '0');
  try {
    const done = ok(await act('sale_finish', sale({ cash_session_id: session.id, payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '3600', note: null }] },
      { items: [item(f.product, '4', '10')], discount_value: '4.00' }))).record;
    const stock = await f.stock(f.product.id), store = await f.balance(f.store.id);
    const data = { sale_id: done.id, expected_version: done.version, items: [{ item_id: done.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: session.id, reason: 'Produto com defeito' };
    refused(await f.call('/v1/frente-caixa/actions/sale_return', 'POST', { command_id: randomUUID(), data }, f.users.vendas), 403, 'return_stock_denied');
    const returned = ok(await act('sale_return', data));
    assert.deepEqual([returned.return.value_cents, returned.return.refund_cents, returned.return.stock, returned.return.refund], ['900', '900', true, true]);
    assert.deepEqual([returned.record.returned[done.items[0].id], returned.return.items], ['1.000000', [{ item_id: done.items[0].id, quantity: '1.000000', value_cents: '900' }]]);
    assert.equal(Number(await f.stock(f.product.id)) - Number(stock), 1);
    assert.equal(Number(store) - Number(await f.balance(f.store.id)), 900);
    refused(await act('sale_return', { ...data, expected_version: returned.record.version, items: [{ item_id: done.items[0].id, quantity: '4' }] }), 400, 'return_exceeds');
    const read = ok(await f.call(`/v1/frente-caixa/vendas/${done.id}`)).record;
    assert.deepEqual([read.returns.length, read.returns[0].reason, read.returned[done.items[0].id]], [1, 'Produto com defeito', '1.000000']);
    const summary = ok(await f.call(`/v1/frente-caixa/caixas/${session.id}/resumo`));
    assert.deepEqual([summary.returns_cents, summary.total_cents, summary.groups.map(row => [row.name, row.quantity, row.percent])], ['900', '3600', [['Sem grupo', '4.000000', '100.00']]]);
  } finally { await closeSession(session); }
});

test('Resumo do caixa: situações consideradas, Dinheiro e Cheque e o Worker que confere a soma', async () => {
  const session = await openSession(f.users.admin, f.store.id, '0');
  try {
    ok(await act('sale_finish', sale({ cash_session_id: session.id })));
    await f.setPreference('vendas-frente-caixa', 'pdv.situacoes_fechamento', ['verificado']);
    let summary = ok(await f.call(`/v1/frente-caixa/caixas/${session.id}/resumo`));
    assert.deepEqual([summary.sales_count, summary.total_cents, summary.methods], [0, '0', []]);
    await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values('Cheque','02','caixa','recebimentos',$1,$1)", [f.users.admin]);
    await f.setPreference('vendas-frente-caixa', 'pdv.dinheiro_cheque', true);
    summary = ok(await f.call(`/v1/frente-caixa/caixas/${session.id}/resumo`));
    assert.deepEqual(summary.methods.map(row => [row.name, row.registered_cents]), [['Cheque', '0'], ['Dinheiro', '0']]);
  } finally {
    await f.setPreference('vendas-frente-caixa', 'pdv.situacoes_fechamento', ['atendido', 'verificado']);
    await f.setPreference('vendas-frente-caixa', 'pdv.dinheiro_cheque', false);
    await closeSession(session);
  }
  refused(await f.call(`/v1/frente-caixa/caixas/${randomUUID()}/resumo`), 404);
});

test('Worker: rotas, parâmetros e projeções conferidas (502 em qualquer divergência)', async () => {
  assert.deepEqual(posRoute('/v1/frente-caixa/actions/sale_finish'), { kind: 'action', action: 'sale_finish' });
  assert.equal(posRoute('/v1/outro'), null);
  assert.equal(posRefusal('erp_pos_stock_zero'), 'stock_zero'); assert.equal(posRefusal('mensagem qualquer'), null);
  for (const bad of ['state=x', 'page=0', 'limit=51', 'caixa=1', 'from=2026-10-10&to=2026-10-01', 'q=a&q=b']) await assert.rejects(() => parsePosRoute(new Request(`https://api.synthetic.invalid/v1/frente-caixa/vendas?${bad}`), posRoute('/v1/frente-caixa/vendas')), error => error.status === 400, bad);
  const parsed = await parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa/vendas?state=open&page=2&limit=10'), posRoute('/v1/frente-caixa/vendas'));
  assert.deepEqual(parsed.args, { p_session: null, p_state: 'open', p_query: null, p_from: null, p_to: null, p_method: null, p_page: 2, p_limit: 10 });
  const real = await f.rpc('erp_pos_context', { p_user_id: f.users.admin });
  for (const broken of [{ ...real, role: 'root' }, { ...real, stores: [{ id: 'x', name: 'Loja' }] }, { ...real, settings: { ...real.settings, default_operation: 'emitir' } }, { ...real, extra: 1, certificate: 'other' }]) {
    const context = await parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa'), posRoute('/v1/frente-caixa'));
    await assert.rejects(() => executePosRoute(context, { userId: f.users.admin, rpc: async () => broken }), error => error.status === 502);
  }
  const done = ok(await act('sale_finish', sale())).record;
  const raw = await f.rpc('erp_pos_sale_get', { p_user_id: f.users.admin, p_id: done.id });
  const route = await parsePosRoute(new Request(`https://api.synthetic.invalid/v1/frente-caixa/vendas/${done.id}`), posRoute(`/v1/frente-caixa/vendas/${done.id}`));
  assert.equal((await executePosRoute(route, { userId: f.users.admin, rpc: async () => raw })).record.id, done.id);
  for (const broken of [{ ...raw.record, total_cents: '1' }, { ...raw.record, items: [{ ...raw.record.items[0], quantity: '1,0' }] }, { ...raw.record, payments: [] , total_cents: '-1' }, { ...raw.record, id: randomUUID() }])
    await assert.rejects(() => executePosRoute(route, { userId: f.users.admin, rpc: async () => ({ ...raw, record: broken }) }), error => error.status === 502);
});

test('Destino Ficha Financeira: as parcelas ficam em aberto na ficha do cliente identificado; sem cliente, recusa', async () => {
  refused(await act('sale_finish', sale({ to_ledger: true })), 400);
  const store = await f.balance(f.store.id);
  const done = ok(await act('sale_finish', sale({ contact_id: f.contact.id, to_ledger: true }))).record;
  assert.deepEqual([done.to_ledger, done.effects.settled_cents, done.effects.open_cents, done.payments[0].settlement_id], [true, '0', '2000', null]);
  assert.equal(await f.balance(f.store.id), store, 'nothing is received in the caixa');
  assert.equal(await f.scalar('select (t.amount_cents-t.settled_cents)::text v from erp_finance.title t where t.id=$1', [done.payments[0].title_id]), '2000');
  await f.db.query('alter table erp_pos.sale disable trigger all');
  await assert.rejects(() => f.db.query('update erp_pos.sale set customer_identified=false where id=$1', [done.id]), /check constraint/);
  await f.db.query('alter table erp_pos.sale enable trigger all');
});

// Review (onda D): devolução e cancelamento não devolvem duas vezes nem pagam o que a venda não recebeu; a venda aberta só grava
// sobre a versão do pedido que a tela leu.
test('Devolução: só o que a venda recebeu sai em dinheiro; efeitos pendentes recusam; a venda com devolução não é cancelada', async () => {
  // Parcela a prazo (cartão em 30 dias, em aberto) e Ficha Financeira: nada foi recebido, nada sai do caixa. A devolução parcial é
  // recusada; 202610200292: a devolução total marca a parcela em aberto como Devolvido (pos-returned-titles-sql).
  for (const extra of [{ payments: [{ payment_method_id: f.methods.cartao, days: 30, amount_cents: '2000', note: null }] }, { contact_id: f.contact.id, to_ledger: true }]) {
    const store = await f.balance(f.store.id), done = ok(await act('sale_finish', sale(extra))).record;
    refused(await act('sale_return', { sale_id: done.id, expected_version: done.version, items: [{ item_id: done.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' }), 400, 'return_exceeds_paid');
    const full = ok(await act('sale_return', { sale_id: done.id, expected_version: done.version, items: [{ item_id: done.items[0].id, quantity: '2' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' }));
    assert.deepEqual([full.return.refund_cents, full.return.refund, full.return.returned_titles], ['0', false, 1]);
    assert.equal(await f.balance(f.store.id), store);
  }
  // Metade à vista em dinheiro, metade a prazo: devolve até o recebido (R$ 10,00), não mais.
  const mixed = ok(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1000', note: null }, { payment_method_id: f.methods.cartao, days: 30, amount_cents: '1000', note: null }] }))).record;
  const first = ok(await act('sale_return', { sale_id: mixed.id, expected_version: mixed.version, items: [{ item_id: mixed.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' }));
  assert.deepEqual([first.return.value_cents, first.return.refund_cents, first.return.refund], ['1000', '1000', true]);
  // 202610200292: the last item completes the return; nothing more leaves the caixa and the open parcela becomes Devolvido.
  const last = ok(await act('sale_return', { sale_id: mixed.id, expected_version: first.record.version, items: [{ item_id: mixed.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' }));
  assert.deepEqual([last.return.refund_cents, last.return.refund, last.return.returned_titles], ['0', false, 1]);
  // Cancelar depois da devolução estornaria de novo o estoque e o dinheiro devolvidos: recusado, nada muda.
  const stock = await f.stock(f.product.id), store = await f.balance(f.store.id);
  refused(await act('sale_cancel', { sale_id: mixed.id, expected_version: last.record.version, reason: 'Cancelar depois da devolução' }), 409, 'sale_has_returns');
  assert.deepEqual([await f.stock(f.product.id), await f.balance(f.store.id)], [stock, store]);
  // Venda finalizada pelo perfil vendas (estoque e contas pendentes): a devolução espera os lançamentos do pedido.
  const pending = ok(await act('sale_finish', sale(), f.users.vendas)).record;
  refused(await act('sale_return', { sale_id: pending.id, expected_version: pending.version, items: [{ item_id: pending.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' }), 409, 'return_effects_pending');
});

test('Devolução: a última devolução do item leva o restante (a soma nunca passa do total) e a venda aceita no máximo 20 devoluções', async () => {
  await f.receive(f.product.id, '200');
  const done = ok(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1000', note: null }] }, { items: [item(f.product, '3', '3.34')], discount_value: '0.02' }))).record;
  assert.equal(done.total_cents, '1000');
  let version = done.version; const values = [];
  for (let n = 0; n < 3; n++) { const r = ok(await act('sale_return', { sale_id: done.id, expected_version: version, items: [{ item_id: done.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' })); values.push(r.return.value_cents); version = r.record.version; }
  assert.deepEqual(values, ['333', '333', '334']);
  const read = ok(await f.call(`/v1/frente-caixa/vendas/${done.id}`)).record;
  assert.deepEqual([read.returns.length, read.returned[done.items[0].id], read.returns.map(row => row.refund_cents)], [3, '3.000000', ['333', '333', '334']]);
  const other = ok(await act('sale_finish', sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: '1000', note: null }] }, { items: [item(f.product, '20', '0.50')] }))).record;
  let current = other.version;
  for (let n = 0; n < 20; n++) current = ok(await act('sale_return', { sale_id: other.id, expected_version: current, items: [{ item_id: other.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' })).record.version;
  refused(await act('sale_return', { sale_id: other.id, expected_version: current, items: [{ item_id: other.items[0].id, quantity: '1' }], refund_account_id: null, cash_session_id: null, reason: 'Defeito' }), 400, 'returns_limit');
});

test('Venda aberta: grava só sobre a versão do pedido lida (edição em Pedidos de venda não é sobrescrita); lista de preço conferida; o caixa é o da gravação', async () => {
  const session = await openSession(f.users.admin, f.store.id, '0');
  try {
    const pre = ok(await act('sale_save', sale({ cash_session_id: session.id, payments: [] }))).record;
    assert.equal(pre.cash_session_id, session.id);
    refused(await act('sale_save', sale({ sale_id: pre.id, expected_version: pre.version, document_version: null, payments: [] })), 400);
    const doc = (await f.rpc('erp_document_get', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: pre.document_id })).document;
    const edited = await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_body: {
      date: doc.date, contact_id: doc.contact_id, warehouse_id: doc.warehouse_id, discount_mode: doc.discount_mode, discount_value: doc.discount_value, freight: doc.freight, other_expenses: doc.other_expenses,
      notes: 'Editado em Pedidos de venda', internal_notes: null, installments: [], ship_date: doc.ship_date, commercial: doc.commercial,
      items: doc.items.map(row => ({ id: row.id, product_id: row.product_id, description: row.description, code: row.code, unit: row.unit, quantity: '5', unit_price: row.unit_price, discount_percent: row.discount_percent, detailed_description: null })) } });
    refused(await act('sale_save', sale({ sale_id: pre.id, expected_version: pre.version, document_version: pre.document_version, payments: [] })), 409, 'document_state');
    const kept = ok(await f.call(`/v1/frente-caixa/vendas/${pre.id}`)).record;
    assert.deepEqual([kept.notes, kept.items[0].quantity, kept.document_version], ['Editado em Pedidos de venda', '5.000000', edited.document.version]);
    refused(await act('sale_save', sale({ sale_id: pre.id, expected_version: kept.version, document_version: kept.document_version, price_list_id: randomUUID(), payments: [] })), 400, 'price_list_unavailable');
    // Reaberta com a versão nova, a venda grava; sem caixa nesta gravação, ela não fica no caixa anterior.
    const saved = ok(await act('sale_save', sale({ sale_id: pre.id, expected_version: kept.version, document_version: kept.document_version, payments: [] }))).record;
    assert.deepEqual([saved.cash_session_id, saved.items[0].quantity], [null, '2.000000']);
    ok(await act('sale_cancel', { sale_id: saved.id, expected_version: saved.version, reason: 'Teste de revisão' }));
  } finally { await closeSession(session); }
});

test('Worker: nomes de cadastros espelhados do Origin com caracteres de controle não derrubam a frente de caixa', async () => {
  const real = await f.rpc('erp_pos_context', { p_user_id: f.users.admin });
  const context = await parsePosRoute(new Request('https://api.synthetic.invalid/v1/frente-caixa'), posRoute('/v1/frente-caixa'));
  const named = { ...real, stores: real.stores.map(row => ({ ...row, name: 'Loja\tsintética' })), warehouses: real.warehouses.map(row => ({ ...row, name: 'Depósito\r' })) };
  const projected = await executePosRoute(context, { userId: f.users.admin, rpc: async () => named });
  assert.deepEqual([projected.stores[0].name, projected.warehouses[0].name], ['Loja\tsintética', 'Depósito\r']);
  await assert.rejects(() => executePosRoute(context, { userId: f.users.admin, rpc: async () => ({ ...real, stores: [{ id: real.stores[0].id, name: 'x'.repeat(201) }] }) }), error => error.status === 502);
});
