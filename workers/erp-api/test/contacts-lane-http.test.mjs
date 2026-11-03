import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';

// Contatos lane routes (/v1/cadastros/{contatos,tipos-contato,vendedores,formas-pagamento,funcionarios}): allow-listed
// parameters and bodies, the exact RPC arguments, strict response validation and error mapping. Synthetic data only.
const user = 'a0000000-0000-4000-8000-000000000001';
const id = 'b0000000-0000-4000-8000-000000000001', other = 'b0000000-0000-4000-8000-000000000002', seller = 'b0000000-0000-4000-8000-0000000000aa';
const command = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const stamp = '2026-10-20T12:00:00+00:00';
const fields = { code: null, trade_name: null, person_type: 'F', document: null, ie: null, email: null, phone: null, mobile: null, postal_code: null, street: null, number: null, complement: null,
  district: null, city: null, state: null, municipal_registration: null, rg: null, rg_issuer: null, country: null, foreign_state: null, fax: null, nfe_email: null, website: null, skype: null,
  profession: null, birthplace: null, father_name: null, father_cpf: null, mother_name: null, mother_cpf: null, payment_condition: null, billing_postal_code: null, billing_state: null,
  billing_city: null, billing_district: null, billing_street: null, billing_number: null, billing_complement: null, billing_foreign_state: null, suframa: null, notes: null, contact_info: null,
  crt: null, taxpayer: '9', carrier_operator: null, public_agency: null, marital_status: null, gender: null, ie_exempt: false, client_since: '2026-10-20', next_visit: null, birth_date: null,
  avg_tax_load: null, credit_limit_mode: 'unlimited', credit_limit: null, finance_category_id: null, operation_nature_id: null, seller_id: null, finance_category_name: null,
  operation_nature_name: null, seller_name: null, updated_by_name: 'Administrador', seller_record_id: null };
const record = { id, entity: 'contacts', version: 1, active: true, created_at: stamp, updated_at: stamp, name: 'Cliente fictício', situation: 'A', roles: ['customer'], types: ['customer'], persons: [], source: null, ...fields };
const item = { id, entity: 'contacts', version: 1, active: true, created_at: stamp, updated_at: stamp, name: 'Cliente fictício', code: null, trade_name: null, person_type: 'F', document: null, email: null,
  phone: null, mobile: null, city: null, state: null, situation: 'A', roles: ['customer'], types: ['customer'], crt: null, seller_id: null, seller_name: null, next_visit: null, is_seller: false, source: null };
const settings = { user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {}, commission_rule: 'parcial', commission_mode: 'fixa',
  commission_rate: null, commission_bands: [], discount_limit: '0', notes: null };
const method = { description: 'Dinheiro', payment_type: '01', condition: null, destination: 'caixa', account_id: null, business_days: false, applicable: 'ambos', interest_rate: null, fine_rate: null,
  card_brand: null, card_integration: null, card_cnpj: null, auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: 'aliquota', fee_rate: null, fee_fixed: null, settlement_days: null };
const employee = { name: 'Funcionária', cpf: '52998224725', rg: null, job_title: null, pis: null, ctps: null, code: null, phone: null, mobile: null, email: null, emergency_phone: null, postal_code: null,
  state: null, city: null, district: null, street: null, number: null, complement: null, birth_date: null, admission_date: null, salary: '1000.00', notes: null };
function harness(result, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/auth/v1/user') ? { id: user } : typeof result === 'function' ? result(JSON.parse(options.body)) : result), { status: url.endsWith('/auth/v1/user') ? 200 : status });
  } }) };
}
const request = (path, verb = 'GET', value, extra = {}) => new Request(`https://api.example.test${path}`, { method: verb, headers: { Authorization: 'Bearer synthetic-user-token', Origin: 'https://erp.example.test', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value) });
const rpc = call => call.url.split('/').at(-1);
const args = call => { const value = JSON.parse(call.body); delete value.p_user_id; return value; };
const page = (items, extra = {}) => ({ entity: 'contacts', items, page: 1, size: 100, total: items.length, sort: 'created_desc', situation: 'latest', scoped: false, data_mode: 'erp_native', ...extra });

test('routes are recognized only under the lane paths; the legacy /contacts contract is untouched', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/contatos'), { contact: 'contacts', id: null, entity: 'contacts' });
  assert.deepEqual(catalogRoute(`/v1/cadastros/contatos/${id.toUpperCase()}/situacao`), { contact: 'contact-situation', id, entity: 'contacts' });
  assert.equal(catalogRoute('/v1/cadastros/contatos/123'), null);
  assert.equal(catalogRoute('/v1/cadastros/contatos/conferir/x'), null);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/formas-pagamento/' + id + '/acao')), ['POST']);
  assert.deepEqual(catalogRoute('/v1/cadastros/contacts'), { entity: 'contacts', id: null, active: false });
});

test('contact page maps every Origin filter, with defaults, and refuses anything else before the database', async () => {
  const { handler, calls } = harness(body => page([item], { page: body.p_page, size: body.p_size, sort: body.p_sort, situation: body.p_situation, total: body.p_page === 1 ? 1 : 101 }));
  const ok = await handler(request(`/v1/cadastros/contatos?page=1&size=50&sort=name_asc&q=%20Ana%20&situation=E&type=accountant&person_type=J&state=sp&city=Campinas&phone=(19)&email=a%40&seller_id=${seller.toUpperCase()}&period=no_purchases&from=2026-10-01&to=2026-10-31&sale_statuses=open,fulfilled`), env);
  assert.equal(ok.status, 200);
  assert.equal(rpc(calls[1]), 'erp_catalog_contact_page');
  assert.deepEqual(args(calls[1]), { p_page: 1, p_size: 50, p_sort: 'name_asc', p_query: 'Ana', p_situation: 'E', p_type: 'accountant', p_person_type: 'J', p_state: 'SP', p_city: 'Campinas', p_phone: '(19)',
    p_email: 'a@', p_seller_id: seller, p_period: 'no_purchases', p_from: '2026-10-01', p_to: '2026-10-31', p_sale_statuses: ['open', 'fulfilled'] });
  const body = await ok.json(); assert.equal(body.items[0].name, 'Cliente fictício'); assert.equal(body.scoped, false);
  await handler(request('/v1/cadastros/contatos'), env);
  assert.deepEqual(args(calls.at(-1)), { p_page: 1, p_size: 100, p_sort: 'created_desc', p_query: null, p_situation: 'latest', p_type: null, p_person_type: null, p_state: null, p_city: null, p_phone: null,
    p_email: null, p_seller_id: null, p_period: null, p_from: null, p_to: null, p_sale_statuses: null });
  const before = calls.length;
  for (const query of ['page=0', 'size=101', 'sort=id', 'situation=X', 'type=Bad-Slug', 'person_type=X', 'state=SPX', 'phone=abc', 'seller_id=1', 'period=created', 'from=2026-10-01',
    'period=next_visit&from=2026-02-30', 'period=created&from=2026-10-02&to=2026-10-01', 'sale_statuses=open', 'period=no_purchases&from=2026-10-01&sale_statuses=aberto',
    'period=no_purchases&from=2026-10-01&sale_statuses=open,open', 'active=true', 'role=customer', 'limit=10', 'q=' + 'x'.repeat(121), 'q=a%01', 'page=1&page=2'])
    assert.equal((await handler(request(`/v1/cadastros/contatos?${query}`), env)).status, 400, query);
  assert.equal(calls.length, before);
});

test('contact responses are validated strictly: incoherent pages, unknown values and inexact decimals are refused', async () => {
  for (const value of [page([item], { total: 2 }), page([{ ...item, situation: 'X' }]), page([{ ...item, active: false }]), page([{ ...item, types: ['Bad'] }]), page([item, item], { total: 2 }),
    page([{ ...item, is_seller: undefined }]), { ...page([item]), data_mode: 'other' }]) {
    const { handler } = harness(value);
    assert.equal((await handler(request('/v1/cadastros/contatos'), env)).status, 502, JSON.stringify(value).slice(0, 80));
  }
  for (const bad of [{ credit_limit: '10.5', credit_limit_mode: 'value' }, { credit_limit: '10.50' }, { avg_tax_load: '12.5' }, { birth_date: '2026-02-30' }, { ie_exempt: 'false' }, { persons: [{ id: other, name: 'x' }] },
    { id: other }, { roles: ['admin'] }, { situation: 'X' }, { notes: 'a\u0001' }, { name: ' ' }]) {
    const { handler } = harness({ entity: 'contacts', record: { ...record, ...bad }, data_mode: 'erp_native' });
    assert.equal((await handler(request(`/v1/cadastros/contatos/${id}`), env)).status, 502, JSON.stringify(bad));
  }
  const { handler } = harness({ entity: 'contacts', record: { ...record, credit_limit_mode: 'value', credit_limit: '1500.50', avg_tax_load: '12.50', persons: [{ id: other, name: 'Pessoa', code: null, situation: 'S' }] }, data_mode: 'erp_native' });
  const response = await handler(request(`/v1/cadastros/contatos/${id}`), env);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual([value.record.credit_limit, value.record.persons[0].situation, value.replayed], ['1500.50', 'S', false]);
});

test('contact save, check, situation and seller link send the exact commands; bodies are allow-listed and bounded', async () => {
  const { handler, calls } = harness({ entity: 'contacts', record, replayed: false, data_mode: 'erp_native' });
  const data = { name: 'Cliente fictício', person_type: 'F', types: ['customer', 'accountant'], persons: [other.toUpperCase()], birth_date: '1990-01-02', credit_limit_mode: 'value', credit_limit: '10.5',
    seller_id: seller.toUpperCase(), notes: 'linha 1\nlinha 2', ie_exempt: false, roles: ['customer'] };
  assert.equal((await handler(request('/v1/cadastros/contatos', 'POST', { command_id: command, data, acknowledged_warnings: ['duplicate_document'] }), env)).status, 200);
  assert.equal(rpc(calls[1]), 'erp_catalog_contact_save');
  assert.deepEqual(args(calls[1]), { p_id: null, p_expected_version: 0, p_command_id: command, p_data: { ...data, persons: [other], seller_id: seller }, p_acknowledged: ['duplicate_document'] });
  assert.equal((await handler(request(`/v1/cadastros/contatos/${id}`, 'PATCH', { command_id: command, expected_version: 3, data: { name: 'Novo' } }), env)).status, 200);
  assert.deepEqual(args(calls.at(-1)), { p_id: id, p_expected_version: 3, p_command_id: command, p_data: { name: 'Novo' }, p_acknowledged: null });
  const situation = harness({ entity: 'contacts', record: { ...record, situation: 'E', active: false }, data_mode: 'erp_native' });
  assert.equal((await situation.handler(request(`/v1/cadastros/contatos/${id}/situacao`, 'PATCH', { command_id: command, expected_version: 1, situation: 'E' }), env)).status, 200);
  assert.deepEqual([rpc(situation.calls[1]), args(situation.calls[1])], ['erp_catalog_contact_set_situation', { p_id: id, p_expected_version: 1, p_command_id: command, p_situation: 'E' }]);
  assert.equal((await situation.handler(request(`/v1/cadastros/contatos/${id}/situacao`, 'PATCH', { command_id: command, expected_version: 1, situation: 'A' }), env)).status, 502, 'the answer must be the requested situation');
  assert.equal((await handler(request(`/v1/cadastros/contatos/${id}/vendedor`, 'PATCH', { command_id: command, expected_version: 2, seller_id: null }), env)).status, 200);
  assert.deepEqual([rpc(calls.at(-1)), args(calls.at(-1))], ['erp_catalog_contact_set_seller', { p_id: id, p_expected_version: 2, p_command_id: command, p_seller_id: null }]);
  const before = calls.length;
  for (const [path, verb, value] of [
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { code: 'sem nome' } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: ' ' } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: 'x', data: { name: 'a' } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', x: 1 } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', situation: 'E' } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', birth_date: '1990-02-30' } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', credit_limit: '1,5' } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', seller_id: '1' } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', types: ['customer', 'customer'] } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', persons: Array.from({ length: 21 }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`) } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', ie_exempt: 'true' } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', credit_limit_mode: null } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a' }, acknowledged_warnings: ['duplicate_code'] }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a'.repeat(201) } }],
    ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', notes: 'x'.repeat(4001) } }], ['/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a', email: 'a\u0001' } }],
    [`/v1/cadastros/contatos/${id}`, 'PATCH', { command_id: command, data: { name: 'a' } }], [`/v1/cadastros/contatos/${id}/situacao`, 'PATCH', { command_id: command, expected_version: 1, situation: 'X' }],
    [`/v1/cadastros/contatos/${id}/vendedor`, 'PATCH', { command_id: command, expected_version: 1 }], ['/v1/cadastros/contatos/conferir', 'POST', { id: '1', data: { name: 'a' } }],
    ['/v1/cadastros/contatos', 'POST', JSON.stringify({ command_id: command, data: { name: 'a', notes: 'x'.repeat(33000) } })],
  ]) assert.equal((await handler(request(path, verb, value), env)).status, 400, `${path} ${typeof value === 'string' ? 'huge' : JSON.stringify(value).slice(0, 60)}`);
  assert.equal(calls.length, before);
  assert.equal((await handler(request(`/v1/cadastros/contatos/${id}`, 'DELETE'), env)).status, 405);
  const check = harness({ entity: 'contacts', warnings: [{ code: 'duplicate_document', field: 'document', total: 1, blocked: true, matches: [{ id: other, name: 'Outro', code: null, active: true }] }, { code: 'invalid_father_cpf', field: 'father_cpf', expected: 'cpf' }], data_mode: 'erp_native' });
  const checked = await check.handler(request('/v1/cadastros/contatos/conferir', 'POST', { id, data: { document: '1' } }), env);
  assert.equal(checked.status, 200); assert.equal((await checked.json()).warnings[0].blocked, true);
  assert.deepEqual([rpc(check.calls[1]), args(check.calls[1])], ['erp_catalog_contact_check', { p_id: id, p_data: { document: '1' } }]);
});

test('upstream refusals map to 400, 403, 404 and 409 without any SQL detail', async () => {
  for (const [code, status] of [['22023', 400], ['42501', 403], ['P0002', 404], ['40001', 409], ['23505', 409]]) {
    const { handler } = harness({ code, message: 'private SQL detail' }, 400);
    const response = await handler(request('/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a' } }), env);
    assert.equal(response.status, status); assert.equal(JSON.stringify(await response.json()).includes('private'), false);
  }
});

test('export, comments, history, import, code and contact types map strictly', async () => {
  const exported = harness(body => ({ scope: 'contacts_export', kind: body.p_kind, offset: body.p_offset, limit: body.p_limit, total: 1, items: body.p_offset === 0 ? [{ ...record, persons: undefined, source: undefined }] : [], data_mode: 'erp_native' }));
  const response = await exported.handler(request('/v1/cadastros/contatos/exportar?kind=birthdays&birth_from=2026-12-01&birth_to=2027-01-31&situation=all&limit=50'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(args(exported.calls[1]), { p_kind: 'birthdays', p_offset: 0, p_limit: 50, p_sort: 'created_desc', p_query: null, p_situation: 'all', p_type: null, p_person_type: null, p_state: null, p_city: null,
    p_phone: null, p_email: null, p_seller_id: null, p_period: null, p_from: null, p_to: null, p_sale_statuses: null, p_birth_from: '2026-12-01', p_birth_to: '2027-01-31' });
  for (const query of ['kind=birthdays', 'birth_from=2026-01-01&birth_to=2026-01-31', 'kind=x', 'offset=10000', 'limit=101', 'kind=birthdays&birth_from=2026-02-01&birth_to=2026-01-01'])
    assert.equal((await exported.handler(request(`/v1/cadastros/contatos/exportar?${query}`), env)).status, 400, query);
  const withPersons = harness({ scope: 'contacts_export', kind: 'contacts', offset: 0, limit: 100, total: 1, items: [record], data_mode: 'erp_native' });
  assert.equal((await withPersons.handler(request('/v1/cadastros/contatos/exportar'), env)).status, 502, 'export rows carry no persons/source');

  const comments = harness({ scope: 'contact_comments', contact_id: id, can_comment: true, items: [{ id: other, body: 'Olá\nmundo', author_name: 'Vendas', created_at: stamp }], data_mode: 'erp_native' });
  assert.equal((await comments.handler(request(`/v1/cadastros/contatos/${id}/comentarios`), env)).status, 200);
  assert.deepEqual([rpc(comments.calls[1]), args(comments.calls[1])], ['erp_catalog_contact_comments', { p_contact_id: id }]);
  const added = harness({ scope: 'contact_comment', contact_id: id, item: { id: other, body: 'Olá', author_name: null, created_at: stamp }, replayed: true, data_mode: 'erp_native' });
  const addedResponse = await added.handler(request(`/v1/cadastros/contatos/${id}/comentarios`, 'POST', { command_id: command, body: 'Olá' }), env);
  assert.equal(addedResponse.status, 200); assert.equal((await addedResponse.json()).replayed, true);
  for (const value of [{ command_id: command, body: ' ' }, { command_id: command, body: 'x'.repeat(2001) }, { command_id: command }])
    assert.equal((await added.handler(request(`/v1/cadastros/contatos/${id}/comentarios`, 'POST', value), env)).status, 400);

  const sales = harness({ scope: 'contact_sales', contact_id: id, visible: true, items: [{ id: other, number: '12', date: '2026-10-10', status: 'open', total: '10.00' }], data_mode: 'erp_native' });
  assert.equal((await sales.handler(request(`/v1/cadastros/contatos/${id}/historico`), env)).status, 200);
  const hidden = harness({ scope: 'contact_sales', contact_id: id, visible: false, items: [{ id: other, number: '12', date: '2026-10-10', status: 'open', total: '10.00' }], data_mode: 'erp_native' });
  assert.equal((await hidden.handler(request(`/v1/cadastros/contatos/${id}/historico`), env)).status, 502);

  const imported = harness(body => ({ scope: 'contact_import', dry_run: body.p_dry_run, replayed: false, items: [...body.p_rows].sort((a, b) => a.row - b.row).map(row => body.p_dry_run ? { row: row.row, status: 'valid' } : { row: row.row, status: 'created', record_id: other }), data_mode: 'erp_native' }));
  assert.equal((await imported.handler(request('/v1/cadastros/contatos/importar', 'POST', { dry_run: true, rows: [{ row: 3, data: { name: 'B' } }, { row: 2, data: { name: 'A' } }] }), env)).status, 200);
  assert.deepEqual(args(imported.calls[1]), { p_command_id: null, p_dry_run: true, p_rows: [{ row: 3, data: { name: 'B' } }, { row: 2, data: { name: 'A' } }] });
  assert.equal((await imported.handler(request('/v1/cadastros/contatos/importar', 'POST', { command_id: command, dry_run: false, rows: [{ row: 2, data: { name: 'A' } }] }), env)).status, 200);
  for (const value of [{ dry_run: false, rows: [{ row: 2, data: { name: 'A' } }] }, { command_id: command, dry_run: true, rows: [{ row: 2, data: { name: 'A' } }] }, { dry_run: true, rows: [] },
    { dry_run: true, rows: [{ row: 2, data: { name: 'A' } }, { row: 2, data: { name: 'B' } }] }, { dry_run: true, rows: [{ row: 0, data: { name: 'A' } }] }, { dry_run: true, rows: [{ row: 2, data: {} }] },
    { dry_run: true, rows: Array.from({ length: 51 }, (_, index) => ({ row: index + 2, data: { name: 'A' } })) }])
    assert.equal((await imported.handler(request('/v1/cadastros/contatos/importar', 'POST', value), env)).status, 400, JSON.stringify(value).slice(0, 80));

  const code = harness({ scope: 'contact_code', mode: 'sequencial', next_number: '11', version: 2, highest_used: '10', can_edit: true, data_mode: 'erp_native' });
  assert.equal((await code.handler(request('/v1/cadastros/contatos/codigo'), env)).status, 200);
  assert.equal((await code.handler(request('/v1/cadastros/contatos/codigo', 'PATCH', { command_id: command, expected_version: 2, next_number: '50' }), env)).status, 200);
  assert.deepEqual([rpc(code.calls.at(-1)), args(code.calls.at(-1))], ['erp_catalog_contact_code_set', { p_command_id: command, p_expected_version: 2, p_next_number: '50' }]);
  for (const value of [{ command_id: command, expected_version: 2, next_number: '0' }, { command_id: command, expected_version: -1, next_number: '5' }, { command_id: command, expected_version: 2, next_number: 5 }])
    assert.equal((await code.handler(request('/v1/cadastros/contatos/codigo', 'PATCH', value), env)).status, 400);

  const typeItem = { id: other, slug: 'accountant', label: 'Contador', system: false, deletable: true, position: 8, contacts: 2 };
  const types = harness({ scope: 'contact_types', can_create: true, can_delete: false, items: [typeItem], data_mode: 'erp_native' });
  assert.equal((await types.handler(request('/v1/cadastros/tipos-contato'), env)).status, 200);
  const systemDeletable = harness({ scope: 'contact_types', can_create: true, can_delete: false, items: [{ ...typeItem, system: true }], data_mode: 'erp_native' });
  assert.equal((await systemDeletable.handler(request('/v1/cadastros/tipos-contato'), env)).status, 502);
  const created = harness({ scope: 'contact_type', item: { ...typeItem, slug: 't' + '0'.repeat(32), label: 'Parceiro', contacts: 0 }, replayed: false, data_mode: 'erp_native' });
  assert.equal((await created.handler(request('/v1/cadastros/tipos-contato', 'POST', { command_id: command, label: ' Parceiro ' }), env)).status, 200);
  assert.deepEqual(args(created.calls[1]), { p_command_id: command, p_label: 'Parceiro' });
  const removed = harness({ scope: 'contact_type_delete', id, unlinked: 3, replayed: false, data_mode: 'erp_native' });
  assert.equal((await removed.handler(request(`/v1/cadastros/tipos-contato/${id}/excluir`, 'POST', { command_id: command }), env)).status, 200);
  assert.equal((await removed.handler(request(`/v1/cadastros/tipos-contato/${id}/excluir`, 'POST', { command_id: command, x: 1 }), env)).status, 400);
});

test('vendedores, formas de pagamento and funcionários map strictly and validate their answers', async () => {
  const sellerDto = { id: seller, contact_id: id, version: 1, created_at: stamp, updated_at: stamp, user_name: null, ...settings };
  const contact = { ...record, types: ['seller'], seller_record_id: seller };
  const saved = harness({ entity: 'sellers', seller: sellerDto, contact, replayed: false, data_mode: 'erp_native' });
  assert.equal((await saved.handler(request('/v1/cadastros/vendedores', 'POST', { command_id: command, contact: { name: 'Vendedora' }, settings }), env)).status, 200);
  assert.deepEqual(args(saved.calls[1]), { p_id: null, p_expected_version: 0, p_contact_expected_version: 0, p_command_id: command, p_contact: { name: 'Vendedora' }, p_settings: settings, p_acknowledged: null });
  for (const value of [{ ...settings, modules: { multilojas: true } }, { ...settings, access_windows: [{ start: '18:00', end: '08:00', days: [1] }] }, { ...settings, commission_rate: '100.5' },
    { ...settings, discount_limit: null }, { ...settings, user_id: 'x' }, { ...settings, extra: 1 }])
    assert.equal((await saved.handler(request('/v1/cadastros/vendedores', 'POST', { command_id: command, contact: { name: 'V' }, settings: value }), env)).status, 400, JSON.stringify(value).slice(0, 80));
  const wrongContact = harness({ entity: 'sellers', seller: sellerDto, contact: { ...contact, types: ['customer'] }, replayed: false, data_mode: 'erp_native' });
  assert.equal((await wrongContact.handler(request('/v1/cadastros/vendedores', 'POST', { command_id: command, contact: { name: 'V' }, settings }), env)).status, 502);
  const read = harness({ entity: 'sellers', seller: sellerDto, contact, can_write: true, users: [{ user_id: user, name: 'Vendas', role: 'vendas' }], data_mode: 'erp_native' });
  assert.equal((await read.handler(request(`/v1/cadastros/vendedores/${seller}`), env)).status, 200);
  const from = harness({ entity: 'sellers', seller: sellerDto, contact, replayed: false, data_mode: 'erp_native' });
  assert.equal((await from.handler(request('/v1/cadastros/vendedores/a-partir-do-contato', 'POST', { command_id: command, contact_id: id }), env)).status, 200);
  assert.deepEqual(args(from.calls[1]), { p_command_id: command, p_contact_id: id });
  const sellers = harness(body => ({ entity: 'sellers', page: 1, size: 100, total: 1, sort: body.p_sort, situation: body.p_situation, can_write: false, items: [{ ...item, seller_id: seller, seller_version: 1, is_seller: true }], data_mode: 'erp_native' }));
  assert.equal((await sellers.handler(request('/v1/cadastros/vendedores?situation=E&type=none'), env)).status, 200);
  const options = harness({ scope: 'seller_options', users: [], items: [{ id: seller, name: 'Vendedora', code: null }], data_mode: 'erp_native' });
  assert.equal((await options.handler(request('/v1/cadastros/vendedores/opcoes?q=ven'), env)).status, 200);
  assert.equal((await options.handler(request('/v1/cadastros/vendedores/opcoes?x=1'), env)).status, 400);

  const methodDto = { id, version: 1, active: true, is_default: false, created_at: stamp, updated_at: stamp, account_name: null, ...method };
  const methods = harness(body => ({ entity: 'payment_methods', page: 1, size: 100, total: 1, can_write: true, accounts: [{ id: other, name: 'Caixa', active: true }], items: [{ ...methodDto, active: body.p_active ?? true }], data_mode: 'erp_native' }));
  assert.equal((await methods.handler(request(`/v1/cadastros/formas-pagamento?applicable=pagamentos&account_id=${other}&situation=inactive`), env)).status, 200);
  assert.deepEqual(args(methods.calls[1]), { p_page: 1, p_size: 100, p_query: null, p_applicable: 'pagamentos', p_account_id: other, p_active: false });
  for (const query of ['situation=x', 'applicable=todos', 'account_id=1']) assert.equal((await methods.handler(request(`/v1/cadastros/formas-pagamento?${query}`), env)).status, 400, query);
  const wrongSituation = harness({ entity: 'payment_methods', page: 1, size: 100, total: 1, can_write: true, accounts: [], items: [{ ...methodDto, active: true }], data_mode: 'erp_native' });
  assert.equal((await wrongSituation.handler(request('/v1/cadastros/formas-pagamento?situation=inactive'), env)).status, 502);
  const saveMethod = harness({ entity: 'payment_methods', item: methodDto, replayed: false, data_mode: 'erp_native' });
  assert.equal((await saveMethod.handler(request('/v1/cadastros/formas-pagamento', 'POST', { command_id: command, data: method }), env)).status, 200);
  for (const value of [{ ...method, payment_type: '06' }, { ...method, extra: 1 }, { ...method, fee_rate: '1,5' }, { ...method, settlement_days: 366 }, { ...method, pix_integration: 'com' }])
    assert.equal((await saveMethod.handler(request('/v1/cadastros/formas-pagamento', 'POST', { command_id: command, data: value }), env)).status, 400);
  const deleted = harness({ entity: 'payment_methods', id, action: 'delete', item: null, previous_default: null, replayed: false, data_mode: 'erp_native' });
  assert.equal((await deleted.handler(request(`/v1/cadastros/formas-pagamento/${id}/acao`, 'POST', { command_id: command, expected_version: 1, action: 'delete' }), env)).status, 200);
  const notDefault = harness({ entity: 'payment_methods', id, action: 'default', item: methodDto, previous_default: null, replayed: false, data_mode: 'erp_native' });
  assert.equal((await notDefault.handler(request(`/v1/cadastros/formas-pagamento/${id}/acao`, 'POST', { command_id: command, expected_version: 1, action: 'default' }), env)).status, 502);

  const employees = harness({ entity: 'employees', page: 1, size: 100, total: 1, situation: 'ativos', items: [{ id, version: 1, name: 'Funcionária', cpf: '52998224725', job_title: null, admission_date: null, situation: 'ativo' }], data_mode: 'erp_native' });
  assert.equal((await employees.handler(request('/v1/cadastros/funcionarios'), env)).status, 200);
  assert.equal((await employees.handler(request('/v1/cadastros/funcionarios?situation=x'), env)).status, 400);
  const employeeRead = harness({ entity: 'employees', item: { id, version: 1, situation: 'ativo', created_at: stamp, updated_at: stamp, ...employee }, data_mode: 'erp_native' });
  assert.equal((await employeeRead.handler(request(`/v1/cadastros/funcionarios/${id}`), env)).status, 200);
  const employeeSave = harness({ entity: 'employees', item: { id, version: 2 }, replayed: false, data_mode: 'erp_native' });
  assert.equal((await employeeSave.handler(request(`/v1/cadastros/funcionarios/${id}`, 'PATCH', { command_id: command, expected_version: 1, data: null, situation: 'desligado' }), env)).status, 200);
  assert.deepEqual(args(employeeSave.calls[1]), { p_id: id, p_expected_version: 1, p_command_id: command, p_data: null, p_situation: 'desligado' });
  for (const value of [{ command_id: command, expected_version: 1, data: null }, { command_id: command, expected_version: 1, data: { ...employee, extra: 1 } }, { command_id: command, expected_version: 1, data: { ...employee, salary: '1.234,5' } }])
    assert.equal((await employeeSave.handler(request(`/v1/cadastros/funcionarios/${id}`, 'PATCH', value), env)).status, 400);
  const leaking = harness({ entity: 'employees', item: { id, version: 2, cpf: '52998224725' }, replayed: false, data_mode: 'erp_native' });
  assert.equal((await leaking.handler(request('/v1/cadastros/funcionarios', 'POST', { command_id: command, data: employee }), env)).status, 502, 'a save answer never carries personal data');
});

test('CORS preflight follows the lane methods', async () => {
  const { handler } = harness({});
  const preflight = (path, verb) => new Request(`https://api.example.test${path}`, { method: 'OPTIONS', headers: { Origin: 'https://erp.example.test', 'Access-Control-Request-Method': verb } });
  assert.equal((await handler(preflight(`/v1/cadastros/contatos/${id}/situacao`, 'PATCH'), env)).status, 204);
  assert.equal((await handler(preflight('/v1/cadastros/contatos/importar', 'POST'), env)).status, 204);
  assert.equal((await handler(preflight('/v1/cadastros/contatos/importar', 'GET'), env)).status, 403);
});
