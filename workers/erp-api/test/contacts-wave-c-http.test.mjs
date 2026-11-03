import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { contactRefusal } from '../src/contacts.mjs';
import { LABEL_DEFAULTS } from '../../../packages/erp-domain/src/reports-labels.mjs';

// Contatos lane, wave C (migration 158): picker by papel, summary, history by kind, labels and the specific refusals of
// the contact RPCs. Synthetic data only.
const user = 'a0000000-0000-4000-8000-000000000001';
const id = 'b0000000-0000-4000-8000-000000000001', other = 'b0000000-0000-4000-8000-000000000002';
const command = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const stamp = '2026-10-20T12:00:00+00:00';
const option = (extra = {}) => ({ id, entity: 'contacts', version: 1, active: true, name: 'Fornecedor fictício', code: 'F-1', trade_name: null, person_type: 'J', document: null, ie: null, email: null,
  phone: null, mobile: null, postal_code: null, street: null, number: null, complement: null, district: null, city: 'Piracicaba', state: 'SP', roles: ['supplier'], types: ['supplier'], situation: 'A',
  has_notes: true, persons: 2, created_at: stamp, updated_at: stamp, source: null, ...extra });
function harness(result, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/auth/v1/user') ? { id: user } : typeof result === 'function' ? result(JSON.parse(options.body)) : result), { status: url.endsWith('/auth/v1/user') ? 200 : status });
  } }) };
}
const request = (path, verb = 'GET', value) => new Request(`https://api.example.test${path}`, { method: verb, headers: { Authorization: 'Bearer synthetic-user-token', Origin: 'https://erp.example.test',
  ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
const rpc = call => call.url.split('/').at(-1);
const args = call => { const value = JSON.parse(call.body); delete value.p_user_id; return value; };

test('the new paths are routed only as GET; the legacy contact routes are untouched', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/contatos/opcoes'), { contact: 'contact-options', id: null, entity: 'contacts' });
  assert.deepEqual(catalogRoute('/v1/cadastros/contatos/etiquetas'), { contact: 'contact-labels', id: null, entity: 'contacts' });
  assert.deepEqual(catalogRoute(`/v1/cadastros/contatos/${id.toUpperCase()}/resumo`), { contact: 'contact-summary', id, entity: 'contacts' });
  for (const path of ['/v1/cadastros/contatos/opcoes', '/v1/cadastros/contatos/etiquetas', `/v1/cadastros/contatos/${id}/resumo`]) assert.deepEqual(catalogMethods(catalogRoute(path)), ['GET']);
  assert.equal(catalogRoute('/v1/cadastros/contatos/opcoes/x'), null);
  assert.deepEqual(catalogRoute('/v1/cadastros/contacts'), { entity: 'contacts', id: null, active: false });
});

test('picker: papel and the search reach the RPC, the answer is checked item by item', async () => {
  const { handler, calls } = harness(body => ({ scope: 'contact_options', role: body.p_role, limit: body.p_limit, scoped: false, has_more: false, items: [option()], data_mode: 'erp_native' }));
  const ok = await handler(request('/v1/cadastros/contatos/opcoes?q=%20Forn%20&papel=fornecedor&cidade=Piracicaba&limit=10'), env);
  assert.equal(ok.status, 200);
  assert.deepEqual([rpc(calls[1]), args(calls[1])], ['erp_catalog_contact_options', { p_query: 'Forn', p_role: 'supplier', p_city: 'Piracicaba', p_limit: 10 }]);
  const body = await ok.json(); assert.deepEqual([body.items[0].name, body.items[0].has_notes, body.items[0].persons, body.role], ['Fornecedor fictício', true, 2, 'supplier']);
  await handler(request('/v1/cadastros/contatos/opcoes'), env);
  assert.deepEqual(args(calls.at(-1)), { p_query: null, p_role: null, p_city: null, p_limit: 25 });
  const before = calls.length;
  for (const query of ['papel=vendedor', 'papel=supplier', 'limit=0', 'limit=51', 'limit=x', 'q=' + 'a'.repeat(121), 'cidade=' + 'c'.repeat(101), 'x=1', 'q=a&q=b'])
    assert.equal((await handler(request(`/v1/cadastros/contatos/opcoes?${query}`), env)).status, 400, query);
  assert.equal(calls.length - before, 0, 'refused queries never reach the session check or the database');
  for (const bad of [{ items: [option({ active: false, situation: 'I' })] }, { items: [option({ roles: ['customer'] })] }, { items: [option(), option()] }, { items: [option({ persons: 21 })] },
    { items: [option({ situation: 'E' })] }, { role: 'customer' }, { has_more: true }, { items: [option({ secret: 1, has_notes: 'yes' })] }]) {
    const broken = harness(body => ({ scope: 'contact_options', role: body.p_role, limit: body.p_limit, scoped: false, has_more: false, items: [option()], data_mode: 'erp_native', ...bad }));
    assert.equal((await broken.handler(request('/v1/cadastros/contatos/opcoes?papel=fornecedor'), env)).status, 502, JSON.stringify(bad));
  }
});

test('summary and history by kind; the history without tipo keeps the sales RPC of migration 125', async () => {
  const person = { id: other, name: 'Pessoa fictícia', code: null, situation: 'A', visible: true, email: 'p@sintetico.test', phone: null, mobile: '(19) 90000-0000' };
  const summary = harness({ scope: 'contact_summary', id, name: 'Cliente fictício', code: null, situation: 'A', notes: 'Entregar pela manhã.\nPortaria 2', contact_info: null, persons: [person], data_mode: 'erp_native' });
  const ok = await summary.handler(request(`/v1/cadastros/contatos/${id}/resumo`), env);
  assert.equal(ok.status, 200); assert.deepEqual([rpc(summary.calls[1]), args(summary.calls[1])], ['erp_catalog_contact_summary', { p_id: id }]);
  assert.equal((await ok.json()).persons[0].mobile, '(19) 90000-0000');
  for (const bad of [{ id: other }, { persons: [{ ...person, visible: false }] }, { persons: [{ ...person, extra: 1 }] }, { notes: 'x'.repeat(4001) }]) {
    const broken = harness({ scope: 'contact_summary', id, name: 'Cliente fictício', code: null, situation: 'A', notes: null, contact_info: null, persons: [], data_mode: 'erp_native', ...bad });
    assert.equal((await broken.handler(request(`/v1/cadastros/contatos/${id}/resumo`), env)).status, 502, JSON.stringify(bad));
  }
  assert.equal((await summary.handler(request(`/v1/cadastros/contatos/${id}/resumo?x=1`), env)).status, 400);
  const item = { id: other, number: '12', date: '2026-10-15', status: 'open', total: '21.00' };
  const history = harness(body => ({ scope: 'contact_history', contact_id: body.p_contact_id, kind: body.p_kind, visible: true, items: [item], data_mode: 'erp_native' }));
  const purchases = await history.handler(request(`/v1/cadastros/contatos/${id}/historico?tipo=pedidos-compra`), env);
  assert.equal(purchases.status, 200); assert.deepEqual([rpc(history.calls[1]), args(history.calls[1])], ['erp_catalog_contact_history', { p_contact_id: id, p_kind: 'purchase_orders' }]);
  await history.handler(request(`/v1/cadastros/contatos/${id}/historico?tipo=pedidos-venda`), env);
  assert.deepEqual(args(history.calls.at(-1)), { p_contact_id: id, p_kind: 'sales_orders' });
  assert.equal((await history.handler(request(`/v1/cadastros/contatos/${id}/historico?tipo=ordens`), env)).status, 400);
  const legacy = harness({ scope: 'contact_sales', contact_id: id, visible: true, items: [], data_mode: 'erp_native' });
  assert.equal((await legacy.handler(request(`/v1/cadastros/contatos/${id}/historico`), env)).status, 200);
  assert.equal(rpc(legacy.calls[1]), 'erp_catalog_contact_sales');
  const hidden = harness(body => ({ scope: 'contact_history', contact_id: body.p_contact_id, kind: body.p_kind, visible: false, items: [item], data_mode: 'erp_native' }));
  assert.equal((await hidden.handler(request(`/v1/cadastros/contatos/${id}/historico?tipo=pedidos-compra`), env)).status, 502, 'a hidden history carries no rows');
});

test('labels: up to 100 distinct ids, the Contato models validated, the values in the order sent', async () => {
  const values = { nome: 'Cliente fictício', fantasia: null, documento: null, endereco: 'Rua Fictícia, 1', bairro: 'Centro', cidade_uf: 'Piracicaba/SP', cep: '13400-000', telefone: null };
  const template = { ...structuredClone(LABEL_DEFAULTS[0]), default: true, version: 0, updated_at: null };
  const custom = { ...structuredClone(LABEL_DEFAULTS[0]), id: 'd0000000-0000-4000-8000-000000000001', description: 'Envelope', default: false, version: 2, updated_at: stamp };
  const labels = harness(body => ({ scope: 'contact_labels', templates: [template, custom], items: body.p_ids.map(value => ({ id: value, values })), data_mode: 'erp_native' }));
  const ok = await labels.handler(request(`/v1/cadastros/contatos/etiquetas?ids=${other.toUpperCase()},${id}`), env);
  assert.equal(ok.status, 200);
  assert.deepEqual([rpc(labels.calls[1]), args(labels.calls[1])], ['erp_catalog_contact_labels', { p_ids: [other, id] }]);
  const body = await ok.json(); assert.deepEqual([body.templates.length, body.items.map(i => i.id)], [2, [other, id]]);
  for (const query of ['', 'ids=', `ids=${id},${id}`, 'ids=x', `ids=${Array.from({ length: 101 }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`])
    assert.equal((await labels.handler(request(`/v1/cadastros/contatos/etiquetas?${query}`), env)).status, 400, query);
  for (const bad of [{ templates: [] }, { templates: [custom] }, { templates: [{ ...template, type: 'produto' }] }, { templates: [template, { ...custom, config: { ...custom.config, fields: [] } }] },
    { items: [{ id, values }] }, { items: [{ id: other, values: { ...values, extra: 'x' } }, { id, values }] }, { items: [{ id, values }, { id: other, values }] }]) {
    const broken = harness(body => ({ scope: 'contact_labels', templates: [template], items: body.p_ids.map(value => ({ id: value, values })), data_mode: 'erp_native', ...bad }));
    assert.equal((await broken.handler(request(`/v1/cadastros/contatos/etiquetas?ids=${other},${id}`), env)).status, 502, JSON.stringify(bad).slice(0, 80));
  }
});

test('Aniversariantes over 366 days is refused before the database with its own code', async () => {
  const { handler, calls } = harness({});
  const response = await handler(request('/v1/cadastros/contatos/exportar?kind=birthdays&birth_from=2026-01-01&birth_to=2027-01-03'), env);
  assert.deepEqual([response.status, (await response.json()).error.code, calls.length], [400, 'ERP_CONTACT_PERIOD_TOO_LONG', 0]);
});

test('specific refusals reach the screen as allow-listed codes and fields; the SQL text never does', async () => {
  const cases = [
    ['22023', 'erp_catalog_contact_required:email', 400, 'ERP_CONTACT_REQUIRED_FIELD', 'email'], ['22023', 'erp_catalog_name_required', 400, 'ERP_CONTACT_REQUIRED_FIELD', 'name'],
    ['22023', 'erp_catalog_contact_invalid:website', 400, 'ERP_CONTACT_INVALID_FIELD', 'website'], ['23505', 'erp_catalog_duplicate_document', 409, 'ERP_CONTACT_DUPLICATE_DOCUMENT', undefined],
    ['42501', 'erp_catalog_contact_not_visible', 403, 'ERP_CONTACT_NOT_VISIBLE', undefined], ['22023', 'erp_catalog_contact_deleted', 400, 'ERP_CONTACT_DELETED', undefined],
    ['22023', 'erp_catalog_contact_required:segredo', 400, 'ERP_CONTACT_REQUIRED_FIELD', undefined], ['22023', 'erp_catalog_invalid_command', 400, 'ERP_INVALID_QUERY', undefined],
    ['40001', 'erp_catalog_version_conflict', 409, 'ERP_CONFLICT', undefined], ['42501', 'erp_catalog_duplicate_document', 403, 'ERP_FORBIDDEN', undefined],
  ];
  for (const [code, message, status, expected, field] of cases) {
    const { handler } = harness({ code, message, details: 'private SQL detail', hint: null }, 400);
    const response = await handler(request('/v1/cadastros/contatos', 'POST', { command_id: command, data: { name: 'a' } }), env);
    const body = await response.json();
    assert.deepEqual([response.status, body.error.code, body.error.field], [status, expected, field], message);
    assert.equal(JSON.stringify(body).includes('erp_catalog') || JSON.stringify(body).includes('private'), false);
  }
  // Only the contact routes translate messages: the legacy /contacts route keeps the generic code.
  const legacy = harness({ code: '23505', message: 'erp_catalog_duplicate_document' }, 400);
  const response = await legacy.handler(request('/v1/cadastros/contacts', 'POST', { command_id: command, data: { name: 'a' } }), env);
  assert.deepEqual([response.status, (await response.json()).error], [409, { code: 'ERP_CONFLICT', request_id: response.headers.get('X-Request-Id') }]);
  assert.deepEqual(contactRefusal('erp_catalog_payment_method_invalid:card_cnpj', 400), { status: 400, code: 'ERP_PAYMENT_METHOD_INVALID_FIELD', field: 'card_cnpj' });
  assert.deepEqual(contactRefusal('erp_catalog_employee_cpf_exists', 409), { status: 409, code: 'ERP_EMPLOYEE_CPF_EXISTS' });
  assert.equal(contactRefusal('x'.repeat(121), 400), null);
});
