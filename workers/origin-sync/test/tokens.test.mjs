import test from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, saveTokens } from '../src/tokens.mjs';
import { encryptTokens, decryptTokens } from '../src/crypto.mjs';
import { Repository } from '../src/repository.mjs';

const env = { ORIGIN_ENABLED: 'true', ORIGIN_TOKEN_ENDPOINT: 'https://api.provider.example/Api/v3/oauth/token', ORIGIN_AUTHORIZATION_ENDPOINT: 'https://oauth.provider.example/Api/v3/oauth/authorize', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'), ORIGIN_CLIENT_ID: 'client', ORIGIN_CLIENT_SECRET: 'secret' };
const tokens = { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer' };

test('a lost credential-save response is recovered from the exact encrypted envelope', async () => {
  let current;
  const repo = { async rpc(_name, params) { current = { ciphertext: params.p_ciphertext, expires_at: params.p_expires_at, revision: 1 }; throw new Error('DATABASE_UNCERTAIN_RESULT'); }, async credentials() { return current; } };
  const saved = await saveTokens(repo, env, tokens, 'owner', { lease_token: 'fence' }, 0);
  assert.equal(saved.recovered, true);
  assert.deepEqual(await decryptTokens(current.ciphertext, env.TOKEN_ENCRYPTION_KEY), tokens);
});

test('refresh is serialized and rechecks credentials after claiming the lease', async () => {
  const encrypted = await encryptTokens(tokens, env.TOKEN_ENCRYPTION_KEY);
  let reads = 0; let refreshes = 0; let releases = 0;
  const now = Date.now();
  const repo = {
    async credentials() { reads++; return { ciphertext: encrypted, revision: 1, expires_at: new Date(reads === 1 ? now - 1 : now + 3600000).toISOString() }; },
    async claim() { return { acquired: true, lease_token: 'fence' }; }, async release() { releases++; },
  };
  const value = await accessToken(repo, env, { now: () => now, refresh: async () => { refreshes++; return tokens; } });
  assert.equal(value, tokens.access_token); assert.equal(refreshes, 0); assert.equal(releases, 1);
});

test('single-use OAuth operations are never blindly retried after an ambiguous response', async () => {
  let attempts = 0;
  const repo = new Repository({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, {
    fetchImpl: async () => { attempts++; throw new Error('response lost after commit'); }, sleep: async () => {},
  });
  await assert.rejects(repo.rpc('origin_sync_consume_oauth_state', {}), /DATABASE_UNCERTAIN_RESULT/);
  assert.equal(attempts, 1);
});
