import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRepository } from '../src/repository.mjs';
import { digest } from '../src/auth.mjs';

const config = { supabaseUrl: 'https://synthetic.supabase.co', serviceKey: 'synthetic-service-key-1234567' };
test('Storage references are fixed and hash/size/type are checked before any ciphertext is consumed', async () => {
  const bytes = Buffer.from('{"synthetic":"ciphertext"}'), hash = await digest(bytes), id = randomUUID(); let calls = 0;
  const ref = { bucket: 'brufap-a1-vault', path: `credentials/${id}/${hash}.json`, hash, size: bytes.length };
  const repository = createRepository({ ...config, fetchImpl: async () => { calls++; return new Response(bytes, { headers: { 'Content-Type': 'application/json' } }); } });
  for (const patch of [{ bucket: 'other' }, { path: `credentials/${id}/../${hash}.json` }, { path: `https://evil.invalid/${hash}` }, { hash: [hash] }, { size: 1500001 }])
    await assert.rejects(repository.readObject({ ...ref, ...patch }), /A1_STORAGE_REFERENCE_INVALID/);
  assert.equal(calls, 0); assert.deepEqual(Buffer.from(await repository.readObject(ref)), bytes);
  for (const response of [new Response('wrong', { headers: { 'Content-Type': 'application/json' } }), new Response(bytes, { headers: { 'Content-Type': 'text/plain' } })]) {
    const bad = createRepository({ ...config, fetchImpl: async () => response }); await assert.rejects(bad.readObject(ref), /A1_STORAGE_VALIDATION_FAILED/);
  }
  assert.throws(() => createRepository({ ...config, supabaseUrl: 'https://synthetic.supabase.co.evil.invalid/' }), /A1_RUNTIME_CONFIGURATION_INVALID/);
});
test('an upload response loss is resolved by exact immutable readback; redirects and raw upstream errors do not escape', async () => {
  const bytes = Buffer.from('{"synthetic":"ciphertext"}'), seen = [], id = randomUUID();
  const repository = createRepository({ ...config, fetchImpl: async (url, options) => {
    seen.push([url, options]); assert.equal(options.redirect, 'error');
    if (options.method === 'POST') { assert.equal(options.headers['x-upsert'], 'false'); throw new TypeError('synthetic upload committed but response lost'); }
    return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
  } });
  const result = await repository.storeObject(id, bytes); assert.equal(result.hash, await digest(bytes)); assert.equal(seen.length, 2);
  const denied = createRepository({ ...config, fetchImpl: async () => Response.json({ code: '42501', message: 'SECRET-UPSTREAM-DIAGNOSTIC' }, { status: 400 }) });
  await assert.rejects(denied.rpc('metadata', {}), e => e.status === 403 && !String(e).includes('SECRET'));
  await assert.rejects(denied.rpc('arbitrary_rpc', {}), /A1_RPC_UNSUPPORTED/);
});
test('the upstream deadline begins before fetch resolves, not just before body reading', async () => {
  const started = Date.now(); let aborted = false;
  const repository = createRepository({ ...config, timeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic abort')); })) });
  await assert.rejects(repository.rpc('metadata', {}), /A1_UPSTREAM_UNAVAILABLE/);
  assert.equal(aborted, true); assert.ok(Date.now() - started < 1000);
});
