import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';

// 202610200164 (vendedor nativo, regras das Preferências e dos vendedores, conversões, numeração, cadastro automático de
// produtos, cópia, pendências) on PGlite through the real Worker. Synthetic data only.
let f;
before(async () => { f = await documentsCFixture({ upto: '202610200164' }); });
after(() => f?.close());
const ok = async (path, method = 'GET', body, user) => { const r = await f.call(path, method, body, user); assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.value)}`); return r.value; };
const save = (kind, data, user, id = null, version = null) => f.call(`/v1/documentos/${kind}${id ? `/${id}` : ''}`, id ? 'PATCH' : 'POST', { command_id: randomUUID(), data, ...(id ? { expected_version: version } : {}) }, user);
const seller = async (user, extra = {}) => {
  const contact = await f.catalog('contacts', { name: `Vendedor ${randomUUID().slice(0, 8)}` });
  const id = randomUUID();
  await f.db.query('insert into erp_catalog.seller(id,contact_id,user_id,allow_unregistered_products,discount_limit,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$6)', [id, contact.id, user ?? null, extra.allow ?? false, extra.limit ?? '0', f.users.admin]);
  return id;
};

test('164 grants and private helpers', async () => {
  for (const fn of ['erp_documents.check_seller_rules(uuid,text,jsonb)', 'erp_documents.auto_products(uuid,text,uuid,jsonb)', 'erp_documents.stored_rules_data(uuid)', 'erp_documents.require_seller(uuid)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  for (const fn of ['public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)', 'public.erp_document_access(uuid)', 'public.erp_proposal_convert(uuid,uuid,integer,uuid)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true);
  }
});

test('native vendedor: checked on save, listed with its name and filtered; required by the Preferências', async () => {
  const id = await seller(null);
  assert.equal((await save('sales_orders', f.data('sales_orders', { seller_id: randomUUID() }))).status, 400);
  assert.equal((await save('purchase_orders', f.data('purchase_orders', { seller_id: id }))).status, 400);
  const doc = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { seller_id: id }) })).document;
  assert.equal(doc.seller_id, id);
  const listed = await ok(`/v1/documentos/sales_orders?page=1&seller_id=${id}`);
  assert.deepEqual(listed.items.map(item => [item.id, item.seller_id, item.seller_name.startsWith('Vendedor')]), [[doc.id, id, true]]);
  assert.equal((await f.call(`/v1/documentos/purchase_orders?page=1&seller_id=${id}`)).status, 400);
  await f.setPreference('vendas-vendas', 'vendas.vendedor_obrigatorio', true);
  assert.equal((await save('sales_orders', f.data('sales_orders'))).status, 400);
  await f.setPreference('vendas-propostas', 'propostas.vendedor_obrigatorio', true);
  assert.equal((await save('sales_proposals', f.data('sales_proposals'))).status, 400);
  assert.equal((await save('sales_proposals', f.data('sales_proposals', { template: true, template_name: 'Modelo' }))).status, 200, 'modelos are exempt');
  await f.setPreference('vendas-vendas', 'vendas.vendedor_obrigatorio', false);
  await f.setPreference('vendas-propostas', 'propostas.vendedor_obrigatorio', false);
  // The copy keeps the vendedor.
  const preview = await ok(`/v1/duplicacao-documentos/sales_orders/${doc.id}/preview`);
  assert.equal(preview.data.seller_id, id);
});

test('vendedor linked to the user: unregistered products and the discount limit', async () => {
  const user = randomUUID();
  await f.db.query('insert into auth.users(id,email) values($1,$2)', [user, 'vendedor@sintetico.test']);
  await f.db.query("insert into erp_access.membership(user_id,role) values($1,'vendas')", [user]);
  await seller(user, { limit: '5' });
  const access = await ok('/v1/documentos', 'GET', undefined, user);
  assert.deepEqual([access.seller.allow_unregistered_products, access.seller.discount_limit], [false, '5.0000']);
  assert.equal((await save('sales_orders', f.data('sales_orders'), user)).status, 400, 'free item refused');
  const item = f.line({ product_id: f.product.id, description: 'Produto sintético C' });
  assert.equal((await save('sales_orders', f.data('sales_orders', { items: [{ ...item, discount_percent: '10' }] }), user)).status, 400);
  assert.equal((await save('sales_orders', f.data('sales_orders', { items: [item], discount_mode: 'percent', discount_value: '6' }), user)).status, 400);
  assert.equal((await save('sales_orders', f.data('sales_orders', { items: [item], discount_mode: 'percent', discount_value: '5' }), user)).status, 200);
  assert.equal((await save('sales_proposals', f.data('sales_proposals'), user)).status, 200, 'propostas accept free items');
  assert.equal((await save('sales_proposals', f.data('sales_proposals', { items: [{ ...item, discount_percent: '7' }] }), user)).status, 400);
});

test('casas decimais do preço: saídas and entradas follow Preferências › Empresa', async () => {
  await f.setPreference('empresa-geral', 'empresa.decimais_preco_saida', 2);
  assert.equal((await save('sales_orders', f.data('sales_orders', { items: [f.line({ unit_price: '10.123' })] }))).status, 400);
  assert.equal((await save('sales_orders', f.data('sales_orders', { items: [f.line({ unit_price: '10.12' })] }))).status, 200);
  assert.equal((await save('purchase_orders', f.data('purchase_orders', { items: [f.line({ unit_price: '10.123' })] }))).status, 200);
  assert.equal((await ok('/v1/documentos')).settings.price_decimals_out, 2);
  await f.setPreference('empresa-geral', 'empresa.decimais_preco_saida', 10);
});

test('conversions follow the rules of the generated document', async () => {
  const proposal = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals') })).document;
  await f.setPreference('vendas-vendas', 'vendas.produtos_nao_cadastrados', false);
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${proposal.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: proposal.version })).status, 400);
  await f.setPreference('vendas-vendas', 'vendas.produtos_nao_cadastrados', true);
  const item = f.line({ product_id: f.product.id, description: 'Produto sintético C' });
  const repeated = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals', { items: [item, item] }) })).document;
  const order = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { items: [item, item] }) })).document;
  await f.setPreference('servicos-os', 'os.itens_repetidos', false);
  assert.equal((await f.call(`/v1/documentos/sales_proposals/${repeated.id}/convert-service`, 'POST', { command_id: randomUUID(), expected_version: repeated.version })).status, 400);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${order.id}/gerar-os`, 'POST', { command_id: randomUUID(), expected_version: order.version })).status, 400);
  await f.setPreference('servicos-os', 'os.itens_repetidos', true);
  assert.equal((await f.call(`/v1/documentos/sales_orders/${order.id}/gerar-os`, 'POST', { command_id: randomUUID(), expected_version: order.version })).status, 200);
  // Cross-Docking enters the data prevista calculated when generating the sale.
  await f.setPreference('vendas-propostas', 'propostas.data_prevista_prazo', true);
  await f.setPreference('suprimentos-estoque', 'estoque.cross_docking_dias', 2);
  const timed = (await ok('/v1/documentos/sales_proposals', 'POST', { command_id: randomUUID(), data: f.data('sales_proposals', { commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
    transport: { freight_mode: null, volume_count: null, gross_weight: null, delivery_days: '3', carrier_reference: null, service_reference: null, tracking_code: null } } }) })).document;
  const converted = await ok(`/v1/documentos/sales_proposals/${timed.id}/convert`, 'POST', { command_id: randomUUID(), expected_version: timed.version });
  assert.equal(converted.sale.expected_date, '2026-10-25');
  await f.setPreference('suprimentos-estoque', 'estoque.cross_docking_dias', 0);
});

test('Editar número: a number already used gives the next free number', async () => {
  await f.setPreference('vendas-vendas', 'vendas.editar_numero', true);
  const first = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders') })).document;
  const taken = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: { ...f.data('sales_orders'), number: first.number } })).document;
  assert.notEqual(taken.number, first.number);
  assert.ok(Number(taken.number) > Number(first.number));
  // Editing keeps the current number when the typed one is taken.
  const edited = (await ok(`/v1/documentos/sales_orders/${taken.id}`, 'PATCH', { command_id: randomUUID(), expected_version: taken.version, data: { ...f.data('sales_orders'), number: first.number } })).document;
  assert.equal(edited.number, taken.number);
  await f.setPreference('vendas-vendas', 'vendas.editar_numero', false);
});

test('Cadastrar automaticamente produtos: free items become products for profiles that register products', async () => {
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_vendas', true);
  const doc = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { items: [f.line({ code: 'AUTO-C1', description: 'Peça automática', unit_price: '12.5' })] }) })).document;
  const product = doc.items[0].product_id;
  assert.ok(product);
  assert.deepEqual(await f.scalar("select jsonb_build_object('name',r.name,'code',r.code,'price',p.price::text) v from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=$1", [product]), { name: 'Peça automática', code: 'AUTO-C1', price: '12.5000' });
  const again = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { items: [f.line({ code: 'auto-c1', description: 'Outra descrição' })] }) })).document;
  assert.equal(again.items[0].product_id, product, 'the same code links to the product');
  const free = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { items: [f.line({ code: 'AUTO-C2' })] }) }, f.users.vendas)).document;
  assert.equal(free.items[0].product_id, null, 'vendas does not register products');
  assert.equal((await ok('/v1/documentos')).settings.auto_products.sales, true);
  await f.setPreference('cadastros-produtos', 'produtos.cadastro_auto_vendas', false);
});

test('clone of a pedido de compra keeps the data prevista with "Data do pedido clonado"; pendências of IE and transportador', async () => {
  const purchase = (await ok('/v1/documentos/purchase_orders', 'POST', { command_id: randomUUID(), data: f.data('purchase_orders', { date: '2026-10-01', expected_date: '2026-10-15' }) })).document;
  await f.setPreference('suprimentos-compras', 'compras.clonagem_data', 'data_original');
  const preview = await ok(`/v1/duplicacao-documentos/purchase_orders/${purchase.id}/preview`);
  assert.deepEqual([preview.data.date, preview.data.expected_date, preview.reset_fields.includes('expected_date')], ['2026-10-01', '2026-10-15', false]);
  await f.setPreference('suprimentos-compras', 'compras.clonagem_data', 'data_atual');
  const taxpayer = await f.catalog('contacts', { name: 'Contribuinte sem IE', person_type: 'J', document: '11222333000181', street: 'Rua A', number: '1', district: 'Centro', city: 'Piracicaba', state: 'SP', postal_code: '13400000' });
  await f.db.query("insert into erp_catalog.contact_profile(record_id,taxpayer) values($1,'1')", [taxpayer.id]);
  const order = (await ok('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: f.data('sales_orders', { contact_id: taxpayer.id, commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
    transport: { freight_mode: '1', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } } }) })).document;
  const listed = (await ok(`/v1/documentos/sales_orders/${order.id}/pendencias`)).pendencies.map(p => `${p.section} • ${p.message}`);
  assert.ok(listed.includes('Cliente • O campo Inscrição Estadual é obrigatório para contribuinte do ICMS'));
  assert.ok(listed.includes('Transportador • O campo Transportador é obrigatório para o frete por conta do destinatário ou de terceiros'));
});

test('erp_document_access reports the settings applied by the screens', async () => {
  const access = await ok('/v1/documentos');
  assert.deepEqual(Object.keys(access.settings).sort(), ['auto_products', 'cross_docking_days', 'default_warehouse', 'occurrence_date_editable', 'price_decimals_in', 'price_decimals_out', 'stock_launch_date']);
  assert.equal(access.seller, null);
});
