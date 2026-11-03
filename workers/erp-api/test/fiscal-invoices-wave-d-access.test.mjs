import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

// HTTP boundary of the wave D note routes (migration 202610200215) with a synthetic upstream: the pedido source v2, the contact
// source, the Vendedor list filter, the seller/destination of the note and the new context flags. No network, no database.
const user = 'a0000000-0000-4000-8000-000000000001', doc = 'd0000000-0000-4000-8000-000000000001', contact = 'e0000000-0000-4000-8000-000000000001';
const product = 'f0000000-0000-4000-8000-000000000001', nature = 'b0000000-0000-4000-8000-000000000001', seller = 'c1000000-0000-4000-8000-000000000001', invoiceId = 'd1000000-0000-4000-8000-000000000001';
const command = 'c0000000-0000-4000-8000-000000000009';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = (path = '', method = 'GET', data) => new Request(`https://api.example.test/v1/notas-fiscais${path}`, { method,
  headers: { Authorization: 'Bearer synthetic-token', Origin: 'https://erp.example.test', ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
const harness = value => { const calls = []; return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/auth/v1/user') ? Response.json({ id: user }) : Response.json(value); } }) }; };
const rpcArgs = h => JSON.parse(h.calls.at(-1).options.body), rpcName = h => h.calls.at(-1).url.split('/').at(-1);
const contactRow = { contact_id: contact, name: 'Cliente sintético', code: 'C-1', active: true, trade_name: null, person_type: 'J', document: '12345678000190', ie: '123456789', email: null, phone: null,
  mobile: null, postal_code: '30110000', street: 'Rua Sintética', number: '10', complement: null, district: null, city: 'Belo Horizonte', state: 'MG', taxpayer: '1', country: null, nfe_email: 'nfe@sintetico.test' };
const carrierRow = { contact_id: product, name: 'Transportadora sintética', active: true, person_type: 'J', document: '22333444000155', ie: '987654321', postal_code: null, street: 'Av. das Cargas', number: '500',
  complement: null, district: 'Centro', city: 'Campinas', state: 'SP' };
const sourceOf = (over = {}) => ({ document: { id: doc, kind: 'sales_orders', number: '42', version: 3, status: 'open', date: '2026-10-10', ship_date: null, customer_po_number: null, notes: null,
  warehouse_id: null, stock_active: false, finance_active: false }, direction: '1', model: '55', eligible: true, reasons: [], contact: contactRow, nature: null,
  items: [{ position: 1, product_id: product, description: 'Peça', code: 'P-1', unit: 'UN', quantity: '2.000000', unit_price: '10.0000000000', gross: '20.00', discount: '0.00', total: '20.00', product: null }],
  totals: { gross: '20.00', line_discount: '0.00', discount: '0.00', freight: '0.00', other_expenses: '0.00', total: '20.00' }, installments: [], delivery: null, transport: null, existing_invoice: null,
  seller: { id: seller, name: 'Vendedora sintética' }, carrier: carrierRow, keep_order_dates: false, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native', ...over });

test('pedido source v2: vendedor, transportador and the parcels rule are checked; a partial or forged v2 answer is a 502', async () => {
  const ok = harness(sourceOf());
  const response = await ok.handler(request(`/pedido/${doc}?model=55`), env);
  assert.equal(response.status, 200); assert.equal(rpcName(ok), 'erp_fiscal_invoice_order_source_v3'); // 202610200254 reads the same v2 answer
  const out = await response.json();
  assert.deepEqual(out.seller, { id: seller, name: 'Vendedora sintética' }); assert.equal(out.carrier.ie, '987654321'); assert.equal(out.keep_order_dates, false);
  const { seller: _s, carrier: _c, keep_order_dates: _k, ...v1 } = sourceOf();
  const old = await (await harness(v1).handler(request(`/pedido/${doc}?model=55`), env)).json();
  assert.equal(old.keep_order_dates, true, 'a database before 215 keeps the pedido due dates'); assert.equal(old.seller, null); assert.equal(old.carrier, null);
  const forged = [sourceOf({ keep_order_dates: 'false' }), sourceOf({ seller: { id: 'x', name: 'A' } }), sourceOf({ seller: { id: seller, name: 'A', secret: 1 } }), sourceOf({ carrier: { ...carrierRow, password: 'x' } }),
    sourceOf({ carrier: { ...carrierRow, contact_id: 'nope' } }), (({ seller: _x, ...rest }) => rest)(sourceOf()), sourceOf({ extra: true })];
  for (const value of forged) assert.equal((await harness(value).handler(request(`/pedido/${doc}?model=55`), env)).status, 502, JSON.stringify(value).slice(-120));
});

test('contact source: strict direction, exact projection of the same contact and 502 for a forged answer', async () => {
  const value = { contact: contactRow, nature: { id: nature, description: 'Venda do contato', crt: '1' }, seller: { id: seller, name: 'Vendedora sintética' }, writable: true, data_mode: 'erp_native' };
  const ok = harness(value);
  const response = await ok.handler(request(`/contato/${contact}?direction=1`), env);
  assert.equal(response.status, 200); assert.equal(rpcName(ok), 'erp_fiscal_invoice_contact_source'); assert.deepEqual(rpcArgs(ok), { p_contact_id: contact, p_direction: '1', p_user_id: user });
  const out = await response.json(); assert.equal(out.contact.taxpayer, '1'); assert.equal(out.nature.id, nature); assert.equal(out.seller.id, seller);
  for (const path of [`/contato/${contact}`, `/contato/${contact}?direction=2`, `/contato/${contact}?direction=1&direction=0`, `/contato/${contact}?direction=1&x=1`]) {
    const h = harness(value); assert.equal((await h.handler(request(path), env)).status, 400, path); assert.equal(h.calls.length, 1, 'never reaches the RPC');
  }
  assert.equal((await harness(value).handler(request(`/contato/${contact}?direction=1`, 'POST', {}), env)).status, 405);
  for (const forged of [{ ...value, contact: { ...contactRow, contact_id: product } }, { ...value, nature: { id: nature, description: 'X', crt: '9' } }, { ...value, secret: true }, { ...value, writable: 'yes' },
    { ...value, contact: { ...contactRow, taxpayer: '3' } }])
    assert.equal((await harness(forged).handler(request(`/contato/${contact}?direction=1`), env)).status, 502);
});

const page = (over = {}) => ({ items: [], origin: 'brufap', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: 0, total_amount: '0.00', amount_unknown: 0, brufap_visible: true,
  show_totals: true, data_mode: 'erp_native_homologation', ...over });
test('list: the Vendedor filter reaches the RPC only when used and must be a UUID', async () => {
  const h = harness(page());
  assert.equal((await h.handler(request(`?model=55&origin=brufap&seller_id=${seller.toUpperCase()}`), env)).status, 200);
  assert.equal(rpcArgs(h).p_seller_id, seller);
  const without = harness(page());
  await without.handler(request('?model=55&origin=brufap'), env);
  assert.equal(Object.hasOwn(rpcArgs(without), 'p_seller_id'), false, 'a database before 215 is called as before');
  for (const query of ['?model=55&seller_id=x', `?model=55&seller_id=${seller}&seller_id=${seller}`]) { const bad = harness(page()); assert.equal((await bad.handler(request(query), env)).status, 400, query); }
});

const record = (over = {}) => ({ id: invoiceId, model: '55', direction: '1', issue_type: 'N', environment: '2', status: 1, version: 1, series: 1, number: null, access_key: null, protocol: null, authorized_at: null,
  nature_id: nature, nature_description: 'Venda sintética', cfop: null, issue_date: '2026-10-20', exit_date: null, exit_time: null, crt: '1', purpose: '1', credit_debit_type: null, presence: '1', final_consumer: false,
  recipient: { name: 'Cliente', person_type: 'F' }, export: null, import_declaration: null, references: [],
  items: [{ description: 'Item', quantity: '1.0000', unit_price: '10.0000000000', position: 1, total: '10.00', allocated: { freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00' } }],
  auto_tax: true, freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00',
  totals: Object.fromEntries(['icms_base', 'icms', 'st_base', 'st', 'fcp', 'fcp_st', 'deson', 'deson_deducted', 'credit', 'difal_dest', 'difal_origin', 'difal_fcp', 'ipi', 'ipi_devol', 'ii', 'pis', 'cofins', 'approx_taxes', 'funrural',
    'ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins', 'ret_base', 'freight', 'insurance', 'other_expenses', 'discount', 'services', 'issqn'].map(k => [k, '0.00']).concat([['products', '10.00'], ['total', '10.00'], ['invoiced', '10.00']])),
  transport: { mode: 'none', freight_by: '9', carrier: {}, vehicle: {}, volumes: {}, delivery: null }, payment: { condition: null, installments: [] }, authorized_xml: [], intermediary: {},
  additional_info: null, nature_additional_info: null, nature_fiscal_info: null, orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null,
  seller_id: seller, seller_name: 'Vendedora sintética', operation_destination: '2', ...over });
const envelope = (over = {}) => ({ invoice: record(), writable: true, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', action: 'create', replayed: false, ...over });
test('note: Vendedor and Destino da Operação go to the database and come back checked; an older record without them still validates', async () => {
  const input = { model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: nature, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', recipient: { name: 'Cliente', person_type: 'F' },
    items: [{ description: 'Item', quantity: '1', unit_price: '10' }], seller_id: seller, operation_destination: '2' };
  const h = harness(envelope());
  const response = await h.handler(request('', 'POST', { command_id: command, invoice: input }), env);
  assert.equal(response.status, 200); const sent = rpcArgs(h).p_data.invoice;
  assert.equal(sent.seller_id, seller); assert.equal(sent.operation_destination, '2');
  const out = await response.json(); assert.equal(out.invoice.seller_name, 'Vendedora sintética');
  assert.equal((await harness(envelope()).handler(request('', 'POST', { command_id: command, invoice: { ...input, operation_destination: '3' } }), env)).status, 400, '3 is only for a foreign recipient');
  assert.equal((await harness(envelope()).handler(request('', 'POST', { command_id: command, invoice: { ...input, seller_id: 'x' } }), env)).status, 400);
  for (const forged of [record({ seller_name: 7 }), record({ seller_id: null, seller_name: 'Fantasma' }), record({ operation_destination: '9' })])
    assert.equal((await harness(envelope({ invoice: forged })).handler(request('', 'POST', { command_id: command, invoice: input }), env)).status, 502);
  const { seller_id: _a, seller_name: _b, operation_destination: _c, ...older } = record();
  const { seller_id: _d, operation_destination: _e, ...olderInput } = input;
  assert.equal((await harness(envelope({ invoice: older })).handler(request('', 'POST', { command_id: command, invoice: olderInput }), env)).status, 200, 'a record before 215 still validates');
});

test('context: Destino da Operação manual and the open contas panels are booleans; a database before 215 leaves them off', async () => {
  const base = { company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [], defaults: {}, preferences: { show_totals: true, sum_weight: false, compute_volume: false,
    ipi_first_installment: false, st_first_installment: false, tracking_in_info: false, purchase_order_in_info: false, simples_credit_message: false, optional_installments: false, fuel_group: false, weapon_group: false,
    vehicle_group: false, retention_group: false, autxml_carrier: false, block_edit_stock: false, block_edit_finance: false, freight_by: '9', species: 'volumes', volume_quantity: 0, markup: '0', autxml_people: [] },
    item_discount: true, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
  const now = await (await harness({ ...base, operation_destination_manual: true, open_titles: { receivable: true, payable: false } }).handler(request('/contexto?model=55'), env)).json();
  assert.equal(now.operation_destination_manual, true); assert.deepEqual(now.open_titles, { receivable: true, payable: false });
  const before = await (await harness(base).handler(request('/contexto?model=55'), env)).json();
  assert.equal(before.operation_destination_manual, false); assert.deepEqual(before.open_titles, { receivable: false, payable: false });
  for (const forged of [{ ...base, operation_destination_manual: 'sim' }, { ...base, open_titles: { receivable: true } }, { ...base, open_titles: { receivable: true, payable: false, all: true } }])
    assert.equal((await harness(forged).handler(request('/contexto?model=55'), env)).status, 502);
});

test('product groups: strict ids, at most 100, only the asked products and 502 for anything else', async () => {
  const group = 'c2000000-0000-4000-8000-000000000001';
  const ok = harness({ items: [{ id: product, group_id: group }, { id: contact, group_id: null }], data_mode: 'erp_native' });
  const response = await ok.handler(request(`/grupos-produtos?ids=${product},${contact.toUpperCase()},${product}`), env);
  assert.equal(response.status, 200); assert.equal(rpcName(ok), 'erp_fiscal_invoice_product_groups'); assert.deepEqual(rpcArgs(ok), { p_product_ids: [product, contact], p_user_id: user });
  assert.deepEqual((await response.json()).items, [{ id: product, group_id: group }, { id: contact, group_id: null }]);
  const many = Array.from({ length: 101 }, (_, n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`).join(',');
  for (const path of ['/grupos-produtos', '/grupos-produtos?ids=', '/grupos-produtos?ids=x', `/grupos-produtos?ids=${many}`, `/grupos-produtos?ids=${product}&x=1`]) {
    const h = harness({ items: [], data_mode: 'erp_native' }); assert.equal((await h.handler(request(path), env)).status, 400, path); assert.equal(h.calls.length, 1);
  }
  for (const forged of [{ items: [{ id: nature, group_id: null }], data_mode: 'erp_native' }, { items: [{ id: product, group_id: 'x' }], data_mode: 'erp_native' }, { items: [{ id: product, group_id: null, name: 'A' }], data_mode: 'erp_native' },
    { items: [{ id: product, group_id: null }, { id: product, group_id: null }], data_mode: 'erp_native' }, { items: [], data_mode: 'other' }])
    assert.equal((await harness(forged).handler(request(`/grupos-produtos?ids=${product}`), env)).status, 502);
});

test('natures: a "Grupo de Produtos" rule round-trips with its groups; a group list on another scope is a 502', async () => {
  const group = 'c2000000-0000-4000-8000-000000000001';
  const rule = { tax: 'ipi', position: 1, destinations: [], product_scope: 'groups', ncms: [], product_ids: [], group_ids: [group], groups: [{ id: group, name: 'Ferramentas' }], products: [], data: { situation: '50', rate: '10.0000' }, additional_info: null, fiscal_info: null };
  const natureOf = rules => ({ nature: { id: nature, description: 'Venda', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
    include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', defaults: [], rules }, writable: true, data_mode: 'erp_native' });
  const out = await (await harness(natureOf([rule])).handler(request(`/naturezas/${nature}`), env)).json();
  assert.deepEqual(out.nature.rules[0].group_ids, [group]); assert.deepEqual(out.nature.rules[0].groups, [{ id: group, name: 'Ferramentas' }]);
  for (const rules of [[{ ...rule, product_scope: 'any', group_ids: undefined }], [{ ...rule, groups: [{ id: nature, name: 'Outro' }] }], [{ ...rule, group_ids: [] }], [(({ groups: _g, ...rest }) => rest)(rule)]])
    assert.equal((await harness(natureOf(rules)).handler(request(`/naturezas/${nature}`), env)).status, 502);
});

test('Importar XML NF-e: the catalog counters of 217 are checked (all three, whole numbers within the items) or absent', async () => {
  const { nfeXml } = await import('./helpers/fiscal-import-xml.mjs');
  const { xml, key } = nfeXml({ number: 777 });
  const parsed = { invoice: record({ direction: '0', issue_type: 'X', status: 8, environment: null, number: 777, access_key: key, protocol: '135260000000777', authorized_at: '2026-10-18T12:00:00Z', nature_id: null, nature_description: 'Venda de mercadoria sintética', seller_id: undefined, seller_name: undefined, operation_destination: undefined }) };
  const fromDb = async over => {
    let sent = null; const calls = [];
    const handler = createHandler({ fetchImpl: async (url, options) => { calls.push(url); if (url.endsWith('/auth/v1/user')) return Response.json({ id: user }); sent = JSON.parse(options.body);
      const candidate = sent.p_data.as_recipient; const inv = { ...parsed.invoice, ...candidate, id: invoiceId, issue_type: 'X', status: 8, environment: null, version: 1, series: Number(candidate.series), number: Number(candidate.number), access_key: key, protocol: '135260000000777', authorized_at: '2026-10-18T12:00:00Z', nature_description: candidate.nature_description,
        items: candidate.items.map((item, i) => ({ ...item, position: i + 1, total: null, allocated: null })), orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null };
      const { invoiceTotals, normalizeInvoiceInput } = await import('../../../packages/erp-domain/src/fiscal-invoice-contract.mjs');
      const totals = invoiceTotals(normalizeInvoiceInput(candidate)); inv.items = inv.items.map((item, i) => ({ ...item, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })); inv.totals = totals.totals;
      delete inv.seller_id; delete inv.seller_name; delete inv.operation_destination;
      return Response.json({ invoice: inv, writable: false, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', action: 'import', replayed: false, imported: true, matched_items: 0, contact_matched: false, ...over }); } });
    return handler(request('/importar', 'POST', { command_id: command, xml }), env);
  };
  const ok = await fromDb({ created_products: 1, updated_products: 0, product_failures: 0 });
  assert.equal(ok.status, 200); assert.deepEqual((({ created_products, updated_products, product_failures }) => [created_products, updated_products, product_failures])(await ok.json()), [1, 0, 0]);
  assert.equal((await fromDb({})).status, 200, 'a database before 217 sends no counters');
  for (const forged of [{ created_products: 1 }, { created_products: -1, updated_products: 0, product_failures: 0 }, { created_products: 1.5, updated_products: 0, product_failures: 0 }, { created_products: 9, updated_products: 0, product_failures: 0 }])
    assert.equal((await fromDb(forged)).status, 502, JSON.stringify(forged));
});

test('item history: strict query, the same contact/product/direction back and 502 for a forged row', async () => {
  const value = { items: [{ origin: 'origin', id: '9801', number: 801, series: 1, issue_date: '2026-10-05', issue_type: null, quantity: '3', unit_price: '10', total: '30.00' },
    { origin: 'brufap', id: invoiceId, number: null, series: 1, issue_date: '2026-10-01', issue_type: 'N', quantity: '2.0000', unit_price: '10.0000000000', total: '20.00' }], contact_id: contact, product_id: product, direction: '1', data_mode: 'erp_native' };
  const ok = harness(value);
  const response = await ok.handler(request(`/historico-item?contact_id=${contact}&product_id=${product}&direction=1`), env);
  assert.equal(response.status, 200); assert.equal(rpcName(ok), 'erp_fiscal_invoice_item_history');
  assert.deepEqual(rpcArgs(ok), { p_contact_id: contact, p_product_id: product, p_direction: '1', p_user_id: user });
  assert.equal((await response.json()).items.length, 2);
  for (const path of ['/historico-item', `/historico-item?contact_id=${contact}&product_id=${product}`, `/historico-item?contact_id=x&product_id=${product}&direction=1`, `/historico-item?contact_id=${contact}&product_id=${product}&direction=1&extra=1`]) {
    const h = harness(value); assert.equal((await h.handler(request(path), env)).status, 400, path); assert.equal(h.calls.length, 1);
  }
  for (const forged of [{ ...value, contact_id: product }, { ...value, items: [{ ...value.items[0], origin: 'other' }] }, { ...value, items: [{ ...value.items[1], issue_type: null }] }, { ...value, items: [{ ...value.items[0], total: 30 }] },
    { ...value, items: Array.from({ length: 21 }, () => value.items[0]) }, { ...value, secret: 1 }])
    assert.equal((await harness(forged).handler(request(`/historico-item?contact_id=${contact}&product_id=${product}&direction=1`), env)).status, 502);
});

test('formas de pagamento and access key lookup: strict queries and exact projections', async () => {
  const methods = { direction: '1', items: [{ id: seller, description: 'Cartão Visa loja', payment_type: '03', card_brand: '01', card_integration: '2', card_cnpj: '11222333000181' }], data_mode: 'erp_native' };
  const ok = harness(methods);
  assert.equal((await ok.handler(request('/formas-pagamento?direction=1'), env)).status, 200); assert.equal(rpcName(ok), 'erp_fiscal_invoice_payment_methods'); assert.deepEqual(rpcArgs(ok), { p_direction: '1', p_user_id: user });
  for (const path of ['/formas-pagamento', '/formas-pagamento?direction=3', '/formas-pagamento?direction=1&x=1']) assert.equal((await harness(methods).handler(request(path), env)).status, 400, path);
  for (const forged of [{ ...methods, direction: '0' }, { ...methods, items: [{ ...methods.items[0], payment_type: '77' }] }, { ...methods, items: [{ ...methods.items[0], secret: 1 }] }, { ...methods, items: [methods.items[0], methods.items[0]] }])
    assert.equal((await harness(forged).handler(request('/formas-pagamento?direction=1'), env)).status, 502);
  const key = '3'.repeat(44);
  const lookup = { key, items: [{ origin: 'origin', id: '9901', model: '55', direction: '1', number: 901, series: 1, issue_date: '2026-10-01', name: 'Cliente', total: '55.50' }], data_mode: 'erp_native' };
  const found = harness(lookup);
  assert.equal((await found.handler(request(`/chave/${key}`), env)).status, 200); assert.equal(rpcName(found), 'erp_fiscal_invoice_key_lookup'); assert.deepEqual(rpcArgs(found), { p_key: key, p_user_id: user });
  for (const path of [`/chave/${key}?x=1`, '/chave/123']) assert.ok([400, 404].includes((await harness(lookup).handler(request(path), env)).status), path);
  for (const forged of [{ ...lookup, key: '4'.repeat(44) }, { ...lookup, items: [{ ...lookup.items[0], origin: 'x' }] }, { ...lookup, items: [{ ...lookup.items[0], total: 55.5 }] }])
    assert.equal((await harness(forged).handler(request(`/chave/${key}`), env)).status, 502);
});

test('returned: strict key and exact projection of the returns of a note', async () => {
  const key = '5'.repeat(44);
  const value = { key, returns: [{ id: invoiceId, model: '55', direction: '0', number: null, series: 1, issue_date: '2026-10-20', status: 1 }], items: [{ product_id: product, code: null, description: 'Peça', quantity: '3.0000' }], data_mode: 'erp_native' };
  const ok = harness(value);
  assert.equal((await ok.handler(request(`/devolucoes/${key}`), env)).status, 200); assert.equal(rpcName(ok), 'erp_fiscal_invoice_returned'); assert.deepEqual(rpcArgs(ok), { p_key: key, p_user_id: user });
  assert.equal((await harness(value).handler(request(`/devolucoes/${key}?x=1`), env)).status, 400);
  for (const forged of [{ ...value, key: '6'.repeat(44) }, { ...value, items: [{ ...value.items[0], quantity: 3 }] }, { ...value, returns: [{ ...value.returns[0], direction: '7' }] }, { ...value, extra: 1 }])
    assert.equal((await harness(forged).handler(request(`/devolucoes/${key}`), env)).status, 502);
});
