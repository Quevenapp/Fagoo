import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';
import { COMPANY, SUPPLIER, nfeXml } from './helpers/fiscal-import-xml.mjs';

// 202610200167 ("Importar › Pedido XML") on PGlite through the real Worker. Synthetic NF-e XML only; nothing is saved.
let f, customer, supplier, product;
before(async () => {
  f = await documentsCFixture({ upto: '202610200167' });
  customer = (await f.catalog('contacts', { name: 'Cliente do XML', person_type: 'J', document: '12.345.678/0001-95' })).id;
  supplier = (await f.catalog('contacts', { name: 'Fornecedor do XML', person_type: 'J', document: '11222333000181' })).id;
  product = (await f.catalog('products', { name: 'Produto com GTIN', code: 'PG-1', unit: 'PC', kind: 'P', format: 'S', price: '10', gtin: '7891234567895' })).id;
});
after(() => f?.close());
const post = (kind, xml, user) => f.call(`/v1/documentos/${kind}/importar-xml`, 'POST', { xml }, user);

test('167 grants', async () => {
  const fn = 'public.erp_document_xml_match(uuid,text,text,jsonb)';
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
});

test('a pedido de venda from an NF-e the company emitted: customer by CNPJ, products by GTIN or code, nothing saved', async () => {
  const xml = nfeXml({ emit: COMPANY, dest: SUPPLIER, items: [{ code: 'X-9', name: 'Produto com GTIN', quantity: '2.0000', price: '10.0000', ean: '7891234567895' }, { code: 'pg-1', name: 'Pelo código', quantity: '1.5000', price: '4.2500' }, { code: 'LIVRE', name: 'Item livre', quantity: '1.0000', price: '5.0000' }], freight: '3.00', dup: false }).xml;
  // The customer is the recipient of the XML: its CNPJ is SUPPLIER of the helper, registered here as "Cliente do XML".
  const before = await f.scalar('select count(*)::int v from erp_documents.document');
  const response = await post('sales_orders', xml, f.users.vendas);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const value = response.value;
  assert.deepEqual(value.contact, { id: customer, name: 'Cliente do XML' });
  assert.deepEqual(value.items.map(item => [item.description, item.quantity, item.unit_price, item.product?.id ?? null, item.product?.by ?? null]),
    [['Produto com GTIN', '2.0000', '10.0000', product, 'gtin'], ['Pelo código', '1.5000', '4.2500', product, 'code'], ['Item livre', '1.0000', '5.0000', null, null]]);
  assert.equal(value.freight, '3.00'); assert.equal(value.issue_date, '2026-10-18'); assert.equal(value.number, '321');
  assert.equal(await f.scalar('select count(*)::int v from erp_documents.document'), before, 'nothing is saved by the import');
});

test('a pedido de compra from the supplier NF-e; refusals for test, unauthorized and oversized XML; profiles', async () => {
  const xml = nfeXml({ emit: COMPANY, dest: SUPPLIER }).xml;
  const purchase = await post('purchase_orders', nfeXml({ emit: '11222333000181', dest: '12345678000195' }).xml, f.users.estoque);
  assert.equal(purchase.status, 200, JSON.stringify(purchase.value));
  assert.deepEqual(purchase.value.contact, { id: supplier, name: 'Fornecedor do XML' });
  assert.deepEqual([purchase.value.items[0].product.id, purchase.value.items[0].product.by], [product, 'gtin'], 'the supplier item is found by its GTIN');
  assert.equal((await post('sales_orders', nfeXml({ emit: COMPANY, tpAmb: '2' }).xml)).status, 422);
  assert.equal((await post('sales_orders', nfeXml({ emit: COMPANY, withProtocol: false }).xml)).status, 422);
  assert.equal((await post('sales_orders', '<nao-e-nfe/>')).status, 422);
  assert.equal((await f.call('/v1/documentos/sales_orders/importar-xml', 'POST', { xml, extra: 1 })).status, 400);
  assert.equal((await post('purchase_orders', xml, f.users.vendas)).status, 403);
  assert.equal((await post('sales_orders', xml, f.users.consulta)).status, 403);
  assert.ok([404, 405].includes((await f.call('/v1/documentos/service_orders/importar-xml', 'POST', { xml })).status), 'OS have no XML import');
});

test('the XML is read only after the session is authenticated: an anonymous or rejected session never has its body read', async () => {
  const { createHandler } = await import('../src/index.mjs');
  const env = { SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
  const calls = [];
  const handler = createHandler({ fetchImpl: async url => { calls.push(url); return new Response(JSON.stringify({ message: 'invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json' } }); } });
  const request = authorization => {
    const tracker = { read: false };
    const body = new ReadableStream({ pull(controller) { tracker.read = true; controller.enqueue(new TextEncoder().encode('{"xml":"<nao-e-nfe/>"')); controller.close(); } }, { highWaterMark: 0 });
    return { tracker, request: new Request('https://api.synthetic.invalid/v1/documentos/sales_orders/importar-xml', { method: 'POST', duplex: 'half', body,
      headers: { 'Content-Type': 'application/json', Origin: 'https://synthetic.invalid', ...(authorization ? { Authorization: authorization } : {}) } }) };
  };
  const anonymous = request(null);
  assert.equal((await handler(anonymous.request, env)).status, 401);
  assert.equal(anonymous.tracker.read, false, 'no body is read without a session');
  assert.equal(calls.length, 0);
  const rejected = request('Bearer sessao-sintetica-invalida');
  assert.equal((await handler(rejected.request, env)).status, 401);
  assert.equal(rejected.tracker.read, false, 'a rejected session never reaches the XML');
  assert.ok(calls.every(url => url.endsWith('/auth/v1/user')));
});
