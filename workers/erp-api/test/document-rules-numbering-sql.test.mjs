import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsFixture } from './helpers/documents-b-fixture.mjs';

// 202610200129 on PGlite (every published migration, then this lane), through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsFixture({ upto: '202610200129' }); });
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const create = (kind, extra = {}, user) => f.call(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: f.data(kind, extra) }, user);
const created = async (kind, extra, user) => { const r = await create(kind, extra, user); assert.equal(r.status, 200, JSON.stringify(r.value)); return r.value.document; };
const edit = (doc, extra = {}) => f.call(`/v1/documentos/${doc.kind}/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data: f.data(doc.kind, extra) });
const status = (doc, target, reason = null) => f.call(`/v1/documentos/${doc.kind}/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: target, reason });
const next = kind => ok(`/v1/documentos/${kind}/proximo-numero`);
const setNext = (kind, expected, value, user, command = randomUUID()) => f.call(`/v1/documentos/${kind}/proximo-numero`, 'POST', { command_id: command, expected_next_number: expected, next_number: value }, user);

test('129 grants: public RPCs only for service_role, helpers private, audit and removals behind RLS', async () => {
  for (const fn of ['public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)', 'public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)', 'public.erp_proposal_convert(uuid,uuid,integer,uuid)',
    'public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid)', 'public.erp_document_next_number(uuid,text)', 'public.erp_document_numbering_set(uuid,text,uuid,text,text)',
    'public.erp_document_occurrence_list(uuid,text,uuid)', 'public.erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid)',
    'public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean)']) {
    for (const role of ['public', 'anon', 'authenticated']) if (role !== 'public') assert.equal(await f.scalar('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, `${role} ${fn}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true, fn);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
    assert.equal(await f.scalar("select proconfig::text v from pg_proc where oid=$1::regprocedure", [fn]), '{search_path=pg_catalog}', fn);
  }
  for (const fn of ['erp_documents.preference(text)', 'erp_documents.number_editable(text)', 'erp_documents.check_preference_rules(text,jsonb)', 'erp_documents.initial_status(text)',
    'erp_documents.sale_body_from_proposal(jsonb)', 'erp_documents.numbering_dto(text)', 'erp_documents.occurrence_list_json(erp_documents.occurrence)', 'erp_documents.transitions()'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  for (const table of ['erp_documents.numbering_audit', 'erp_documents.occurrence_removal']) {
    assert.equal(await f.scalar('select relrowsecurity v from pg_class where oid=$1::regclass', [table]), true, table);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await f.scalar("select has_table_privilege('service_role',$1,$2) v", [table, privilege]), false, `${table} ${privilege}`);
  }
});

test('the new pedido is born Em aberto (save, copy and proposal); the default list filter is only Em aberto', async () => {
  const order = await created('sales_orders');
  assert.equal(order.status, 'open');
  assert.equal((await created('sales_proposals')).status, 'draft');
  assert.equal((await created('purchase_orders')).status, 'open');
  const preview = await ok(`/v1/duplicacao-documentos/sales_orders/${order.id}/preview`);
  const copy = await ok(`/v1/duplicacao-documentos/sales_orders/${order.id}`, 'POST', { command_id: randomUUID(), expected_source_version: order.version, data: preview.data });
  assert.equal(copy.document.status, 'open');
  const view = await ok('/v1/documentos/sales_orders/preferencias-listagem');
  assert.deepEqual(view.default_statuses, ['open']);
  let proposal = await created('sales_proposals', { commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null, transport: { freight_mode: null, volume_count: null, gross_weight: null, delivery_days: '5', carrier_reference: null, service_reference: null, tracking_code: null } } });
  proposal = (await status(proposal, 'approved')).value.document;
  const converted = await ok(`/v1/documentos/sales_proposals/${proposal.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: proposal.version });
  assert.equal(converted.sale.status, 'open');
  assert.equal(converted.sale.expected_date ?? null, null, 'without the preference the expected date is not computed');
  const history = await ok(`/v1/documentos/sales_proposals/${proposal.id}/ocorrencias`);
  assert.deepEqual([history.items[0].status_before, history.items[0].status_after], ['approved', 'completed'], 'Concluído by the conversion is an occurrence');
  await f.setPreference('vendas-propostas', 'propostas.data_prevista_prazo', true);
  let second = await created('sales_proposals', { commercial: converted.sale.commercial });
  second = (await status(second, 'approved')).value.document;
  const sale = await ok(`/v1/documentos/sales_proposals/${second.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: second.version });
  assert.equal(sale.sale.expected_date, '2026-10-25', 'Data da venda (20/10) + prazo de entrega (5 dias)');
  let service = await created('sales_proposals');
  service = (await status(service, 'approved')).value.document;
  const os = await ok(`/v1/documentos/sales_proposals/${service.id}/convert-service`, 'POST', { command_id: randomUUID(), expected_version: service.version });
  assert.equal(os.service_order.status, 'open');
  assert.equal((await ok(`/v1/documentos/sales_proposals/${service.id}/ocorrencias`)).items[0].status_after, 'completed');
});

test('Editar número: refused while the preference is off; with it, a free number is kept and the sequence moves past it', async () => {
  assert.equal((await create('purchase_orders', { number: '700' }, f.users.estoque)).status, 400, 'preference off');
  const plain = await created('purchase_orders', {}, f.users.estoque);
  assert.equal((await edit(plain, { number: plain.number })).status, 200, 'the current number is not a change');
  await f.setPreference('suprimentos-compras', 'compras.editar_numero', true);
  const chosen = await created('purchase_orders', { number: '700' }, f.users.estoque);
  assert.equal(chosen.number, '700');
  assert.equal((await next('purchase_orders')).next_number, '701');
  assert.equal((await create('purchase_orders', { number: '700' }, f.users.estoque)).status, 409, 'number already used');
  const auto = await created('purchase_orders', {}, f.users.estoque);
  assert.equal(auto.number, '701', 'the automatic number never collides with the free one');
  const moved = await edit(auto, { number: '650' });
  assert.equal(moved.status, 200); assert.equal(moved.value.document.number, '650');
  assert.equal((await edit(moved.value.document, { number: '700' })).status, 409);
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.audit where document_id=$1 and action='edit' and before_data->>'number'='701' and after_data->>'number'='650'", [auto.id]), 1, 'the change is audited');
  for (const value of ['0', '07', 7, '12345678901']) assert.equal((await create('purchase_orders', { number: value }, f.users.estoque)).status, 400, String(value));
  // The reviewed copy always takes the automatic number (the editor does not offer the field there).
  const preview = await ok(`/v1/duplicacao-documentos/purchase_orders/${chosen.id}/preview`, 'GET', undefined, f.users.estoque);
  assert.equal((await f.call(`/v1/duplicacao-documentos/purchase_orders/${chosen.id}`, 'POST', { command_id: randomUUID(), expected_source_version: chosen.version, data: { ...preview.data, number: '900' } }, f.users.estoque)).status, 400, 'a copy does not take a requested number');
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.document where kind='purchase_orders' and number=900"), 0);
  assert.equal((await create('sales_orders', { number: '9000' })).status, 400, 'the sales preference is separate');
});

test('Preferências rules on save and copy: produtos não cadastrados, itens repetidos na OS e próximo contato', async () => {
  const free = await created('sales_orders');
  await f.setPreference('vendas-vendas', 'vendas.produtos_nao_cadastrados', false);
  assert.equal((await create('sales_orders')).status, 400, 'free item refused');
  assert.equal((await create('sales_orders', { items: [f.line({ product_id: f.product.id, description: f.product.name })] })).status, 200);
  const preview = await ok(`/v1/duplicacao-documentos/sales_orders/${free.id}/preview`);
  assert.equal((await f.call(`/v1/duplicacao-documentos/sales_orders/${free.id}`, 'POST', { command_id: randomUUID(), expected_source_version: free.version, data: preview.data })).status, 400, 'the copy follows the same rule');
  assert.equal((await create('sales_proposals')).status, 200, 'propostas keep free items');
  await f.setPreference('vendas-vendas', 'vendas.produtos_nao_cadastrados', true);
  const twice = { items: [f.line({ product_id: f.product.id, description: 'A' }), f.line({ product_id: f.product.id, description: 'B' }), f.line({ description: 'Livre' }), f.line({ description: 'Livre' })] };
  assert.equal((await create('service_orders', twice)).status, 200, 'repeated items allowed by default');
  await f.setPreference('servicos-os', 'os.itens_repetidos', false);
  assert.equal((await create('service_orders', twice)).status, 400);
  assert.equal((await create('service_orders', { items: [f.line({ product_id: f.product.id }), f.line({ product_id: f.other.id }), f.line(), f.line()] })).status, 200, 'free lines are never repeated items');
  await f.setPreference('vendas-propostas', 'propostas.proximo_contato_obrigatorio', true);
  assert.equal((await create('sales_proposals')).status, 400);
  assert.equal((await create('sales_proposals', { next_contact: '2026-10-27' })).status, 200);
  assert.equal((await create('sales_proposals', { template: true })).status, 200, 'a model needs no próximo contato');
  await f.setPreference('vendas-propostas', 'propostas.proximo_contato_obrigatorio', false);
  await f.setPreference('servicos-os', 'os.itens_repetidos', true);
});

test('Próximo número: administrador only, CAS on the number read, never at or below a used number, idempotent and audited', async () => {
  const before = await next('sales_proposals');
  assert.match(before.minimum_next_number, /^[1-9]\d*$/);
  assert.equal((await setNext('sales_proposals', before.next_number, '5000', f.users.vendas)).status, 403, 'vendas writes proposals but does not set the number');
  assert.equal((await setNext('sales_proposals', String(Number(before.next_number) + 1), '5000')).status, 409, 'stale number');
  assert.equal((await setNext('sales_proposals', before.next_number, before.next_number)).status, 400, 'unchanged');
  const used = await created('sales_proposals');
  const current = await next('sales_proposals');
  assert.equal((await setNext('sales_proposals', current.next_number, used.number)).status, 409, 'a used number');
  const command = randomUUID();
  const set = await setNext('sales_proposals', current.next_number, '5000', f.users.admin, command);
  assert.equal(set.status, 200); assert.deepEqual([set.value.next_number, set.value.replayed, set.value.reserved], ['5000', false, false]);
  const replay = await setNext('sales_proposals', current.next_number, '5000', f.users.admin, command);
  assert.deepEqual([replay.status, replay.value.replayed], [200, true]);
  assert.equal((await setNext('sales_proposals', current.next_number, '5001', f.users.admin, command)).status, 409, 'same command, other body');
  assert.equal((await created('sales_proposals')).number, '5000');
  const lower = await next('sales_proposals');
  assert.equal((await setNext('sales_proposals', lower.next_number, String(Number(used.number) + 1))).status, 409, 'cannot go back to the numbers already used');
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.numbering_audit where kind='sales_proposals' and command_id=$1 and actor=$2", [command, f.users.admin]), 1);
  await assert.rejects(() => f.db.query('update erp_documents.numbering_audit set after_last=1'), /immutable/);
  for (const body of [{ command_id: randomUUID(), expected_next_number: '1' }, { command_id: randomUUID(), expected_next_number: '01', next_number: '2' }, { command_id: 'x', expected_next_number: '1', next_number: '2' }, { command_id: randomUUID(), expected_next_number: '1', next_number: '2', extra: 1 }])
    assert.equal((await f.call('/v1/documentos/sales_proposals/proximo-numero', 'POST', body)).status, 400, JSON.stringify(body));
});

test('pedido de compra: Origin situações from any to any, with occurrences and the same reason rule', async () => {
  let order = await created('purchase_orders', {}, f.users.estoque);
  order = (await status(order, 'fulfilled')).value.document;
  assert.equal(order.status, 'fulfilled', 'Em aberto → Atendido directly');
  assert.equal((await status(order, 'in_progress')).status, 400, 'leaving Atendido needs a reason');
  const added = await ok(`/v1/documentos/purchase_orders/${order.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-20', occurred_time: '10:30', text: 'Faltou receber uma caixa', status: 'in_progress' }, f.users.estoque);
  assert.equal(added.document.status, 'in_progress');
  const listed = await ok(`/v1/documentos/purchase_orders/${order.id}/ocorrencias`, 'GET', undefined, f.users.estoque);
  assert.deepEqual(listed.items.map(item => [item.status_before, item.status_after]), [['fulfilled', 'in_progress'], ['open', 'fulfilled']]);
  assert.equal(listed.can_write, true);
  assert.equal((await f.call(`/v1/documentos/purchase_orders/${order.id}/ocorrencias`, 'GET', undefined, f.users.vendas)).status, 403, 'vendas does not read pedidos de compra');
});

test('Remover ocorrência: hidden from the modal, kept and audited; names come from Sistema › Usuários', async () => {
  await f.db.query("insert into erp_access.profile(user_id,name,version,updated_at,updated_by)values($1,'Ana Sintética',1,now(),$1)", [f.users.admin]);
  let order = await created('sales_orders');
  const first = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: order.version, occurred_on: '2026-10-20', occurred_time: '11:00', text: 'Ligar para o cliente' });
  order = (await status(first.document, 'verified')).value.document;
  let listed = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`);
  assert.deepEqual(listed.items.map(item => item.actor_name), ['Ana Sintética', 'Ana Sintética']);
  const path = `/v1/documentos/sales_orders/${order.id}/ocorrencias/${first.occurrence.id}/exclusao`, command = randomUUID();
  assert.equal((await f.call(path, 'POST', { command_id: randomUUID() }, f.users.consulta)).status, 403);
  const removed = await ok(path, 'POST', { command_id: command });
  assert.deepEqual([removed.removed_id, removed.replayed, removed.document.version], [first.occurrence.id, false, order.version], 'the document version does not change');
  assert.equal((await ok(path, 'POST', { command_id: command })).replayed, true);
  assert.equal((await f.call(path, 'POST', { command_id: randomUUID() })).status, 404, 'already removed');
  listed = await ok(`/v1/documentos/sales_orders/${order.id}/ocorrencias`, 'GET', undefined, f.users.vendas);
  assert.deepEqual(listed.items.map(item => item.status_after), ['verified']);
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.occurrence where document_id=$1', [order.id]), 2, 'the immutable row stays');
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.audit where document_id=$1 and action='occurrence_remove' and before_data->>'text'='Ligar para o cliente'", [order.id]), 1);
  const other = await created('sales_orders');
  assert.equal((await f.call(`/v1/documentos/sales_orders/${other.id}/ocorrencias/${first.occurrence.id}/exclusao`, 'POST', { command_id: randomUUID() })).status, 404, 'an occurrence of another document');
  assert.equal((await f.call(`/v1/documentos/sales_orders/${other.id}/ocorrencias/x/exclusao`, 'POST', { command_id: randomUUID() })).status, 405, 'not a document route (unknown paths only answer GET)');
  assert.equal((await f.call(path, 'GET')).status, 405);
});

test('Ordem de compra is saved and found by the Origin search of pedidos de compra', async () => {
  const order = await created('purchase_orders', { order_reference: 'OC-2026-0042' }, f.users.estoque);
  assert.equal(order.order_reference, 'OC-2026-0042');
  const found = await ok('/v1/documentos/purchase_orders?page=1&q=oc-2026-0042');
  assert.deepEqual(found.items.map(item => item.id), [order.id]);
  assert.equal((await ok('/v1/documentos/sales_orders?page=1&q=oc-2026-0042')).total_count, 0);
  assert.equal((await create('purchase_orders', { order_reference: 'x'.repeat(101) }, f.users.estoque)).status, 400);
  assert.equal((await f.call(`/v1/documentos/purchase_orders/${order.id}`, 'PATCH', { command_id: randomUUID(), expected_version: order.version, data: f.data('purchase_orders') }, f.users.estoque)).status, 409, 'an older client that omits the new field cannot erase it');
});

test('Exibir totais em listas: the sum of the list is omitted for the users the Preferências leave without it', async () => {
  const totals = async (kind, user) => { const r = await f.call(`/v1/documentos/${kind}?page=1`, 'GET', undefined, user); assert.equal(r.status, 200, JSON.stringify(r.value)); return r.value.total_amount; };
  await created('sales_orders');
  assert.match(await totals('sales_orders', f.users.vendas), /^\d+\.\d{2}$/, 'visible by default');
  await f.setPreference('vendas-vendas', 'vendas.exibir_totais_usuarios', [f.users.admin].sort());
  assert.equal(await totals('sales_orders', f.users.vendas), null, 'vendas is not one of the marked users');
  assert.match(await totals('sales_orders', f.users.admin), /^\d+\.\d{2}$/, 'the marked user keeps the totals');
  const legacy = await f.call('/v1/documentos/sales_orders?limit=5', 'GET', undefined, f.users.vendas);
  assert.deepEqual([legacy.status, legacy.value.total_amount], [200, null], 'the cursor list follows the same rule');
  await f.setPreference('vendas-vendas', 'vendas.exibir_totais', false);
  assert.equal(await totals('sales_orders', f.users.admin), null, 'off: nobody sees the totals');
  await f.setPreference('vendas-vendas', 'vendas.exibir_totais', true);
  await f.setPreference('vendas-vendas', 'vendas.exibir_totais_usuarios', []);
  assert.match(await totals('sales_orders', f.users.vendas), /^\d+\.\d{2}$/);
  await f.setPreference('vendas-propostas', 'propostas.exibir_totais', false);
  await f.setPreference('servicos-os', 'os.exibir_totais', false);
  assert.equal(await totals('sales_proposals', f.users.admin), null);
  assert.equal(await totals('service_orders', f.users.admin), null);
  assert.match(await totals('sales_orders', f.users.admin), /^\d+\.\d{2}$/, 'each kind has its own preference');
  assert.match(await totals('purchase_orders', f.users.estoque), /^\d+\.\d{2}$/, 'pedidos de compra always show the totals');
  await f.setPreference('vendas-propostas', 'propostas.exibir_totais', true);
  await f.setPreference('servicos-os', 'os.exibir_totais', true);
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_documents.list_totals_visible(uuid,text)','EXECUTE') v"), false);
});
