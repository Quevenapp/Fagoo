import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createScheduled, ENTITIES } from '../src/index.mjs';
import { createAttachmentStorage } from '../src/attachment-storage.mjs';
import { createCnabStorage } from '../src/cnab.mjs';
import { runOriginTwoWay, originWriterFromEnv } from '../src/origin-two-way.mjs';

const user = 'a0000000-0000-4000-8000-000000000001';
const baseUrl = 'https://database.customer.example';
const env = { SUPABASE_URL: baseUrl, SUPABASE_DEPLOYMENT: 'self-hosted', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' };
const request = () => new Request('https://request-controlled.example/v1/me', { headers: { Authorization: 'Bearer synthetic-user' } });
const forbidden = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };

test('authenticated ERP API preserves actor derivation and RPC paths on self-hosted HTTPS', async () => {
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/auth/v1/user') ? { id: user } : { user_id: user, role: 'admin', resources: ENTITIES, data_mode: 'staging_readonly' });
  } });
  assert.equal((await handler(request(), env)).status, 200);
  assert.equal(calls[0].url, `${baseUrl}/auth/v1/user`);
  assert.equal(new URL(calls[1].url).origin, baseUrl);
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_user_id: user });
  assert.ok(calls.every(({ options }) => options.redirect === 'manual'));
});

test('session capabilities come only from explicit server flags, never RPC or request claims', async () => {
  const handler = createHandler({ fetchImpl: async url => Response.json(url.endsWith('/auth/v1/user')
    ? { id: user, user_metadata: { originIntegration: true } }
    : { user_id: user, role: 'admin', resources: ENTITIES, data_mode: 'staging_readonly', capabilities: { originIntegration: true } }) });
  for (const [flags, originIntegration, originHistory] of [[{}, false, false], [{ ORIGIN_ENABLED: 'true' }, false, true], [{ ORIGIN_TWO_WAY_ENABLED: 'true' }, false, false],
    [{ ORIGIN_ENABLED: 'false', ORIGIN_TWO_WAY_ENABLED: 'true' }, false, false],
    [{ ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true' }, true, true],
    [{ ORIGIN_HISTORY_ENABLED: 'true' }, false, true]]) {
    const response = await handler(request(), { ...env, ...flags });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).capabilities, { originIntegration, originHistory, originConnection: false });
  }
  const configured = await handler(request(), { ...env, ORIGIN_ENABLED: 'true', ORIGIN_CONNECTOR_ENABLED: 'true' });
  assert.deepEqual((await configured.json()).capabilities, { originIntegration: false, originHistory: true, originConnection: true });
});

test('synchronization status requires both runtime flags and SQL enablement; disabled requests never run', async () => {
  let databaseEnabled = true;
  const calls = [];
  const handler = createHandler({ fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: user });
    assert.ok(url.endsWith('/rpc/erp_sync_status'), url);
    return Response.json({ scope: 'origin_sync', enabled: databaseEnabled, actor_configured: false,
      push: { pending: 2, failed: 0, last_sent_at: null }, pull: { pending: 0, failed: 0, last_applied_at: null },
      issues: 0, recent_issues: [], run: null });
  } });
  const syncRequest = method => new Request('https://api.customer.example/v1/sincronizacao-origin',
    { method, headers: { Authorization: 'Bearer synthetic-user' } });
  for (const flags of [{}, { ORIGIN_ENABLED: 'true' }, { ORIGIN_TWO_WAY_ENABLED: 'true' },
    { ORIGIN_ENABLED: 'false', ORIGIN_TWO_WAY_ENABLED: 'true' }]) {
    const got = await handler(syncRequest('GET'), { ...env, ...flags });
    assert.equal(got.status, 200);
    const status = await got.json();
    assert.equal(status.enabled, false);
    assert.equal(status.push.pending, 2, 'historical queue counts remain truthful');
    const before = calls.length;
    assert.equal((await handler(syncRequest('POST'), { ...env, ...flags })).status, 503);
    assert.equal(calls.length, before);
  }
  const enabled = { ...env, ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true' };
  assert.equal((await (await handler(syncRequest('GET'), enabled)).json()).enabled, true);
  databaseEnabled = false;
  assert.equal((await (await handler(syncRequest('GET'), enabled)).json()).enabled, false);
});

test('backend self-hosting requires opt-in and rejects malformed origins before any network access', async () => {
  const handler = createHandler({ fetchImpl: forbidden });
  assert.equal((await handler(request(), { ...env, SUPABASE_DEPLOYMENT: undefined })).status, 503);
  for (const SUPABASE_URL of ['http://database.customer.example', 'https://u:p@database.customer.example', `${baseUrl}/path`, `${baseUrl}?destination=x`, `${baseUrl}#fragment`]) {
    assert.equal((await handler(request(), { ...env, SUPABASE_URL })).status, 503);
  }
  for (const make of [createAttachmentStorage, createCnabStorage]) {
    assert.throws(() => make({ baseUrl, key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl: forbidden }), /STORAGE_CONFIG/);
    assert.doesNotThrow(() => make({ baseUrl, supabaseDeployment: 'self-hosted', key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl: forbidden }));
  }
});

test('attachment transfer retains the configured host and blocks redirect attempts', async () => {
  const calls = [], objectKey = `company/logo/${user}/${'a'.repeat(64)}`;
  const storage = createAttachmentStorage({ baseUrl, supabaseDeployment: 'self-hosted', key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example/' } });
  } });
  await assert.rejects(storage.get(objectKey), /ERP_ATTACHMENT_STORAGE_UNAVAILABLE/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${baseUrl}/storage/v1/object/authenticated/erp-attachments/${objectKey}`);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('scheduled jobs and external synchronization are inert in a virgin installation', async () => {
  for (const env of [{}, { ERP_SCHEDULED_TASKS_ENABLED: 'false' }]) {
    assert.deepEqual(await createScheduled({ fetchImpl: forbidden, runTwoWay: forbidden })({ cron: '*/2 * * * *' }, env), { state: 'disabled' });
  }
  for (const env of [{}, { ORIGIN_TWO_WAY_ENABLED: 'true' }, { ORIGIN_ENABLED: 'true' }]) {
    assert.deepEqual(await runOriginTwoWay({ rpc: forbidden, env, writerFactory: forbidden }), { state: 'disabled' });
  }
  assert.equal(await originWriterFromEnv({}, { repoFactory: forbidden, fetchImpl: forbidden }), null);
});
