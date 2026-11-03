import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeConfigure, parseConfigure, CONFIGURE_TYPE } from '../src/protocol.mjs';
import { digest, verifyRuntimeRequest } from '../src/auth.mjs';
import { FLAGS } from '../src/dto.mjs';

// Optional runtime regression: Miniflare/esbuild are Wrangler dependencies, not
// production dependencies. No network, Auth service, certificate or key is real.
const enabled = process.env.BRUFAP_RUN_WORKERD_TESTS === '1';
let Miniflare, convertV4MiniflareOptions, bundled;
if (enabled) {
  ({ Miniflare, convertV4MiniflareOptions } = await import('miniflare'));
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../../workers/fiscal-gateway/src/index.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  bundled = result.outputFiles[0].text;
}
const options = { skip: !enabled, timeout: 30000 };
const current = { version: 0, state: 'unconfigured', credential_id: null, company_identity_version: null, metadata: null, company_changed: false, time_valid_now: false };

async function fixture({ redirectAuth = false, redirectRuntime = false, anonymous = false } = {}) {
  const actor = randomUUID(), transportSecret = randomBytes(32), calls = { auth: 0, runtime: 0, configure: 0 };
  const runtime = async request => {
    calls.runtime++;
    assert.equal(request.headers.get('apikey'), null);
    assert.equal(request.headers.get('origin'), null);
    assert.match(request.headers.get('authorization'), /^Brufap-A1 /);
    const body = new Uint8Array(await request.arrayBuffer());
    try {
      const path = new URL(request.url).pathname;
      const claims = await verifyRuntimeRequest({ header: request.headers.get('authorization'), secretBytes: transportSecret, keyId: 'synthetic-transport', audience: 'synthetic-workerd', method: request.method, path });
      assert.equal(claims.actor, actor);
      assert.equal(claims.body_hash, await digest(body));
      if (redirectRuntime) return new Response(null, { status: 302, headers: { Location: 'https://never-follow.invalid/' } });
      if (request.method === 'POST') {
        assert.equal(path, '/internal/v1/a1/configure');
        assert.equal(request.headers.get('content-type'), CONFIGURE_TYPE);
        const parsed = parseConfigure(body);
        assert.deepEqual(parsed.pfxBytes, new TextEncoder().encode('SYNTHETIC-NOT-A-PFX'));
        assert.deepEqual(parsed.passwordBytes, new TextEncoder().encode('synthetic-only-password'));
        calls.configure++;
        return Response.json({ ...FLAGS, current, state: 'pending', receipt: null, error_code: null, replayed: false });
      }
      assert.equal(path, '/internal/v1/a1');
      assert.equal(body.length, 0);
      return Response.json({ ...FLAGS, current });
    } finally { body.fill(0); }
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled, compatibilityDate: '2026-10-16', cf: false,
    bindings: { ALLOWED_ORIGINS: 'https://app.synthetic.invalid', SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_ANON_KEY: 'synthetic-public-key-only', A1_TRANSPORT_SECRET: transportSecret.toString('base64'), A1_TRANSPORT_KEY_ID: 'synthetic-transport', A1_AUDIENCE: 'synthetic-workerd' },
    serviceBindings: { A1_RUNTIME: runtime },
    // Every external fetch is intercepted here, including a wrongly followed
    // redirect. Unexpected destinations fail the test instead of reaching DNS.
    outboundService: request => {
      calls.auth++;
      assert.equal(request.url, 'https://synthetic.supabase.co/auth/v1/user');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic-session-token-1234567890');
      if (redirectAuth) return new Response(null, { status: 302, headers: { Location: 'https://never-follow.invalid/' } });
      return Response.json({ id: actor, is_anonymous: anonymous });
    },
  }));
  return {
    calls,
    request: (path = '', body) => mf.dispatchFetch(`https://gateway.synthetic.invalid/v1/a1${path}`, {
      method: body ? 'POST' : 'GET', headers: { Origin: 'https://app.synthetic.invalid', Authorization: 'Bearer synthetic-session-token-1234567890', ...(body ? { 'Content-Type': CONFIGURE_TYPE } : {}) }, ...(body ? { body } : {}),
    }),
    async dispose() { await mf.dispose(); transportSecret.fill(0); },
  };
}

test('workerd bundled gateway authenticates and signs metadata and binary configure without unsupported redirect modes', options, async () => {
  const f = await fixture();
  const body = encodeConfigure({ command_id: randomUUID(), expected_version: 0, expected_identity_version: 1, reason: 'Synthetic workerd regression', pfxBytes: new TextEncoder().encode('SYNTHETIC-NOT-A-PFX'), passwordBytes: new TextEncoder().encode('synthetic-only-password') });
  try {
    const metadata = await f.request(); assert.equal(metadata.status, 200); assert.deepEqual(await metadata.json(), { ...FLAGS, current });
    const configure = await f.request('/configure', body); assert.equal(configure.status, 200); assert.equal((await configure.json()).state, 'pending');
    assert.deepEqual(f.calls, { auth: 2, runtime: 2, configure: 1 });
  } finally { body.fill(0); await f.dispose(); }
});
test('workerd refuses Auth redirects before reading or forwarding the credential body', options, async () => {
  const f = await fixture({ redirectAuth: true });
  try { const response = await f.request('/configure', new Uint8Array([1, 2, 3])); assert.equal(response.status, 401); assert.equal((await response.json()).error, 'A1_UNAUTHENTICATED'); assert.deepEqual(f.calls, { auth: 1, runtime: 0, configure: 0 }); }
  finally { await f.dispose(); }
});
test('workerd rejects a redirect returned by the runtime binding without following it', options, async () => {
  const f = await fixture({ redirectRuntime: true });
  try { const response = await f.request(); assert.equal(response.status, 503); assert.equal((await response.json()).error, 'A1_RESPONSE_INVALID'); assert.deepEqual(f.calls, { auth: 1, runtime: 1, configure: 0 }); }
  finally { await f.dispose(); }
});
test('workerd rejects anonymous Auth identities before the isolated runtime', options, async () => {
  const f = await fixture({ anonymous: true });
  try { const response = await f.request(); assert.equal(response.status, 401); assert.equal((await response.json()).error, 'A1_UNAUTHENTICATED'); assert.deepEqual(f.calls, { auth: 1, runtime: 0, configure: 0 }); }
  finally { await f.dispose(); }
});
