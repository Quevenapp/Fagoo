import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/index.mjs';
import { createUnsignedGateway } from '../src/unsigned.mjs';
const base = 'https://database.customer.example';
const env = { SUPABASE_URL: base, SUPABASE_DEPLOYMENT: 'self-hosted', SUPABASE_ANON_KEY: 'synthetic-public-key-123456', ALLOWED_ORIGINS: 'https://erp.customer.example', A1_RUNTIME: { fetch() { throw new Error('UNEXPECTED_RUNTIME_CALL'); } } };
for (const [name, factory, path, method] of [['A1', createGateway, '/v1/a1', 'GET'], ['unsigned', createUnsignedGateway, '/v1/fiscal-unsigned/preview', 'POST']]) {
  test(`${name} gateway pins self-hosted auth to configured origin and fails closed without opt-in`, async () => {
    const calls = [];
    const gateway = factory({ now: Date.now, nonce: () => crypto.randomUUID(), fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ error: 'synthetic' }, { status: 401 }); } });
    const request = () => new Request(`https://request-controlled.example${path}`, { method, headers: { Origin: env.ALLOWED_ORIGINS, Authorization: 'Bearer synthetic-user-session-1234567890' } });
    assert.equal((await gateway(request(), env)).status, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${base}/auth/v1/user`);
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal((await gateway(request(), { ...env, SUPABASE_DEPLOYMENT: undefined })).status, 503);
    for (const SUPABASE_URL of [`${base}/path`, `${base}?url=https://untrusted.example`, 'http://database.customer.example', 'https://u:p@database.customer.example']) {
      assert.equal((await gateway(request(), { ...env, SUPABASE_URL })).status, 503);
    }
    assert.equal(calls.length, 1);
  });
}
