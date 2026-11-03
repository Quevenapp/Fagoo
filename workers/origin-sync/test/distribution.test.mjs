import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginClient } from '../src/client.mjs';
import { authorizationUrl, refreshTokens } from '../src/oauth.mjs';
import { accessToken } from '../src/tokens.mjs';
import { runSync } from '../src/sync.mjs';
import worker, { handleRequest } from '../src/index.mjs';
import { Repository } from '../src/repository.mjs';

const apiOrigin = 'https://api.provider.example';
const tokenEndpoint = `${apiOrigin}/oauth/token`;
const forbidden = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };

test('new installations perform no collector work even when an old schedule fires', async () => {
  for (const env of [{}, { SYNC_ENABLED: 'true' }, { ORIGIN_ENABLED: 'false', SYNC_ENABLED: 'true' }]) {
    assert.deepEqual(await runSync({ claim: forbidden }, env, { getToken: forbidden }), { status: 'disabled' });
    await worker.scheduled({}, env);
    await assert.rejects(accessToken({ credentials: forbidden }, env), /ORIGIN_DISABLED/);
  }
  await assert.rejects(runSync({ claim: forbidden }, { ORIGIN_ENABLED: 'true', SYNC_ENABLED: 'true' }), /ORIGIN_ENDPOINT_NOT_CONFIGURED/);
});

test('disabled OAuth callback cannot consume state or send credentials', async () => {
  const response = await handleRequest(new Request('https://sync.example.test/oauth/callback?code=synthetic'), {}, { repoFactory: forbidden, exchange: forbidden });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'ORIGIN_DISABLED' });
});

test('upstream endpoints require explicit HTTPS configuration and never come from a request', async () => {
  for (const apiOrigin of [undefined, '', 'http://api.provider.example', 'https://u:p@api.provider.example', 'https://api.provider.example/path', 'https://api.provider.example?target=x', 'https://api.provider.example#x']) {
    assert.throws(() => new OriginClient('synthetic', { apiOrigin, fetchImpl: forbidden }), /ORIGIN_INVALID_CLIENT_CONFIG/);
  }
  for (const invalid of [undefined, 'http://api.provider.example/token', 'https://u:p@api.provider.example/token', `${tokenEndpoint}?`, `${tokenEndpoint}#`]) {
    await assert.rejects(refreshTokens({ clientId: 'synthetic', clientSecret: 'synthetic', refreshToken: 'synthetic', tokenEndpoint: invalid, fetchImpl: forbidden }), /ORIGIN_ENDPOINT_NOT_CONFIGURED/);
    assert.throws(() => authorizationUrl({ clientId: 'synthetic', redirectUri: 'https://sync.example.test/callback', state: 'synthetic', authorizationEndpoint: invalid }), /ORIGIN_ENDPOINT_NOT_CONFIGURED/);
  }
  const calls = [];
  const client = new OriginClient('synthetic', { apiOrigin, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ data: [] }); } });
  await client.get('/produtos', { pesquisa: 'https://untrusted.example/' });
  assert.equal(new URL(calls[0].url).origin, apiOrigin);
  assert.equal(calls[0].options.redirect, 'manual');
  await assert.rejects(client.get('https://untrusted.example/produtos'), /ORIGIN_INVALID_PATH/);
  assert.equal(calls.length, 1);
});

test('collector database uses only an opted-in installation origin and fixed RPC paths', async () => {
  const env = { SUPABASE_URL: 'https://database.customer.example', SUPABASE_DEPLOYMENT: 'self-hosted', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' };
  assert.throws(() => new Repository({ ...env, SUPABASE_DEPLOYMENT: undefined }), /INVALID_SUPABASE_URL/);
  const calls = [];
  const repo = new Repository(env, { fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ ready: true }); } });
  assert.deepEqual(await repo.rpc('origin_sync_status'), { ready: true });
  assert.equal(calls[0].url, `${env.SUPABASE_URL}/rest/v1/rpc/origin_sync_status`);
  assert.equal(calls[0].options.redirect, 'manual');
  const redirected = new Repository(env, { fetchImpl: async () => new Response(null, { status: 307, headers: { Location: 'https://untrusted.example/' } }) });
  await assert.rejects(redirected.rpc('origin_sync_status'), /DATABASE_REDIRECT_BLOCKED/);
});
