import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

const user = 'a0000000-0000-4000-8000-000000000001';
const id = 'b0000000-0000-4000-8000-000000000001';
const command = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const record = { id, entity: 'contacts', version: 1, active: true, name: 'Contato sintético', code: null, roles: ['customer'], created_at: '2026-10-16T03:00:00Z', updated_at: '2026-10-16T03:00:00Z', source: null };
const envelope = { entity: 'contacts', record, data_mode: 'erp_native' };
function harness(result = envelope, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/auth/v1/user') ? { id: user } : result), { status: url.endsWith('/auth/v1/user') ? 200 : status });
  } }) };
}
function request(path = '/v1/cadastros/contacts', method = 'GET', value) {
  return new Request(`https://api.example.test${path}`, { method, headers: { Authorization: 'Bearer synthetic-user-token', Origin: 'https://erp.example.test', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
}

test('catalog create uses verified actor, idempotency UUID and expected version zero without arbitrary fields', async () => {
  const { handler, calls } = harness({ ...envelope, audit: 'private', record: { ...record, raw_payload: 'private' } });
  const response = await handler(request(undefined, 'POST', { command_id: command, data: { name: 'Contato sintético', document: '12.ABC.345/01DE-35', roles: ['customer'] } }), env);
  assert.equal(response.status, 200);
  assert.equal(calls[1].url, `${env.SUPABASE_URL}/rest/v1/rpc/erp_catalog_save`);
  assert.deepEqual(JSON.parse(calls[1].body), { p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: command, p_data: { name: 'Contato sintético', document: '12.ABC.345/01DE-35', roles: ['customer'] }, p_user_id: user });
  assert.doesNotMatch(await response.text(), /private|raw_payload|audit/);
});

test('catalog permissions, cursor filters, detail, CAS patch and archive map to exact RPC contracts', async () => {
  const access = harness({ read: ['contacts'], write: ['contacts'], data_mode: 'erp_native', private: true });
  assert.deepEqual(await (await access.handler(request('/v1/cadastros'), env)).json(), { read: ['contacts'], write: ['contacts'], data_mode: 'erp_native' });
  const list = harness({ entity: 'contacts', items: [record], limit: 1, has_more: true, next_cursor: id, data_mode: 'erp_native' });
  assert.equal((await list.handler(request(`/v1/cadastros/contacts?limit=1&after=${id}&q=A%26B&active=false`), env)).status, 200);
  assert.deepEqual(JSON.parse(list.calls[1].body), { p_entity: 'contacts', p_limit: 1, p_after: id, p_query: 'A&B', p_active: false, p_user_id: user });
  for (const [path, method, body, rpc] of [
    [`/v1/cadastros/contacts/${id}`, 'GET', undefined, 'erp_catalog_get'],
    [`/v1/cadastros/contacts/${id}`, 'PATCH', { expected_version: 1, command_id: command, data: { name: 'Novo nome' } }, 'erp_catalog_save'],
    [`/v1/cadastros/contacts/${id}/active`, 'PATCH', { expected_version: 1, command_id: command, active: false }, 'erp_catalog_set_active'],
  ]) {
    const h = harness(); assert.equal((await h.handler(request(path, method, body), env)).status, 200);
    const args = JSON.parse(h.calls[1].body); assert.equal(args.p_id, id); assert.ok(h.calls[1].url.endsWith(rpc));
    if (method === 'PATCH') { assert.equal(args.p_expected_version, 1); assert.equal(args.p_command_id, command); }
  }
});

test('malformed, oversized and extra write input is rejected before an upstream mutation', async () => {
  const { handler, calls } = harness();
  for (const data of [{}, { name: '' }, { name: 'ok', active: false }, { name: 'ok', source: {} }, { name: 'ok', roles: ['admin'] }, { name: 'x'.repeat(201) }]) assert.equal((await handler(request(undefined, 'POST', { command_id: command, data }), env)).status, 400);
  assert.equal((await handler(request(undefined, 'POST', { command_id: command, p_user_id: user, data: { name: 'ok' } }), env)).status, 400);
  assert.equal((await handler(request(`/v1/cadastros/contacts/${id}`, 'PATCH', { command_id: command, data: { name: 'ok' } }), env)).status, 400);
  assert.equal((await handler(request('/v1/cadastros/products', 'POST', { command_id: command, data: { name: 'ok', price: 12.35 } }), env)).status, 400);
  assert.equal((await handler(request('/v1/cadastros/products', 'POST', { command_id: command, data: { name: 'ok', price: '-1' } }), env)).status, 400);
  assert.equal((await handler(request('/v1/cadastros/contacts?after=123'), env)).status, 400);
  const huge = new Request('https://api.example.test/v1/cadastros/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' }, body: JSON.stringify({ command_id: command, data: { name: 'x'.repeat(17000) } }) });
  assert.equal((await handler(huge, env)).status, 400);
  assert.equal(calls.length, 0);
});

test('write requests require authentication and SQL errors are sanitized with appropriate HTTP status', async () => {
  const noAuth = request(undefined, 'POST', { command_id: command, data: { name: 'ok' } }); noAuth.headers.delete('Authorization');
  const h = harness(); assert.equal((await h.handler(noAuth, env)).status, 401); assert.equal(h.calls.length, 0);
  for (const [code, status] of [['42501',403],['40001',409],['23505',409],['22023',400],['P0002',404]]) {
    const { handler } = harness({ code, message: 'private database detail', details: 'private data' }, 400);
    const result = await handler(request(undefined, 'POST', { command_id: command, data: { name: 'ok' } }), env);
    assert.equal(result.status, status, code); assert.doesNotMatch(await result.text(), /private|database/);
  }
});

test('PostgREST 16 serialization response remains a sanitized terminal ERP conflict', async () => {
  const { handler, calls } = harness({ code: '40001', message: 'erp_catalog_version_conflict',
    details: 'private database detail', hint: null }, 500);
  const response = await handler(request(`/v1/cadastros/contacts/${id}/active`, 'PATCH', {
    expected_version: 2, command_id: command, active: true,
  }), env);
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.match(body, /ERP_CONFLICT/);
  assert.doesNotMatch(body, /private|erp_catalog_version_conflict|40001/);
  assert.equal(calls.filter(call => call.url.endsWith('/rpc/erp_catalog_set_active')).length, 1);
});

test('CORS permits writes only on native catalog routes; staging remains read-only', async () => {
  const { handler, calls } = harness();
  const preflight = (path, method, origin = 'https://erp.example.test') => new Request(`https://api.example.test${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  assert.equal((await handler(preflight('/v1/cadastros/contacts', 'POST'), env)).status, 204);
  assert.equal((await handler(preflight(`/v1/cadastros/contacts/${id}`, 'PATCH'), env)).status, 204);
  assert.equal((await handler(preflight('/v1/records/contacts', 'POST'), env)).status, 403);
  assert.equal((await handler(preflight('/v1/cadastros/contacts', 'POST', 'https://evil.example.test'), env)).status, 403);
  assert.equal((await handler(request('/v1/records/contacts', 'POST', { command_id: command, data: { name: 'ok' } }), env)).status, 405);
  assert.equal(calls.length, 0);
});
