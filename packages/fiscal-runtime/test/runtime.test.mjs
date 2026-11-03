import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRuntimeHandler } from '../src/handler.mjs';
import { RuntimeError, encodeConfigure, CONFIGURE_TYPE } from '../src/protocol.mjs';
import { FLAGS } from '../src/dto.mjs';
import { digest, signRuntimeRequest } from '../src/auth.mjs';
import { createGateway } from '../../../workers/fiscal-gateway/src/index.mjs';
import { createOpenSslLoader, parseEnvelope } from '../../fiscal-vault/src/index.mjs';
import { binary, chainFixture, exportPfx, PASSWORD, CONTEXT, NOW } from '../../fiscal-vault/test/fixtures.mjs';

const chain = await chainFixture(), pfx = await exportPfx(chain.leaf, chain.chain), loader = await createOpenSslLoader({ binaryPath: binary });
function setup() {
  const actor = randomUUID(), secret = randomBytes(32), fingerprintSecret = randomBytes(32), kek = randomBytes(32), commands = new Map(), objects = new Map(), nonces = new Set();
  let state = { version: 0, state: 'unconfigured', credential_id: null, company_identity_version: null, metadata: null, company_changed: false, time_valid_now: false };
  const fixture = { actor, secret, fingerprintSecret, kek, commands, objects, allowed: true, lostFinalize: false, revokeOnStore: false, storedCount: 0, finalized: 0 };
  const current = () => structuredClone(state), full = (value = {}) => ({ ...FLAGS, ...value, current: current() });
  const repository = {
    async rpc(name, p) {
      if (!fixture.allowed || p.p_user_id !== actor) throw new RuntimeError(403, 'A1_FORBIDDEN');
      if (name === 'authorize') {
        if (nonces.has(p.p_nonce)) throw new RuntimeError(409, 'A1_CONFLICT'); nonces.add(p.p_nonce);
        return full({ vault_id: CONTEXT.vault_id, company: { identity_version: 1, cnpj: CONTEXT.holder_cnpj } });
      }
      if (name === 'metadata') return full();
      const existing = commands.get(p.p_command_id);
      if (name === 'command') { if (!existing) throw new RuntimeError(404, 'A1_NOT_FOUND'); return full({ state: existing.state, receipt: existing.receipt || null, error_code: existing.error_code || null }); }
      if (name === 'reserve' || name === 'disable') {
        if (existing) {
          if (existing.hash !== p.p_request_hash) throw new RuntimeError(409, 'A1_CONFLICT');
          if (existing.state !== 'pending') return full({ state: existing.state, receipt: existing.receipt, error_code: existing.error_code || null, replayed: true });
          throw new RuntimeError(409, 'A1_CONFLICT');
        }
        if (p.p_expected_version !== state.version) throw new RuntimeError(409, 'A1_CONFLICT');
        if (name === 'disable') {
          state = { ...state, version: state.version + 1, state: 'disabled', credential_id: null, company_identity_version: null, metadata: null, company_changed: false, time_valid_now: false };
          const receipt = { command_id: p.p_command_id, action: 'disable', version: state.version, state: state.state, credential_id: null, company_identity_version: null, metadata: null, recorded_at: NOW.toISOString() };
          commands.set(p.p_command_id, { hash: p.p_request_hash, state: 'committed', receipt }); return full({ state: 'committed', receipt, replayed: false });
        }
        const id = randomUUID(), lease = randomUUID(), context = { ...CONTEXT, credential_id: id };
        commands.set(p.p_command_id, { hash: p.p_request_hash, state: 'pending', lease, id, context, action: p.p_action });
        return full({ state: 'reserved', lease_id: lease, lease_until: new Date(NOW.getTime() + 60000).toISOString(), credential_id: id, context, metadata: null, source_object: null });
      }
      assert.ok(existing); assert.equal(p.p_lease_id, existing.lease);
      if (name === 'reject') { existing.state = 'rejected'; existing.error_code = p.p_error_code; return full({ state: 'rejected', error_code: p.p_error_code, replayed: false }); }
      assert.equal(name, 'finalize');
      state = { ...state, version: state.version + 1, state: 'configured_offline', credential_id: existing.id, company_identity_version: 1, metadata: p.p_metadata, time_valid_now: true };
      const receipt = { command_id: p.p_command_id, action: existing.action, version: state.version, state: state.state, credential_id: existing.id, company_identity_version: 1, metadata: p.p_metadata, recorded_at: NOW.toISOString() };
      existing.state = 'committed'; existing.receipt = receipt; fixture.finalized++;
      if (fixture.lostFinalize) { fixture.lostFinalize = false; throw new RuntimeError(503, 'A1_UPSTREAM_UNAVAILABLE'); }
      return full({ state: 'committed', receipt, replayed: false, internal_secret: 'must be stripped' });
    },
    async storeObject(id, bytes) {
      const hash = await digest(bytes), path = `credentials/${id}/${hash}.json`;
      objects.set(path, Buffer.from(bytes)); fixture.storedCount++;
      if (fixture.revokeOnStore) fixture.allowed = false;
      return { bucket: 'brufap-a1-vault', path, hash, size: bytes.length };
    },
  };
  const handler = createRuntimeHandler({ repository, loader, transportSecret: secret, transportKeyId: 'transport1', audience: 'test', fingerprintSecret, keyring: new Map([['kek1', kek]]), currentKeyId: 'kek1', now: () => NOW.getTime() });
  const invoke = async (action, body, { tokenNonce = randomUUID(), tamper = false } = {}) => {
    const path = action.startsWith('commands/') ? `/internal/v1/a1/${action}` : action === 'metadata' ? '/internal/v1/a1' : `/internal/v1/a1/${action}`, method = body ? 'POST' : 'GET';
    const bytes = body instanceof Uint8Array ? body : body ? Buffer.from(JSON.stringify(body)) : new Uint8Array();
    const header = await signRuntimeRequest({ secretBytes: secret, keyId: 'transport1', audience: 'test', actor, nonce: tokenNonce, method, path, bodyHash: await digest(bytes), now: NOW.getTime() });
    return handler(new Request(`https://test${path}`, { method, headers: { Authorization: header, 'Content-Type': action === 'configure' ? CONFIGURE_TYPE : 'application/json' }, ...(body ? { body: tamper ? Buffer.from('tampered') : bytes } : {}) }));
  };
  return { ...fixture, fixture, repository, handler, invoke, current };
}
function config(command = randomUUID(), file = pfx) { return encodeConfigure({ command_id: command, expected_version: 0, expected_identity_version: 1, reason: 'Synthetic A1 test', pfxBytes: file, passwordBytes: PASSWORD }); }
test('configuration seals only; commit-response loss recovers once and historical replay never reactivates disabled credentials', async () => {
  const f = setup(), id = randomUUID(), body = config(id); f.fixture.lostFinalize = true;
  const lost = await f.invoke('configure', body); assert.equal(lost.status, 503); assert.equal(f.current().version, 1);
  const retry = await (await f.invoke('configure', body)).json(); assert.equal(retry.replayed, true); assert.equal(retry.receipt.command_id, id);
  assert.equal(f.fixture.finalized, 1); assert.equal(f.fixture.storedCount, 1);
  const saved = [...f.objects.values()][0], envelope = parseEnvelope(saved);
  assert.equal(envelope.metadata.can_transmit, false); assert.equal(saved.includes(Buffer.from(PASSWORD)), false); assert.equal(saved.includes(pfx), false);
  const disabled = await f.invoke('disable', { command_id: randomUUID(), expected_version: 1, reason: 'Synthetic disable' }); assert.equal(disabled.status, 200);
  const replay = await (await f.invoke('configure', body)).json(); assert.equal(replay.receipt.version, 1); assert.equal(replay.current.state, 'disabled'); assert.equal(replay.current.version, 2);
  const text = JSON.stringify(replay); for (const forbidden of ['internal_secret', 'ciphertext', 'key_id', 'source_object', 'lease_id', 'password']) assert.equal(text.includes(forbidden), false);
  assert.equal((await f.invoke('configure', config(id, Buffer.from('different')))).status, 409);
});
test('nonce reuse, body tampering and revoked membership cannot activate an uploaded envelope', async () => {
  const f = setup(), nonce = randomUUID(); assert.equal((await f.invoke('metadata', null, { tokenNonce: nonce })).status, 200);
  assert.equal((await f.invoke('metadata', null, { tokenNonce: nonce })).status, 409);
  assert.equal((await f.invoke('configure', config(), { tamper: true })).status, 401); assert.equal(f.commands.size, 0);
  f.fixture.revokeOnStore = true;
  assert.equal((await f.invoke('configure', config())).status, 403); assert.equal(f.current().state, 'unconfigured'); assert.equal(f.fixture.storedCount, 1);
});
test('malformed credentials persist only a fixed rejection and do not upload plaintext or encrypted objects', async () => {
  const f = setup(), id = randomUUID(), request = config(id, Buffer.from('not-a-certificate'));
  const response = await f.invoke('configure', request), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.state, 'rejected'); assert.equal(result.error_code, 'CERTIFICATE_REJECTED');
  assert.equal(f.objects.size, 0); assert.equal((await (await f.invoke('configure', request)).json()).replayed, true);
});
test('dedicated gateway checks Auth before forwarding, binds actor and excludes browser bearer/KEK from runtime handoff', async () => {
  const f = setup(), gateway = createGateway({ now: () => NOW.getTime(), fetchImpl: async (url, options) => { assert.equal(url, 'https://synthetic.supabase.co/auth/v1/user'); assert.equal(options.redirect, 'manual'); return Response.json({ id: f.actor, email: 'synthetic@example.invalid' }); } });
  let forwarded = 0;
  const env = { ALLOWED_ORIGINS: 'https://app.example.invalid', SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_ANON_KEY: 'synthetic-public-key-123456',
    A1_TRANSPORT_SECRET: f.secret.toString('base64'), A1_TRANSPORT_KEY_ID: 'transport1', A1_AUDIENCE: 'test', A1_RUNTIME: { fetch(request) { forwarded++; assert.match(request.headers.get('authorization'), /^Brufap-A1 /); assert.equal(request.headers.get('apikey'), null); return f.handler(request); } } };
  const req = origin => new Request('https://gateway.example.invalid/v1/a1', { headers: { Origin: origin, Authorization: 'Bearer synthetic-user-token-1234567890' } });
  const ok = await gateway(req('https://app.example.invalid'), env); assert.equal(ok.status, 200); assert.equal((await ok.json()).current.state, 'unconfigured');
  assert.equal(ok.headers.get('cache-control'), 'no-store'); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example.invalid');
  assert.equal((await gateway(req('https://evil.invalid'), env)).status, 403); assert.equal(forwarded, 1);
  const unauth = createGateway({ fetchImpl: async () => new Response(null, { status: 401 }) });
  assert.equal((await unauth(req('https://app.example.invalid'), env)).status, 401); assert.equal(forwarded, 1);
  const anonymous = createGateway({ fetchImpl: async () => Response.json({ id: f.actor, is_anonymous: true }) });
  assert.equal((await anonymous(req('https://app.example.invalid'), env)).status, 401); assert.equal(forwarded, 1);
  const redirected = createGateway({ fetchImpl: async () => Response.redirect('https://evil.invalid/', 302) });
  assert.equal((await redirected(req('https://app.example.invalid'), env)).status, 401); assert.equal(forwarded, 1);
});
test('gateway dependency failures expose only fixed phase codes, never exception data', async () => {
  const f = setup(), sensitive = 'PRIVATE-CREDENTIAL-DO-NOT-RETURN';
  const env = { ALLOWED_ORIGINS: 'https://app.example.invalid', SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_ANON_KEY: 'synthetic-public-key-123456', A1_TRANSPORT_SECRET: f.secret.toString('base64'), A1_TRANSPORT_KEY_ID: 'transport1', A1_AUDIENCE: 'test', A1_RUNTIME: { fetch() { throw new Error(sensitive); } } };
  const request = () => new Request('https://gateway.example.invalid/v1/a1', { headers: { Origin: 'https://app.example.invalid', Authorization: 'Bearer synthetic-user-token-1234567890' } });
  for (const [fetchImpl, code] of [[async () => { throw new Error(sensitive); }, 'A1_AUTH_SERVICE_UNAVAILABLE'], [async () => Response.json({ id: f.actor }), 'A1_RUNTIME_BINDING_UNAVAILABLE']]) {
    const response = await createGateway({ fetchImpl })(request(), env), body = await response.text();
    assert.equal(response.status, 503); assert.equal(body.includes(sensitive), false);
    assert.deepEqual(JSON.parse(body), { error: code, recovery_required: false });
  }
});
