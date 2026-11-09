import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, ENTITIES } from '../src/index.mjs';

const USER = 'a0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const request = (path = '/v1/me', extra = {}) => new Request(`https://api.example.test${path}`, { headers: { Authorization: 'Bearer synthetic-user-jwt' }, ...extra });
const member = { user_id: USER, role: 'admin', resources: ENTITIES, data_mode: 'staging_readonly' };
function handlerFor(rpc = member, { user = { id: USER }, authStatus = 200, rpcStatus = 200 } = {}) {
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return url.endsWith('/auth/v1/user') ? json(user, authStatus) : json(rpc, rpcStatus);
  } });
  return { handler, calls };
}

test('missing, malformed and rejected bearer tokens return 401 without trusting claims', async () => {
  for (const authorization of ['', 'Basic fake', 'Bearer a b']) {
    const { handler, calls } = handlerFor();
    assert.equal((await handler(request('/v1/me', { headers: { Authorization: authorization } }), env)).status, 401);
    assert.equal(calls.length, 0);
  }
  const { handler, calls } = handlerFor(member, { authStatus: 401, user: { message: 'sensitive-upstream-error' } });
  const response = await handler(request(), env);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(await response.text(), /sensitive|synthetic-user/);
});

test('verified UUID goes to service RPC; user metadata, email and arbitrary response fields are not returned', async () => {
  const { handler, calls } = handlerFor({ ...member, raw_payload: { secret: 'secret-value' }, email: 'private@example.test' }, {
    user: { id: USER, email: 'private@example.test', user_metadata: { role: 'admin' } },
  });
  const response = await handler(request('/v1/me', { headers: { Authorization: 'Bearer synthetic-user-jwt', Origin: 'https://erp.example.test' } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...member, capabilities: { originIntegration: false, originConnection: false, originHistory: false } });
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-user-jwt');
  assert.equal(calls[1].headers.Authorization, 'Bearer synthetic-service-key');
  assert.deepEqual(JSON.parse(calls[1].body), { p_user_id: USER });
  assert.ok(calls.every(call => call.redirect === 'manual'));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://erp.example.test');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('valid Auth user without active membership receives 403, not automatic signup authorization', async () => {
  const { handler, calls } = handlerFor({ code: '42501', message: 'membership-details-must-not-leak' }, { rpcStatus: 403 });
  const response = await handler(request(), env);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(await response.text(), /membership-details|42501/);
  const anonymous = handlerFor(member, { user: { id: USER, is_anonymous: true } });
  assert.equal((await anonymous.handler(request(), env)).status, 403);
  assert.equal(anonymous.calls.length, 1);
});

test('origins default to none and CORS only allows explicitly configured origins and GET preflights', async () => {
  const { handler, calls } = handlerFor();
  const withOrigin = request('/v1/me', { headers: { Origin: 'https://erp.example.test', Authorization: 'Bearer synthetic-user-jwt' } });
  assert.equal((await handler(withOrigin, { ...env, ALLOWED_ORIGINS: '' })).status, 403);
  assert.equal((await handler(request('/v1/me', { headers: { Origin: 'https://erp.example.test.attacker.test' } }), env)).status, 403);
  assert.equal(calls.length, 0);
  const preflight = method => request('/v1/me', { method: 'OPTIONS', headers: { Origin: 'https://erp.example.test', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Authorization' } });
  assert.equal((await handler(preflight('GET'), env)).status, 204);
  assert.equal((await handler(preflight('POST'), env)).status, 403);
  assert.equal(calls.length, 0);
});

test('list pagination and allowlisted filters are sent as parameters; IDs remain strings and raw values are excluded', async () => {
  const id = '90071992547409931234';
  const result = { entity: 'nfe', items: [{ id, entity: 'nfe', number: '123', amount: '200.10', model: '55', raw_payload: { secret: 'do-not-return' }, xml: 'https://private.example.test/signed' }],
    limit: 1, offset: 5, total: 8, has_more: true, next_offset: 6, data_mode: 'staging_readonly' };
  const { handler, calls } = handlerFor(result);
  const response = await handler(request('/v1/records/nfe?limit=1&offset=5&q=Cliente&status=6&from=2026-01-01&to=2026-10-16'), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].id, id);
  assert.equal(body.items[0].amount, '200.10');
  assert.equal(body.items[0].xml, undefined);
  assert.equal(body.items[0].raw_payload, undefined);
  assert.equal(body.next_offset, 6);
  assert.deepEqual(JSON.parse(calls[1].body), { p_user_id: USER, p_entity: 'nfe', p_limit: 1, p_offset: 5,
    p_query: 'Cliente', p_status: '6', p_from: '2026-01-01', p_to: '2026-10-16' });
});

test('unknown resources, write methods, duplicate parameters and invalid ranges fail before upstream access', async () => {
  const { handler, calls } = handlerFor();
  for (const suffix of ['limit=101', 'limit=0', 'limit=1e2', 'offset=-1', 'offset=100001', 'limit=1&limit=2', 'fields=payload', 'p_user_id=attacker', 'from=2026-02-30', 'from=2026-10-16&to=2026-01-01', 'q=%0Ainjected']) {
    assert.equal((await handler(request(`/v1/records/contacts?${suffix}`), env)).status, 400, suffix);
  }
  assert.equal((await handler(request('/v1/records/credentials'), env)).status, 404);
  assert.equal((await handler(request('/v1/me', { method: 'POST' }), env)).status, 405);
  assert.equal(calls.length, 0);
});

test('forbidden resource remains 403 even for valid authentication', async () => {
  const { handler } = handlerFor({ message: 'forbidden db details' }, { rpcStatus: 403 });
  const response = await handler(request('/v1/records/payables'), env);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /db details/);
});

test('invalid or redirected upstream response fails closed without leaking token, metadata or body', async () => {
  const redirect = createHandler({ fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.test/' } }) });
  assert.equal((await redirect(request(), env)).status, 502);
  const invalid = handlerFor({ entity: 'nfe', items: [{ id: 9007199254740992, entity: 'nfe' }], limit: 25, offset: 0, total: 1, has_more: false, next_offset: null, data_mode: 'staging_readonly' });
  assert.equal((await invalid.handler(request('/v1/records/nfe'), env)).status, 502);
  const unavailable = createHandler({ fetchImpl: async () => { throw new Error('Bearer sensitive-token'); } });
  const response = await unavailable(request(), env);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive-token|Bearer/);
});
