import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { preferencesFixture } from './helpers/preferences-fixture.mjs';
import { laneUpTo } from './helpers/fiscal-lane.mjs';
import { invoiceRecord } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { orderSourceRecord, estimateTaxes, estimateRequest, estimateResult } from '../../../packages/erp-domain/src/fiscal-invoice-order.mjs';

// 176 on PGlite (published chain + this lane + the contact profile of 124), synthetic data only: "Gerar nota fiscal" from a
// pedido, the parcels rule of "Campos com validação opcional" and the IPI / ICMS ST estimate context. Nothing posts effects.
const LANE = [...laneUpTo('202610200143'), '202610200116_list_preferences.sql', '202610200117_access_users.sql', '202610200118_activity_files.sql',
  '202610200124_contact_profile.sql', '202610200176_fiscal_invoice_order_generation.sql'];
const code = expected => error => error.code === expected;
const message = (expected, errcode = '22023') => error => error.code === errcode && error.message === expected;
let f, product, service, warehouse, contact, foreign, saleNature, buyNature, ipiNature;
const catalog = async (entity, data) => (await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;
const order = async (kind, body = {}, statuses = []) => {
  let d = (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-20', contact_id: contact.id, warehouse_id: warehouse.id,
    items: [{ product_id: product.id, description: 'Peça sintética 176', unit: 'UN', quantity: '2', unit_price: '10' }], ...body } })).document;
  for (const s of statuses) d = (await f.rpc('erp_document_transition', { p_user_id: f.users.admin, p_kind: kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: s, p_reason: 'Transição sintética' })).document;
  return d;
};
const source = (id, model = '55', user = f.users.fiscal) => f.rpc('erp_fiscal_invoice_order_source', { p_user_id: user, p_document_id: id, p_model: model });
const savePrefs = async (page, changes) => {
  const current = await f.rpc('erp_preferences_page', { p_user_id: f.users.admin, p_page: page });
  return f.rpc('erp_preferences_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_page: page, p_changes: Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(i => i.key === key).version, value })) });
};
const invoice = (over = {}) => ({ model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: saleNature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
  recipient: { name: 'Contato sintético', person_type: 'J', document: '12345678000190', state: 'SP' }, items: [{ product_id: product.id, description: 'Peça sintética 176', quantity: '2', unit_price: '10' }],
  payment: { installments: [{ date: '2026-11-20', amount: '20.00' }] }, ...over });
const execute = (action, data, user = f.users.fiscal, command = randomUUID()) => f.rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });

before(async () => {
  const base = await preferencesFixture({ lane: LANE });
  f = { ...base, scalar: async (text, args = []) => (await base.db.query(text, args)).rows[0]?.value };
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: 'SP', cnpj: '11.222.333/0001-81' }), f.users.admin]);
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [f.users.admin]);
  product = await catalog('products', { name: 'Peça sintética 176', code: 'P-176', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '84714900' });
  service = await catalog('products', { name: 'Serviço sintético 176', code: 'S-176', unit: 'UN', kind: 'S', format: 'S', price: '5' });
  await f.db.query("update erp_catalog.product set cest='0100100',origin='0',gross_weight=1.5,net_weight=1.25,volumes=1 where record_id=$1", [product.id]);
  contact = await catalog('contacts', { name: 'Cliente sintético 176', person_type: 'J', document: '12345678000190', ie: '123456789', state: 'MG', city: 'Belo Horizonte', postal_code: '30110000', street: 'Rua Sintética', number: '10' });
  foreign = await catalog('contacts', { name: 'Cliente estrangeiro 176', person_type: 'E', state: 'EX' });
  warehouse = await catalog('warehouses', { name: 'Depósito 176' });
  await f.rpc('erp_stock_post', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_occurred_on: '2026-10-15', p_reason: 'Entrada sintética 176', p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: '3', expected_version: 0 }] });
  const nature = async data => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  saleNature = await nature({ description: 'Venda 176', direction: '1', crt: '1' }); buyNature = await nature({ description: 'Compra 176', direction: '0', crt: '1', presence: '9' });
  ipiNature = await nature({ description: 'Venda com IPI 176', direction: '1', crt: '1', rules: [{ tax: 'ipi', destinations: [], product_scope: 'any', ncms: [], product_ids: [], data: { situation: '50', rate: '10' } }] });
  await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'set_default', p_data: { id: saleNature.id, expected_version: 1, code: 'S' } });
});
after(() => f?.close());

test('176 entry points are SECURITY DEFINER for service_role only, helpers stay private and the order link is indexed', async () => {
  for (const signature of ['public.erp_fiscal_invoice_order_source(uuid,uuid,text)', 'public.erp_fiscal_tax_estimate_context(uuid,text,uuid,jsonb)', 'public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb)', 'public.erp_fiscal_invoice_link(uuid,uuid,jsonb)', 'public.erp_fiscal_invoice_order_link_states(uuid,jsonb)', 'public.erp_fiscal_invoice_context(uuid,text)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false, `${role} ${signature}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
    assert.equal(await f.scalar("select proconfig::text value from pg_proc where oid=$1::regprocedure", [signature]), '{search_path=pg_catalog}');
  }
  for (const helper of ['erp_fiscal_invoices.order_source(uuid,text)', 'erp_fiscal_invoices.orders_finance_locked(jsonb)', 'erp_fiscal_invoices.store_orders(uuid,text,jsonb)', 'erp_fiscal_invoices.require_orders_readable(text,uuid,jsonb)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
  assert.equal(await f.scalar("select indexdef value from pg_indexes where indexname='erp_fiscal_invoice_order_document'"), 'CREATE INDEX erp_fiscal_invoice_order_document ON erp_fiscal_invoices.invoice_order USING btree (document_id)');
});

test('176 order source: the pedido with the current cadastro, Data saída, Pedido de compra, entrega, transport and parcels, only for admin and fiscal', async () => {
  const sale = await order('sales_orders', { ship_date: '2026-10-22', customer_po_number: 'PC-7788', notes: 'Entregar pela manhã', freight: '5', discount_mode: 'amount', discount_value: '2',
    items: [{ product_id: product.id, description: 'Peça sintética 176', unit: 'UN', quantity: '2', unit_price: '10', discount_percent: '10' }, { product_id: service.id, description: 'Serviço sintético 176', unit: 'UN', quantity: '1', unit_price: '5' }],
    installments: [{ due_date: '2026-11-19', amount: '13.00', method: 'Boleto' }, { due_date: '2026-12-19', amount: '13.00', method: null }],
    delivery_address: { name: 'Filial sintética', postal_code: '30110-001', state: 'MG', city: 'Contagem', district: 'Centro', street: 'Av. Sintética', number: '200', complement: null, country: 'Brasil' },
    commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
      transport: { freight_mode: '0', volume_count: '2', gross_weight: '3.5', delivery_days: null, carrier_reference: { system: 'origin', source_id: '77', label: 'Transportadora sintética' }, service_reference: null, tracking_code: 'BR123' } } });
  for (const user of [f.users.consulta, f.users.vendas, f.users.estoque]) await assert.rejects(() => source(sale.id, '55', user), code('42501'));
  await assert.rejects(() => source(randomUUID()), code('P0002'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_order_source', { p_user_id: f.users.fiscal, p_document_id: sale.id, p_model: '57' }), code('22023'));
  const raw = await source(sale.id), s = orderSourceRecord(raw);
  assert.equal(s.eligible, true); assert.deepEqual(s.reasons, []); assert.equal(s.direction, '1'); assert.equal(s.model, '55');
  assert.deepEqual({ ...s.document, id: undefined, version: undefined }, { id: undefined, version: undefined, kind: 'sales_orders', number: sale.number, status: sale.status, date: '2026-10-20', ship_date: '2026-10-22',
    customer_po_number: 'PC-7788', notes: 'Entregar pela manhã', warehouse_id: warehouse.id, stock_active: false, finance_active: false });
  assert.equal(s.contact.contact_id, contact.id); assert.equal(s.contact.document, '12345678000190'); assert.equal(s.contact.state, 'MG');
  assert.deepEqual(s.items.map(i => [i.position, i.product_id, i.quantity, i.gross, i.discount, i.total]), [[1, product.id, '2.000000', '20.00', '2.00', '18.00'], [2, service.id, '1.000000', '5.00', '0.00', '5.00']]);
  assert.deepEqual(s.items[0].product, { kind: 'P', ncm: '84714900', gtin: null, gtin_tax: null, cest: '0100100', origin: '0', gross_weight: '1.500000', net_weight: '1.250000', volumes: '1' });
  assert.deepEqual(s.totals, { gross: '25.00', line_discount: '2.00', discount: '2.00', freight: '5.00', other_expenses: '0.00', total: '26.00' });
  assert.deepEqual(s.installments.map(i => [i.position, i.due_date, i.amount, i.method]), [[1, '2026-11-19', '13.00', 'Boleto'], [2, '2026-12-19', '13.00', null]]);
  assert.equal(s.delivery.city, 'Contagem'); assert.equal(s.delivery.postal_code, '30110001');
  assert.deepEqual(s.transport, { freight_mode: '0', volume_count: '2.000000', gross_weight: '3.500000', tracking_code: 'BR123', carrier_label: 'Transportadora sintética' });
  assert.equal(s.existing_invoice, null); assert.equal(s.nature, null);
  // Purchase orders feed entry notes; NFC-e exists only for sales.
  const purchase = await order('purchase_orders');
  assert.equal(orderSourceRecord(await source(purchase.id)).direction, '0');
  await assert.rejects(() => source(purchase.id, '65'), code('22023'));
});

test('176 order source: Origin reasons for "Erro ao gerar a Nota fiscal" (cancelled, has invoice, quantity, foreign contact, negative stock)', async () => {
  const cancelled = await order('sales_orders', {}, ['cancelled']);
  assert.deepEqual(orderSourceRecord(await source(cancelled.id)).reasons, [{ code: 'cancelled', items: [] }]);
  const fraction = await order('sales_orders', { items: [{ product_id: product.id, description: 'Peça sintética 176', unit: 'UN', quantity: '1.123456', unit_price: '10' }] });
  assert.deepEqual(orderSourceRecord(await source(fraction.id)).reasons, [{ code: 'quantity_precision', items: [1] }]);
  // Three in stock: four leave it negative while "Permite geração de NF … com estoque negativo" is off; services never count.
  const big = await order('sales_orders', { items: [{ product_id: product.id, description: 'Peça', unit: 'UN', quantity: '2', unit_price: '10' }, { product_id: service.id, description: 'Serviço', unit: 'UN', quantity: '9', unit_price: '1' },
    { product_id: product.id, description: 'Peça de novo', unit: 'UN', quantity: '2', unit_price: '10' }] });
  assert.deepEqual(orderSourceRecord(await source(big.id)).reasons, [{ code: 'stock_negative', items: [1, 3] }]);
  await savePrefs('suprimentos-estoque', { 'estoque.nf_estoque_negativo': true });
  assert.equal(orderSourceRecord(await source(big.id)).eligible, true);
  await savePrefs('suprimentos-estoque', { 'estoque.nf_estoque_negativo': false });
  const abroad = (await f.rpc('erp_document_save', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: '2026-10-20', contact_id: foreign.id,
    items: [{ product_id: product.id, description: 'Peça', unit: 'UN', quantity: '1', unit_price: '10' }] } })).document;
  assert.deepEqual(orderSourceRecord(await source(abroad.id)).reasons, [{ code: 'international', items: [] }]);
  const sale = await order('sales_orders');
  const note = invoiceRecord((await execute('create', { invoice: invoice(), orders: [sale.id] })).invoice);
  const s = orderSourceRecord(await source(sale.id));
  assert.deepEqual(s.reasons, [{ code: 'has_invoice', items: [] }]); assert.deepEqual(s.existing_invoice, { id: note.id, model: '55', number: null, status: 1 });
  await execute('delete', { id: note.id, expected_version: 1, reason: 'Teste sintético' });
  assert.equal(orderSourceRecord(await source(sale.id)).eligible, true, 'a deleted note frees the pedido');
});

test('176 order source: the contact natureza and Contribuinte come from the contact profile', async () => {
  await f.db.query('insert into erp_catalog.contact_profile(record_id,taxpayer,operation_nature_id,country) values($1,$2,$3,$4)', [contact.id, '1', ipiNature.id, 'Brasil']);
  const s = orderSourceRecord(await source((await order('sales_orders')).id));
  assert.deepEqual(s.nature, { id: ipiNature.id, description: 'Venda com IPI 176', crt: '1' }); assert.equal(s.contact.taxpayer, '1'); assert.equal(s.contact.country, 'Brasil');
  const entry = orderSourceRecord(await source((await order('purchase_orders')).id));
  assert.equal(entry.nature, null, 'a sale nature never feeds an entry note');
  await f.db.query('delete from erp_catalog.contact_profile where record_id=$1', [contact.id]);
});

test('176 "Campos com validação opcional: Parcelas": the database refuses parcels that do not add up to the total, unless the preference or a finance lock says so', async () => {
  const mismatch = invoice({ payment: { installments: [{ date: '2026-11-20', amount: '15.00' }] } });
  await assert.rejects(() => execute('create', { invoice: mismatch }), message('erp_fiscal_invoice_installments_mismatch'));
  assert.equal((await execute('create', { invoice: invoice({ payment: { installments: [] } }) })).invoice.version, 1, 'no parcels, nothing to add up');
  const ok = invoiceRecord((await execute('create', { invoice: invoice() })).invoice);
  await assert.rejects(() => execute('update', { id: ok.id, expected_version: 1, invoice: mismatch }), message('erp_fiscal_invoice_installments_mismatch'));
  await savePrefs('notas-nfe', { 'nfe.validacao_opcional': ['parcelas'] });
  assert.equal((await execute('update', { id: ok.id, expected_version: 1, invoice: mismatch })).invoice.version, 2, 'optional with Parcelas marked');
  await savePrefs('notas-nfe', { 'nfe.validacao_opcional': [] });
  // A note whose parcels follow contas already posted by the pedido stays savable when its total moves.
  const sale = await order('sales_orders');
  await f.db.query("insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id) values($1,$2,$3,'{}'::jsonb,$4,$5,$6)",
    [sale.id, sale.version, randomUUID(), 'a'.repeat(64), f.users.admin, randomUUID()]);
  await assert.rejects(() => execute('create', { invoice: mismatch, orders: [sale.id] }), message('erp_fiscal_invoice_installments_mismatch'), 'preference off: no lock');
  await savePrefs('notas-nfe', { 'nfe.bloquear_edicao_contas': true });
  const locked = invoiceRecord((await execute('create', { invoice: mismatch, orders: [sale.id] })).invoice);
  assert.deepEqual((await f.rpc('erp_fiscal_invoice_get', { p_user_id: f.users.fiscal, p_id: locked.id })).locks, { items: false, installments: true });
  const pricier = invoice({ payment: { installments: [{ date: '2026-11-20', amount: '15.00' }] }, items: [{ product_id: product.id, description: 'Peça sintética 176', quantity: '2', unit_price: '12' }] });
  assert.equal((await execute('update', { id: locked.id, expected_version: 1, invoice: pricier, orders: [sale.id] })).invoice.version, 2, 'finance lock only: items change, parcels stay');
  await savePrefs('notas-nfe', { 'nfe.bloquear_edicao_contas': false });
  await assert.rejects(() => execute('update', { id: locked.id, expected_version: 2, invoice: pricier, orders: [sale.id] }), message('erp_fiscal_invoice_installments_mismatch'), 'unlocked, the rule is back');
});

test('176 estimate context: document readers get the natureza rules for the Worker; the engine estimates IPI and ICMS ST', async () => {
  const context = (user, kind = 'sales_orders', contactId = contact.id, products = [product.id]) => f.rpc('erp_fiscal_tax_estimate_context', { p_user_id: user, p_kind: kind, p_contact_id: contactId, p_product_ids: products });
  await assert.rejects(() => context(f.users.estoque, 'sales_proposals'), code('42501'), 'estoque does not read proposals');
  await assert.rejects(() => context(f.users.inactive), code('42501'));
  await assert.rejects(() => context(f.users.vendas, 'purchase_orders'), code('22023'));
  await assert.rejects(() => context(f.users.vendas, 'sales_orders', randomUUID()), code('22023'));
  const plain = await context(f.users.vendas);
  assert.equal(plain.enabled, false); assert.equal(plain.nature.id, saleNature.id, 'default Padrão venda'); assert.deepEqual(plain.company, { crt: '1', state: 'SP' });
  assert.deepEqual(plain.products, [{ id: product.id, ncm: '84714900', kind: 'P' }]);
  await savePrefs('vendas-propostas', { 'propostas.exibir_ipi_st': true });
  await f.db.query('insert into erp_catalog.contact_profile(record_id,taxpayer,operation_nature_id) values($1,$2,$3)', [contact.id, '1', ipiNature.id]);
  const withIpi = await context(f.users.vendas, 'sales_proposals');
  assert.equal(withIpi.enabled, true); assert.equal(withIpi.nature.id, ipiNature.id); assert.equal(withIpi.recipient.taxpayer, '1');
  const request = estimateRequest({ kind: 'sales_proposals', contact_id: contact.id, items: [{ product_id: product.id, quantity: '2.000000', unit_price: '10' }], discount: '0', freight: '0', other_expenses: '0' });
  const result = estimateResult(estimateTaxes(withIpi, request, '2026-10-20'));
  assert.deepEqual({ available: result.available, totals: result.totals, items: result.items }, { available: true, totals: { ipi: '2.00', st: '0.00', total: '22.00' }, items: [{ product_id: product.id, ipi: '2.00', st: '0.00' }] });
});

test('176 ordens de serviço: the parts feed an exit note linked to the OS (letter O); an OS with services only is refused', async () => {
  const os = await order('service_orders', { items: [{ product_id: product.id, description: 'Peça da OS', unit: 'UN', quantity: '1', unit_price: '10' }, { product_id: service.id, description: 'Mão de obra', unit: 'UN', quantity: '1', unit_price: '50' }] });
  // Ordens de serviço are read by admin, consulta, financeiro and vendas (erp_documents.allowed): the fiscal profile gets neither the OS nor a new link to it.
  await assert.rejects(() => source(os.id), code('42501'), 'fiscal does not read ordens de serviço');
  const s = orderSourceRecord(await source(os.id, '55', f.users.admin));
  assert.equal(s.direction, '1'); assert.equal(s.document.kind, 'service_orders'); assert.equal(s.eligible, true); assert.deepEqual(s.items.map(i => i.product.kind), ['P', 'S']);
  await assert.rejects(() => source(os.id, '65', f.users.admin), code('22023'), 'NFC-e only from pedidos de venda');
  const servicesOnly = await order('service_orders', { items: [{ product_id: service.id, description: 'Mão de obra', unit: 'UN', quantity: '1', unit_price: '50' }] });
  assert.deepEqual(orderSourceRecord(await source(servicesOnly.id, '55', f.users.admin)).reasons, [{ code: 'no_products', items: [] }]);
  // "Permite geração de NF a partir da venda e ordem de serviço com estoque negativo" (off) holds for the parts of an OS too.
  const manyParts = await order('service_orders', { items: [{ product_id: product.id, description: 'Peça da OS', unit: 'UN', quantity: '9', unit_price: '10' }] });
  assert.deepEqual(orderSourceRecord(await source(manyParts.id, '55', f.users.admin)).reasons, [{ code: 'stock_negative', items: [1] }]);
  const partsNote = invoice({ payment: { installments: [] }, items: [{ product_id: product.id, description: 'Peça da OS', quantity: '1', unit_price: '10' }] });
  await assert.rejects(() => execute('create', { invoice: partsNote, orders: [os.id] }), code('42501'), 'fiscal does not link an OS');
  const note = invoiceRecord((await execute('create', { invoice: partsNote, orders: [os.id] }, f.users.admin)).invoice);
  assert.deepEqual(note.orders.map(o => [o.id, o.kind]), [[os.id, 'service_orders']]);
  // A link already on the note stays: the fiscal profile keeps saving the note an administrator generated from the OS.
  assert.equal((await execute('update', { id: note.id, expected_version: 1, invoice: { ...partsNote, additional_info: 'Revisada pelo fiscal' }, orders: [os.id] })).invoice.version, 2);
  const listed = await f.rpc('erp_fiscal_invoice_list', { p_user_id: f.users.admin, p_origin: 'brufap', p_model: '55', p_direction: '1', p_order_number: os.number });
  assert.ok(listed.items.some(r => r.id === note.id && r.orders.some(o => o.kind === 'service_orders')), 'the list carries the OS for the O letter');
  assert.deepEqual(orderSourceRecord(await source(os.id, '55', f.users.admin)).reasons, [{ code: 'has_invoice', items: [] }]);
  const entry = invoiceRecord((await execute('create', { invoice: invoice({ direction: '0', nature_id: buyNature.id, presence: '9', payment: { installments: [] } }) })).invoice);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_link', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_data: { invoice_id: entry.id, expected_version: 1, action: 'link', document_id: os.id } }), code('22023'), 'entry notes link only pedidos de compra');
  const plain = invoiceRecord((await execute('create', { invoice: invoice() })).invoice);
  const link = (user, document_id) => f.rpc('erp_fiscal_invoice_link', { p_user_id: user, p_command_id: randomUUID(), p_data: { invoice_id: plain.id, expected_version: 1, action: 'link', document_id } });
  await assert.rejects(() => link(f.users.fiscal, servicesOnly.id), code('42501'), 'fiscal does not link an OS');
  const linked = await link(f.users.admin, servicesOnly.id);
  assert.deepEqual(invoiceRecord(linked.invoice).orders.map(o => o.kind), ['service_orders']);
});

test('176 "Vinculação" of the pedidos de compra: Não vinculado, Parcial and Vinculado from the linked entry notes, for the readers of pedidos de compra', async () => {
  const states = (ids, user = f.users.consulta) => f.rpc('erp_fiscal_invoice_order_link_states', { p_user_id: user, p_document_ids: ids });
  const purchase = await order('purchase_orders'), untouched = await order('purchase_orders'), sale = await order('sales_orders');
  await assert.rejects(() => states([purchase.id], f.users.vendas), code('42501'), 'vendas does not read pedidos de compra');
  await assert.rejects(() => states(Array.from({ length: 101 }, () => randomUUID())), code('22023'));
  const entry = qty => invoice({ direction: '0', nature_id: buyNature.id, presence: '9', payment: { installments: [] }, items: [{ product_id: product.id, description: 'Peça sintética 176', quantity: qty, unit_price: '10' }] });
  const first = invoiceRecord((await execute('create', { invoice: entry('1'), orders: [purchase.id] })).invoice);
  assert.deepEqual((await states([purchase.id, untouched.id, sale.id])).items.map(i => [i.document_id, i.state]).sort(), [[purchase.id, 'partial'], [untouched.id, 'none']].sort(), 'a sales order is not a pedido de compra');
  await execute('create', { invoice: entry('1'), orders: [purchase.id] });
  assert.deepEqual((await states([purchase.id])).items, [{ document_id: purchase.id, state: 'linked' }]);
  await execute('delete', { id: first.id, expected_version: 1, reason: 'Teste sintético' });
  assert.deepEqual((await states([purchase.id], f.users.estoque)).items, [{ document_id: purchase.id, state: 'partial' }], 'a deleted note no longer counts');
});

test('176 "Informar desconto individualmente nos itens": item discounts are the note discount, exactly like the JavaScript totals', async () => {
  const dto = await import('../../../packages/erp-domain/src/fiscal-invoice-dto.mjs');
  const { invoiceTotals, normalizeInvoiceInput } = await import('../../../packages/erp-domain/src/fiscal-invoice-contract.mjs');
  assert.deepEqual((await f.scalar('select erp_fiscal_invoices.invoice_specs() value')).item, JSON.parse(JSON.stringify(dto.ITEM_SPEC)), 'the item descriptors match the shared ones, discount included');
  const input = invoice({ discount: '1.75', freight: '3', payment: { installments: [] }, items: [{ product_id: product.id, description: 'Peça A', quantity: '2', unit_price: '10', discount: '1.5' },
    { description: 'Peça B', quantity: '1', unit_price: '5', discount: '0.25' }, { description: 'Peça C', quantity: '3', unit_price: '1' }] });
  const saved = invoiceRecord((await execute('create', { invoice: input })).invoice), expected = invoiceTotals(normalizeInvoiceInput(input));
  assert.deepEqual(saved.totals, expected.totals); assert.deepEqual(saved.items.map(i => i.allocated.discount), ['1.50', '0.25', '0.00']);
  assert.deepEqual(expected.allocation.discount, ['1.50', '0.25', '0.00']); assert.equal(saved.totals.total, '29.25', '28.00 - 1.75 + 3.00');
  await assert.rejects(() => execute('create', { invoice: { ...input, discount: '1.00' } }), message('erp_fiscal_invoice_discount_mismatch'));
  assert.throws(() => normalizeInvoiceInput({ ...input, discount: '1.00' }), e => e.code === 'FISCAL_INVOICE_DISCOUNT_MISMATCH');
  await assert.rejects(() => execute('create', { invoice: invoice({ discount: '21', payment: { installments: [] }, items: [{ description: 'Peça', quantity: '2', unit_price: '10', discount: '21' }] }) }), message('erp_fiscal_invoice_discount_exceeds'));
  await assert.rejects(() => execute('create', { invoice: invoice({ discount: '1', payment: { installments: [] }, items: [{ description: 'Peça', quantity: '2', unit_price: '10' }, { description: 'Brinde', quantity: '1', unit_price: '5', invoiced: false, discount: '1' }] }) }),
    message('erp_fiscal_invoice_discount_exceeds'), 'a line outside the total takes no discount');
  const spread = invoiceRecord((await execute('create', { invoice: invoice({ discount: '1', payment: { installments: [] }, items: [{ description: 'A', quantity: '1', unit_price: '10' }, { description: 'B', quantity: '1', unit_price: '20' }] }) })).invoice);
  assert.deepEqual(spread.items.map(i => i.allocated.discount), ['0.33', '0.67'], 'without item discounts the note discount is spread as before');
  assert.equal((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' })).item_discount, true, 'Origin default');
  await savePrefs('notas-nfe', { 'nfe.desconto_itens': false });
  assert.equal((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' })).item_discount, false);
  await savePrefs('notas-nfe', { 'nfe.desconto_itens': true });
});
