// Synthetic data only. 202610200294: "Exibir descrição do produto no fornecedor" of the prints: the description of the product at the
// supplier (aba Fornecedores), of the supplier of the pedido de compra or the default one. PGlite with every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f, supplierA, supplierB, other;
before(async () => {
  f = await documentsEFixture();
  supplierA = await f.catalog('contacts', { name: 'Fornecedor G294 A' });
  supplierB = await f.catalog('contacts', { name: 'Fornecedor G294 B' });
  other = await f.catalog('products', { name: 'Produto G294 sem descrição', unit: 'UN', kind: 'P', format: 'S', price: '5' });
  await f.db.query(`insert into erp_catalog.product_supplier(record_id,position,supplier_id,description,code,is_default) values
    ($1,1,$2,'Parafuso 3/8 zincado',null,false),($1,2,$3,E'Parafuso\tsextavado',null,true),($4,1,$2,'   ',null,true)`, [f.product.id, supplierA.id, supplierB.id, other.id]);
});
after(async () => f?.close());
const read = (kind, id, user = f.users.admin) => f.call(`/v1/documentos/${kind}/${id}/descricoes-fornecedor`, 'GET', undefined, user);

test('privileges: erp_document_supplier_descriptions runs only for service_role', async () => {
  const sig = 'public.erp_document_supplier_descriptions(uuid,text,uuid)';
  const row = (await f.db.query('select prosecdef,proconfig,provolatile from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
  assert.deepEqual([row.prosecdef, row.proconfig, row.provolatile], [true, ['search_path=pg_catalog'], 's']);
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
});

test('sales use the default supplier; the pedido de compra its own supplier; items without a description are left out', async () => {
  const sale = await f.create('sales_orders', { items: [f.line({ product_id: f.product.id }), f.line({ product_id: other.id }), f.line()] });
  const r = await read('sales_orders', sale.id);
  assert.equal(r.status, 200, JSON.stringify(r.value));
  assert.deepEqual(r.value.items, [{ item_id: sale.items[0].id, product_id: f.product.id, description: 'Parafuso sextavado' }], 'control characters become a space');
  assert.deepEqual([r.value.kind, r.value.document_id, r.value.data_mode, r.value.operational_effects], ['sales_orders', sale.id, 'erp_native', false]);
  const order = await f.create('purchase_orders', { contact_id: supplierA.id });
  assert.deepEqual((await read('purchase_orders', order.id)).value.items.map(item => item.description), ['Parafuso 3/8 zincado']);
  const fromOther = await f.create('purchase_orders', { contact_id: f.contact.id });
  assert.deepEqual((await read('purchase_orders', fromOther.id)).value.items.map(item => item.description), ['Parafuso sextavado'], 'not a supplier of the product: the default one');
});

test('refusals: query string, unknown document, another kind, profile without read and a contact out of the seller scope', async () => {
  const sale = await f.create('sales_orders', { items: [f.line({ product_id: f.product.id })] });
  assert.equal((await f.call(`/v1/documentos/sales_orders/${sale.id}/descricoes-fornecedor?x=1`)).status, 400);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${sale.id}/descricoes-fornecedor`, 'POST', {})).status, 405);
  assert.equal((await read('sales_orders', '00000000-0000-4000-8000-000000000294')).status, 404);
  assert.equal((await read('purchase_orders', sale.id)).status, 404, 'the id of another kind is not found');
  const order = await f.create('purchase_orders', { contact_id: supplierA.id });
  assert.equal((await read('purchase_orders', order.id, f.users.vendas)).status, 403, 'Vendas does not read pedidos de compra');
  await f.seller(f.users.vendas2, { name: 'Vendedor G294' });
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try { assert.equal((await read('sales_orders', sale.id, f.users.vendas2)).status, 404); }
  finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); }
});

test('the Worker refuses a response out of contract (502)', async () => {
  const sale = await f.create('sales_orders', { items: [f.line({ product_id: f.product.id })] });
  await f.db.exec(`alter function public.erp_document_supplier_descriptions(uuid,text,uuid) rename to g294_real;
    create function public.erp_document_supplier_descriptions(p_user_id uuid,p_kind text,p_document_id uuid) returns jsonb language sql as
    $$ select public.g294_real(p_user_id,p_kind,p_document_id)||jsonb_build_object('items',jsonb_build_array(jsonb_build_object('item_id',gen_random_uuid(),'product_id',gen_random_uuid(),'description',E'a\nb'))) $$;`);
  try { assert.equal((await read('sales_orders', sale.id)).status, 502); }
  finally { await f.db.exec(`drop function public.erp_document_supplier_descriptions(uuid,text,uuid); alter function public.g294_real(uuid,text,uuid) rename to erp_document_supplier_descriptions;`); }
});
