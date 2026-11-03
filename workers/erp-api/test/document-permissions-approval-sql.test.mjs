// Documentos lane, wave E, migration 239 (PGlite with every migration and the real Worker): Sistema › Usuários › Permissões ›
// Serviços › Ordem de Serviço enforced in the OS RPCs, and Preferências › Vendas "Situação para aprovação de descontos".
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f;
test.before(async () => { f = await documentsEFixture(); });
test.after(async () => { await f?.close(); });
const ok = async (path, method = 'GET', body, user = f.users.admin) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.value)}`); return r.value; };
const OS = ['servicos.ordem_servico'];
const sqlError = async (promise, code) => { await assert.rejects(promise, error => { assert.equal(error.message, code); return true; }); };

test('privileges: the new RPCs run only for service_role; the internal helpers for nobody', async () => {
  for (const fn of ['public.erp_document_discount_approval(uuid)', 'public.erp_document_discount_approval_save(uuid,uuid,integer,jsonb)', 'public.erp_document_access(uuid)',
    'public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)', 'public.erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)']) {
    assert.deepEqual((await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [fn])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] }, fn);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'execute') v`, [fn]), false, `${fn} ${role}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'execute') v", [fn]), true);
  }
  for (const fn of ['erp_documents.require_role(uuid,text,boolean)', 'erp_documents.os_permitted(uuid,text)', 'erp_documents.seller_rules(uuid,text,jsonb)', 'erp_documents.check_situation_change(uuid,text,text,text)',
    'erp_documents.discount_approver(uuid,text)', 'erp_documents.approval_situations()', 'erp_documents.approval_target()'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'execute') v`, [fn]), false, `${fn} ${role}`);
  for (const table of ['discount_approval', 'discount_approval_audit']) for (const role of ['anon', 'authenticated', 'service_role'])
    assert.equal(await f.scalar(`select has_table_privilege('${role}','erp_documents.${table}','select') v`), false);
});

test('Ordem de Serviço permissions: visualizar, inclusão e edição, situações, lançamentos, histórico financeiro and forma de pagamento', async () => {
  const user = f.users.vendas;
  const os = await f.create('service_orders', { items: [f.line({ product_id: f.product.id })] });
  // Without a saved set the profile keeps everything (229).
  let access = await ok('/v1/documentos', 'GET', undefined, user);
  assert.ok(access.read.includes('service_orders') && access.write.includes('service_orders'));
  assert.deepEqual(access.permissions.service_orders, { situations: true, stock: true, finance: true, finance_history: true, payment_method: true });
  // No module: no OS at all (list, read, access lists).
  await f.permissions(user, ['vendas.pedidos_venda']);
  access = await ok('/v1/documentos', 'GET', undefined, user);
  assert.ok(!access.read.includes('service_orders') && !access.write.includes('service_orders') && access.read.includes('sales_orders'));
  assert.equal((await f.call('/v1/documentos/service_orders?page=1', 'GET', undefined, user)).status, 403);
  assert.equal((await f.call(`/v1/documentos/service_orders/${os.id}`, 'GET', undefined, user)).status, 403);
  // An occurrence that repeats the current situação is only a note: it needs Inclusão e edição too.
  const current = os.situation?.key ?? os.status, today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  assert.equal((await f.call(`/v1/documentos/service_orders/${os.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: os.version, occurred_on: today, occurred_time: '00:00', text: 'Nota sem permissão', status: current }, user)).status, 403);
  // Visualizar only: reads, no writes.
  await f.permissions(user, OS);
  assert.equal((await f.call(`/v1/documentos/service_orders/${os.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: os.version, occurred_on: today, occurred_time: '00:00', text: 'Nota só com visualizar', status: current }, user)).status, 403);
  assert.equal((await f.call(`/v1/documentos/service_orders/${os.id}`, 'GET', undefined, user)).status, 200);
  assert.equal((await f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), data: f.data('service_orders') }, user)).status, 403);
  // Inclusão e edição without Gerenciar situações: saves and notes, no change of situação (also through an occurrence).
  await f.permissions(user, [...OS, 'servicos.ordem_servico.ie']);
  const created = await f.create('service_orders', {}, user);
  const refused = await f.transition(created, 'quoted', user);
  assert.equal(refused.status, 403); assert.equal(refused.value.error.code, 'ERP_DOCUMENT_PERMISSION_DENIED');
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const note = await f.call(`/v1/documentos/service_orders/${created.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: created.version, occurred_on: now, occurred_time: '00:00', text: 'Nota sintética' }, user);
  assert.equal(note.status, 200, JSON.stringify(note.value));
  const viaOccurrence = await f.call(`/v1/documentos/service_orders/${created.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: note.value.document.version, occurred_on: now, occurred_time: '00:00', text: 'Mudança', status: 'quoted' }, user);
  assert.equal(viaOccurrence.status, 403);
  // Gerenciar situações without Inclusão e edição: the change of situação is accepted.
  await f.permissions(user, [...OS, 'servicos.ordem_servico.situacoes']);
  const moved = await f.transition(note.value.document, 'quoted', user);
  assert.equal(moved.status, 200, JSON.stringify(moved.value));
  // Lançar estoque / Lançar contas of the OS (the public RPCs, also used by the transitions).
  await sqlError(f.rpc('erp_document_stock_preview', { p_user_id: user, p_kind: 'service_orders', p_document_id: os.id, p_expected_version: os.version, p_occurred_on: now, p_reason: 'Sintético' }), 'erp_document_permission_denied');
  await sqlError(f.rpc('erp_document_finance_preview', { p_user_id: user, p_kind: 'service_orders', p_document_id: os.id, p_expected_version: os.version, p_category_id: null, p_plan: null }), 'erp_document_permission_denied');
  // Histórico financeiro: the Financeiro tab of the history comes hidden.
  const history = await ok(`/v1/documentos/service_orders/historico?contact_id=${f.contact.id}`, 'GET', undefined, user);
  assert.deepEqual([history.finance, history.finance_hidden], [null, true]);
  await f.permissions(user, [...OS, 'servicos.ordem_servico.historico_financeiro']);
  assert.ok((await ok(`/v1/documentos/service_orders/historico?contact_id=${f.contact.id}`, 'GET', undefined, user)).finance);
  // Alterar forma de pagamento: a Forma the OS does not have yet.
  const method = (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,account_id,applicable,created_by,updated_by) values('Pix sintético','20','contas',null,'ambos',$1,$1) returning id::text", [f.users.admin])).rows[0].id;
  await f.permissions(user, [...OS, 'servicos.ordem_servico.ie']);
  const installments = [{ due_date: '2026-10-20', amount: '10.00', method: null, note: null, payment_reference: null, payment_method_id: method, details: null }];
  const denied = await f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), data: f.data('service_orders', { items: [f.line({ product_id: f.product.id })], installments }) }, user);
  assert.equal(denied.status, 403); assert.equal(denied.value.error.code, 'ERP_DOCUMENT_PERMISSION_DENIED');
  await f.permissions(user, [...OS, 'servicos.ordem_servico.ie', 'servicos.ordem_servico.forma_pagamento']);
  const withMethod = await f.create('service_orders', { items: [f.line({ product_id: f.product.id })], installments }, user);
  // A Forma already in the OS stays editable without the permission.
  await f.permissions(user, [...OS, 'servicos.ordem_servico.ie']);
  const kept = await f.call(`/v1/documentos/service_orders/${withMethod.id}`, 'PATCH', { command_id: randomUUID(), expected_version: withMethod.version,
    data: { ...f.data('service_orders', { items: [f.line({ product_id: f.product.id })], installments }), notes: 'Sem trocar a forma' } }, user);
  assert.equal(kept.status, 200, JSON.stringify(kept.value));
  access = await ok('/v1/documentos', 'GET', undefined, user);
  assert.deepEqual(access.permissions.service_orders, { situations: false, stock: false, finance: false, finance_history: false, payment_method: false });
  await f.db.query('delete from erp_access.user_control where user_id=$1', [user]);
});

test('Situação para aprovação de descontos: configuration, the pedido above the limit and the approver', async () => {
  const approval = await f.situation('sales_orders', 'draft', 'Aguardando aprovação');
  const other = await f.situation('sales_orders', 'open', 'Aberta especial');
  await f.rule('sales_orders', approval, 'open');
  // Configuration: administrador only, custom situações of Em digitação, CAS and replay.
  let read = await ok('/v1/documentos/sales_orders/aprovacao-descontos');
  assert.deepEqual([read.version, read.situations, read.can_write], [0, [], true]);
  assert.equal((await f.call('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: randomUUID(), expected_version: 0, situations: [approval] }, f.users.vendas)).status, 403);
  assert.equal((await f.call('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: randomUUID(), expected_version: 0, situations: [other] })).status, 400, 'only situações of Em digitação');
  const command = randomUUID();
  const saved = await ok('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: command, expected_version: 0, situations: [approval] });
  assert.deepEqual([saved.version, saved.situations.map(s => s.id), saved.replayed], [1, [approval], false]);
  assert.equal((await ok('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: command, expected_version: 0, situations: [approval] })).replayed, true);
  assert.equal((await f.call('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: randomUUID(), expected_version: 0, situations: [] })).status, 409);
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.discount_approval_audit'), 1);
  // The seller with a 5% limit: 10% goes for approval instead of being refused.
  const sellerId = await f.seller(f.users.vendas2, { allow: true, limit: '5' });
  const body = f.data('sales_orders', { items: [f.line({ product_id: f.product.id, discount_percent: '10' })] });
  const sent = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: body }, f.users.vendas2);
  assert.equal(sent.status, 200, JSON.stringify(sent.value));
  assert.equal(sent.value.document.status, 'draft'); assert.equal(sent.value.discount_approval.situation.key, approval);
  assert.equal(sent.value.discount_approval.situation.name, 'Aguardando aprovação');
  const doc = sent.value.document;
  const occurrences = await ok(`/v1/documentos/sales_orders/${doc.id}/ocorrencias`, 'GET', undefined, f.users.vendas2);
  assert.ok(occurrences.items.some(item => item.text === 'Venda enviada para aprovação do desconto'));
  assert.equal((await ok(`/v1/documentos/sales_orders/${doc.id}`, 'GET', undefined, f.users.vendas2)).document.situation.key, approval);
  // Only an approver takes it out of the approval situação.
  const blocked = await f.transition(doc, 'open', f.users.vendas2);
  assert.equal(blocked.status, 403); assert.equal(blocked.value.error.code, 'ERP_DOCUMENT_APPROVAL_REQUIRED');
  let access = await ok('/v1/documentos', 'GET', undefined, f.users.vendas2);
  assert.deepEqual(access.permissions.sales_orders, { discount_approver: false, approval_situations: [approval] });
  // A vendas user with "Desconsiderar limite de desconto do vendedor" saved in the set approves (and is not limited himself).
  await f.permissions(f.users.vendas, ['vendas.pedidos_venda', 'vendas.pedidos_venda.ie', 'vendas.pedidos_venda.situacoes', 'vendas.pedidos_venda.limite_desconto']);
  assert.equal((await ok('/v1/documentos', 'GET', undefined, f.users.vendas)).permissions.sales_orders.discount_approver, true);
  const approved = await f.transition(doc, 'open', f.users.vendas);
  assert.equal(approved.status, 200, JSON.stringify(approved.value)); assert.equal(approved.value.document.status, 'open');
  await f.permissions(f.users.vendas2, ['vendas.pedidos_venda', 'vendas.pedidos_venda.ie', 'vendas.pedidos_venda.limite_desconto']);
  const free = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: body }, f.users.vendas2);
  assert.equal(free.status, 200); assert.equal(free.value.document.status, 'open'); assert.equal(free.value.discount_approval, undefined);
  await f.db.query('delete from erp_access.user_control where user_id=any($1)', [[f.users.vendas, f.users.vendas2]]);
  // Proposals keep the 164 refusal; without a configured situação the pedido is refused too.
  assert.equal((await f.call('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals', { items: [f.line({ product_id: f.product.id, discount_percent: '10' })] }) }, f.users.vendas2)).status, 400);
  read = await ok('/v1/documentos/sales_orders/aprovacao-descontos');
  await ok('/v1/documentos/sales_orders/aprovacao-descontos', 'POST', { command_id: randomUUID(), expected_version: read.version, situations: [] });
  assert.equal((await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: body }, f.users.vendas2)).status, 400);
  await f.db.query('delete from erp_catalog.seller where id=$1', [sellerId]);
});

test('Últimas compras: the manual stock entries of the product join the purchases when no fornecedor is chosen', async () => {
  const warehouse = await f.catalog('warehouses', { name: 'Depósito sintético E' });
  const product = await f.catalog('products', { name: 'Chapa sintética', code: 'CH-E', unit: 'UN', kind: 'P', format: 'S', price: '50' });
  const launched = await f.rpc('erp_stock_launch', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_product_id: product.id, p_warehouse_id: warehouse.id, p_quantity: '3',
    p_expected_version: 0, p_unit_price: '12.5', p_unit_cost: '11', p_note: 'Entrada sintética', p_destination_id: null, p_destination_version: null });
  const order = await f.create('purchase_orders', { items: [f.line({ product_id: product.id, unit_price: '13' })] });
  const all = await ok(`/v1/documentos/purchase_orders/historico?product_id=${product.id}`);
  const stock = all.items.find(item => item.type === 'stock');
  assert.ok(stock, JSON.stringify(all.items));
  assert.deepEqual([stock.document_id, stock.number, stock.quantity, stock.unit_price], [launched.movement.id, null, '3.000000', '12.5000']);
  assert.ok(all.items.some(item => item.type === 'purchase' && item.document_id === order.id));
  const bySupplier = await ok(`/v1/documentos/purchase_orders/historico?product_id=${product.id}&contact_id=${f.contact.id}`);
  assert.equal(bySupplier.items.some(item => item.type === 'stock'), false, 'the fornecedor filter keeps only its purchases');
});
