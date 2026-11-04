import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createScheduled } from '../src/index.mjs';

const env = { SUPABASE_URL: 'https://backend.example.test', SUPABASE_DEPLOYMENT: 'self-hosted',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test',
  ORIGIN_ENABLED: 'true', ORIGIN_CONNECTOR_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true', PUBLIC_BASE_URL: 'https://api.example.test',
  ORIGIN_CONNECTION_NAME: 'Fornecedor sintético', ORIGIN_CONNECTION_MODE: 'receive', ORIGIN_WRITE_ENABLED: 'false' };
const user = 'a0000000-0000-4000-8000-000000000001';
const status = { scope: 'origin_sync', enabled: true, actor_configured: true, push: { pending: 0, failed: 0, last_sent_at: null },
  pull: { pending: 0, failed: 0, last_applied_at: null }, issues: 0, recent_issues: [], run: null };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('setup is opt-in, contains no secrets, escapes the label and keeps OAuth admin routes protected', async () => {
  const handler = createHandler({ fetchImpl: async () => assert.fail('no backend call expected') });
  const setup = new Request('https://api.example.test/integracao-externa');
  assert.equal((await handler(setup, { ...env, ORIGIN_CONNECTOR_ENABLED: 'false' })).status, 404);
  const response = await handler(setup, { ...env, ORIGIN_CONNECTION_NAME: '<script>attack</script>', INTEGRATION_ADMIN_TOKEN: 'secret-not-for-page' });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('&lt;script&gt;attack&lt;/script&gt;'));
  assert.ok(!html.includes('secret-not-for-page'));
  assert.ok(html.includes('Somente recebimento'));
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  for (const path of ['/admin/status', '/admin/oauth/start']) {
    assert.equal((await handler(new Request('https://api.example.test'+path, { method: 'POST' }), env)).status, 401);
  }
  assert.equal((await handler(new Request('https://api.example.test/oauth/callback'), { ...env, PUBLIC_BASE_URL: 'https://api.example.test',
    ORIGIN_TOKEN_ENDPOINT: 'https://api.provider.example/oauth/token' })).status, 400);
});

test('receive-only reports mode but rejects manual outgoing runs before calling request RPC', async () => {
  const calls = [];
  const handler = createHandler({ fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/auth/v1/user')) return json({ id: user, app_metadata: {} });
    if (url.endsWith('/rpc/erp_sync_status')) return json(status);
    assert.fail('unexpected request: ' + url);
  } });
  const call = method => handler(new Request('https://api.example.test/v1/sincronizacao-origin', { method, headers: { Authorization: 'Bearer synthetic' } }), env);
  const got = await call('GET');
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).connection, { name: 'Fornecedor sintético', mode: 'receive', setup_url: 'https://api.example.test/integracao-externa' });
  const post = await call('POST');
  assert.equal(post.status, 409);
  assert.ok(!calls.some(url => url.endsWith('/rpc/erp_sync_request')));
});

test('scheduled collection precedes mirrors and two-way work, and paused mode runs nothing', async () => {
  const calls = [];
  const scheduled = createScheduled({ collectOrigin: async () => calls.push('collect'),
    fetchImpl: async url => { calls.push(new URL(url).pathname); return json({ state: 'ready', processed: 0 }); },
    runTwoWay: async () => { calls.push('two-way'); return { state: 'ready' }; } });
  await scheduled({ cron: '*/2 * * * *' }, { ...env, ERP_SCHEDULED_TASKS_ENABLED: 'true', SYNC_ENABLED: 'true' });
  assert.equal(calls[0], 'collect');
  assert.equal(calls.at(-1), 'two-way');
  calls.length = 0;
  assert.deepEqual(await scheduled({ cron: '*/2 * * * *' }, { ...env, ERP_SCHEDULED_TASKS_ENABLED: 'false' }), { state: 'disabled' });
  assert.deepEqual(calls, []);
});
