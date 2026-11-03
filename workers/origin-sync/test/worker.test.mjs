import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { handleRequest } from '../src/index.mjs';
import { randomToken, sha256 } from '../src/crypto.mjs';

const env = { ORIGIN_ENABLED: 'true', ORIGIN_TOKEN_ENDPOINT: 'https://api.provider.example/Api/v3/oauth/token', ORIGIN_AUTHORIZATION_ENDPOINT: 'https://oauth.provider.example/Api/v3/oauth/authorize', INTEGRATION_ADMIN_TOKEN: 'test-administrator-secret-at-least-32-characters', PUBLIC_BASE_URL: 'https://sync.example.com', ORIGIN_CLIENT_ID: 'client', ORIGIN_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), SYNC_ENABLED: 'false' };
const admin = path => new Request(`https://sync.example.com${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.INTEGRATION_ADMIN_TOKEN}` } });

test('admin endpoints deny unauthenticated access before creating a repository', async () => {
  const response = await handleRequest(new Request('https://sync.example.com/admin/status', { method: 'POST' }), env, { repoFactory: () => { throw new Error('should not execute'); } });
  assert.equal(response.status, 401);
});

test('admin status reports extra collection as disabled by default without querying or claiming coverage', async () => {
  for (const flag of [undefined, 'false', 'true']) {
    const calls=[];
    const response=await handleRequest(admin('/admin/status'), {...env, EXTRA_RESOURCES_ENABLED:flag}, {repoFactory:()=>({rpc:async name=>{calls.push(name);return {entities:[]};}})});
    const body=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(calls,['origin_sync_status']);
    assert.deepEqual(body.extra_resources,{enabled:flag==='true',coverage_complete:false});
  }
});

test('OAuth start persists only hashes and binds state to a protected browser cookie', async () => {
  const writes = [];
  const response = await handleRequest(admin('/admin/oauth/start'), env, { repoFactory: () => ({ rpc: async (...args) => { writes.push(args); return {}; } }) });
  assert.equal(response.status, 200);
  const { url } = await response.json();
  const state = new URL(url).searchParams.get('state');
  assert.equal(writes[0][1].p_state_hash, await sha256(state));
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!JSON.stringify(writes).includes(state));
});

test('callback rejects missing browser binding and replay before token exchange', async () => {
  const state = randomToken(); const browser = randomToken(); let exchanged = false;
  const deps = { repoFactory: () => ({ rpc: async () => false }), exchange: async () => { exchanged = true; } };
  const url = `https://sync.example.com/oauth/callback?state=${state}&code=secret-code`;
  assert.equal((await handleRequest(new Request(url), env, deps)).status, 400);
  const replay = await handleRequest(new Request(url, { headers: { Cookie: `__Host-brufap_oauth=${browser}` } }), env, deps);
  assert.equal(replay.status, 400); assert.equal(exchanged, false);
});

test('successful callback stores encrypted token pair with lease and clears cookie', async () => {
  const state = randomToken(); const browser = randomToken(); const writes = [];
  const repo = {
    async rpc(name, args) { writes.push([name, args]); return name.endsWith('consume_oauth_state') ? true : {}; },
    async claim() { return { acquired: true, lease_token: 'fence' }; },
    async credentials() { return { revision: 0 }; }, async release() {},
  };
  const response = await handleRequest(new Request(`https://sync.example.com/oauth/callback?state=${state}&code=one-time-code`, { headers: { Cookie: `__Host-brufap_oauth=${browser}` } }), env, {
    repoFactory: () => repo,
    exchange: async () => ({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer' }),
  });
  assert.equal(response.status, 200);
  assert.ok(!JSON.stringify(writes).includes('private-access'));
  assert.ok(!JSON.stringify(writes).includes('private-refresh'));
  assert.equal(writes[1][1].p_ciphertext.version, 1);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('public page uses restrictive CSP and never embeds admin token', async () => {
  const response = await handleRequest(new Request('https://sync.example.com/'), env);
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.ok(!(await response.text()).includes(env.INTEGRATION_ADMIN_TOKEN));
});

test('setup page rejects browser opaque redirects before using their body', async () => {
  const response = await handleRequest(new Request('https://sync.example.com/'), env);
  const script = (await response.text()).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = { result: {}, key: { value: 'private' }, status: {}, connect: {} };
  let attempts = 0;
  runInNewContext(script, {
    document: { getElementById: id => elements[id] },
    fetch: async (path, options) => {
      attempts++;
      assert.equal(path, '/admin/status');
      assert.equal(options.redirect, 'manual');
      return { type: 'opaqueredirect', status: 0, json: () => { assert.fail('redirect body must not be read'); } };
    },
  });
  await elements.status.onclick();
  assert.equal(attempts, 1);
  assert.equal(elements.result.textContent, 'Redirecionamento inesperado na integração');
});
