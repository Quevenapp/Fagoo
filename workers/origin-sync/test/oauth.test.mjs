import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationUrl, exchangeCode, refreshTokens } from '../src/oauth.mjs';

const credentials = { tokenEndpoint: 'https://api.provider.example/Api/v3/oauth/token', clientId: 'app-id', clientSecret: 'PRIVATE_SECRET' };
const redirectUri = 'https://erp.example.test/api/origin/callback';
const validTokens = { access_token: 'JWT_TOKEN', refresh_token: 'ROTATED_REFRESH', expires_in: 3600, token_type: 'Bearer' };

test('authorization URL fixes origin and safely encodes state', () => {
  const state = 'random&redirect_uri=https://attacker.invalid/';
  const url = new URL(authorizationUrl({ authorizationEndpoint: 'https://oauth.provider.example/Api/v3/oauth/authorize', clientId: credentials.clientId, redirectUri, state }));
  assert.equal(url.origin, 'https://oauth.provider.example');
  assert.equal(url.pathname, '/Api/v3/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), credentials.clientId);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.throws(() => authorizationUrl({ authorizationEndpoint: 'https://oauth.provider.example/Api/v3/oauth/authorize', clientId: 'app', redirectUri: 'http://invalid.example/', state: 'state' }), /^Error: ORIGIN_OAUTH_INVALID_REDIRECT$/);
  assert.throws(() => authorizationUrl({ authorizationEndpoint: 'https://oauth.provider.example/Api/v3/oauth/authorize', clientId: 'app', redirectUri, state: '' }), /^Error: ORIGIN_OAUTH_INVALID_CONFIG$/);
});

test('code exchange uses Basic authentication, JWT header and fixed token endpoint', async () => {
  const code = 'PRIVATE_CODE&extra=value';
  let request;
  const result = await exchangeCode({ ...credentials, code, redirectUri, fetchImpl: async (url, options) => {
    request = { url, options };
    return Response.json({ ...validTokens, scope: 'not-returned' });
  } });
  assert.equal(request.url, 'https://api.provider.example/Api/v3/oauth/token');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'manual');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.options.headers['enable-jwt'], '1');
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('app-id:PRIVATE_SECRET').toString('base64')}`);
  const body = new URLSearchParams(request.options.body);
  assert.deepEqual([...body], [['grant_type', 'authorization_code'], ['code', code]]);
  assert.deepEqual(result, validTokens);
});

test('refresh preserves rotated token pair and dynamic expiry', async () => {
  let request;
  const result = await refreshTokens({ ...credentials, refreshToken: 'OLD_PRIVATE_REFRESH', fetchImpl: async (url, options) => {
    request = options;
    return Response.json({ ...validTokens, expires_in: 1800, token_type: 'bearer' });
  } });
  assert.equal(request.headers['enable-jwt'], '1');
  assert.deepEqual([...new URLSearchParams(request.body)], [['grant_type', 'refresh_token'], ['refresh_token', 'OLD_PRIVATE_REFRESH']]);
  assert.equal(result.refresh_token, 'ROTATED_REFRESH');
  assert.equal(result.expires_in, 1800);
  assert.equal(result.token_type, 'Bearer');
});

test('token redirects are rejected without reading a body or following Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let attempts = 0;
    await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'private', fetchImpl: async (url, options) => {
      attempts++;
      assert.equal(url, 'https://api.provider.example/Api/v3/oauth/token');
      assert.equal(options.redirect, 'manual');
      const response = new Response('private', { status, headers: { location: 'https://evil.test/steal' } });
      response.json = () => { assert.fail('redirect body must not be read'); };
      return response;
    } }), /^Error: ORIGIN_OAUTH_REDIRECT_BLOCKED$/);
    assert.equal(attempts, 1);
  }
});

test('upstream failure bodies and network exceptions never leak credentials', async () => {
  await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'private', fetchImpl: async () =>
    new Response('PRIVATE_SECRET PRIVATE_TOKEN', { status: 401 }) }), /^Error: ORIGIN_OAUTH_HTTP_401$/);
  await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'private', fetchImpl: async () => {
    throw new Error('PRIVATE_SECRET PRIVATE_TOKEN');
  } }), /^Error: ORIGIN_OAUTH_REQUEST_FAILED$/);
  await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'private', fetchImpl: async () =>
    new Response('PRIVATE_NOT_JSON') }), /^Error: ORIGIN_OAUTH_INVALID_RESPONSE$/);
});

test('OAuth failures expose only allowlisted codes from nested and standard envelopes', async () => {
  const codes = ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope'];
  for (const code of codes) {
    for (const error of [code, { type: code, message: 'PRIVATE_SECRET', description: 'PRIVATE_TOKEN' }]) {
      await assert.rejects(exchangeCode({ ...credentials, code: 'PRIVATE_CODE', redirectUri, fetchImpl: async () =>
        Response.json({ error, error_description: 'PRIVATE_SECRET PRIVATE_CODE', access_token: 'PRIVATE_TOKEN' }, { status: 400 }) }), failure => {
        assert.equal(failure.message, `ORIGIN_OAUTH_HTTP_400_${code.toUpperCase()}`);
        assert.doesNotMatch(String(failure) + JSON.stringify(failure), /PRIVATE_SECRET|PRIVATE_TOKEN|PRIVATE_CODE/);
        return true;
      });
    }
  }
});

test('unknown, malformed and descriptive OAuth failures retain the generic HTTP code', async () => {
  const bodies = [
    'PRIVATE_NOT_JSON',
    JSON.stringify({ error: 'invalid_client PRIVATE_SECRET' }),
    JSON.stringify({ error: { type: 'VALIDATION_ERROR', message: 'invalid_grant', description: 'PRIVATE_CODE' } }),
    JSON.stringify({ error: { type: { code: 'invalid_client' }, description: 'PRIVATE_SECRET' } }),
    JSON.stringify({ error_description: 'invalid_client PRIVATE_TOKEN' }),
    JSON.stringify({ error: null }),
  ];
  for (const body of bodies) {
    await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'PRIVATE_REFRESH', fetchImpl: async () =>
      new Response(body, { status: 400 }) }), /^Error: ORIGIN_OAUTH_HTTP_400$/);
  }
});

test('invalid token responses are rejected without hardcoding token duration', async () => {
  for (const changes of [{ access_token: '' }, { refresh_token: undefined }, { expires_in: '3600' }, { expires_in: 0 }, { expires_in: 1.5 }, { token_type: 'Basic' }]) {
    await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'private', fetchImpl: async () =>
      Response.json({ ...validTokens, ...changes }) }), /^Error: ORIGIN_OAUTH_INVALID_RESPONSE$/);
  }
});

test('token requests abort on timeout with a fixed error', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => {
    queueMicrotask(callback);
    return 0;
  });
  await assert.rejects(refreshTokens({ ...credentials, refreshToken: 'private', fetchImpl: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT_DETAIL')), { once: true }))
  }), /^Error: ORIGIN_OAUTH_TIMEOUT$/);
});
