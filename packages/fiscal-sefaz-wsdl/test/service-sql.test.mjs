// Complementary 051 integration: real encrypted 041 envelope, custody, OpenSSL and RPC DTOs.
// All certificates are generated fixtures. HTTPS and Storage are intercepted in memory.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SecureContext} from 'node:tls';
import {serviceFixture, hash} from './service-fixture.mjs';
import {createWsdlService, createWsdlPreparationAuthorizer} from '../src/service.mjs';
import {createWsdlRpc} from '../src/service-rpc.mjs';
import {createWsdlCustodyPort} from '../../fiscal-runtime/src/wsdl-custody.mjs';
import {createOpenSslLoader, sealCredential, envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {createSpWsdlTlsLoader} from '../../fiscal-runtime/src/wsdl-server-trust.mjs';
import {createWsdlRuntimeHandler} from '../../fiscal-wsdl-runtime/src/handler.mjs';
import {signRuntimeRequest, digest as bodyDigest} from '../../fiscal-wsdl-runtime/src/auth.mjs';
import {binary, exportPfx, PASSWORD, KEK, HOLDER} from '../../fiscal-vault/test/fixtures.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';

const certificates = await trustFixture();
const pfx = await exportPfx(certificates.leaf, [certificates.intermediate, certificates.root]);
const offline = await createOpenSslLoader({binaryPath: binary});
const tls = await createSpWsdlTlsLoader({binaryPath: binary});
after(() => pfx.fill(0));
const erased = value => assert.ok(value.every(byte => byte === 0));
const count = (f, action) => f.trace.filter(entry => entry === `rpc:${action}`).length;
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: {'content-type': 'application/json'},
});

async function integratedFixture({model = '55', afterRpc, beforeAuthorization, beforeCallback, corruptEnvelope = false} = {}) {
  const f = await serviceFixture({model});
  const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0].value;
  const trace = [], opened = [], delivered = [], tlsScopes = [], key = Buffer.from(KEK);
  try {
    // Align the in-memory company with the deliberately synthetic certificate holder.
    const identity = {legal_name: 'Empresa fictícia de integração WSDL', trade_name: null, cnpj: HOLDER,
      ie: null, postal_code: '13400000', street: 'Rua Teste', number: '1', complement: null,
      district: 'Centro', city: 'Piracicaba', municipality_code: '3538709', state: 'SP', phone: null, email: null};
    await scalar('select public.erp_company_save_identity($1::uuid,1,$2::uuid,$3::jsonb) value', [f.actor, randomUUID(), JSON.stringify(identity)]);
    // Replace only the in-memory placeholder with a real synthetic encrypted credential.
    const command = randomUUID();
    const reserved = await scalar("select public.erp_a1_reserve($1::uuid,$2::uuid,$3,'configure',1,2,'PFX sintético de interoperabilidade') value", [f.actor, command, hash(command)]);
    const envelope = await sealCredential({pfxBytes: pfx, passwordBytes: PASSWORD,
      context: reserved.context, kekBytes: key, keyId: 'synthetic-interop', loader: offline, now: new Date()});
    const bytes = envelopeBytes(envelope), digest = hash(bytes);
    const path = `credentials/${reserved.credential_id}/${digest}.json`;
    await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)', [
      'brufap-a1-vault', path, JSON.stringify({size: bytes.length, mimetype: 'application/json'}),
    ]);
    await scalar('select public.erp_a1_finalize($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,\'synthetic-interop\') value', [
      f.actor, command, reserved.lease_id, JSON.stringify(envelope.metadata), digest, bytes.length,
    ]);
    f.input.expectedA1Version = 2;
    f.input.expectedIdentityVersion = 2;
    let consumed = false;
    // This is the real transport adapter. Its injected fetch can reach only this PGlite database.
    const rpc = createWsdlRpc({projectUrl: 'https://abcdefghijklmnopqrst.supabase.co', serviceKey: 'synthetic-service-key-only',
      fetchImpl: async (url, options) => {
        assert.match(url, /^https:\/\/abcdefghijklmnopqrst\.supabase\.co\/rest\/v1\/rpc\/erp_fiscal_wsdl_(begin|use|finish|fail|command)$/);
        assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
        assert.equal(options.signal.aborted, false);
        const name = url.split('/').at(-1), action = name.slice('erp_fiscal_wsdl_'.length);
        const args = JSON.parse(Buffer.from(options.body).toString('utf8'));
        trace.push(`rpc:${action}`);
        let result;
        try { result = await f.callSql(name, args); }
        catch (error) { return jsonResponse({code: error.code, message: 'PRIVATE_SQL_DETAIL'}, 400); }
        if (action === 'use') { consumed = true; trace.push('use:committed'); }
        await afterRpc?.({action, result, f});
        return jsonResponse(result);
      }});
    const authorize = createWsdlPreparationAuthorizer({rpc});
    const custody = createWsdlCustodyPort({keyring: new Map([['synthetic-interop', key]]),
      authorizePreparation: async (value, options) => {
        trace.push('authorize'); await beforeAuthorization?.(f);
        return authorize(value, options);
      },
      readObject: async (reference, options) => {
        trace.push('envelope:read'); assert.equal(options.signal.aborted, false);
        assert.deepEqual(reference, {bucket: 'brufap-a1-vault', path, hash: digest, size: bytes.length, key_id: 'synthetic-interop'});
        const copy = Buffer.from(bytes); if (corruptEnvelope) copy[copy.length - 1] ^= 1;
        delivered.push(copy); return copy;
      },
      loader: {async withContext(input, action) {
        trace.push('tls:open'); opened.push(input);
        await tls.withContext(input, async session => {
          assert.ok(session.secureContext instanceof SecureContext); tlsScopes.push(session);
          trace.push('tls:callback'); await beforeCallback?.(f);
          await action(session);
        });
      }},
    });
    const service = createWsdlService({rpc, storage: f.ports.storage, withPreparedTlsSession: custody,
      requestImpl: (...args) => {
        assert.equal(consumed, true, 'The 051 use commit must precede even constructing an HTTPS request');
        trace.push('https:request'); assert.ok(args[0].secureContext instanceof SecureContext);
        return f.wire.requestImpl(...args);
      }});
    return {...f, service, rpc, trace, opened, delivered, tlsScopes, key, envelope,
      async dispose() { bytes.fill(0); key.fill(0); await f.close(); }};
  } catch (error) { key.fill(0); await f.close(); throw error; }
}

for (const model of ['55', '65']) test(`051 + real encrypted custody + RPC adapter stores model ${model} without exposing credential material`, {timeout: 20000}, async () => {
  const f = await integratedFixture({model});
  try {
    const result = await f.service.run(f.input);
    assert.equal(result.status, 'stored'); assert.equal(result.failure_code, null);
    assert.equal(result.binding_verified, false); assert.equal(result.receipt.model, model);
    assert.equal(result.artifact.inspection_status, 'supported');
    assert.equal(f.wire.calls, 1); assert.equal(count(f, 'begin'), 2); assert.equal(count(f, 'use'), 1);
    assert.equal(count(f, 'finish'), 1);
    assert.ok(f.trace.indexOf('authorize') < f.trace.indexOf('envelope:read'));
    assert.ok(f.trace.indexOf('envelope:read') < f.trace.indexOf('tls:open'));
    assert.ok(f.trace.indexOf('tls:callback') < f.trace.indexOf('use:committed'));
    assert.ok(f.trace.indexOf('use:committed') < f.trace.indexOf('https:request'));
    for (const value of f.delivered) erased(value);
    for (const input of f.opened) { erased(input.pfxBytes); erased(input.passwordBytes); }
    for (const session of f.tlsScopes) assert.equal(session.signal.aborted, true);
    assert.deepEqual(f.key, KEK); assert.equal(f.envelope.context.purpose, 'offline-homologation');
    assert.doesNotMatch(JSON.stringify(result), /credential_id|issuer_cnpj|fingerprint|key_id|SecureContext|execution|metadata|wsdl\/|PRIVATE/);
    const stored = (await f.command()).artifact;
    assert.equal(stored.evidence.tls.client_fingerprint, f.envelope.metadata.fingerprint_sha256);
    assert.equal(stored.evidence.tls.client_chain, 'not_evaluated');
    assert.equal(stored.evidence.tls.revocation, 'unknown_offline');
    assert.equal(stored.evidence.tls.client_profile, 'compatible');
    const replay = await f.service.run(f.input);
    assert.equal(replay.status, 'stored'); assert.equal(f.wire.calls, 1); assert.equal(f.opened.length, 1);
  } finally { await f.dispose(); }
});

test('lost use ACK after opening real custody never handshakes and cannot consume the grant again', {timeout: 20000}, async () => {
  const f = await integratedFixture({afterRpc({action}) { if (action === 'use') throw Error('PRIVATE_USE_ACK_LOST'); }});
  try {
    const result = await f.service.run(f.input);
    assert.equal(result.status, 'dispatched'); assert.equal(result.recovery_required, true);
    assert.equal(f.opened.length, 1); assert.equal(f.wire.calls, 0); assert.equal(count(f, 'use'), 1);
    assert.equal(count(f, 'finish'), 0); assert.equal(count(f, 'fail'), 0);
    const replay = await f.service.run(f.input);
    assert.equal(replay.status, 'dispatched'); assert.equal(f.opened.length, 1); assert.equal(f.wire.calls, 0);
    assert.equal(count(f, 'use'), 1);
    for (const input of f.opened) { erased(input.pfxBytes); erased(input.passwordBytes); }
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_USE_ACK_LOST/);
  } finally { await f.dispose(); }
});

test('lost finish ACK plus failed readback recovers SQL artifact later without reopening custody or repeating GET', {timeout: 20000}, async () => {
  let finished = false, loseRead = true;
  const f = await integratedFixture({afterRpc({action}) {
    if (action === 'finish') { finished = true; throw Error('PRIVATE_FINISH_ACK_LOST'); }
    if (action === 'command' && finished && loseRead) { loseRead = false; throw Error('PRIVATE_READBACK_LOST'); }
  }});
  try {
    const first = await f.service.run(f.input);
    assert.equal(first.status, 'unconfirmed'); assert.equal(first.recovery_required, true); assert.equal(first.artifact, null);
    assert.equal((await f.command()).current.state, 'stored');
    const read = await f.service.command({actor: f.actor, commandId: f.input.commandId});
    assert.equal(read.status, 'stored'); assert.equal(read.read_only, true);
    const replay = await f.service.run(f.input);
    assert.equal(replay.status, 'stored'); assert.equal(f.wire.calls, 1); assert.equal(count(f, 'finish'), 1);
    assert.equal(count(f, 'use'), 1); assert.equal(f.opened.length, 1); assert.equal(f.calls.put.length, 1);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  } finally { await f.dispose(); }
});

test('private handler preserves a verified stored ACK when readback fails, then only queries recovery', {timeout: 20000}, async () => {
  let finished = false, failedReads = 0;
  const f = await integratedFixture({afterRpc({action}) {
    if (action === 'finish') finished = true;
    if (action === 'command' && finished && failedReads++ < 2) throw Error('PRIVATE_CURRENT_READBACK_LOST');
  }});
  const secret = Buffer.alloc(32, 17), keyId = 'synthetic-wsdl-interop', audience = 'synthetic-wsdl';
  const handler = createWsdlRuntimeHandler({service: f.service, transportSecret: secret, transportKeyId: keyId, audience});
  const payload = {command_id: f.input.commandId, model: f.input.model, operation: f.input.operation,
    expected_a1_version: f.input.expectedA1Version, expected_identity_version: f.input.expectedIdentityVersion, confirmed: true};
  async function request(action, audienceOverride = audience) {
    const method = action === 'run' ? 'POST' : 'GET';
    const path = `/internal/v1/fiscal-wsdl/${action === 'run' ? 'run' : 'commands/' + f.input.commandId}`;
    const bytes = Buffer.from(method === 'POST' ? JSON.stringify(payload) : '');
    const authorization = await signRuntimeRequest({secretBytes: secret, keyId, audience: audienceOverride,
      actor: f.actor, nonce: randomUUID(), method, path, bodyHash: await bodyDigest(bytes)});
    return new Request(`http://runtime.internal${path}`, {method,
      headers: {Authorization: authorization, ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})},
      ...(method === 'POST' ? {body: bytes} : {})});
  }
  try {
    assert.equal((await handler(await request('run', 'wrong-wsdl'))).status, 401);
    assert.equal(f.trace.length, 0);
    const first = await handler(await request('run'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const confirmed = await first.json();
    assert.equal(confirmed.status, 'stored'); assert.equal(confirmed.recovery_required, false);
    assert.equal(confirmed.recovered, true); assert.equal(confirmed.current.state, 'stored'); assert.ok(confirmed.artifact?.sha256);
    assert.equal(confirmed.binding_verified, false);
    assert.doesNotMatch(JSON.stringify(confirmed), /PRIVATE_|credential_id|fingerprint|issuer_cnpj|lease_id|execution|wsdl\/|key_id/);
    const response = await handler(await request('command'));
    assert.equal(response.status, 200);
    const current = await response.json();
    assert.equal(current.status, 'stored'); assert.equal(current.read_only, true); assert.equal(current.recovery_required, false);
    assert.deepEqual(current.artifact, confirmed.artifact);
    assert.equal(f.wire.calls, 1); assert.equal(f.opened.length, 1); assert.equal(count(f, 'use'), 1); assert.equal(count(f, 'finish'), 1);
  } finally { handler.dispose(); secret.fill(0); await f.dispose(); }
});

test('membership revoked after begin is rechecked before encrypted Storage and OpenSSL', {timeout: 20000}, async () => {
  const f = await integratedFixture({beforeAuthorization: f => f.db.query('update erp_access.membership set active=false where user_id=$1', [f.actor])});
  try {
    const result = await f.service.run(f.input);
    assert.equal(result.recovery_required, true); assert.equal(f.delivered.length, 0); assert.equal(f.opened.length, 0);
    assert.equal(f.wire.calls, 0); assert.equal(count(f, 'use'), 0); assert.equal(count(f, 'finish'), 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SQL_DETAIL/);
  } finally { await f.dispose(); }
});

test('A1 disabled after TLS preparation is rejected by use before any HTTPS request', {timeout: 20000}, async () => {
  const f = await integratedFixture({beforeCallback: async f => {
    const command = randomUUID();
    await f.db.query("select public.erp_a1_disable($1::uuid,$2::uuid,$3,2,'Desativação sintética antes do GET')", [f.actor, command, hash(command)]);
  }});
  try {
    const result = await f.service.run(f.input);
    assert.equal(result.recovery_required, true); assert.equal(f.opened.length, 1); assert.equal(count(f, 'use'), 1);
    assert.equal(f.trace.includes('use:committed'), false); assert.equal(f.wire.calls, 0); assert.equal(count(f, 'finish'), 0);
    assert.equal((await f.command()).current.a1_changed, true);
    for (const input of f.opened) { erased(input.pfxBytes); erased(input.passwordBytes); }
  } finally { await f.dispose(); }
});

test('altered encrypted object fails before the TLS loader and consumes no WSDL grant', {timeout: 20000}, async () => {
  const f = await integratedFixture({corruptEnvelope: true});
  try {
    const result = await f.service.run(f.input);
    assert.equal(result.status, 'failed'); assert.equal(result.recovery_required, true);
    assert.equal(f.delivered.length, 1); erased(f.delivered[0]);
    assert.equal(f.opened.length, 0); assert.equal(count(f, 'use'), 0); assert.equal(f.wire.calls, 0);
    assert.equal(count(f, 'finish'), 0);
    const replay = await f.service.run(f.input);
    assert.equal(replay.status, 'failed'); assert.equal(f.delivered.length, 1);
  } finally { await f.dispose(); }
});
