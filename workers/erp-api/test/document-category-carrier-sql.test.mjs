import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';

// 202610200168 (Categoria e Transportador do cadastro nos documentos) on PGlite through the real Worker. Synthetic data only.
let f, sale, saleChild, purchase, carrier;
const finance = (action, data) => f.rpc('erp_finance_category_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const category = async (kind, name, parent = null) => (await finance('category_create', { kind, name, ...(parent ? { parent_id: parent } : {}) })).record.id;
const setActive = async (id, active) => finance('category_set_active', { id, active, expected_version: await f.scalar('select version v from erp_finance.category where id=$1', [id]) });
before(async () => {
  f = await documentsCFixture({ upto: '202610200168' });
  sale = await category('receivable', 'Vendas sintéticas');
  saleChild = await category('receivable', 'Balcão', sale);
  purchase = await category('payable', 'Compras sintéticas');
  carrier = await f.catalog('contacts', { name: 'Transportadora Sintética' });
});
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const save = (kind, extra, user) => f.call(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: f.data(kind, extra) }, user);
const read = async (kind, id) => (await ok(`/v1/documentos/${kind}/${id}`)).document;

test('168 grants', async () => {
  const fn = 'public.erp_document_categories(uuid,text)';
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
  for (const internal of ['erp_documents.check_links(text,jsonb,jsonb)', 'erp_documents.category_usable(text,text)', 'erp_documents.carrier_usable(text)', 'erp_documents.document_finance_category(erp_documents.document,uuid)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [internal]), false, internal);
});

test('Categoria: receita in pedidos de venda and OS, despesa in compras, checked when new or changed; the reading names it', async () => {
  const options = await ok('/v1/documentos/sales_orders/categorias', 'GET', undefined, f.users.vendas);
  assert.deepEqual(options.items.map(item => [item.name, item.depth]), [['Vendas sintéticas', 1], ['Balcão', 2]]);
  assert.deepEqual([options.category_kind, options.default, options.has_more], ['receivable', null, false]);
  assert.deepEqual((await ok('/v1/documentos/purchase_orders/categorias', 'GET', undefined, f.users.estoque)).items.map(item => item.name), ['Compras sintéticas']);
  assert.equal((await f.call('/v1/documentos/sales_proposals/categorias')).status, 404, 'propostas have no categoria');
  assert.equal((await f.call('/v1/documentos/purchase_orders/categorias', 'GET', undefined, f.users.vendas)).status, 403);

  const created = await save('sales_orders', { category_id: saleChild }, f.users.vendas);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const doc = await read('sales_orders', created.value.document.id);
  assert.deepEqual([doc.category_id, doc.category_name], [saleChild, 'Balcão']);
  assert.equal((await save('sales_orders', { category_id: purchase })).status, 400, 'a despesa is refused in a pedido de venda');
  assert.equal((await save('purchase_orders', { category_id: sale })).status, 400, 'a receita is refused in a pedido de compra');
  assert.equal((await save('purchase_orders', { category_id: purchase })).status, 200);
  assert.equal((await save('service_orders', { category_id: sale })).status, 200);
  assert.equal((await save('sales_proposals', { category_id: sale })).status, 400, 'propostas have no categoria');
  assert.equal((await save('sales_orders', { category_id: randomUUID() })).status, 400);
  // An inactive categoria cannot be chosen again, but a pedido that already has it can still be edited.
  await setActive(saleChild, false);
  assert.equal((await save('sales_orders', { category_id: saleChild })).status, 400);
  const edited = await f.call(`/v1/documentos/sales_orders/${doc.id}`, 'PATCH', { command_id: randomUUID(), expected_version: doc.version, data: f.data('sales_orders', { category_id: saleChild, notes: 'Editado' }) });
  assert.equal(edited.status, 200, JSON.stringify(edited.value));
  assert.deepEqual((await ok('/v1/documentos/sales_orders/categorias')).items.map(item => item.name), ['Vendas sintéticas']);
  await setActive(saleChild, true);
});

test('Transportador of the cadastro: checked when new or changed, named in the reading, pendência and list filter', async () => {
  const created = await save('sales_orders', { carrier_id: carrier.id, commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
    transport: { freight_mode: '1', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } } }, f.users.vendas);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const doc = await read('sales_orders', created.value.document.id);
  assert.deepEqual([doc.carrier_id, doc.carrier_name], [carrier.id, 'Transportadora Sintética']);
  const pendencies = await ok(`/v1/documentos/sales_orders/${doc.id}/pendencias`);
  assert.equal(pendencies.pendencies.some(item => item.section === 'Transportador'), false, 'the transportador of the cadastro satisfies the pendência');
  const without = (await save('sales_orders', { commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
    transport: { freight_mode: '1', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } } })).value.document;
  assert.equal((await ok(`/v1/documentos/sales_orders/${without.id}/pendencias`)).pendencies.some(item => item.section === 'Transportador'), true);
  const listed = await ok('/v1/documentos/sales_orders?carrier=sintética&limit=25&page=1&order=number_desc');
  assert.deepEqual(listed.items.map(item => item.id), [doc.id], 'the Transportador filter finds the name of the cadastro');
  assert.equal(listed.items[0].carrier_name, 'Transportadora Sintética', 'the Transportador column shows the cadastro');
  assert.equal((await save('sales_proposals', { carrier_id: carrier.id })).status, 200);
  assert.equal((await save('purchase_orders', { carrier_id: carrier.id })).status, 200);
  assert.equal((await save('sales_orders', { carrier_id: f.product.id })).status, 400, 'a product is not a transportador');
});

test('Lançar contas uses the categoria of the pedido before the padrão; a chosen one wins; clones keep both links', async () => {
  const other = await category('receivable', 'Serviços sintéticos');
  await finance('category_set_default', { key: 'sale', category_id: other, expected_version: await f.scalar("select version v from erp_finance.category_default where key='sale'") });
  const created = (await save('sales_orders', { category_id: sale, carrier_id: carrier.id, installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] })).value.document;
  const verified = (await ok(`/v1/documentos/sales_orders/${created.id}/status`, 'POST', { command_id: randomUUID(), expected_version: created.version, status: 'verified', reason: null })).document;
  const base = `/v1/documentos/sales_orders/${verified.id}/financeiro`;
  const preview = (await ok(`${base}/preview`, 'POST', { expected_document_version: verified.version, category_id: null, installments: null }, f.users.financeiro)).preview;
  assert.deepEqual([preview.category_id, preview.category_name], [sale, 'Vendas sintéticas']);
  const chosen = (await ok(`${base}/preview`, 'POST', { expected_document_version: verified.version, category_id: other, installments: null }, f.users.financeiro)).preview;
  assert.equal(chosen.category_id, other);
  const posted = await ok(`${base}/post`, 'POST', { expected_document_version: verified.version, category_id: null, installments: null, command_id: randomUUID(), preview_hash: preview.preview_hash }, f.users.financeiro);
  assert.equal(posted.titles[0].category_id, sale);
  // With the categoria of the pedido inactive, the padrão is used.
  const second = (await save('sales_orders', { category_id: saleChild, installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] })).value.document;
  await setActive(saleChild, false);
  const checked = (await ok(`/v1/documentos/sales_orders/${second.id}/status`, 'POST', { command_id: randomUUID(), expected_version: second.version, status: 'verified', reason: null })).document;
  assert.equal((await ok(`/v1/documentos/sales_orders/${checked.id}/financeiro/preview`, 'POST', { expected_document_version: checked.version, category_id: null, installments: null }, f.users.financeiro)).preview.category_id, other);
  // Clonar keeps the categoria and the transportador that can still be chosen.
  const copy = await ok(`/v1/duplicacao-documentos/sales_orders/${created.id}/preview`, 'GET');
  assert.deepEqual([copy.data.category_id, copy.data.carrier_id], [sale, carrier.id]);
  const stale = await ok(`/v1/duplicacao-documentos/sales_orders/${second.id}/preview`, 'GET');
  assert.equal(stale.data.category_id ?? null, null, 'an inactive categoria is not copied');
  await setActive(saleChild, true);
});

test('a transition with Lançar contas uses the categoria of the pedido when there is no padrão', async () => {
  const fresh = await documentsCFixture({ upto: '202610200168' });
  try {
    const own = (await fresh.rpc('erp_finance_category_execute', { p_user_id: fresh.users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'payable', name: 'Compras do pedido' } })).record.id;
    const doc = await fresh.create('purchase_orders', { category_id: own, installments: [{ due_date: '2026-11-20', amount: '10.00', method: null }] });
    await fresh.transition('purchase_orders', 'open', 'in_progress', { active: true, actions: ['post_finance'] });
    const moved = await fresh.call(`/v1/documentos/purchase_orders/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status: 'in_progress', reason: null });
    assert.equal(moved.status, 200, JSON.stringify(moved.value));
    assert.equal(await fresh.scalar('select count(*)::int v from erp_finance.title t join erp_finance.document_title l on l.title_id=t.id join erp_finance.document_posting p on p.id=l.posting_id where p.document_id=$1 and t.category_id=$2', [doc.id, own]), 1);
  } finally { await fresh.close(); }
});

test('"Editar contato": the save with refresh_contact takes the current data of the contact; without it the snapshot stays', async () => {
  const person = await f.catalog('contacts', { name: 'Nome antigo' });
  const created = (await save('sales_orders', { contact_id: person.id })).value.document;
  const version = await f.scalar('select version v from erp_catalog.record where id=$1', [person.id]);
  const updated = await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: 'contacts', p_id: person.id, p_expected_version: version, p_command_id: randomUUID(), p_data: { name: 'Nome novo' } });
  assert.equal(updated.record.name, 'Nome novo');
  const kept = await f.call(`/v1/documentos/sales_orders/${created.id}`, 'PATCH', { command_id: randomUUID(), expected_version: created.version, data: f.data('sales_orders', { contact_id: person.id, notes: 'Sem atualizar' }) });
  assert.equal(kept.value.document.contact_snapshot.name, 'Nome antigo');
  const refreshed = await f.call(`/v1/documentos/sales_orders/${created.id}`, 'PATCH', { command_id: randomUUID(), expected_version: kept.value.document.version, data: { ...f.data('sales_orders', { contact_id: person.id }), refresh_contact: true } });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.value));
  assert.equal(refreshed.value.document.contact_snapshot.name, 'Nome novo');
  assert.equal(Object.hasOwn(refreshed.value.document, 'refresh_contact'), false, 'the flag is never stored');
  assert.equal((await f.call(`/v1/documentos/sales_orders/${created.id}`, 'PATCH', { command_id: randomUUID(), expected_version: refreshed.value.document.version, data: { ...f.data('sales_orders', { contact_id: person.id }), refresh_contact: false } })).status, 400);
});

test('Preferências › Serviços "Data base da garantia" decides the Garantia filter of the OS list', async () => {
  const os = (await save('service_orders', { date: '2026-10-01', finish_date: '2026-10-10', warranty_days: '30' })).value.document;
  const found = async day => (await ok(`/v1/documentos/service_orders?date_type=warranty_until&date_from=${day}&date_to=${day}&limit=25&page=1&order=number_desc`)).items.map(item => item.id);
  assert.deepEqual(await found('2026-10-31'), [os.id], 'Não utilizar keeps the rule of 102: data de saída, else the date of the OS');
  await f.setPreference('servicos-os', 'os.garantia_base', 'data_conclusao');
  assert.deepEqual(await found('2026-11-09'), [os.id], 'counted from the data de conclusão');
  assert.deepEqual(await found('2026-10-31'), []);
});
