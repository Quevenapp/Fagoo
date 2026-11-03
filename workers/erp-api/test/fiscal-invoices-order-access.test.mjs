import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

// HTTP boundary of "Gerar nota fiscal" from a pedido and of the IPI / ICMS ST estimate (migration 202610200176), synthetic upstream.
const user = 'a0000000-0000-4000-8000-000000000001', doc = 'd0000000-0000-4000-8000-000000000001', contact = 'e0000000-0000-4000-8000-000000000001';
const product = 'f0000000-0000-4000-8000-000000000001', nature = 'b0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = (path = '', method = 'GET', data) => new Request(`https://api.example.test/v1/notas-fiscais${path}`, { method,
  headers: { Authorization: 'Bearer synthetic-token', Origin: 'https://erp.example.test', ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
const harness = value => { const calls = []; return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/auth/v1/user') ? Response.json({ id: user }) : Response.json(value); } }) }; };
const rpcArgs = h => JSON.parse(h.calls.at(-1).options.body), rpcName = h => h.calls.at(-1).url.split('/').at(-1);
const contactRow = { contact_id: contact, name: 'Cliente sintético', code: 'C-1', active: true, trade_name: null, person_type: 'J', document: '12345678000190', ie: '123456789', email: null, phone: null,
  mobile: null, postal_code: '30110000', street: 'Rua Sintética', number: '10', complement: null, district: null, city: 'Belo Horizonte', state: 'MG', taxpayer: '1', country: null, nfe_email: null };
const sourceOf = (over = {}) => ({ document: { id: doc, kind: 'sales_orders', number: '42', version: 3, status: 'open', date: '2026-10-20', ship_date: '2026-10-22', customer_po_number: 'PC-1', notes: null,
  warehouse_id: null, stock_active: false, finance_active: false }, direction: '1', model: '55', eligible: true, reasons: [], contact: contactRow, nature: null,
  items: [{ position: 1, product_id: product, description: 'Peça', code: 'P-1', unit: 'UN', quantity: '2.000000', unit_price: '10.0000000000', gross: '20.00', discount: '0.00', total: '20.00',
    product: { kind: 'P', ncm: '84714900', gtin: null, gtin_tax: null, cest: null, origin: '0', gross_weight: null, net_weight: null, volumes: null } }],
  totals: { gross: '20.00', line_discount: '0.00', discount: '0.00', freight: '0.00', other_expenses: '0.00', total: '20.00' }, installments: [{ position: 1, due_date: '2026-11-20', amount: '20.00', method: 'Boleto', note: null }],
  delivery: null, transport: null, existing_invoice: null, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native', ...over });

test('order source: strict query, exact projection and 502 for any forged answer', async () => {
  const ok = harness(sourceOf());
  const response = await ok.handler(request(`/pedido/${doc}?model=55`), env);
  assert.equal(response.status, 200);
  // 202610200215: the Worker reads the v2 source (vendedor, transportador and parcels rule); a v1 answer still validates.
  assert.equal(rpcName(ok), 'erp_fiscal_invoice_order_source_v3'); // 202610200254 (v2 and v1 answers are still read) assert.deepEqual(rpcArgs(ok), { p_document_id: doc, p_model: '55', p_user_id: user });
  const out = await response.json();
  assert.equal(out.document.ship_date, '2026-10-22'); assert.equal(out.items[0].product.ncm, '84714900'); assert.equal(out.eligible, true);
  for (const path of [`/pedido/${doc}`, `/pedido/${doc}?model=57`, `/pedido/${doc}?model=55&model=65`, `/pedido/${doc}?model=55&x=1`]) assert.equal((await harness(sourceOf()).handler(request(path), env)).status, 400, path);
  assert.equal((await harness(sourceOf()).handler(request(`/pedido/${doc}?model=55`, 'POST', {}), env)).status, 405);
  assert.equal((await harness(sourceOf()).handler(request('/pedido/nao-e-uuid?model=55'), env)).status, 404);
  const forged = [sourceOf({ document: { ...sourceOf().document, id: product } }), sourceOf({ model: '65' }), sourceOf({ eligible: false }), sourceOf({ reasons: [{ code: 'other', items: [] }], eligible: false }),
    sourceOf({ extra: true }), sourceOf({ reasons: [{ code: 'has_invoice', items: [] }], eligible: false }), sourceOf({ emission_enabled: true }), sourceOf({ direction: '0' }),
    sourceOf({ existing_invoice: { id: product, model: '55', number: null, status: 1 } }), sourceOf({ items: [{ ...sourceOf().items[0], position: 2 }] }),
    sourceOf({ items: [{ ...sourceOf().items[0], quantity: '2.1234567' }] }), sourceOf({ installments: [{ position: 1, due_date: '20/11/2026', amount: '20.00', method: null, note: null }] }),
    sourceOf({ contact: { ...contactRow, password: 'x' } }), sourceOf({ transport: { freight_mode: '7', volume_count: null, gross_weight: null, tracking_code: null, carrier_label: null } })];
  for (const value of forged) assert.equal((await harness(value).handler(request(`/pedido/${doc}?model=55`), env)).status, 502, JSON.stringify(value).slice(0, 160));
  const os = { ...sourceOf().document, kind: 'service_orders' };
  assert.equal((await harness(sourceOf({ document: os })).handler(request(`/pedido/${doc}?model=55`), env)).status, 200, 'ordens de serviço feed exit notes');
  for (const value of [sourceOf({ document: os, model: '65' }), sourceOf({ document: os, direction: '0' }), sourceOf({ document: { ...os, kind: 'sales_proposals' } })])
    assert.equal((await harness(value).handler(request(`/pedido/${doc}?model=${value.model}`), env)).status, 502);
  const refused = harness(sourceOf({ eligible: false, reasons: [{ code: 'has_invoice', items: [] }], existing_invoice: { id: product, model: '55', number: null, status: 1 } }));
  assert.equal((await refused.handler(request(`/pedido/${doc}?model=55`), env)).status, 200, 'a refused pedido still answers with the reasons');
});

const rule = (tax, data) => ({ tax, position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], products: [], data, additional_info: null, fiscal_info: null });
const natureRecord = (over = {}) => ({ id: nature, description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false,
  update_last_purchase_price: false, include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z',
  updated_at: '2026-10-20T12:00:00Z', defaults: ['S'], rules: [rule('ipi', { situation: '50', rate: '10.0000' }), rule('icms', { situation: '201', rate: '12.0000', st_rate: '18.0000', st_mva: '40.0000' })], ...over });
const settings = { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false };
const contextOf = (over = {}) => ({ enabled: true, company: { crt: '1', state: 'SP' }, recipient: { person_type: 'J', state: 'MG', ie: '123', taxpayer: '1' }, nature: natureRecord(), settings, difal_by_state: {},
  products: [{ id: product, ncm: '84714900', kind: 'P' }], data_mode: 'erp_native', ...over });
const body = (over = {}) => ({ kind: 'sales_orders', contact_id: contact, items: [{ product_id: product, quantity: '2.000000', unit_price: '50' }, { product_id: product, quantity: '1', unit_price: '0' }], discount: '0', freight: '0', other_expenses: '0', ...over });
const query = (over = {}) => { const b = body(over); return `/estimativa?${new URLSearchParams({ kind: b.kind, ...(b.contact_id ? { contact_id: b.contact_id } : {}), items: b.items.map(i => `${i.product_id ?? '-'},${i.quantity},${i.unit_price}`).join(';'), discount: b.discount, freight: b.freight, other_expenses: b.other_expenses })}`; };

test('estimate: the Worker runs the note engine over the natureza rules and answers only the IPI / ICMS ST values', async () => {
  const ok = harness(contextOf());
  const response = await ok.handler(request(query()), env);
  assert.equal(response.status, 200);
  assert.equal(rpcName(ok), 'erp_fiscal_tax_estimate_context_v2'); assert.deepEqual(rpcArgs(ok), { p_kind: 'sales_orders', p_contact_id: contact, p_product_ids: [product], p_user_id: user });
  const out = await response.json();
  // IPI 10% of 100.00; ST: (100 + 10 IPI) × 1,40 = 154.00 × 18% = 27.72 minus own ICMS 12.00 = 15.72.
  assert.deepEqual(out.totals, { ipi: '10.00', st: '15.72', total: '125.72' }); assert.deepEqual(out.items.map(i => [i.ipi, i.st]), [['10.00', '15.72'], ['0.00', '0.00']]);
  assert.deepEqual(out.nature, { id: nature, description: 'Venda sintética' }); assert.equal(JSON.stringify(out).includes('st_mva'), false, 'the rules never reach the screen');
  const regime = await (await harness(contextOf({ company: { crt: '3', state: 'SP' } })).handler(request(query()), env)).json();
  assert.deepEqual([regime.available, regime.reason, regime.totals.total], [false, 'regime', null]);
  const none = await (await harness(contextOf({ nature: null })).handler(request(query()), env)).json();
  assert.equal(none.reason, 'no_nature');
  const precision = await (await harness(contextOf()).handler(request(query({ items: [{ product_id: product, quantity: '1.123456', unit_price: '1' }] })), env)).json();
  assert.equal(precision.reason, 'quantity_precision');
  for (const bad of [query({ kind: 'purchase_orders' }), query({ items: [{ product_id: product, quantity: '0', unit_price: '1' }] }), query({ discount: '1,00' }), `${query()}&extra=1`, query({ contact_id: 'x' }),
    `${query()}&kind=sales_orders`, '/estimativa?kind=sales_orders', query({ items: Array.from({ length: 61 }, () => ({ product_id: product, quantity: '1', unit_price: '1' })) }),
    query().replace(/items=[^&]*/, 'items=' + encodeURIComponent(`${product},1`))])
    assert.equal((await harness(contextOf()).handler(request(bad), env)).status, 400, bad.slice(0, 120));
  assert.equal((await harness(contextOf({ products: [] })).handler(request(query({ items: [{ product_id: null, quantity: '1', unit_price: '5' }] })), env)).status, 200, 'items without product are estimated too');
  for (const forged of [contextOf({ data_mode: 'x' }), contextOf({ products: [] }), contextOf({ nature: { ...natureRecord(), direction: '0' } }), contextOf({ settings: { ...settings, difal_default: 'magic' } }), contextOf({ extra: 1 })])
    assert.equal((await harness(forged).handler(request(query()), env)).status, 502, JSON.stringify(forged).slice(0, 120));
  assert.equal((await harness(contextOf()).handler(request('/estimativa', 'POST', body()), env)).status, 405, 'a read, never a POST');
});

test('link states: one state per asked pedido de compra, strict body and 502 for anything else', async () => {
  const other = 'd0000000-0000-4000-8000-000000000002';
  const ok = harness({ items: [{ document_id: doc, state: 'partial' }], data_mode: 'erp_native' });
  const response = await ok.handler(request('/vinculos', 'POST', { document_ids: [doc, doc.toUpperCase(), other] }), env);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { items: [{ document_id: doc, state: 'partial' }], data_mode: 'erp_native' });
  assert.equal(rpcName(ok), 'erp_fiscal_invoice_order_link_states'); assert.deepEqual(rpcArgs(ok), { p_document_ids: [doc, other], p_user_id: user });
  for (const bad of [{}, { document_ids: [] }, { document_ids: ['x'] }, { document_ids: Array.from({ length: 101 }, () => doc) }, { document_ids: [doc], extra: 1 }])
    assert.equal((await harness({}).handler(request('/vinculos', 'POST', bad), env)).status, 400, JSON.stringify(bad).slice(0, 80));
  for (const forged of [{ items: [{ document_id: product, state: 'none' }], data_mode: 'erp_native' }, { items: [{ document_id: doc, state: 'maybe' }], data_mode: 'erp_native' },
    { items: [{ document_id: doc, state: 'none' }, { document_id: doc, state: 'linked' }], data_mode: 'erp_native' }, { items: [], data_mode: 'x' }, { items: [], data_mode: 'erp_native', note: 'x' }])
    assert.equal((await harness(forged).handler(request('/vinculos', 'POST', { document_ids: [doc] }), env)).status, 502, JSON.stringify(forged));
  assert.equal((await harness({}).handler(request('/vinculos'), env)).status, 405);
});

test('context: "Informar desconto individualmente nos itens" is projected; a forged value is 502 and a database before 176 means off', async () => {
  const { DEFAULT_INVOICE_PREFERENCES } = await import('../../../packages/erp-domain/src/fiscal-invoice-contract.mjs');
  const context = extra => ({ company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [], defaults: {}, preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] },
    writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native', ...extra });
  for (const [value, expected] of [[{ item_discount: true }, true], [{ item_discount: false }, false], [{}, false]]) {
    const response = await harness(context(value)).handler(request('/contexto?model=55'), env);
    assert.equal(response.status, 200); assert.equal((await response.json()).item_discount, expected, JSON.stringify(value));
  }
  for (const forged of [{ item_discount: 'true' }, { item_discount: null }]) assert.equal((await harness(context(forged)).handler(request('/contexto?model=55'), env)).status, 502, JSON.stringify(forged));
});
