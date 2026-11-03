import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';

const user = 'a0000000-0000-4000-8000-000000000001';
const id = 'b0000000-0000-4000-8000-000000000001';
const other = 'b0000000-0000-4000-8000-000000000002';
const warehouse = 'b0000000-0000-4000-8000-0000000000aa';
const command = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const stamp = '2026-10-19T12:00:00+00:00';
const contactItem = { id, entity: 'contacts', version: 2, active: true, name: 'Cliente fictício', code: 'C-1', trade_name: null, person_type: 'J', document: '00.000.000/0001-91', email: null, phone: null, mobile: '(19) 90000-0000', city: 'Cidade fictícia', state: 'SP', roles: ['customer'], created_at: stamp, updated_at: stamp, source: null };
const productItem = { id, entity: 'products', version: 3, active: true, name: 'Produto fictício', code: 'QA-1', unit: 'UN', price: '1.5000', kind: 'P', format: 'S', gtin: null, brand: null, ncm: null, created_at: stamp, updated_at: stamp, source: { system: 'origin', source_id: '77', state: 'synced' }, stock: { state: 'recorded', quantity: '7.500000', warehouse: null } };
const page = (entity, items, extra = {}) => ({ entity, items, page: 1, size: 100, total: items.length, sort: 'created_desc', data_mode: 'erp_native', ...(entity === 'products' ? { stock_visible: true } : {}), ...extra });
function harness(result, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/auth/v1/user') ? { id: user } : result), { status: url.endsWith('/auth/v1/user') ? 200 : status });
  } }) };
}
const request = (path, method = 'GET', value) => new Request(`https://api.example.test${path}`, { method, headers: { Authorization: 'Bearer synthetic-user-token', Origin: 'https://erp.example.test', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
const rpc = call => call.url.split('/').at(-1);

test('numbered pages map every Origin filter to the page RPCs with defaults; the cursor contract is unchanged', async () => {
  const contacts = harness(page('contacts', [contactItem]));
  const response = await contacts.handler(request('/v1/cadastros/contacts?page=2&size=50&sort=name_desc&q=%20Jo%C3%A3o%20silva%20&active=true&role=none&person_type=J&state=sp&city=s%C3%A3o&phone=(19)%209&email=a%40b&period=created&from=2026-10-01&to=2026-10-19'), env);
  assert.equal(response.status, 502, 'echo of page/size must match the request');
  assert.equal(rpc(contacts.calls[1]), 'erp_catalog_page');
  assert.deepEqual(JSON.parse(contacts.calls[1].body), { p_entity: 'contacts', p_page: 2, p_size: 50, p_sort: 'name_desc', p_query: 'João silva', p_active: true, p_period: 'created', p_from: '2026-10-01', p_to: '2026-10-19', p_role: 'none', p_person_type: 'J', p_state: 'SP', p_city: 'são', p_phone: '(19) 9', p_email: 'a@b', p_user_id: user });
  const defaults = harness(page('contacts', [contactItem]));
  const ok = await defaults.handler(request('/v1/cadastros/contacts?page=1'), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(defaults.calls[1].body), { p_entity: 'contacts', p_page: 1, p_size: 100, p_sort: 'created_desc', p_query: null, p_active: null, p_period: null, p_from: null, p_to: null, p_role: null, p_person_type: null, p_state: null, p_city: null, p_phone: null, p_email: null, p_user_id: user });
  assert.deepEqual(await ok.json(), page('contacts', [contactItem]));
  const products = harness(page('products', [productItem], { sort: 'code_asc' }));
  assert.equal((await products.handler(request(`/v1/cadastros/products?page=1&sort=code_asc&kind=P&format=S&ncm_presence=present&ncm=7318&brand=%20A%C3%A7o%20&stock=zero&warehouse_id=${warehouse.toUpperCase()}`), env)).status, 502, 'warehouse block is required when a depósito is requested');
  assert.deepEqual(JSON.parse(products.calls[1].body), { p_page: 1, p_size: 100, p_sort: 'code_asc', p_query: null, p_active: null, p_period: null, p_from: null, p_to: null, p_kind: 'P', p_format: 'S', p_ncm_presence: 'present', p_ncm: '7318', p_brand: 'Aço', p_stock: 'zero', p_warehouse_id: warehouse, p_user_id: user });
  assert.equal(rpc(products.calls[1]), 'erp_catalog_product_page');
  const warehouses = harness(page('warehouses', [], { page: 3 }));
  assert.equal((await warehouses.handler(request('/v1/cadastros/warehouses?page=3&period=updated&to=2026-10-19'), env)).status, 200);
  assert.deepEqual(JSON.parse(warehouses.calls[1].body), { p_entity: 'warehouses', p_page: 3, p_size: 100, p_sort: 'created_desc', p_query: null, p_active: null, p_period: 'updated', p_from: null, p_to: '2026-10-19', p_user_id: user });
  const legacy = harness({ entity: 'contacts', items: [], limit: 25, has_more: false, next_cursor: null, data_mode: 'erp_native' });
  assert.equal((await legacy.handler(request('/v1/cadastros/contacts?limit=25&active=true&q=x'), env)).status, 200);
  assert.equal(rpc(legacy.calls[1]), 'erp_catalog_list');
});

test('page parameters are allow-listed per entity and rejected before any upstream call', async () => {
  const { handler, calls } = harness(page('contacts', []));
  for (const query of ['page=0', 'page=100001', 'page=01', 'page=1&size=0', 'page=1&size=101', 'page=1&sort=id', 'page=1&after=' + id, 'page=1&limit=10', 'page=1&page=2', 'page=1&x=1',
    'page=1&active=yes', 'page=1&q=' + 'x'.repeat(121), 'page=1&q=a%01', 'page=1&role=admin', 'page=1&person_type=X', 'page=1&state=SPX', 'page=1&phone=abc', 'page=1&city=' + 'x'.repeat(101),
    'page=1&period=created', 'page=1&from=2026-10-01', 'page=1&period=deleted&from=2026-10-01', 'page=1&period=created&from=2026-02-30', 'page=1&period=created&from=2026-10-02&to=2026-10-01',
    'page=1&period=created&from=1899-12-31', 'page=1&stock=zero', 'page=1&warehouse_id=' + warehouse, 'page=1&kind=P', 'role=customer'])
    assert.equal((await handler(request(`/v1/cadastros/contacts?${query}`), env)).status, 400, query);
  for (const query of ['page=1&role=customer', 'page=1&stock=some', 'page=1&ncm=7318x', 'page=1&ncm=73&ncm_presence=missing', 'page=1&warehouse_id=123', 'page=1&kind=X', 'page=1&brand=' + 'x'.repeat(101), 'page=1&email=a'])
    assert.equal((await handler(request(`/v1/cadastros/products?${query}`), env)).status, 400, query);
  for (const query of ['page=1&role=customer', 'page=1&city=x', 'page=1&stock=zero'])
    assert.equal((await handler(request(`/v1/cadastros/warehouses?${query}`), env)).status, 400, query);
  assert.equal(calls.length, 0);
});

test('page responses are validated strictly and lean items drop unknown or private fields', async () => {
  const valid = async (entity, value, query = 'page=1') => { const { handler } = harness(value); const response = await handler(request(`/v1/cadastros/${entity}?${query}`), env); return { status: response.status, body: response.status === 200 ? await response.json() : null }; };
  const leaky = await valid('products', page('products', [{ ...productItem, description: 'private long text', additional_info: 'private', source: { system: 'origin', source_id: '77', state: 'synced' } }]));
  assert.equal(leaky.status, 200);
  assert.equal('description' in leaky.body.items[0], false);
  assert.deepEqual(leaky.body.items[0].stock, { state: 'recorded', quantity: '7.500000', warehouse: null });
  assert.equal((await valid('products', page('products', [{ ...productItem, stock: null }], { stock_visible: false }))).status, 200);
  const selected = { ...productItem, stock: { state: 'recorded', quantity: '7.500000', warehouse: { id: warehouse, state: 'no_movements', quantity: null } } };
  assert.equal((await valid('products', page('products', [selected]), `page=1&warehouse_id=${warehouse}`)).status, 200);
  for (const [label, entity, value, query] of [
    ['too many items', 'contacts', page('contacts', [contactItem, { ...contactItem, id: other }], { size: 1, total: 2 }), 'page=1&size=1'],
    ['wrong page echo', 'contacts', page('contacts', [contactItem], { page: 2 })],
    ['wrong sort echo', 'contacts', page('contacts', [contactItem], { sort: 'name_asc' })],
    ['total below items', 'contacts', page('contacts', [contactItem], { total: 0 })],
    ['short page not last', 'contacts', page('contacts', [contactItem], { total: 5 })],
    ['empty page inside the total', 'contacts', page('contacts', [], { total: 3 })],
    ['empty second page inside the total', 'contacts', page('contacts', [], { page: 2, size: 1, total: 2 }), 'page=2&size=1'],
    ['duplicate ids', 'contacts', page('contacts', [contactItem, contactItem])],
    ['float total', 'contacts', page('contacts', [contactItem], { total: 1.5 })],
    ['wrong data mode', 'contacts', page('contacts', [contactItem], { data_mode: 'staging' })],
    ['unknown role', 'contacts', page('contacts', [{ ...contactItem, roles: ['seller'] }])],
    ['missing roles', 'contacts', page('contacts', [{ ...contactItem, roles: undefined }])],
    ['source with extra hash', 'contacts', page('contacts', [{ ...contactItem, source: { system: 'origin', source_id: '1', state: 'synced', applied_hash: 'x' } }])],
    ['wrong entity item', 'contacts', page('contacts', [{ ...contactItem, entity: 'products' }])],
    ['non-canonical price', 'products', page('products', [{ ...productItem, price: '1.5' }])],
    ['missing stock flag', 'products', { ...page('products', [productItem]), stock_visible: undefined }],
    ['hidden stock leaked', 'products', page('products', [productItem], { stock_visible: false })],
    ['recorded without quantity', 'products', page('products', [{ ...productItem, stock: { state: 'recorded', quantity: null, warehouse: null } }])],
    ['quantity without six places', 'products', page('products', [{ ...productItem, stock: { state: 'recorded', quantity: '7.5', warehouse: null } }])],
    ['no movements reported as zero', 'products', page('products', [{ ...productItem, stock: { state: 'no_movements', quantity: '0.000000', warehouse: null } }])],
    ['unknown stock state', 'products', page('products', [{ ...productItem, stock: { state: 'negative', quantity: null, warehouse: null } }])],
    ['unrequested depósito block', 'products', page('products', [selected])],
    ['other depósito', 'products', page('products', [{ ...selected, stock: { ...selected.stock, warehouse: { id: other, state: 'no_movements', quantity: null } } }]), `page=1&warehouse_id=${warehouse}`],
    ['review only in depósito', 'products', page('products', [{ ...selected, stock: { ...selected.stock, warehouse: { id: warehouse, state: 'review_required', quantity: null } } }]), `page=1&warehouse_id=${warehouse}`],
  ]) assert.equal((await valid(entity, value, query)).status, 502, label);
});

test('check route is POST-only, validates its body and response, and never forwards unknown fields', async () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/contacts/check'), { entity: 'contacts', id: null, active: false, check: true });
  assert.equal(catalogRoute('/v1/cadastros/warehouses/check'), null);
  assert.equal(catalogRoute('/v1/cadastros/products/check/active'), null);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/products/check')), ['POST']);
  const result = { entity: 'products', warnings: [{ code: 'duplicate_code', field: 'code', total: 7, matches: [{ id: other, name: 'Outro produto', code: 'QA-1', active: false }] }], data_mode: 'erp_native' };
  const ok = harness(result);
  const response = await ok.handler(request('/v1/cadastros/products/check', 'POST', { id: id.toUpperCase(), data: { name: 'Produto', code: 'QA-1' } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(rpc(ok.calls[1]), 'erp_catalog_check');
  assert.deepEqual(JSON.parse(ok.calls[1].body), { p_entity: 'products', p_id: id, p_data: { name: 'Produto', code: 'QA-1' }, p_user_id: user });
  const contact = harness({ entity: 'contacts', warnings: [{ code: 'invalid_document', field: 'document', expected: 'cpf' }], data_mode: 'erp_native' });
  assert.equal((await contact.handler(request('/v1/cadastros/contacts/check', 'POST', { id: null, data: { document: '123' } }), env)).status, 200);
  const { handler, calls } = harness(result);
  for (const body of [{ data: {} }, { id: 'x', data: { code: 'A' } }, { data: { code: 'A' }, extra: 1 }, { id }, { data: { unknown: 'x' } }, { data: { price: 1 } }])
    assert.equal((await handler(request('/v1/cadastros/products/check', 'POST', body), env)).status, 400, JSON.stringify(body));
  assert.equal((await handler(request('/v1/cadastros/products/check'), env)).status, 405);
  assert.equal((await handler(request('/v1/cadastros/products/check?x=1', 'POST', { data: { code: 'A' } }), env)).status, 400);
  assert.equal(calls.length, 0);
  for (const warnings of [
    [{ code: 'duplicate_document', field: 'document', total: 1, matches: [{ id: other, name: 'X', code: null, active: true }] }],
    [{ code: 'duplicate_code', field: 'gtin', total: 1, matches: [{ id: other, name: 'X', code: null, active: true }] }],
    [{ code: 'duplicate_code', field: 'code', total: 1, matches: [] }],
    [{ code: 'duplicate_code', field: 'code', total: 0, matches: [{ id: other, name: 'X', code: null, active: true }] }],
    [{ code: 'duplicate_code', field: 'code', total: 9, matches: Array.from({ length: 6 }, () => ({ id: other, name: 'X', code: null, active: true })) }],
    [{ code: 'duplicate_code', field: 'code', total: 1, matches: [{ id: other, name: 'X', code: null, active: true, document: 'private' }] }],
    [{ code: 'other', field: 'code' }],
  ]) {
    const bad = harness({ entity: 'products', warnings, data_mode: 'erp_native' });
    assert.equal((await bad.handler(request('/v1/cadastros/products/check', 'POST', { data: { code: 'A' } }), env)).status, 502, JSON.stringify(warnings));
  }
  const cors = new Request('https://api.example.test/v1/cadastros/products/check', { method: 'OPTIONS', headers: { Origin: 'https://erp.example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  assert.equal((await handler(cors, env)).status, 204);
});

test('acknowledged warnings select the checked save RPC; malformed confirmations are rejected', async () => {
  const envelope = { entity: 'products', record: { id, entity: 'products', version: 1, active: true, name: 'Produto', code: 'QA-1', created_at: stamp, updated_at: stamp, source: null }, replayed: false, data_mode: 'erp_native' };
  const create = harness(envelope);
  assert.equal((await create.handler(request('/v1/cadastros/products', 'POST', { command_id: command, data: { name: 'Produto', code: 'QA-1' }, acknowledged_warnings: ['duplicate_code'] }), env)).status, 200);
  assert.equal(rpc(create.calls[1]), 'erp_catalog_save_checked');
  assert.deepEqual(JSON.parse(create.calls[1].body), { p_entity: 'products', p_id: null, p_expected_version: 0, p_command_id: command, p_data: { name: 'Produto', code: 'QA-1' }, p_acknowledged: ['duplicate_code'], p_user_id: user });
  const update = harness(envelope);
  assert.equal((await update.handler(request(`/v1/cadastros/products/${id}`, 'PATCH', { command_id: command, expected_version: 1, data: { code: 'QA-1' }, acknowledged_warnings: [] }), env)).status, 200);
  assert.deepEqual(JSON.parse(update.calls[1].body).p_acknowledged, []);
  const plain = harness(envelope);
  assert.equal((await plain.handler(request(`/v1/cadastros/products/${id}`, 'PATCH', { command_id: command, expected_version: 1, data: { price: '2' } }), env)).status, 200);
  assert.equal(rpc(plain.calls[1]), 'erp_catalog_save', 'existing callers keep the original RPC');
  const { handler, calls } = harness(envelope);
  for (const acknowledged_warnings of [null, 'duplicate_code', ['duplicate_code', 'duplicate_code'], ['unknown'], [1], ['duplicate_code', 'duplicate_gtin', 'invalid_document', 'duplicate_document', 'duplicate_code']])
    assert.equal((await handler(request('/v1/cadastros/products', 'POST', { command_id: command, data: { name: 'Produto' }, acknowledged_warnings }), env)).status, 400, JSON.stringify(acknowledged_warnings));
  assert.equal((await handler(request('/v1/cadastros/warehouses', 'POST', { command_id: command, data: { name: 'Depósito' }, acknowledged_warnings: [] }), env)).status, 400);
  assert.equal((await handler(request(`/v1/cadastros/products/${id}/active`, 'PATCH', { command_id: command, expected_version: 1, active: false, acknowledged_warnings: [] }), env)).status, 400);
  assert.equal(calls.length, 0);
  for (const [code, status] of [['40001', 409], ['22023', 400], ['42501', 403], ['P0002', 404]]) {
    const failure = harness({ code, message: 'private detail' }, 400);
    const result = await failure.handler(request('/v1/cadastros/products', 'POST', { command_id: command, data: { name: 'Produto', code: 'QA-1' }, acknowledged_warnings: [] }), env);
    assert.equal(result.status, status); assert.doesNotMatch(await result.text(), /private/);
  }
});
