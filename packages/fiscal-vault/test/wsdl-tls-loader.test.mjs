import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecureContext, SecureContext} from 'node:tls';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWsdlTlsLoader} from '../src/wsdl-tls-loader.mjs';
import {createOpenSslLoader} from '../src/openssl-loader.mjs';
import {binary, exportPfx, HOLDER, OTHER, NOW, PASSWORD} from './fixtures.mjs';
import {trustFixture} from './trust-fixtures.mjs';

const fixture = await trustFixture(), pfx = await exportPfx(fixture.leaf, [fixture.intermediate, fixture.root]);
const fingerprint = createHash('sha256').update(fixture.leaf.certificateDer).digest('hex');
const input = {pfxBytes:pfx, passwordBytes:PASSWORD, expectedHolderCnpj:HOLDER, expectedFingerprint:fingerprint, now:NOW, purpose:'sefaz-sp-wsdl-readonly-v1'};
const loader = await createWsdlTlsLoader({binaryPath:binary});

test('WSDL context is scoped, client EKU checked and PEM wiped before callback; no private material is returned', async () => {
  let pem, called = 0, signal;
  const observed = await createWsdlTlsLoader({binaryPath:binary}, {createContext(options) {
    pem = options.key;
    assert.ok(pem.includes(Buffer.from('PRIVATE KEY')));
    assert.equal(options.minVersion, 'TLSv1.2'); assert.equal(options.maxVersion, 'TLSv1.3');
    assert.equal(options.ca, undefined); assert.equal(options.cert.includes(fixture.root.certificate.trim()), false);
    return createSecureContext(options);
  }});
  assert.equal(await observed.withContext(input, async context => {
    called++; signal = context.signal;
    assert.ok(context.secureContext instanceof SecureContext);
    assert.deepEqual(Object.keys(context).sort(), ['deadline','metadata','secureContext','signal']);
    assert.equal(context.metadata.fingerprint_sha256, fingerprint);
    assert.equal(context.metadata.client_auth_usage, 'explicit_client_auth');
    assert.equal(context.metadata.can_transmit, false); assert.equal(context.metadata.revocation_checked, false);
    assert.equal(pem.every(byte => byte === 0), true);
  }), undefined);
  assert.equal(called, 1); assert.equal(signal.aborted, true);
  assert.notEqual(pfx[0], 0); assert.notEqual(PASSWORD[0], 0);
});

test('offline and WSDL purposes stay separate; fingerprint, holder, expiry and password failures never call action', async () => {
  let called = 0; const action = () => { called++; };
  const offline = await createOpenSslLoader({binaryPath:binary});
  await assert.rejects(offline.load(input), /VAULT_OFFLINE_ONLY/);
  for (const change of [
    {purpose:'offline-homologation'}, {purpose:'production'}, {expectedFingerprint:'0'.repeat(64)},
    {expectedHolderCnpj:OTHER}, {now:new Date('2028-01-01T00:00:00Z')}, {passwordBytes:Buffer.from('SYNTHETIC-SECRET-NOT-IN-ERROR')},
  ]) await assert.rejects(loader.withContext({...input, ...change}, action), error => error.code.startsWith('VAULT_') && !JSON.stringify(error).includes('SYNTHETIC-SECRET'));
  assert.equal(called, 0);
});

test('explicit server-only EKU is rejected before a context or callback exists', async () => {
  const serverOnly = await trustFixture({eku:['1.3.6.1.5.5.7.3.1']});
  const file = await exportPfx(serverOnly.leaf, [serverOnly.intermediate,serverOnly.root]);
  let contexts = 0, actions = 0;
  const restricted = await createWsdlTlsLoader({binaryPath:binary}, {createContext(options) { contexts++; return createSecureContext(options); }});
  await assert.rejects(restricted.withContext({...input,pfxBytes:file,expectedFingerprint:createHash('sha256').update(serverOnly.leaf.certificateDer).digest('hex')}, () => { actions++; }), /VAULT_TLS_CLIENT_USAGE_EXCLUDED/);
  assert.equal(contexts, 0); assert.equal(actions, 0);
});

test('caller bytes and options are captured before the first await, and getters are refused', async () => {
  const file = Buffer.from(pfx), password = Buffer.from(PASSWORD), at = new Date(NOW);
  const value = {...input, pfxBytes:file, passwordBytes:password, now:at}; let called = 0;
  const pending = loader.withContext(value, () => { called++; });
  file.fill(0); password.fill(0); at.setUTCFullYear(2028); value.expectedFingerprint = '0'.repeat(64);
  await pending; assert.equal(called, 1);
  let getters = 0;
  const dangerous = {...input}; Object.defineProperty(dangerous, 'passwordBytes', {enumerable:true, get() { getters++; return PASSWORD; }});
  await assert.rejects(loader.withContext(dangerous, () => {}), /VAULT_TLS_INPUT_INVALID/); assert.equal(getters, 0);
  await assert.rejects(loader.withContext({...input, [Symbol('unexpected')]:true}, () => {}), /VAULT_TLS_INPUT_INVALID/);
});

test('context callbacks must return void, failures are sanitized and cancellation closes the scoped signal', async () => {
  await assert.rejects(loader.withContext(input, context => context.secureContext), /VAULT_TLS_ACTION_MUST_RETURN_VOID/);
  await assert.rejects(loader.withContext(input, () => { throw new Error('PEM-OR-PASSWORD-MUST-NOT-LEAK'); }), error => error.code === 'VAULT_TLS_CONTEXT_FAILED' && !JSON.stringify(error).includes('MUST-NOT-LEAK'));
  const stopped = new AbortController(); stopped.abort(); let called = 0;
  await assert.rejects(loader.withContext({...input, signal:stopped.signal}, () => { called++; }), /VAULT_TLS_ABORTED/); assert.equal(called, 0);
  const controller = new AbortController(); let scoped;
  await assert.rejects(loader.withContext({...input, signal:controller.signal}, context => {
    scoped = context.signal; controller.abort(); return new Promise(() => {});
  }), /VAULT_TLS_ABORTED/); assert.equal(scoped.aborted, true);
});

test('deadline and abort terminate a stalled PKCS12 subprocess instead of waiting for its independent timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brufap-wsdl-loader-'));
  try {
    const fake = join(directory, 'openssl-synthetic');
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "version" ]; then echo "OpenSSL 3.6.3 synthetic"; exit 0; fi\nexec /bin/sleep 5\n', {mode:0o700});
    const stalled = await createWsdlTlsLoader({binaryPath:fake,timeoutMs:5000}); let called = 0;
    let started = Date.now();
    await assert.rejects(stalled.withContext({...input,deadline:Date.now()+100}, () => { called++; }), /VAULT_TLS_TIMEOUT/);
    assert.ok(Date.now()-started < 2000);
    const controller = new AbortController(); started = Date.now();
    const pending = stalled.withContext({...input,signal:controller.signal}, () => { called++; });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(pending, /VAULT_TLS_ABORTED/); } finally { clearTimeout(timer); }
    assert.ok(Date.now()-started < 2000); assert.equal(called, 0);
  } finally { await rm(directory, {recursive:true,force:true}); }
});
