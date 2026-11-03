import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsFixture } from './helpers/documents-b-fixture.mjs';

// 202610200131 (nota de origem, pendências, Gerar ordem serviço) on PGlite through the real Worker. Synthetic data only.
let f, complete, ready;
before(async () => {
  f = await documentsFixture({ upto: '202610200131' });
  complete = (await f.catalog('contacts', { name: 'Cliente completo', person_type: 'J', document: '11222333000181', street: 'Rua das Flores', number: '10', district: 'Centro', city: 'Piracicaba', state: 'SP', postal_code: '13400000' })).id;
  ready = (await f.catalog('products', { name: 'Produto pronto', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '39269090', origin: '0' })).id;
});
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const create = async extra => (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', extra) })).document;
const row = async (id, q = '') => (await ok(`/v1/documentos/sales_orders?page=1${q}`)).items.find(item => item.id === id);
const convert = (doc, user, command = randomUUID()) => f.call(`/v1/documentos/sales_orders/${doc.id}/gerar-os`, 'POST', { command_id: command, expected_version: doc.version }, user);

test('131 grants and private helpers', async () => {
  for (const fn of ['public.erp_document_pendencies(uuid,text,uuid)', 'public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, `${role} ${fn}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
  }
  for (const fn of ['erp_documents.pendencies(uuid)', 'erp_documents.order_invoice(uuid)', 'erp_documents.list_row(uuid,boolean,boolean)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  assert.equal(await f.scalar("select relrowsecurity v from pg_class where oid='erp_documents.sales_service_link'::regclass"), true);
});

test('pendências cadastrais: client and product data needed by the nota, flagged on the row and listed by section', async () => {
  const pending = await create({ items: [f.line({ product_id: f.product.id, description: 'Produto sem NCM' }), f.line({ description: 'Item livre' })] });
  assert.equal((await row(pending.id)).pendencies, true);
  const listed = await ok(`/v1/documentos/sales_orders/${pending.id}/pendencias`, 'GET', undefined, f.users.vendas);
  assert.deepEqual(listed.pendencies.map(p => `${p.section} • ${p.message}`), [
    'Cliente • O campo CPF/CNPJ é obrigatório', 'Cliente • O campo Endereço é obrigatório', 'Cliente • O campo Número é obrigatório', 'Cliente • O campo Bairro é obrigatório',
    'Cliente • O campo Cidade é obrigatório', 'Cliente • O campo UF é obrigatório', 'Cliente • O campo CEP é obrigatório',
    'Produto Produto sem NCM • O campo NCM é obrigatório', 'Produto Produto sem NCM • O campo Origem é obrigatório', 'Produto Item livre • O item não está vinculado a um produto cadastrado']);
  const clean = await create({ contact_id: complete, items: [f.line({ product_id: ready, description: 'Produto pronto' })] });
  assert.equal((await row(clean.id)).pendencies, false);
  assert.deepEqual((await ok(`/v1/documentos/sales_orders/${clean.id}/pendencias`)).pendencies, []);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${clean.id}/pendencias`, 'GET', undefined, f.users.estoque)).status, 200, 'estoque reads pedidos');
  assert.equal((await f.call(`/v1/documentos/sales_orders/${clean.id}/pendencias?x=1`)).status, 400);
});

test('the nota fiscal linked to the pedido shows on its row; Gerar ordem serviço happens once and only without nota', async () => {
  const sale = await create({ contact_id: complete, items: [f.line({ product_id: ready, description: 'Produto pronto', quantity: '2' })] });
  assert.equal((await convert(sale, f.users.estoque)).status, 403, 'estoque does not write OS');
  assert.equal((await convert(sale, f.users.consulta)).status, 403, 'consulta only reads');
  const command = randomUUID(), first = await convert(sale, f.users.vendas, command);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const os = first.value.service_order;
  assert.deepEqual([os.kind, os.status, os.version, os.contact_id, os.items.length, os.totals.total], ['service_orders', 'open', 1, complete, 1, sale.totals.total]);
  assert.equal(first.value.sale.status, sale.status, 'the pedido keeps its situação');
  const replay = await convert(sale, f.users.vendas, command);
  assert.deepEqual([replay.status, replay.value.replayed, replay.value.service_order.id], [200, true, os.id]);
  assert.equal((await convert(sale, f.users.vendas)).status, 409, 'only one OS per pedido');
  assert.equal((await row(sale.id)).service_order_number, os.number);
  const history = await ok(`/v1/documentos/sales_orders/${sale.id}/ocorrencias`);
  assert.equal(history.items[0].text, `Ordem de serviço ${os.number} gerada a partir deste pedido`);
  const invoiced = await create({ contact_id: complete, items: [f.line({ product_id: ready, description: 'Produto pronto' })] });
  const invoice = randomUUID();
  await f.db.query(`insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
    values($1,'55','1','N','2',1,1,321,'Venda sintética','2026-10-19','1','1','1',false,'{}','[]','{}','{}','[]','{}',false,0,0,0,0,'{}',$2,$2)`, [invoice, f.users.admin]);
  await f.db.query('insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id)values($1,$2)', [invoice, invoiced.id]);
  assert.deepEqual((await row(invoiced.id)).invoice, { model: '55', number: '321', series: '1', issue_date: '2026-10-19', authorized: false });
  assert.deepEqual((await ok('/v1/documentos/sales_orders?page=1', 'GET', undefined, f.users.fiscal)).items.find(item => item.id === invoiced.id).invoice?.number, '321', 'fiscal reads the Brufap notas');
  // The Brufap notas are read only by admin and fiscal (113): the other profiles that read pedidos do not see them on the row.
  for (const user of [f.users.vendas, f.users.estoque, f.users.consulta, f.users.financeiro])
    assert.equal((await ok('/v1/documentos/sales_orders?page=1', 'GET', undefined, user)).items.find(item => item.id === invoiced.id).invoice, null);
  assert.equal((await row(sale.id)).invoice, null);
  assert.equal((await convert(invoiced, f.users.vendas)).status, 400, 'a pedido with nota fiscal does not generate an OS');
  for (const body of [{ command_id: randomUUID() }, { command_id: 'x', expected_version: 1 }, { command_id: randomUUID(), expected_version: 1, extra: 1 }])
    assert.equal((await f.call(`/v1/documentos/sales_orders/${invoiced.id}/gerar-os`, 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await f.call(`/v1/documentos/sales_orders/${invoiced.id}/gerar-os`)).status, 405);
});

test('Gerar venda and Gerar ordem de serviço no longer require Aprovado (only not cancelled, not concluded, not a model)', async () => {
  const draft = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals') })).document;
  const sale = await ok(`/v1/documentos/sales_proposals/${draft.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: draft.version });
  assert.deepEqual([sale.proposal.status, sale.sale.status], ['completed', 'open']);
  let cancelled = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals') })).document;
  cancelled = (await ok(`/v1/documentos/sales_proposals/${cancelled.id}/status`, 'POST', { command_id: randomUUID(), expected_version: cancelled.version, status: 'cancelled', reason: 'Cliente desistiu' })).document;
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${cancelled.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: cancelled.version })).status, 400);
  const model = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals', { template: true }) })).document;
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${model.id}/convert-service`, 'POST', { command_id: randomUUID(), expected_version: model.version })).status, 400);
  const named = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals', { template: true, template_name: 'Modelo de instalação' }) })).document;
  assert.equal((await ok('/v1/documentos/sales_proposals?page=1&template=true')).items.find(item => item.id === named.id).template_name, 'Modelo de instalação', 'Selecione o modelo shows the name');
  const pending = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals') })).document;
  assert.equal((await ok(`/v1/documentos/sales_proposals/${pending.id}/convert-service`, 'POST', { command_id: randomUUID(), expected_version: pending.version })).service_order.status, 'open');
});
