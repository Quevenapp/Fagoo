import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsDFixture } from './helpers/documents-d-fixture.mjs';

// 202610200198 (letra N das ordens de serviço com nota fiscal) on PGlite through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsDFixture(); });
after(() => f?.close());
const rowOf = async (id, user = f.users.admin) => (await f.call('/v1/documentos/service_orders?page=1', 'GET', undefined, user)).value.items.find(item => item.id === id);

test('198 keeps list_row internal', async () => {
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_documents.list_row(uuid,boolean,boolean)','EXECUTE') v"), false);
});

test('an OS with a nota fiscal shows it like the pedido: number for administrador, the link for the other profiles', async () => {
  const os = await f.create('service_orders', { items: [f.line({ product_id: f.product.id, description: 'Peça' })] });
  assert.deepEqual([(await rowOf(os.id)).invoice, (await rowOf(os.id)).invoice_linked], [null, false]);
  const invoice = randomUUID();
  await f.db.query(`insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
    values($1,'55','1','N','2',1,1,654,'Venda sintética','2026-10-20','1','1','1',false,'{}','[]','{}','{}','[]','{}',false,0,0,0,0,'{}',$2,$2)`, [invoice, f.users.admin]);
  await f.db.query('insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id)values($1,$2)', [invoice, os.id]);
  const admin = await rowOf(os.id);
  assert.deepEqual([admin.invoice?.number, admin.invoice_linked], ['654', true]);
  const vendas = await rowOf(os.id, f.users.vendas);
  assert.deepEqual([vendas.invoice, vendas.invoice_linked], [null, true], 'the number and date stay with administrador and fiscal');
});
