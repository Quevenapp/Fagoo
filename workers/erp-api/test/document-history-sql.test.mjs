import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';

// 202610200169 (históricos dos formulários) on PGlite through the real Worker. Synthetic data only; nothing is saved by the reads.
let f, supplier;
before(async () => {
  f = await documentsCFixture({ upto: '202610200169' });
  supplier = await f.catalog('contacts', { name: 'Fornecedor sintético' });
  const item = (description, extra = {}) => f.line({ product_id: f.product.id, description, code: null, ...extra });
  await f.create('sales_orders', { date: '2026-09-01', items: [item('Produto sintético C', { quantity: '2', unit_price: '9.5' }), f.line({ description: 'Serviço avulso', unit_price: '3' })] });
  await f.create('sales_orders', { date: '2026-10-01', items: [item('Produto sintético C', { quantity: '1.5', unit_price: '10' })] });
  const cancelled = await f.create('sales_orders', { date: '2026-10-05', items: [item('Produto sintético C', { quantity: '7' })] });
  await f.db.query("update erp_documents.document set status='cancelled',version=version+1 where id=$1", [cancelled.id]);
  await f.create('purchase_orders', { date: '2026-08-10', contact_id: supplier.id, items: [item('Produto sintético C', { quantity: '10', unit_price: '6.25' })] });
  await f.create('purchase_orders', { date: '2026-08-20', items: [item('Produto sintético C', { quantity: '3', unit_price: '6.5' })] });
  // A nota fiscal de saída autorizada do Brufap for the same cliente (inserted directly; the notas lane owns the writer).
  const invoice = (await f.db.query(`insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,
    recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
    values('55','1','N','2',6,1,42,'Venda sintética','2026-10-10','1','1','1',false,$1::jsonb,'[]','{}','{}','[]','{}',false,0,0,0,0,'{}',$2,$2) returning id`,
    [JSON.stringify({ contact_id: f.contact.id, name: 'Contato sintético C', person_type: 'F' }), f.users.admin])).rows[0].id;
  await f.db.query(`insert into erp_fiscal_invoices.invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
    values($1,1,$2,4,8.75,35,0,0,0,0,$3::jsonb)`, [invoice, f.product.id, JSON.stringify({ description: 'Produto sintético C', code: 'PSC', unit: 'UN' })]);
  // Contas a receber do cliente: one open and overdue, one partly settled, one settled (not shown).
  for (const [due, amount, settled] of [['2026-09-15', 10000, 0], ['2026-11-15', 5000, 2000], ['2026-10-01', 3000, 3000]])
    await f.db.query(`insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents)
      values($1,1,1,'receivable',$2,'Pedido de venda sintético','2026-09-01',$3,$4,$5)`, [randomUUID(), f.contact.id, due, amount, settled]);
});
after(() => f?.close());
const get = (path, user) => f.call(path, 'GET', undefined, user);
const ok = async (path, user) => { const r = await get(path, user); assert.equal(r.status, 200, `${path} ${JSON.stringify(r.value)}`); return r.value; };

test('169 grants', async () => {
  const fn = 'public.erp_document_history(uuid,text,uuid,uuid,text,integer)';
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
});

test('Últimos registros deste cliente: vendas (not cancelled), notas for administrador and fiscal, pesquisa and the open receivables', async () => {
  const admin = await ok(`/v1/documentos/sales_orders/historico?contact_id=${f.contact.id}`);
  assert.deepEqual(admin.items.map(item => [item.type, item.date, item.description, item.quantity, item.unit_price]), [
    ['invoice', '2026-10-10', 'Produto sintético C', '4.000000', '8.7500'],
    ['sale', '2026-10-01', 'Produto sintético C', '1.500000', '10.0000'],
    ['sale', '2026-09-01', 'Produto sintético C', '2.000000', '9.5000'],
    ['sale', '2026-09-01', 'Serviço avulso', '1.000000', '3.0000']]);
  assert.equal(admin.invoices_included, true);
  assert.deepEqual([admin.finance.open_count, admin.finance.open_amount, admin.finance.overdue_amount], [2, '130.00', '100.00']);
  assert.deepEqual(admin.finance.titles.map(t => [t.due_on, t.open_amount]), [['2026-09-15', '100.00'], ['2026-11-15', '30.00']]);
  const seller = await ok(`/v1/documentos/sales_proposals/historico?contact_id=${f.contact.id}&q=avulso`, f.users.vendas);
  assert.deepEqual(seller.items.map(item => item.description), ['Serviço avulso'], 'pesquisa by description; the vendas profile does not see notas');
  assert.equal(seller.invoices_included, false);
  assert.equal(seller.finance.open_amount, '130.00', 'the summary of open receivables is shown to whoever reads the document');
  const item = await ok(`/v1/documentos/sales_orders/historico?contact_id=${f.contact.id}&product_id=${f.product.id}`, f.users.vendas);
  assert.deepEqual(item.items.map(row => row.quantity), ['1.500000', '2.000000']);
  assert.equal(item.finance, null);
  const page = await ok(`/v1/documentos/sales_orders/historico?contact_id=${f.contact.id}&limit=2`);
  assert.deepEqual([page.items.length, page.has_more], [2, true]);
});

test('Últimas compras of the product, all suppliers or only the supplier of the pedido; refusals', async () => {
  const all = await ok(`/v1/documentos/purchase_orders/historico?product_id=${f.product.id}`, f.users.estoque);
  assert.deepEqual(all.items.map(item => [item.type, item.date, item.unit_price]), [['purchase', '2026-08-20', '6.5000'], ['purchase', '2026-08-10', '6.2500']]);
  assert.equal(all.finance, null);
  const one = await ok(`/v1/documentos/purchase_orders/historico?product_id=${f.product.id}&contact_id=${supplier.id}`, f.users.estoque);
  assert.deepEqual(one.items.map(item => item.quantity), ['10.000000']);
  assert.equal((await get('/v1/documentos/purchase_orders/historico', f.users.estoque)).status, 400, 'the product is required');
  assert.equal((await get('/v1/documentos/sales_orders/historico')).status, 400, 'the cliente is required');
  assert.equal((await get(`/v1/documentos/sales_orders/historico?contact_id=${f.contact.id}&limit=51`)).status, 400);
  assert.equal((await get(`/v1/documentos/sales_orders/historico?contact_id=${f.contact.id}&extra=1`)).status, 400);
  assert.equal((await get(`/v1/documentos/purchase_orders/historico?product_id=${f.product.id}`, f.users.vendas)).status, 403);
});
