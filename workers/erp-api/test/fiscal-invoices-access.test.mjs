import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

// HTTP boundary of /v1/notas-fiscais with a synthetic upstream (no network, no database).
const user = 'a0000000-0000-4000-8000-000000000001', nature = 'b0000000-0000-4000-8000-000000000001', command = 'c0000000-0000-4000-8000-000000000001', invoice = 'd0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = (path = '', method = 'GET', data, headers = {}) => new Request(`https://api.example.test/v1/notas-fiscais${path}`, { method,
  headers: { Authorization: 'Bearer synthetic-token', Origin: 'https://erp.example.test', ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
const harness = (value, status = 200, authUser = { id: user }) => { const calls = []; return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/auth/v1/user') ? Response.json(authUser) : Response.json(value, { status }); } }) }; };
const emptyPage = (over = {}) => ({ items: [], origin: 'origin', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: 0, total_amount: '0.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: 'origin_mirror_readonly', ...over });
const row = (over = {}) => ({ origin: 'origin', id: '9001', version: null, number: 123, series: 1, issue_date: '2026-10-15', entry_date: null, name: 'Cliente sintético', document: '12345678000190', state: 'SP', nature: null,
  status: 6, status_raw: '5', total: '100.10', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0, orders: [], ...over });
const record = (over = {}) => ({ id: invoice, model: '55', direction: '1', issue_type: 'N', environment: '2', status: 1, version: 1, series: 1, number: null, access_key: null, protocol: null, authorized_at: null,
  nature_id: nature, nature_description: 'Venda sintética', cfop: null, issue_date: '2026-10-20', exit_date: null, exit_time: null, crt: '1', purpose: '1', credit_debit_type: null, presence: '1', final_consumer: false,
  recipient: { name: 'Cliente', person_type: 'F' }, export: null, import_declaration: null, references: [],
  items: [{ description: 'Item', quantity: '1.0000', unit_price: '10.0000000000', position: 1, total: '10.00', allocated: { freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00' } }],
  auto_tax: true, freight: '0.00', insurance: '0.00', other_expenses: '0.00', discount: '0.00',
  totals: Object.fromEntries(['icms_base', 'icms', 'st_base', 'st', 'fcp', 'fcp_st', 'deson', 'deson_deducted', 'credit', 'difal_dest', 'difal_origin', 'difal_fcp', 'ipi', 'ipi_devol', 'ii', 'pis', 'cofins', 'approx_taxes', 'funrural',
    'ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins', 'ret_base', 'freight', 'insurance', 'other_expenses', 'discount', 'services', 'issqn'].map(k => [k, '0.00']).concat([['products', '10.00'], ['total', '10.00'], ['invoiced', '10.00']])),
  transport: { mode: 'none', freight_by: '9', carrier: {}, vehicle: {}, volumes: {}, delivery: null }, payment: { condition: null, installments: [] }, authorized_xml: [], intermediary: {},
  additional_info: null, nature_additional_info: null, nature_fiscal_info: null, orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, ...over });
const envelope = (over = {}) => ({ invoice: record(), writable: true, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', locks: { items: false, installments: false }, ...over });
const body = { command_id: command, invoice: { model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: nature, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', recipient: { name: 'Cliente', person_type: 'F' }, items: [{ description: 'Item', quantity: '1', unit_price: '10' }] } };

test('the list routes the verified actor and every Origin filter to the private RPC and projects only the contract', async () => {
  const h = harness(emptyPage({ items: [row()], total_count: 1, total_amount: '100.10', secret: 'PRIVATE' }));
  const response = await h.handler(request('?model=55&q=%2012.345%20&status=issued&date_from=2026-10-01&date_to=2026-10-31&state=SP&person_type=J&series=1&tracking=BR1'), env);
  assert.equal(response.status, 200); const text = await response.text(); assert.doesNotMatch(text, /PRIVATE/);
  assert.equal(h.calls.length, 2); assert.ok(h.calls[1].url.endsWith('/rest/v1/rpc/erp_fiscal_invoice_list')); assert.equal(h.calls[1].options.redirect, 'manual');
  const args = JSON.parse(h.calls[1].options.body);
  assert.equal(args.p_user_id, user); assert.equal(args.p_query, '12.345'); assert.equal(args.p_status, 'issued'); assert.equal(args.p_series, 1); assert.equal(args.p_origin, 'origin'); assert.equal(args.p_limit, 100);
  assert.deepEqual(JSON.parse(text).items[0].total, '100.10');
  for (const query of ['', '?model=55&page=0', '?model=55&order=nome', '?model=55&p_user_id=x', '?model=55&status=x', '?model=55&product_id=x']) {
    const bad = harness(emptyPage()); assert.equal((await bad.handler(request(query), env)).status, 400, query); assert.equal(bad.calls.length, 1, 'authenticated, never reaches the RPC');
  }
});

test('response forgery, wrong page, production or emission flags are refused with 502', async () => {
  for (const value of [emptyPage({ page: 2 }), emptyPage({ data_mode: 'erp_native' }), emptyPage({ items: [row({ total: 100.1 })], total_count: 1, total_amount: '100.10' }),
    emptyPage({ items: [row({ origin: 'brufap' })], total_count: 1, total_amount: '100.10' }), emptyPage({ total_count: 150, has_more: false })])
    assert.equal((await harness(value).handler(request('?model=55'), env)).status, 502);
  for (const value of [envelope({ emission_enabled: true }), envelope({ production_enabled: true }), envelope({ invoice: record({ environment: '1' }) }), envelope({ invoice: record({ totals: { ...record().totals, total: '9.99' } }) }),
    envelope({ invoice: record({ id: nature }) }), envelope({ writable: false }), envelope({ invoice: record({ recipient: { name: 'Cliente', person_type: 'F', secret: 'x' } }) })])
    assert.equal((await harness(value).handler(request(`/${invoice}`), env)).status, 502);
  assert.equal((await harness(envelope()).handler(request(`/${invoice}`), env)).status, 200);
});

test('commands authenticate first, bind the command id and the expected version, and sanitize SQL errors', async () => {
  const h = harness({ ...envelope(), action: 'create', replayed: false });
  assert.equal((await h.handler(request('', 'POST', body), env)).status, 200);
  const args = JSON.parse(h.calls[1].options.body);
  assert.equal(args.p_command_id, command); assert.equal(args.p_action, 'create'); assert.equal(args.p_data.invoice.items[0].quantity, '1.0000'); assert.deepEqual(args.p_data.orders, []);
  const noAuth = request('', 'POST', body); noAuth.headers.delete('Authorization'); const denied = harness({}); assert.equal((await denied.handler(noAuth, env)).status, 401); assert.equal(denied.calls.length, 0);
  for (const extra of [{ p_user_id: user }, { environment: '1' }]) { const bad = harness({}); assert.equal((await bad.handler(request('', 'POST', { ...body, ...extra }), env)).status, 400); assert.equal(bad.calls.length, 1); }
  const forged = harness({}); assert.equal((await forged.handler(request('', 'POST', { ...body, invoice: { ...body.invoice, environment: '1' } }), env)).status, 400);
  const own = harness({}); assert.equal((await own.handler(request('', 'POST', { ...body, invoice: { ...body.invoice, number: '10' } }), env)).status, 400, 'number is reserved on send');
  const patch = harness({ ...envelope({ invoice: record({ version: 3 }) }), action: 'update', replayed: true });
  assert.equal((await patch.handler(request(`/${invoice}`, 'PATCH', { ...body, expected_version: 2 }), env)).status, 200);
  assert.equal(JSON.parse(patch.calls[1].options.body).p_data.expected_version, 2);
  assert.equal((await harness({ ...envelope({ invoice: record({ version: 5 }) }), action: 'update', replayed: false }).handler(request(`/${invoice}`, 'PATCH', { ...body, expected_version: 2 }), env)).status, 502);
  for (const [code, status] of [['42501', 403], ['40001', 409], ['22023', 400], ['P0002', 404], ['23505', 409]]) {
    const r = await harness({ code, message: 'PRIVATE_SQL' }, 400).handler(request('', 'POST', body), env);
    assert.equal(r.status, status); assert.doesNotMatch(await r.text(), /PRIVATE_SQL/);
  }
  assert.equal((await harness({}, 200, { id: user, is_anonymous: true }).handler(request('?model=55'), env)).status, 403);
});

test('methods, unknown paths and CORS follow the other ERP routes', async () => {
  for (const [path, method] of [['', 'DELETE'], [`/${invoice}`, 'POST'], [`/${invoice}/excluir`, 'GET'], ['/contexto', 'POST'], ['/origin/nfe/1', 'POST'], ['/naturezas/' + nature, 'PATCH']])
    assert.equal((await harness({}).handler(request(path, method), env)).status, 405, `${method} ${path}`);
  for (const path of ['/outra', `/${invoice}/emitir`, '/origin/contacts/1', '/naturezas/x']) assert.equal((await harness({}).handler(request(path), env)).status, 404, path);
  const h = harness({});
  const preflight = new Request('https://api.example.test/v1/notas-fiscais', { method: 'OPTIONS', headers: { Origin: 'https://erp.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  const ok = await h.handler(preflight, env); assert.equal(ok.status, 204); assert.equal(ok.headers.get('Access-Control-Allow-Methods'), 'GET, POST'); assert.equal(h.calls.length, 0);
  preflight.headers.set('Access-Control-Request-Headers', 'X-Other'); assert.equal((await h.handler(preflight, env)).status, 403);
  assert.equal((await harness({}).handler(request('?model=55', 'GET', undefined, { Origin: 'https://other.invalid' }), env)).status, 403);
});
