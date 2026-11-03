// Synthetic data only. 202610200271: the Relatório de Vendas with the Origin parameters (Vendedor, Fornecedor, Tags, Categorias, Tipo de
// contato, Data do faturamento, Exibir lucro), its options and the Relatório de Romaneio. PGlite with every migration, the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f, s;
before(async () => {
  f = await documentsEFixture();
  const seller = await f.seller(f.users.vendas, { allow: true, name: 'Vendedora Sintética F' });
  const typed = await f.catalog('contacts', { name: 'Cliente F Atacado', city: 'Campinas', state: 'SP', street: 'Rua do Cliente', number: '10', district: 'Centro' });
  const untyped = await f.catalog('contacts', { name: 'Cliente F Sem Tipo', city: 'Campinas', state: 'SP' });
  const supplier = await f.catalog('contacts', { name: 'Fornecedor F' }), carrier = await f.catalog('contacts', { name: 'Transportadora F' });
  const type = await f.scalar("insert into erp_catalog.contact_type(slug,label,system,deletable,role_backed,position) values('atacado_f','Atacado F',false,true,false,90) returning id::text v");
  await f.db.query('delete from erp_catalog.contact_type_link where contact_id=any($1::uuid[])', [[typed.id, untyped.id]]);
  await f.db.query('insert into erp_catalog.contact_type_link(contact_id,type_id) values($1,$2)', [typed.id, type]);
  const tagged = await f.catalog('products', { name: 'Produto F Custo', code: 'PF-C', unit: 'UN', kind: 'P', format: 'S', price: '10' });
  const plain = await f.catalog('products', { name: 'Produto F Compra', code: 'PF-P', unit: 'CX', kind: 'P', format: 'S', price: '10' });
  await f.db.query('insert into erp_catalog.product_supplier(record_id,position,supplier_id,cost_price,purchase_price,is_default) values($1,1,$2,4,5,true)', [tagged.id, supplier.id]);
  const group = await f.scalar("insert into erp_catalog.taxonomy(kind,name,tag_type) values('tag_groups','Grupo F','products') returning id::text v");
  const tag = await f.scalar("insert into erp_catalog.taxonomy(kind,parent_id,name,tag_type) values('tags',$1,'Linha F','products') returning id::text v", [group]);
  await f.db.query("insert into erp_catalog.product_tag(record_id,tag_id) values($1,$2)", [tagged.id, tag]);
  const parent = randomUUID(), child = randomUUID();
  await f.db.query("insert into erp_finance.category(id,name,kind,active) values($1,'Vendas F','receivable',true)", [parent]);
  await f.db.query("insert into erp_finance.category(id,name,kind,active,parent_id) values($1,'Vendas F balcão','receivable',true,$2)", [child, parent]);
  // Preço da última compra of the plain product: a lançamento of entrada today (always after the September pedidos).
  const warehouse = await f.catalog('warehouses', { name: 'Depósito F' });
  await f.rpc('erp_stock_launch', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_product_id: plain.id, p_warehouse_id: warehouse.id, p_quantity: '10',
    p_expected_version: 0, p_unit_price: '6', p_unit_cost: '6', p_note: 'Entrada sintética F', p_destination_id: null, p_destination_version: null });
  const transport = (extra = {}) => ({ introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
    transport: { freight_mode: '0', volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null, ...extra } });
  const o1 = await f.create('sales_orders', { date: '2026-09-10', contact_id: typed.id, seller_id: seller, category_id: child,
    items: [f.line({ product_id: tagged.id, description: 'Produto F Custo', code: 'PF-C', quantity: '2', unit_price: '10' }), f.line({ product_id: plain.id, description: 'Produto F Compra', code: 'PF-P', unit: 'CX', quantity: '1', unit_price: '10' })] });
  const o2 = await f.create('sales_orders', { date: '2026-09-12', contact_id: untyped.id, ship_date: '2026-09-25', carrier_id: carrier.id, commercial: transport({ volume_count: '2', gross_weight: '12.5' }),
    delivery_address: { name: 'Depósito do cliente', postal_code: '13000-000', state: 'SP', city: 'Campinas', district: 'Vila F', street: 'Rua da Entrega', number: '200', complement: null, country: null },
    items: [f.line({ product_id: plain.id, description: 'Produto F Compra', code: 'PF-P', unit: 'CX', quantity: '3', unit_price: '5' })] });
  const cancelled = await f.create('sales_orders', { date: '2026-09-13', contact_id: untyped.id, items: [f.line({ quantity: '1', unit_price: '1' })] });
  await f.transition(cancelled, 'cancelled');
  s = { seller, typed, untyped, supplier, carrier, type, tagged, plain, tag, parent, child, o1, o2, warehouse };
});
after(async () => f?.close());
const ok = async (path, user) => { const r = await f.call(path, 'GET', undefined, user); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.value)}`); return r.value; };
const status = async (path, user) => (await f.call(path, 'GET', undefined, user)).status;
const sales = (params, user) => ok(`/v1/documentos/sales_orders/relatorio-vendas?${new URLSearchParams({ from: '2026-09-01', to: '2026-09-30', status: 'open', ...params })}`, user);
const rows = report => report.groups.map(g => [g.label, g.sales, g.amount]);

test('privileges: the report RPCs run only for service_role; the internal helpers for nobody', async () => {
  for (const sig of ['erp_document_sales_report(uuid,jsonb)', 'erp_document_sales_report_options(uuid)', 'erp_document_sales_romaneio(uuid,jsonb)']) {
    const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [`public.${sig}`])).rows[0];
    assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']], sig);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, `public.${sig}`]), false, `${role} ${sig}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [`public.${sig}`]), true, sig);
  }
  for (const sig of ['erp_documents.report_uuid_list(jsonb,integer)', 'erp_documents.report_seller_key(jsonb)', 'erp_documents.report_seller_label(jsonb)', 'erp_documents.report_last_purchase_until(uuid,date,boolean)',
    'erp_documents.report_unit_cost(uuid,text,date,boolean)', 'erp_documents.romaneio_address(jsonb,jsonb)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false, `${role} ${sig}`);
});

test('Vendedor, Categorias, Tipo de contato, Fornecedor and Tags filter the Relatório de Vendas', async () => {
  const bySeller = await sales({ group: 'seller' });
  assert.deepEqual(rows(bySeller), [['Sem vendedor', 1, '15.00'], ['Vendedora Sintética F', 1, '30.00']], 'the native vendedor of the pedido names the group');
  assert.deepEqual([bySeller.date_type, bySeller.show_profit, bySeller.profit_base, bySeller.totals.cost, bySeller.totals.items_without_cost], ['date', false, null, null, 0]);
  assert.deepEqual(rows(await sales({ group: 'contact', seller_id: s.seller })), [['Cliente F Atacado', 1, '30.00']]);
  assert.deepEqual(rows(await sales({ group: 'contact', categories: s.parent })), [['Cliente F Atacado', 1, '30.00']], 'the subcategorias of the chosen categoria enter');
  assert.deepEqual(rows(await sales({ group: 'contact', contact_types: s.type })), [['Cliente F Atacado', 1, '30.00']]);
  assert.deepEqual(rows(await sales({ group: 'contact', contact_types: '', contact_untyped: 'true' })), [['Cliente F Sem Tipo', 1, '15.00']], 'Sem vínculo only');
  assert.deepEqual(rows(await sales({ group: 'contact', contact_types: s.type, contact_untyped: 'true' })).map(r => r[0]), ['Cliente F Atacado', 'Cliente F Sem Tipo']);
  assert.deepEqual(rows(await sales({ group: 'product', supplier_id: s.supplier.id })), [['Produto F Custo (PF-C)', 1, '20.00']], 'Fornecedor chooses the items of its products');
  assert.deepEqual(rows(await sales({ group: 'contact', supplier_id: s.supplier.id })), [['Cliente F Atacado', 1, '30.00']], 'grouped by cliente: the pedidos with one of those items');
  assert.deepEqual(rows(await sales({ group: 'product', tags: s.tag })), [['Produto F Custo (PF-C)', 1, '20.00']]);
  assert.deepEqual(rows(await sales({ group: 'product', tags: s.tag, untagged: 'true' })), [['Produto F Compra (PF-P)', 2, '25.00'], ['Produto F Custo (PF-C)', 1, '20.00']], 'Incluir produtos sem classificação');
  assert.deepEqual(rows(await sales({ group: 'product', tags: '', untagged: 'true' })), [['Produto F Compra (PF-P)', 2, '25.00']]);
});

test('Exibir lucro: Preço de custo, Preço da última compra and até a data do pedido, only for the readers of pedidos de compra', async () => {
  const cost = await sales({ group: 'product', show_profit: 'true', profit_base: 'cost' });
  assert.deepEqual(cost.groups.map(g => [g.label, g.amount, g.cost, g.profit]), [['Produto F Compra (PF-P)', '25.00', '0.00', '25.00'], ['Produto F Custo (PF-C)', '20.00', '8.00', '12.00']]);
  assert.deepEqual([cost.show_profit, cost.profit_base, cost.totals.cost, cost.totals.profit, cost.totals.items_without_cost], [true, 'cost', '8.00', '37.00', 2], 'the items without preço base are counted');
  const last = await sales({ group: 'contact', subgroup: 'product', show_profit: 'true', profit_base: 'last_purchase' });
  assert.deepEqual(last.groups.map(g => [g.label, g.amount, g.cost, g.profit, g.subgroups.map(x => [x.label, x.cost])]),
    [['Cliente F Atacado', '30.00', '6.00', '24.00', [['Produto F Compra (PF-P)', '6.00'], ['Produto F Custo (PF-C)', '0.00']]], ['Cliente F Sem Tipo', '15.00', '18.00', '-3.00', [['Produto F Compra (PF-P)', '18.00']]]]);
  const until = await sales({ group: 'contact', show_profit: 'true', profit_base: 'last_purchase_until' });
  assert.deepEqual([until.totals.cost, until.totals.items_without_cost], ['0.00', 3], 'the only compra is after the September pedidos');
  // The same compra counts for a pedido dated after it.
  await f.create('sales_orders', { date: '2099-01-15', contact_id: s.untyped.id, items: [f.line({ product_id: s.plain.id, description: 'Produto F Compra', quantity: '2', unit_price: '10' })] });
  const later = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${new URLSearchParams({ from: '2099-01-01', to: '2099-01-31', group: 'contact', show_profit: 'true', profit_base: 'last_purchase_until' })}`);
  assert.deepEqual([later.totals.amount, later.totals.cost, later.totals.profit], ['20.00', '12.00', '8.00']);
  const grouped = await sales({ group: 'contact', show_profit: 'true' });
  assert.deepEqual([grouped.profit_base, grouped.totals.cost], ['cost', '8.00'], 'Preço de custo is the default base');
  for (const user of [f.users.estoque, f.users.fiscal, f.users.financeiro, f.users.consulta]) assert.equal(await status(`/v1/documentos/sales_orders/relatorio-vendas?from=2026-09-01&to=2026-09-30&show_profit=true`, user), 200);
  assert.equal(await status('/v1/documentos/sales_orders/relatorio-vendas?from=2026-09-01&to=2026-09-30&show_profit=true', f.users.vendas), 403, 'vendas does not read purchase prices');
  assert.equal(await status('/v1/documentos/sales_orders/relatorio-vendas?from=2026-09-01&to=2026-09-30&show_profit=false', f.users.vendas), 200);
});

test('Data do faturamento: the first nota of the Brufap linked to the pedido, for admin and fiscal', async () => {
  const insert = async (id, statusCode, day, documentId) => {
    await f.db.query(`insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
      values($1,'55','1','N','2',$2,1,$3,'Venda sintética',$4,'1','1','1',false,'{}','[]','{}','{}','[]','{}',false,0,0,0,0,'{}',$5,$5)`, [id, statusCode, Math.floor(Math.random() * 900000) + 1000, day, f.users.admin]);
    await f.db.query('insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)', [id, documentId]);
  };
  await insert(randomUUID(), 1, '2026-09-20', s.o2.id);
  await insert(randomUUID(), 3, '2026-09-21', s.o1.id); // cancelled: does not count
  const invoiced = await sales({ group: 'contact', date_type: 'invoice', from: '2026-09-15' });
  assert.deepEqual([invoiced.date_type, rows(invoiced)], ['invoice', [['Cliente F Sem Tipo', 1, '15.00']]]);
  assert.equal((await sales({ group: 'contact', date_type: 'invoice', from: '2026-09-15' }, f.users.fiscal)).totals.sales, 1);
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, f.users.consulta])
    assert.equal(await status('/v1/documentos/sales_orders/relatorio-vendas?from=2026-09-01&to=2026-09-30&date_type=invoice', user), 403);
  assert.equal((await sales({ group: 'contact', without_invoice: 'true' })).totals.sales, 0, 'Não considerar pedidos com nota fiscal gerada (130) keeps counting a cancelled nota as gerada');
});

test('the new parameters are checked by the Worker and the database', async () => {
  const base = 'from=2026-09-01&to=2026-09-30';
  const many = Array.from({ length: 101 }, () => randomUUID()).join(',');
  for (const bad of ['categories=', `categories=${s.parent},${s.parent}`, 'contact_untyped=true', 'untagged=true', 'profit_base=cost', 'show_profit=true&profit_base=custo_atual', `tags=${many}`,
    'seller_id=x', 'date_type=ship_date', 'show_profit=1', `contact_types=${s.type},x`])
    assert.equal(await status(`/v1/documentos/sales_orders/relatorio-vendas?${base}&${bad}`), 400, bad);
  for (const filters of [{ from: '2026-09-01', to: '2026-09-30', untagged: true }, { from: '2026-09-01', to: '2026-09-30', profit_base: 'cost' }, { from: '2026-09-01', to: '2026-09-30', show_profit: true, profit_base: 'custo_atual' },
    { from: '2026-09-01', to: '2026-09-30', tag_ids: [s.tag, s.tag] }, { from: '2026-09-01', to: '2026-09-30', category_ids: 'x' }])
    await assert.rejects(() => f.rpc('erp_document_sales_report', { p_user_id: f.users.admin, p_filters: filters }), /erp_document_report_invalid/, JSON.stringify(filters));
});

test('options: Tipo de contato, Tags, Vendedor and what the profile may use; a seller-scoped user sees the own vendedor', async () => {
  const all = await ok('/v1/documentos/sales_orders/relatorio-vendas/opcoes');
  assert.ok(all.contact_types.some(t => t.id === s.type && t.label === 'Atacado F'));
  assert.ok(all.tags.some(t => t.id === s.tag && t.name === 'Grupo F › Linha F'));
  assert.ok(all.sellers.some(t => t.id === s.seller && t.name === 'Vendedora Sintética F'));
  assert.deepEqual([all.profit_visible, all.invoice_visible], [true, true]);
  const seller = await ok('/v1/documentos/sales_orders/relatorio-vendas/opcoes', f.users.vendas);
  assert.deepEqual([seller.profit_visible, seller.invoice_visible], [false, false]);
  assert.deepEqual((await ok('/v1/documentos/sales_orders/relatorio-vendas/opcoes', f.users.fiscal)).invoice_visible, true);
  await f.seller(f.users.vendas2, { name: 'Outro Vendedor F' });
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try {
    assert.deepEqual((await ok('/v1/documentos/sales_orders/relatorio-vendas/opcoes', f.users.vendas)).sellers.map(x => x.name), ['Vendedora Sintética F']);
    assert.deepEqual(rows(await sales({ group: 'contact' }, f.users.vendas)), [], 'no contact of the September pedidos belongs to the seller');
    await f.assign(s.typed.id, s.seller);
    assert.deepEqual(rows(await sales({ group: 'contact' }, f.users.vendas)), [['Cliente F Atacado', 1, '30.00']]);
    assert.ok((await ok('/v1/documentos/sales_orders/relatorio-vendas/opcoes')).sellers.length >= 2, 'the administrator sees every vendedor');
  } finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); }
  assert.equal(await status('/v1/documentos/sales_orders/relatorio-vendas/opcoes?x=1'), 400);
  assert.equal(await status('/v1/documentos/service_orders/relatorio-vendas/opcoes'), 404);
  assert.equal((await f.call('/v1/documentos/sales_orders/relatorio-vendas/opcoes', 'POST', {})).status, 405);
});

test('Relatório de Romaneio: address, transportador, volumes, peso bruto and items of the pedidos to deliver', async () => {
  const romaneio = await ok('/v1/documentos/sales_orders/romaneio?from=2026-09-01&to=2026-09-30');
  assert.deepEqual(romaneio.rows.map(r => r.contact_name), ['Cliente F Atacado', 'Cliente F Sem Tipo'], 'the cancelled pedido stays out');
  const [first, second] = romaneio.rows;
  assert.deepEqual(first.address, { source: 'contact', name: null, street: 'Rua do Cliente', number: '10', complement: null, district: 'Centro', city: 'Campinas', state: 'SP', postal_code: null });
  assert.deepEqual(first.items.map(i => [i.code, i.description, i.unit, i.quantity]), [['PF-C', 'Produto F Custo', 'UN', '2.000000'], ['PF-P', 'Produto F Compra', 'CX', '1.000000']]);
  assert.deepEqual([second.address.source, second.address.street, second.address.name, second.carrier, second.freight_mode, second.volumes, second.gross_weight, second.ship_date],
    ['delivery', 'Rua da Entrega', 'Depósito do cliente', 'Transportadora F', '0', '2.000000', '12.500000', '2026-09-25']);
  assert.deepEqual([romaneio.row_count, romaneio.truncated, romaneio.totals], [2, false, { orders: 2, volumes: '2.000000', gross_weight: '12.500000' }]);
  assert.deepEqual((await ok(`/v1/documentos/sales_orders/romaneio?from=2026-09-01&to=2026-09-30&carrier_id=${s.carrier.id}`)).rows.map(r => r.id), [s.o2.id]);
  assert.deepEqual((await ok('/v1/documentos/sales_orders/romaneio?from=2026-09-20&to=2026-09-30&date_type=ship_date')).rows.map(r => r.id), [s.o2.id]);
  assert.deepEqual((await ok(`/v1/documentos/sales_orders/romaneio?from=2026-09-01&to=2026-09-30&contact_id=${s.typed.id}`)).rows.map(r => r.id), [s.o1.id]);
  assert.equal((await ok('/v1/documentos/sales_orders/romaneio?from=2026-09-01&to=2026-09-30&status=cancelled')).row_count, 1, 'a chosen situação is honored');
  for (const user of [f.users.vendas, f.users.estoque, f.users.fiscal, f.users.consulta, f.users.financeiro]) assert.equal(await status('/v1/documentos/sales_orders/romaneio?from=2026-09-01&to=2026-09-30', user), 200);
  for (const bad of ['from=2026-01-01&to=2027-02-01', 'from=2026-09-01&to=2026-09-30&date_type=invoice', 'from=2026-09-01&to=2026-09-30&carrier_id=x', 'from=2026-09-01&to=2026-09-30&status=open,open', 'from=2026-09-01'])
    assert.equal(await status(`/v1/documentos/sales_orders/romaneio?${bad}`), 400, bad);
  assert.equal(await status('/v1/documentos/service_orders/romaneio?from=2026-09-01&to=2026-09-30'), 404);
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try { assert.deepEqual((await ok('/v1/documentos/sales_orders/romaneio?from=2026-09-01&to=2026-09-30', f.users.vendas)).rows.map(r => r.contact_name), ['Cliente F Atacado']); }
  finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); }
});
