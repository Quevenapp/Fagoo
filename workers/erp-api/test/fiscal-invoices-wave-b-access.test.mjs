import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
import { DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { nfeXml } from './helpers/fiscal-import-xml.mjs';
import { createHash } from 'node:crypto';

// HTTP boundary of the second wave of /v1/notas-fiscais (migrations 202610200140-144) with a synthetic upstream.
const user = 'a0000000-0000-4000-8000-000000000001', nature = 'b0000000-0000-4000-8000-000000000001', command = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = (path = '', method = 'GET', data, headers = {}) => new Request(`https://api.example.test/v1/notas-fiscais${path}`, { method,
  headers: { Authorization: 'Bearer synthetic-token', Origin: 'https://erp.example.test', ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
const harness = (value, status = 200) => { const calls = []; return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/auth/v1/user') ? Response.json({ id: user }) : Response.json(typeof value === 'function' ? value(url, options) : value, { status }); } }) }; };
const rpcArgs = h => JSON.parse(h.calls.at(-1).options.body), rpcName = h => h.calls.at(-1).url.split('/').at(-1);
const context = (preferences = { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] }) => ({ company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [], defaults: {}, preferences,
  writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' });
const natureRecord = (over = {}) => ({ id: nature, description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false,
  update_last_purchase_price: false, include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z',
  updated_at: '2026-10-20T12:00:00Z', defaults: [], rules: [], ...over });

test('context: the preferences block is projected exactly and any forged or missing value is refused with 502', async () => {
  const people = [{ document: '11222333000181', name: 'Contabilidade sintética' }];
  const ok = harness(context({ ...DEFAULT_INVOICE_PREFERENCES, freight_by: '1', autxml_people: people, secret: undefined }));
  const response = await ok.handler(request('/contexto?model=55'), env);
  assert.equal(response.status, 200);
  const out = await response.json();
  assert.deepEqual(out.preferences, { ...DEFAULT_INVOICE_PREFERENCES, freight_by: '1', autxml_people: people });
  assert.equal(rpcName(ok), 'erp_fiscal_invoice_context'); assert.deepEqual(rpcArgs(ok), { p_model: '55', p_user_id: user });
  const base = { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] };
  for (const forged of [null, { ...base, freight_by: '7' }, { ...base, show_totals: 'yes' }, { ...base, volume_quantity: 1.5 }, { ...base, markup: 35.5 }, { ...base, species: 'pallets' },
    { ...base, extra: true }, { ...base, autxml_people: [{ document: '123', name: '' }] }, { ...base, autxml_people: [...people, ...people] }, { ...base, autxml_people: [{ document: '11222333000181' }] }]) {
    const bad = harness(context(forged));
    assert.equal((await bad.handler(request('/contexto?model=55'), env)).status, 502, JSON.stringify(forged));
  }
});

test('list: "Exibir totais" is required and projected', async () => {
  const page = over => ({ items: [], origin: 'origin', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: 0, total_amount: '0.00', amount_unknown: 0, brufap_visible: false, data_mode: 'origin_mirror_readonly', ...over });
  const ok = harness(page({ show_totals: false }));
  const response = await ok.handler(request('?model=55'), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).show_totals, false);
  for (const forged of [page({}), page({ show_totals: 'false' })]) assert.equal((await harness(forged).handler(request('?model=55'), env)).status, 502);
});

test('natures: the list carries the review; "delete" and "Confirmo que revisei" are strict commands', async () => {
  const listed = { items: [], page: 1, limit: 100, total_count: 0, writable: true, data_mode: 'erp_native' };
  const ok = harness({ ...listed, review: { confirmed: true, version: 2, confirmed_at: '2026-10-20T13:00:00Z' } });
  const response = await ok.handler(request('/naturezas?active=true'), env);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).review, { confirmed: true, version: 2, confirmed_at: '2026-10-20T13:00:00Z' });
  for (const review of [undefined, { confirmed: true, version: 0, confirmed_at: null }, { confirmed: false, version: 0, confirmed_at: '2026-10-20T13:00:00Z' }, { confirmed: true, version: 1, confirmed_at: 'ontem' }])
    assert.equal((await harness({ ...listed, review }).handler(request('/naturezas'), env)).status, 502, JSON.stringify(review));

  const deleted = harness({ nature: natureRecord({ version: 2, active: false }), action: 'delete', replayed: false, data_mode: 'erp_native' });
  const del = await deleted.handler(request('/naturezas', 'POST', { command_id: command, action: 'delete', id: nature, expected_version: 1 }), env);
  assert.equal(del.status, 200); assert.equal(rpcName(deleted), 'erp_fiscal_nature_execute');
  assert.deepEqual(rpcArgs(deleted), { p_command_id: command, p_action: 'delete', p_data: { id: nature, expected_version: 1 }, p_user_id: user });
  for (const forged of [natureRecord({ version: 2, active: true }), natureRecord({ version: 3, active: false }), natureRecord({ version: 2, active: false, defaults: ['S'] })])
    assert.equal((await harness({ nature: forged, action: 'delete', replayed: false, data_mode: 'erp_native' }).handler(request('/naturezas', 'POST', { command_id: command, action: 'delete', id: nature, expected_version: 1 }), env)).status, 502);
  for (const bad of [{ command_id: command, action: 'delete', id: nature }, { command_id: command, action: 'delete', id: nature, expected_version: 1, reason: 'x' }])
    assert.equal((await harness({}).handler(request('/naturezas', 'POST', bad), env)).status, 400);

  const review = harness({ review: { confirmed: true, version: 1, confirmed_at: '2026-10-20T13:00:00Z' }, action: 'confirm_review', replayed: false, data_mode: 'erp_native' });
  const confirmed = await review.handler(request('/naturezas/revisao', 'POST', { command_id: command, expected_version: 0 }), env);
  assert.equal(confirmed.status, 200); assert.equal(rpcName(review), 'erp_fiscal_nature_review_confirm');
  assert.deepEqual(rpcArgs(review), { p_command_id: command, p_expected_version: 0, p_user_id: user });
  assert.equal((await review.handler(request('/naturezas/revisao'), env)).status, 405);
  for (const bad of [{ command_id: command }, { command_id: command, expected_version: -1 }, { command_id: 'x', expected_version: 0 }, { command_id: command, expected_version: 0, user_id: user }])
    assert.equal((await harness({}).handler(request('/naturezas/revisao', 'POST', bad), env)).status, 400, JSON.stringify(bad));
  const stale = harness({ review: { confirmed: true, version: 3, confirmed_at: '2026-10-20T13:00:00Z' }, action: 'confirm_review', replayed: false, data_mode: 'erp_native' });
  assert.equal((await stale.handler(request('/naturezas/revisao', 'POST', { command_id: command, expected_version: 0 }), env)).status, 502, 'a fresh confirmation moves exactly one version');
});

const invoiceId = 'd0000000-0000-4000-8000-000000000001', order = 'e0000000-0000-4000-8000-000000000001';
const invoice = (over = {}) => ({ id: invoiceId, model: '55', direction: '0', issue_type: 'T', environment: null, status: 8, version: 2, series: 1, number: 77, access_key: null, protocol: null, authorized_at: null,
  nature_id: null, nature_description: 'Compra sintética', cfop: null, issue_date: '2026-10-20', exit_date: null, exit_time: null, crt: '1', purpose: '1', credit_debit_type: null, presence: '9', final_consumer: false,
  recipient: { name: 'Fornecedor', person_type: 'J' }, export: null, import_declaration: null, references: [],
  items: [{ description: 'Item', quantity: '1.0000', unit_price: '10.0000000000', position: 1, total: '10.00', allocated: { freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00' } }],
  auto_tax: true, freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00',
  totals: Object.fromEntries(['icms_base', 'icms', 'st_base', 'st', 'fcp', 'fcp_st', 'deson', 'deson_deducted', 'credit', 'difal_dest', 'difal_origin', 'difal_fcp', 'ipi', 'ipi_devol', 'ii', 'pis', 'cofins', 'approx_taxes', 'funrural',
    'ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins', 'ret_base', 'freight', 'insurance', 'other_expenses', 'discount', 'services', 'issqn'].map(k => [k, '0.00']).concat([['products', '10.00'], ['total', '10.00'], ['invoiced', '10.00']])),
  transport: { mode: 'none', freight_by: '9', carrier: {}, vehicle: {}, volumes: {}, delivery: null }, payment: { condition: null, installments: [] }, authorized_xml: [], intermediary: {},
  additional_info: null, nature_additional_info: null, nature_fiscal_info: null, orders: [{ id: order, kind: 'purchase_orders', number: '15', date: '2026-10-15', contact_name: 'Fornecedor' }],
  created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, ...over });
const envelope = (over = {}) => ({ invoice: invoice(), writable: true, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', ...over });

test('invoice read carries the edit locks; linking an order is one strict command', async () => {
  const ok = harness(envelope({ locks: { items: true, installments: false } }));
  const response = await ok.handler(request(`/${invoiceId}`), env);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).locks, { items: true, installments: false });
  for (const locks of [undefined, { items: true }, { items: 'true', installments: false }, { items: true, installments: false, orders: true }])
    assert.equal((await harness(envelope({ locks })).handler(request(`/${invoiceId}`), env)).status, 502, JSON.stringify(locks));

  const linked = harness(envelope({ action: 'link_order', replayed: false, document_id: order }));
  const sent = await linked.handler(request(`/${invoiceId}/pedidos`, 'POST', { command_id: command, expected_version: 1, action: 'link', document_id: order.toUpperCase() }), env);
  assert.equal(sent.status, 200); assert.equal(rpcName(linked), 'erp_fiscal_invoice_link');
  assert.deepEqual(rpcArgs(linked), { p_command_id: command, p_data: { invoice_id: invoiceId, expected_version: 1, action: 'link', document_id: order }, p_user_id: user });
  const unlinked = harness(envelope({ invoice: invoice({ version: 3, orders: [] }), action: 'unlink_order', replayed: false, document_id: order }));
  assert.equal((await unlinked.handler(request(`/${invoiceId}/pedidos`, 'POST', { command_id: command, expected_version: 2, action: 'unlink', document_id: order }), env)).status, 200);
  for (const forged of [envelope({ action: 'link_order', replayed: false, document_id: order, invoice: invoice({ orders: [] }) }), envelope({ action: 'link_order', replayed: false, document_id: order, invoice: invoice({ version: 3 }) }),
    envelope({ action: 'unlink_order', replayed: false, document_id: order }), envelope({ action: 'link_order', replayed: false })])
    assert.equal((await harness(forged).handler(request(`/${invoiceId}/pedidos`, 'POST', { command_id: command, expected_version: 1, action: 'link', document_id: order }), env)).status, 502);
  for (const bad of [{ command_id: command, expected_version: 1, action: 'link' }, { command_id: command, expected_version: 1, action: 'replace', document_id: order }, { command_id: command, expected_version: 0, action: 'link', document_id: order },
    { command_id: command, expected_version: 1, action: 'link', document_id: 'pedido-15' }, { command_id: command, expected_version: 1, action: 'link', document_id: order, orders: [] }])
    assert.equal((await harness({}).handler(request(`/${invoiceId}/pedidos`, 'POST', bad), env)).status, 400, JSON.stringify(bad));
  assert.equal((await harness({}).handler(request(`/${invoiceId}/pedidos`), env)).status, 405);
});

const importedInvoice = (over = {}) => invoice({ issue_type: 'X', status: 8, version: 1, environment: null, protocol: '135260000000777', authorized_at: '2026-10-18T12:31:05Z', orders: [], ...over });

test('Importar XML NF-e: refusals read from the XML never reach the database; the database answer is checked strictly', async () => {
  for (const [xml, refused] of [[nfeXml({ tpAmb: '2' }).xml, 'xml_homologation'], [nfeXml({ withProtocol: false }).xml, 'xml_not_authorized'], [nfeXml({ extraTotal: 3 }).xml, 'xml_total_mismatch'],
    ['<!DOCTYPE x><x/>', 'xml_invalid'],
    // Wave F (202610200274) imports the NFC-e; one outside the rules of the NFC-e (presença 9) is still not.
    [nfeXml({ model: '65', indPres: '9' }).xml, 'xml_unsupported']]) {
    const h = harness({});
    const response = await h.handler(request('/importar', 'POST', { command_id: command, xml }), env);
    assert.equal(response.status, 200); const out = await response.json();
    assert.equal(out.imported, false); assert.equal(out.refused, refused); assert.equal(h.calls.length, 1, `${refused}: only the session check`);
  }
  const { xml, key } = nfeXml();
  const accepted = harness(envelope({ invoice: importedInvoice({ access_key: key, number: 321 }), writable: false, action: 'import', replayed: false, imported: true, matched_items: 1, contact_matched: false }));
  const sent = await accepted.handler(request('/importar', 'POST', { command_id: command, xml }), env);
  assert.equal(rpcName(accepted), 'erp_fiscal_invoice_import');
  const args = rpcArgs(accepted).p_data;
  assert.equal(args.sha256, createHash('sha256').update(xml).digest('hex')); assert.equal(args.size, Buffer.byteLength(xml)); assert.equal(args.key, key);
  assert.equal(args.as_recipient.direction, '0'); assert.equal(args.as_recipient.issue_type, 'T'); assert.equal(args.as_emitter.direction, '1'); assert.deepEqual(Object.keys(rpcArgs(accepted)).sort(), ['p_command_id', 'p_data', 'p_user_id']);
  assert.equal(sent.status, 200); const body = await sent.json(); assert.equal(body.imported, true); assert.equal(body.matched_items, 1); assert.equal(body.invoice.issue_type, 'X');
  const other = nfeXml({ number: 322 }).key;
  for (const forged of [importedInvoice({ access_key: other, number: 322 }), importedInvoice({ access_key: key, number: 321, protocol: '135260000000778' }), importedInvoice({ access_key: key, number: 321, issue_type: 'T' })])
    assert.equal((await harness(envelope({ invoice: forged, writable: false, action: 'import', replayed: false, imported: true, matched_items: 1, contact_matched: false })).handler(request('/importar', 'POST', { command_id: command, xml }), env)).status, 502);
  for (const [value, status] of [[{ imported: false, refused: 'duplicate', invoice_id: invoiceId, data_mode: 'erp_native' }, 200], [{ imported: false, refused: 'other_company', invoice_id: null, data_mode: 'erp_native' }, 200],
    [{ imported: false, refused: 'duplicate', invoice_id: null, data_mode: 'erp_native' }, 502], [{ imported: false, refused: 'bad', invoice_id: null, data_mode: 'erp_native' }, 502]])
    assert.equal((await harness(value).handler(request('/importar', 'POST', { command_id: command, xml }), env)).status, status, JSON.stringify(value));
  for (const bad of [{ command_id: command }, { command_id: command, xml: 12 }, { command_id: command, xml, entry: true }, { command_id: 'x', xml }])
    assert.equal((await harness({}).handler(request('/importar', 'POST', bad), env)).status, 400);
});

test('Baixar XML of an imported note: size, SHA-256 and access key are checked before the browser gets it; Conciliar produtos is strict', async () => {
  const { xml, key } = nfeXml();
  const stored = (over = {}) => ({ invoice_id: invoiceId, access_key: key, sha256: createHash('sha256').update(xml).digest('hex'), size: Buffer.byteLength(xml), signed: true, protocol_status: '100', imported_at: '2026-10-20T12:00:00Z', xml, data_mode: 'erp_native', ...over });
  const ok = await harness(stored()).handler(request(`/${invoiceId}/xml`), env);
  assert.equal(ok.status, 200); assert.equal((await ok.json()).xml, xml);
  for (const forged of [stored({ xml: xml.replace('Parafuso', 'Prego') }), stored({ size: 10 }), stored({ access_key: '1'.repeat(44) }), stored({ invoice_id: command }), stored({ extra: 1 })])
    assert.equal((await harness(forged).handler(request(`/${invoiceId}/xml`), env)).status, 502);
  const reconciled = harness(envelope({ invoice: importedInvoice({ version: 2, items: [{ ...invoice().items[0], product_id: nature }] }), writable: false, action: 'reconcile', replayed: false }));
  const response = await reconciled.handler(request(`/${invoiceId}/conciliar`, 'POST', { command_id: command, expected_version: 1, items: [{ position: 1, product_id: nature }] }), env);
  assert.equal(response.status, 200); assert.equal(rpcName(reconciled), 'erp_fiscal_invoice_reconcile');
  assert.deepEqual(rpcArgs(reconciled).p_data, { invoice_id: invoiceId, expected_version: 1, items: [{ position: 1, product_id: nature }] });
  assert.equal((await reconciled.handler(request(`/${invoiceId}/conciliar`, 'POST', { command_id: command, expected_version: 1, items: [{ position: 1, product_id: null }] }), env)).status, 502, 'answer differs from the request');
  for (const bad of [{ command_id: command, expected_version: 1, items: [] }, { command_id: command, expected_version: 1, items: [{ position: 1 }] }, { command_id: command, expected_version: 1, items: [{ position: 1, product_id: null }, { position: 1, product_id: null }] }])
    assert.equal((await harness({}).handler(request(`/${invoiceId}/conciliar`, 'POST', bad), env)).status, 400);
  assert.equal((await harness(envelope({ invoice: importedInvoice(), writable: true })).handler(request(`/${invoiceId}`), env)).status, 502, 'an imported note is never writable');
});
