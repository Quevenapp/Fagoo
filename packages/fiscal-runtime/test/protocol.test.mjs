import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encodeConfigure, parseConfigure, parseCommand, readBounded, CONFIGURE_TYPE } from '../src/protocol.mjs';
import { digest, signRuntimeRequest, verifyRuntimeRequest } from '../src/auth.mjs';
import { requestFingerprint } from '../src/handler.mjs';

const command_id = randomUUID(), meta = { command_id, expected_version: 0, expected_identity_version: 1, reason: 'Synthetic configuration' };
test('binary protocol preserves exact PFX/password, bounds fields and rejects coerced IDs', async () => {
  const encoded = encodeConfigure({ ...meta, pfxBytes: new Uint8Array([0, 255, 2]), passwordBytes: new TextEncoder().encode('synthetic password') });
  const result = parseConfigure(encoded); assert.deepEqual(result.pfxBytes, new Uint8Array([0, 255, 2]));
  assert.equal(new TextDecoder().decode(result.passwordBytes), 'synthetic password');
  assert.throws(() => parseConfigure(encoded.slice(0, -1)), /A1_BODY_INVALID/);
  assert.throws(() => encodeConfigure({ ...meta, command_id: [command_id], pfxBytes: new Uint8Array([1]), passwordBytes: new Uint8Array([2]) }), /A1_BODY_INVALID/);
  assert.throws(() => parseCommand(Buffer.from(JSON.stringify({ command_id: [command_id], expected_version: 1, reason: 'Synthetic disable' })), 'disable'), /A1_BODY_INVALID/);
  assert.throws(() => parseCommand(Buffer.from(JSON.stringify({ ...meta, password: 'must not be accepted' })), 'rewrap'), /A1_BODY_INVALID/);
  const request = new Request('https://test/configure', { method: 'POST', headers: { 'Content-Type': CONFIGURE_TYPE, 'Content-Encoding': 'gzip' }, body: encoded });
  await assert.rejects(readBounded(request, { limit: encoded.length }), /A1_ENCODING_UNSUPPORTED/);
});
test('stream limits and timeout cancel readers, including late chunks', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBounded(new Response(stream), { limit: 10, timeoutMs: 20 }), /A1_BODY_TOO_LARGE/); assert.equal(cancelled, true);
  let close;
  const late = new ReadableStream({ start(c) { close = c; }, cancel() { cancelled = true; } });
  cancelled = false;
  await assert.rejects(readBounded(new Response(late), { limit: 10, timeoutMs: 20 }), /A1_BODY_TIMEOUT/);
  assert.equal(cancelled, true); assert.throws(() => close.enqueue(new Uint8Array([1])));
});
test('transport authentication binds exact actor/path/method/audience/hash/time and secret fingerprint is stable', async () => {
  const secretBytes = randomBytes(32), actor = randomUUID(), nonce = randomUUID(), now = Date.now(), body = Buffer.from('synthetic-pfx-password');
  const options = { secretBytes, keyId: 'transport1', audience: 'test', actor, nonce, method: 'POST', path: '/internal/v1/a1/configure', bodyHash: await digest(body), now };
  const header = await signRuntimeRequest(options);
  assert.equal((await verifyRuntimeRequest({ ...options, header })).actor, actor);
  for (const changed of [{ method: 'GET' }, { path: '/internal/v1/a1/disable' }, { audience: 'other' }, { now: now + 60001 }, { secretBytes: randomBytes(32) }])
    await assert.rejects(verifyRuntimeRequest({ ...options, header, ...changed }), /A1_RUNTIME_UNAUTHORIZED/);
  await assert.rejects(signRuntimeRequest({ ...options, actor: [actor] }), /A1_RUNTIME_UNAUTHORIZED/);
  const selected = { action: 'configure', path: options.path }, fingerprintKey = randomBytes(32);
  const fingerprint = requestFingerprint(fingerprintKey, actor, selected, body);
  assert.equal(requestFingerprint(fingerprintKey, actor, selected, body), fingerprint);
  assert.notEqual(fingerprint, await digest(body));
  assert.notEqual(fingerprint, requestFingerprint(secretBytes, actor, selected, body));
  assert.notEqual(fingerprint, requestFingerprint(fingerprintKey, randomUUID(), selected, body));
});
