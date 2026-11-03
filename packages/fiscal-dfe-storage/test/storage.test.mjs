import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDfeStorage, DfeStorageError } from '../src/storage.mjs';

const projectUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const serviceKey = 'synthetic-storage-service-key';
const bytes = Buffer.from('<synthetic>PRIVATE FIXTURE</synthetic>');
const digest = value => createHash('sha256').update(value).digest('hex');
const key = `objects/${digest(bytes)}.xml`;
const journal = `responses/11111111-1111-4111-8111-111111111111/${'a'.repeat(64)}.xml`;
const input = (extra = {}) => ({ bucket: 'brufap-received-dfe', key, deadline: Date.now() + 10000, ...extra });
const upload = (extra = {}) => input({ bytes, contentType: 'application/octet-stream', upsert: false, ifNoneMatch: '*', ...extra });
const port = fetchImpl => createDfeStorage({ projectUrl, serviceKey, fetchImpl });
const xml = (value = bytes, headers = {}) => new Response(value, { headers: { 'Content-Type': 'application/octet-stream', ...headers } });
const rejects = (fn, code) => assert.rejects(fn, error => error instanceof DfeStorageError && error.code === code && !error.cause);

test('requires explicit trusted dependencies and restricts the destination before handling credentials', () => {
  for (const url of ['http://abcdefghijklmnopqrst.supabase.co', projectUrl + '/', projectUrl + '/other', projectUrl + '?token=x', projectUrl + '@evil.invalid', 'https://evil.invalid', 'https://x.supabase.co']) {
    assert.throws(() => createDfeStorage({ projectUrl: url, serviceKey, fetchImpl: async () => {} }), /DFE_STORAGE_PROJECT_INVALID/);
  }
  assert.throws(() => createDfeStorage({ projectUrl, serviceKey }), /DFE_STORAGE_DRIVER_REQUIRED/);
  assert.throws(() => createDfeStorage({ projectUrl, serviceKey: serviceKey + '\n', fetchImpl: async () => {} }), /DFE_STORAGE_CREDENTIAL_INVALID/);
});

test('immutable POST and authenticated GET are fixed and byte-preserving; no provider headers escape', async () => {
  const calls = [], original = Buffer.from(bytes);
  const storage = port(async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, `Bearer ${serviceKey}`);
    assert.equal(options.headers.apikey, serviceKey);
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    if (options.method === 'POST') {
      assert.deepEqual(options.body, bytes); assert.equal(options.headers['x-upsert'], 'false');
      assert.equal(options.headers['If-None-Match'], '*'); assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      return Response.json({ Key: 'not-relayed', Id: 'not-relayed' }, { status: 201 });
    }
    return xml(bytes, { 'Set-Cookie': 'must-not-escape', 'X-Private-Debug': 'must-not-escape' });
  });
  assert.deepEqual(await storage.putImmutable(upload()), { status: 201, requires_readback: true });
  const response = await storage.read(input());
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); assert.deepEqual(bytes, original);
  assert.equal(calls[0].url, `${projectUrl}/storage/v1/object/brufap-received-dfe/${key}`);
  assert.equal(calls[1].url, `${projectUrl}/storage/v1/object/authenticated/brufap-received-dfe/${key}`);
  assert.equal(response.headers.get('Content-Length'), String(bytes.length)); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('X-Private-Debug'), null);
  assert.ok(calls.every(call => call.options.signal.aborted));
});

test('journal path is immutable but its request digest is not confused with its response digest', async () => {
  const calls = [];
  const storage = port(async (url, options) => { calls.push(url); return options.method === 'POST' ? Response.json({}) : xml(); });
  await storage.putImmutable(upload({ key: journal }));
  assert.deepEqual(Buffer.from(await (await storage.read(input({ key: journal }))).arrayBuffer()), bytes);
  assert.equal(calls.length, 2);
});

test('rejects path traversal, foreign buckets, unknown options, mutable writes and wrong content hashes before fetch', async () => {
  let calls = 0; const storage = port(async () => { calls++; return xml(); });
  for (const candidate of ['../x', key.toUpperCase(), key + '?x=1', key + '\n', key + '\r\n', key + '\0', 'objects/%2e%2e.xml', 'objects/' + 'a'.repeat(64) + '/x.xml', 'responses/not-a-uuid/' + 'a'.repeat(64) + '.xml']) {
    await rejects(() => storage.read(input({ key: candidate })), 'DFE_STORAGE_INPUT_INVALID');
  }
  await rejects(() => storage.read(input({ bucket: 'other' })), 'DFE_STORAGE_INPUT_INVALID');
  await rejects(() => storage.read(input({ url: projectUrl })), 'DFE_STORAGE_INPUT_INVALID');
  for (const change of [{ upsert: true }, { ifNoneMatch: undefined }, { contentType: 'text/xml' }, { bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(8388609) }]) {
    await rejects(() => storage.putImmutable(upload(change)), 'DFE_STORAGE_WRITE_INVALID');
  }
  await rejects(() => storage.putImmutable(upload({ key: `objects/${'a'.repeat(64)}.xml` })), 'DFE_STORAGE_HASH_CONFLICT');
  assert.equal(calls, 0);
});

test('normalizes only documented duplicate codes to a readback requirement; never retries or upserts', async () => {
  for (const [status, body] of [[409, { code: 'ResourceAlreadyExists' }], [409, { code: 'KeyAlreadyExists' }], [409, { code: 'already_exists' }], [400, { error: 'Duplicate' }]]) {
    let calls = 0;
    const storage = port(async () => { calls++; return Response.json(body, { status }); });
    assert.deepEqual(await storage.putImmutable(upload()), { status: 409, requires_readback: true }); assert.equal(calls, 1);
  }
  for (const body of [{ code: 'InvalidJWT', error: 'Duplicate' }, { code: 'BucketAlreadyExists' }, { message: 'Asset Already Exists' }, { error: 'Unauthorized' }]) {
    await rejects(() => port(async () => Response.json(body, { status: 400 })).putImmutable(upload()), 'DFE_STORAGE_HTTP_REJECTED');
  }
});

test('only confirmed missing key returns null; missing bucket and denied access remain errors', async () => {
  assert.equal(await port(async () => Response.json({ code: 'NoSuchKey' }, { status: 404 })).read(input()), null);
  for (const [status, body] of [[404, { code: 'NoSuchBucket' }], [404, { code: 'not_found' }], [403, { code: 'AccessDenied' }], [401, { code: 'InvalidJWT' }]]) {
    await rejects(() => port(async () => Response.json(body, { status })).read(input()), 'DFE_STORAGE_HTTP_REJECTED');
  }
});

test('does not follow redirects or trust a mismatched effective response origin', async () => {
  for (const method of ['read', 'putImmutable']) {
    let calls = 0;
    const storage = port(async () => { calls++; return new Response(null, { status: 307, headers: { Location: 'https://evil.invalid/' } }); });
    await rejects(() => storage[method](method === 'read' ? input() : upload()), 'DFE_STORAGE_REDIRECT_REJECTED'); assert.equal(calls, 1);
  }
  const result = xml(); Object.defineProperty(result, 'url', { value: 'https://evil.invalid/file' });
  await rejects(() => port(async () => result).read(input()), 'DFE_STORAGE_RESPONSE_INVALID');
});

test('verifies object bytes and rejects incomplete, encoded, oversized, empty or wrong-MIME responses', async () => {
  await rejects(() => port(async () => xml(Buffer.from('different'))).read(input()), 'DFE_STORAGE_HASH_CONFLICT');
  for (const headers of [{ 'Content-Length': String(bytes.length + 1) }, { 'Content-Length': '-1' }, { 'Content-Encoding': 'gzip' }]) {
    await rejects(() => port(async () => xml(bytes, headers)).read(input()), 'DFE_STORAGE_BODY_INVALID');
  }
  await rejects(() => port(async () => xml(Buffer.alloc(8388609))).read(input()), 'DFE_STORAGE_BODY_LIMIT');
  await rejects(() => port(async () => xml(Buffer.alloc(0))).read(input()), 'DFE_STORAGE_BODY_INVALID');
  await rejects(() => port(async () => new Response(bytes, { headers: { 'Content-Type': 'text/xml' } })).read(input()), 'DFE_STORAGE_HTTP_REJECTED');
  await rejects(() => port(async () => xml(bytes, { 'Content-Length': '8388609' })).read(input()), 'DFE_STORAGE_BODY_INVALID');
});

test('bounds acknowledgement/error bodies and sanitizes provider, driver and malformed JSON errors', async () => {
  for (const status of [200, 400]) {
    await rejects(() => port(async () => new Response('x'.repeat(8193), { status, headers: { 'Content-Type': 'application/json' } })).putImmutable(upload()), 'DFE_STORAGE_BODY_LIMIT');
  }
  const sensitive = 'SYNTHETIC_RAW_PROVIDER_DETAILS';
  await rejects(() => port(async () => { throw new Error(sensitive); }).read(input()), 'DFE_STORAGE_IO_FAILED');
  await assert.rejects(() => port(async () => new Response('{' + sensitive, { status: 400, headers: { 'Content-Type': 'application/json' } })).putImmutable(upload()), error => {
    assert.doesNotMatch(String(error) + JSON.stringify(error), /SYNTHETIC_RAW_PROVIDER_DETAILS|synthetic-storage-service-key/); return true;
  });
});

test('whole-call deadline covers stalled body and late headers; abort cancels without a retry', async () => {
  let cancelled = false, calls = 0;
  const stalled = port(async () => { calls++; return xml(new ReadableStream({ cancel() { cancelled = true; } })); });
  await rejects(() => stalled.read(input({ deadline: Date.now() + 25 })), 'DFE_STORAGE_TIMEOUT');
  assert.equal(cancelled, true); assert.equal(calls, 1);
  let release, lateCancelled = false;
  const late = port(() => new Promise(resolve => { release = resolve; }));
  await rejects(() => late.read(input({ deadline: Date.now() + 25 })), 'DFE_STORAGE_TIMEOUT');
  release(xml(new ReadableStream({ cancel() { lateCancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(lateCancelled, true);
  const controller = new AbortController(); let seen;
  const aborting = port(async (_, options) => { seen = options.signal; return xml(new ReadableStream()); });
  const result = aborting.read(input({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await rejects(() => result, 'DFE_STORAGE_ABORTED'); assert.equal(seen.aborted, true);
});

test('expired deadlines and already aborted calls never invoke the fetch port', async () => {
  let calls = 0; const storage = port(async () => { calls++; return xml(); });
  await rejects(() => storage.read(input({ deadline: Date.now() - 1 })), 'DFE_STORAGE_DEADLINE_INVALID');
  const controller = new AbortController(); controller.abort();
  await rejects(() => storage.read(input({ signal: controller.signal })), 'DFE_STORAGE_ABORTED');
  assert.equal(calls, 0);
});
