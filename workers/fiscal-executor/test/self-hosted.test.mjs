import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createContainerBridge } from '../src/bridge.mjs';
import { digest, signRuntimeRequest } from '../../../packages/fiscal-runtime/src/auth.mjs';

test('executor forwards the installation backend mode inside the authenticated fixed container boundary', async () => {
  const secret = randomBytes(32), path = '/internal/v1/a1';
  const env = { SUPABASE_URL: 'https://database.customer.example', SUPABASE_DEPLOYMENT: 'self-hosted', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', A1_TRANSPORT_SECRET: secret.toString('base64'), A1_TRANSPORT_KEY_ID: 'synthetic-transport', A1_AUDIENCE: 'synthetic-runtime', A1_FINGERPRINT_SECRET: randomBytes(32).toString('base64'), A1_KEK_RING_JSON: JSON.stringify({ synthetic: randomBytes(32).toString('base64') }), A1_CURRENT_KEK_ID: 'synthetic', UNRELATED_SECRET: 'not-forwarded' };
  let startup;
  const container = { running: false, images: { base: 'synthetic-image' }, start(args) { startup = args; this.running = true; }, async setInactivityTimeout() {}, getTcpPort() { return { fetch: async request => typeof request === 'string' ? new Response(null, { status: 401, headers: { 'X-Content-Type-Options': 'nosniff' } }) : Response.json({ synthetic: true }) }; } };
  const bridge = createContainerBridge({ container }, env);
  const authorization = await signRuntimeRequest({ secretBytes: secret, keyId: env.A1_TRANSPORT_KEY_ID, audience: env.A1_AUDIENCE, actor: randomUUID(), nonce: randomUUID(), method: 'GET', path, bodyHash: await digest(new Uint8Array()) });
  assert.equal((await bridge(new Request(`https://fiscal-runtime.internal${path}`, { headers: { Authorization: authorization } }))).status, 200);
  assert.equal(startup.env.SUPABASE_DEPLOYMENT, 'self-hosted');
  assert.equal(startup.env.SUPABASE_URL, env.SUPABASE_URL);
  assert.equal(startup.env.UNRELATED_SECRET, undefined);
});
