// Synthetic data only. 202610200268: Peças e Serviços executados separados na OS (grupo, Orçar e OK), serviços livres cadastrados
// como Serviço, Equipamento de até 4.000 caracteres e os filtros Peça e Serviço. PGlite with every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f, service;
before(async () => {
  f = await documentsEFixture();
  service = await f.catalog('products', { name: 'Mão de obra sintética', code: 'SRV-268', unit: 'H', kind: 'S', format: 'S', price: '80' });
});
after(async () => f?.close());
const part = (extra = {}) => f.line({ product_id: f.product.id, description: 'Produto sintético E', group: 'part', quote: false, done: false, ...extra });
const labour = (extra = {}) => f.line({ product_id: service.id, description: 'Mão de obra sintética', code: 'SRV-268', unit: 'H', quantity: '1.5', unit_price: '80', group: 'service', quote: true, done: false, ...extra });
const os = (extra = {}) => f.data('service_orders', { items: [part(), labour()], equipment: 'Notebook sintético', ...extra });
const create = (data, user = f.users.admin) => f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), data }, user);
const editable = doc => { const { id, kind, number, status, version, effect_flags, contact_snapshot, source_proposal_id, created_at, updated_at, totals, situation, seller_name, category_name, carrier_name,
  price_list_name, payment_account_name, payment_method_names, payment_account_names, ...data } = doc; return { ...data, items: data.items.map(({ position, gross, discount, total, product_snapshot, ...item }) => item),
  installments: data.installments.map(({ position, ...row }) => row) }; };

test('privileges and signature: erp_document_list has p_service_id (the 238 signature is gone); the replaced internal helpers stay closed', async () => {
  const lists = (await f.db.query("select p.oid::regprocedure::text sig,p.prosecdef,p.proconfig from pg_proc p where p.proname='erp_document_list' and p.pronamespace='public'::regnamespace")).rows;
  // 202610200289 appends p_lots and p_custom after p_service_id.
  assert.equal(lists.length, 1); assert.match(lists[0].sig, /,uuid,uuid,uuid(,text\[\],jsonb)?\)$/);
  assert.deepEqual([lists[0].prosecdef, lists[0].proconfig], [true, ['search_path=pg_catalog']]);
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, lists[0].sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [lists[0].sig]), true);
  for (const sig of ['erp_documents."normalize"(text,jsonb)', 'erp_documents.require_commercial_input(jsonb,jsonb)', 'erp_documents.auto_products(uuid,text,uuid,jsonb)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false, `${role} ${sig}`);
});

test('Peças e Serviços executados: group, Orçar and OK are saved and read; the total is every item; Equipamento takes 4,000 characters', async () => {
  const equipment = 'Notebook sintético\nCarregador e bolsa\n' + 'x'.repeat(3900);
  const saved = await create(os({ equipment }));
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const doc = saved.value.document;
  assert.deepEqual(doc.items.map(item => [item.group, item.quote, item.done, item.total]), [['part', false, false, '10.00'], ['service', true, false, '120.00']]);
  assert.equal(doc.totals.total, '130.00'); assert.equal(doc.equipment, equipment);
  const read = (await f.call(`/v1/documentos/service_orders/${doc.id}`)).value.document;
  assert.deepEqual(read.items.map(item => item.group), ['part', 'service']);
  // Edit: OK of the serviço done.
  const body = editable(read); body.items[1].done = true;
  const edited = await f.call(`/v1/documentos/service_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: read.version, data: body });
  assert.equal(edited.status, 200, JSON.stringify(edited.value)); assert.equal(edited.value.document.items[1].done, true);
  // An OS event keeps the long Equipamento in its snapshot and the Worker answers it.
  const event = await f.call(`/v1/ordens-servico/${doc.id}/eventos`, 'POST', { command_id: randomUUID(), expected_document_version: edited.value.document.version,
    data: { type: 'reception', occurred_on: '2026-10-16', declarant_name: 'Pessoa fictícia', declarant_role: 'customer', details: { accessories: null, apparent_condition: 'Condição declarada' }, notes: null,
      attachment_id: null, corrects_event_id: null, correction_reason: null, confirm_record: true } });
  assert.equal(event.status, 200, JSON.stringify(event.value).slice(0, 300));
  assert.equal((await f.call(`/v1/ordens-servico/${doc.id}/eventos`)).status, 200);
});

test('refusals: Orçar/OK only on a serviço, the group only in the OS, Equipamento only in the OS and up to 4,000', async () => {
  for (const data of [os({ items: [part({ quote: true })] }), os({ items: [labour({ group: 'outro' })] }), os({ equipment: 'x'.repeat(4001) })])
    assert.equal((await create(data)).status, 400);
  const sale = f.data('sales_orders', { items: [f.line({ product_id: f.product.id, group: 'part', quote: false, done: false })] });
  assert.equal((await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: sale })).status, 400);
  // Straight to SQL (the Worker validates first): the database refuses the same bodies.
  await assert.rejects(() => f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: sale }), /erp_document_item_group_invalid/);
  await assert.rejects(() => f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'service_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: os({ items: [part({ done: true })] }) }), /erp_document_item_group_invalid/);
  await assert.rejects(() => f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: f.data('sales_orders', { equipment: 'Equipamento' }) }), /erp_document_service_field_invalid/);
});

test('an OS whose items have the group is not saved by a client that drops it (ERP anterior): 409 campos obrigatórios', async () => {
  const doc = (await create(os())).value.document;
  const body = editable(doc); body.items = body.items.map(({ group, quote, done, ...item }) => item);
  const refused = await f.call(`/v1/documentos/service_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data: body });
  assert.equal(refused.status, 409);
  // An OS saved before 268 (no group) keeps being edited without it.
  const legacy = (await create(f.data('service_orders', { items: [f.line({ product_id: f.product.id })] }))).value.document;
  const plain = editable(legacy);
  assert.equal((await f.call(`/v1/documentos/service_orders/${legacy.id}`, 'PATCH', { command_id: randomUUID(), expected_version: legacy.version, data: { ...plain, notes: 'Sem grupo' } })).status, 200);
});

test('Cadastrar automaticamente produtos/serviços a partir de ordens de serviço: the free serviço becomes a Serviço (S), the peça a Produto (P)', async () => {
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_os', true);
  try {
    const data = os({ items: [f.line({ description: 'Peça livre 268', code: 'PCL-268', group: 'part', quote: false, done: false }), f.line({ description: 'Serviço livre 268', code: 'SVL-268', unit: 'H', group: 'service', quote: false, done: true })] });
    const saved = await create(data, f.users.vendas);
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    const kinds = await f.rows("select i.position,p.kind from erp_documents.item i join erp_catalog.product p on p.record_id=i.product_id where i.document_id=$1 order by i.position", [saved.value.document.id]);
    assert.deepEqual(kinds.map(row => row.kind), ['P', 'S']);
  } finally { await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_os', false); }
});

test('filters Peça (product_id) and Serviço (service_id) of the OS list; the Relatório de OS sums peças and serviços by group; the copy keeps the group', async () => {
  const other = await f.catalog('products', { name: 'Outro serviço sintético', code: 'SRV-269', unit: 'H', kind: 'S', format: 'S', price: '10' });
  const both = (await create(os({ date: '2026-08-10' }))).value.document;
  const onlyPart = (await create(os({ date: '2026-08-10', items: [part()] }))).value.document;
  const otherService = (await create(os({ date: '2026-08-10', items: [part(), labour({ product_id: other.id, code: 'SRV-269', description: 'Outro serviço sintético' })] }))).value.document;
  const ids = async query => (await f.call(`/v1/documentos/service_orders?page=1&limit=100&date_from=2026-08-01&date_to=2026-08-31&${query}`)).value.items.map(row => row.id).sort();
  assert.deepEqual(await ids(`service_id=${service.id}`), [both.id]);
  assert.deepEqual(await ids(`product_id=${f.product.id}&service_id=${other.id}`), [otherService.id]);
  assert.deepEqual(await ids(`product_id=${f.product.id}`), [both.id, onlyPart.id, otherService.id].sort());
  assert.equal((await f.call(`/v1/documentos/sales_orders?page=1&service_id=${service.id}`)).status, 400);
  assert.equal((await f.call('/v1/documentos/service_orders?page=1&service_id=nao-e-uuid')).status, 400);
  const report = (await f.call(`/v1/documentos/service_orders/relatorio-os?condicoes=${encodeURIComponent(JSON.stringify([{ column: 'number', value: both.number }]))}`)).value;
  assert.deepEqual(report.rows.map(row => [row.parts, row.services, row.total]), [['10.00', '120.00', '130.00']]);
  const copy = (await f.call(`/v1/duplicacao-documentos/service_orders/${both.id}/preview`)).value;
  assert.deepEqual(copy.data.items.map(item => [item.group, item.quote, item.done]), [['part', false, false], ['service', true, false]]);
});

test('Gerar ordem de serviço da proposta (pré-preenchida): the serviços (S) go to the Serviços executados, the rest to the Peças', async () => {
  const proposal = await f.create('sales_proposals', { items: [f.line({ product_id: f.product.id, description: 'Produto sintético E' }), f.line({ product_id: service.id, description: 'Mão de obra sintética', unit: 'H', unit_price: '80' }), f.line({ description: 'Item livre da proposta' })] });
  const draft = await f.call(`/v1/documentos/service_orders/a-partir-da-proposta/${proposal.id}`);
  assert.equal(draft.status, 200, JSON.stringify(draft.value));
  assert.deepEqual(draft.value.data.items.map(item => [item.description, item.group, item.quote, item.done]),
    [['Produto sintético E', 'part', false, false], ['Mão de obra sintética', 'service', false, false], ['Item livre da proposta', 'part', false, false]]);
  const sale = await f.call(`/v1/documentos/sales_orders/a-partir-da-proposta/${proposal.id}`);
  assert.equal(sale.status, 200); assert.ok(sale.value.data.items.every(item => !('group' in item)), 'the pedido de venda has no groups');
  // Saving the prefilled OS keeps the groups and concludes the proposta.
  const saved = await f.call('/v1/documentos/service_orders', 'POST', { command_id: randomUUID(), source_proposal: { id: proposal.id, expected_version: draft.value.source.version }, data: draft.value.data });
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); assert.deepEqual(saved.value.document.items.map(item => item.group), ['part', 'service', 'part']);
});
