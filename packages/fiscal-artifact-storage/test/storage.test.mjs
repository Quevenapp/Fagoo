import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFiscalArtifactStorage, FiscalArtifactStorageError } from '../src/storage.mjs';

const projectUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const serviceKey = 'synthetic-storage-service-key';
const bytes = Buffer.from('<synthetic>PRIVATE FIXTURE</synthetic>');
const digest = value => createHash('sha256').update(value).digest('hex');
const jobId = '11111111-1111-4111-8111-111111111111';
const key = `jobs/${jobId}/${digest(bytes)}.xml`;
const input = (extra = {}) => ({ bucket: 'brufap-fiscal-artifacts', key, deadline: Date.now() + 10000, ...extra });
const upload = (extra = {}) => input({ bytes, contentType: 'application/octet-stream', upsert: false, ifNoneMatch: '*', ...extra });
const port = fetchImpl => createFiscalArtifactStorage({ projectUrl, serviceKey, fetchImpl });
const xml = (value = bytes, headers = {}) => new Response(value, { headers: { 'Content-Type': 'application/octet-stream', ...headers } });
const rejects = (fn, code) => assert.rejects(fn, error => error instanceof FiscalArtifactStorageError && error.code === code && !error.cause);

test('requires explicit trusted dependencies and restricts the destination before handling credentials', () => {
  for (const url of ['http://abcdefghijklmnopqrst.supabase.co', projectUrl + '/', projectUrl + '/other', projectUrl + '?token=x', projectUrl + '@evil.invalid', 'https://evil.invalid', 'https://x.supabase.co']) {
    assert.throws(() => createFiscalArtifactStorage({ projectUrl: url, serviceKey, fetchImpl: async () => {} }), /FISCAL_ARTIFACT_STORAGE_PROJECT_INVALID/);
  }
  assert.throws(() => createFiscalArtifactStorage({ projectUrl, serviceKey }), /FISCAL_ARTIFACT_STORAGE_DRIVER_REQUIRED/);
  assert.throws(() => createFiscalArtifactStorage({ projectUrl, serviceKey: serviceKey + '\n', fetchImpl: async () => {} }), /FISCAL_ARTIFACT_STORAGE_CREDENTIAL_INVALID/);
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
  assert.equal(calls[0].url, `${projectUrl}/storage/v1/object/brufap-fiscal-artifacts/${key}`);
  assert.equal(calls[1].url, `${projectUrl}/storage/v1/object/authenticated/brufap-fiscal-artifacts/${key}`);
  assert.equal(response.headers.get('Content-Length'), String(bytes.length)); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('X-Private-Debug'), null);
  assert.ok(calls.every(call => call.options.signal.aborted));
});

test('rejects path traversal, foreign buckets, unknown options, mutable writes and wrong content hashes before fetch', async () => {
  let calls = 0; const storage = port(async () => { calls++; return xml(); });
  for (const candidate of [`objects/${digest(bytes)}.xml`, `responses/${jobId}/${digest(bytes)}.xml`, `jobs/${jobId}/${digest(bytes)}.pfx`, '../x', key.toUpperCase(), key + '?x=1', key + '\n', key + '\r\n', key + '\0', 'objects/%2e%2e.xml', 'objects/' + 'a'.repeat(64) + '/x.xml', 'responses/not-a-uuid/' + 'a'.repeat(64) + '.xml']) {
    await rejects(() => storage.read(input({ key: candidate })), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  }
  await rejects(() => storage.read(input({ bucket: 'other' })), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  await rejects(() => storage.read(input({ url: projectUrl })), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  for (const change of [{ upsert: true }, { ifNoneMatch: undefined }, { contentType: 'text/xml' }, { bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(8388609) }]) {
    await rejects(() => storage.putImmutable(upload(change)), 'FISCAL_ARTIFACT_STORAGE_WRITE_INVALID');
  }
  await rejects(() => storage.putImmutable(upload({ key: `jobs/${jobId}/${'a'.repeat(64)}.xml` })), 'FISCAL_ARTIFACT_STORAGE_HASH_CONFLICT');
  assert.equal(calls, 0);
});

test('signed candidates use the same immutable, hash-checked boundary without accepting arbitrary namespaces', async () => {
  const candidateKey = `candidates/${jobId}/${digest(bytes)}.xml`, calls = [];
  const storage = port(async (url, options) => {
    calls.push({url, method: options.method});
    if(options.method === 'POST') {
      assert.equal(options.headers['x-upsert'], 'false');
      assert.equal(options.headers['If-None-Match'], '*');
      return Response.json({Key:'synthetic-ignored'}, {status:201});
    }
    return xml(bytes);
  });
  assert.deepEqual(await storage.putImmutable(upload({key:candidateKey})), {status:201,requires_readback:true});
  assert.deepEqual(Buffer.from(await (await storage.read(input({key:candidateKey}))).arrayBuffer()), bytes);
  assert.equal(calls[0].url, `${projectUrl}/storage/v1/object/brufap-fiscal-artifacts/${candidateKey}`);
  assert.equal(calls[1].url, `${projectUrl}/storage/v1/object/authenticated/brufap-fiscal-artifacts/${candidateKey}`);
  for(const invalid of [candidateKey.replace('candidates/','candidate/'),candidateKey.replace('candidates/','credentials/'),candidateKey.replace('/'+jobId+'/', '/'+jobId+'/../'),candidateKey+'?download=1',candidateKey.toUpperCase()]) {
    await rejects(()=>storage.read(input({key:invalid})), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  }
  await rejects(()=>storage.putImmutable(upload({key:`candidates/${jobId}/${'a'.repeat(64)}.xml`})), 'FISCAL_ARTIFACT_STORAGE_HASH_CONFLICT');
  await rejects(()=>port(async()=>xml(Buffer.from('corrupted'))).read(input({key:candidateKey})), 'FISCAL_ARTIFACT_STORAGE_HASH_CONFLICT');
  assert.equal(calls.length, 2);
});

test('normalizes only documented duplicate codes to a readback requirement; never retries or upserts', async () => {
  for (const [status, body] of [[409, { code: 'ResourceAlreadyExists' }], [409, { code: 'KeyAlreadyExists' }], [409, { code: 'already_exists' }], [400, { error: 'Duplicate' }]]) {
    let calls = 0;
    const storage = port(async () => { calls++; return Response.json(body, { status }); });
    assert.deepEqual(await storage.putImmutable(upload()), { status: 409, requires_readback: true }); assert.equal(calls, 1);
  }
  for (const body of [{ code: 'InvalidJWT', error: 'Duplicate' }, { code: 'BucketAlreadyExists' }, { message: 'Asset Already Exists' }, { error: 'Unauthorized' }]) {
    await rejects(() => port(async () => Response.json(body, { status: 400 })).putImmutable(upload()), 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
  }
});

test('WSDL evidence has an isolated fixed namespace and a tighter 512000 byte write/read limit', async () => {
  const wsdlKey = `wsdl/${jobId}/${digest(bytes)}.xml`, calls=[];
  const storage=port(async(url,options)=>{calls.push(url);return options.method==='POST'?Response.json({}, {status:201}):xml(bytes);});
  await storage.putImmutable(upload({key:wsdlKey}));
  assert.deepEqual(Buffer.from(await(await storage.read(input({key:wsdlKey}))).arrayBuffer()),bytes);
  assert.ok(calls.every(url=>url.endsWith('/'+wsdlKey)));
  const maximum=Buffer.alloc(512000,120), maxKey=`wsdl/${jobId}/${digest(maximum)}.xml`;
  assert.deepEqual(await port(async()=>Response.json({}, {status:201})).putImmutable(upload({key:maxKey,bytes:maximum})),{status:201,requires_readback:true});
  const tooLarge=Buffer.alloc(512001,120), largeKey=`wsdl/${jobId}/${digest(tooLarge)}.xml`;
  await rejects(()=>storage.putImmutable(upload({key:largeKey,bytes:tooLarge})),'FISCAL_ARTIFACT_STORAGE_WRITE_INVALID');
  await rejects(()=>port(async()=>xml(tooLarge)).read(input({key:largeKey})),'FISCAL_ARTIFACT_STORAGE_BODY_LIMIT');
  await rejects(()=>port(async()=>xml(tooLarge,{'Content-Length':String(tooLarge.length)})).read(input({key:largeKey})),'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
  for(const bad of [wsdlKey.replace('wsdl/','wsdls/'),wsdlKey.replace('.xml','.json'),wsdlKey+'?x',wsdlKey.replace(jobId,jobId+'/..')])
    await rejects(()=>storage.read(input({key:bad})),'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  assert.equal(calls.length,2);
});

test('only confirmed missing key returns null; missing bucket and denied access remain errors', async () => {
  assert.equal(await port(async () => Response.json({ code: 'NoSuchKey' }, { status: 404 })).read(input()), null);
  for (const statusCode of ['404', 404]) {
    assert.equal(await port(async () => Response.json({code:'NoSuchKey',statusCode,error:'not_found',message:'Object not found'}, {status:400})).read(input()), null);
  }
  for (const [status, body] of [[404, { code: 'NoSuchBucket' }], [404, { code: 'not_found' }], [403, { code: 'AccessDenied' }], [401, { code: 'InvalidJWT' }]]) {
    await rejects(() => port(async () => Response.json(body, { status })).read(input()), 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
  }
  for (const body of [{code:'NoSuchKey'}, {code:'NoSuchKey',statusCode:'400'}, {code:'NoSuchBucket',statusCode:'404'}, {code:'AccessDenied',statusCode:'404'}, {statusCode:'404',error:'not_found',message:'Object not found'}]) {
    await rejects(() => port(async () => Response.json(body, {status:400})).read(input()), 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
  }
});

test('does not follow redirects or trust a mismatched effective response origin', async () => {
  for (const method of ['read', 'putImmutable']) {
    let calls = 0;
    const storage = port(async () => { calls++; return new Response(null, { status: 307, headers: { Location: 'https://evil.invalid/' } }); });
    await rejects(() => storage[method](method === 'read' ? input() : upload()), 'FISCAL_ARTIFACT_STORAGE_REDIRECT_REJECTED'); assert.equal(calls, 1);
  }
  const result = xml(); Object.defineProperty(result, 'url', { value: 'https://evil.invalid/file' });
  await rejects(() => port(async () => result).read(input()), 'FISCAL_ARTIFACT_STORAGE_RESPONSE_INVALID');
});

test('verifies object bytes and rejects incomplete, encoded, oversized, empty or wrong-MIME responses', async () => {
  await rejects(() => port(async () => xml(Buffer.from('different'))).read(input()), 'FISCAL_ARTIFACT_STORAGE_HASH_CONFLICT');
  for (const headers of [{ 'Content-Length': String(bytes.length + 1) }, { 'Content-Length': '-1' }, { 'Content-Encoding': 'gzip' }]) {
    await rejects(() => port(async () => xml(bytes, headers)).read(input()), 'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
  }
  await rejects(() => port(async () => xml(Buffer.alloc(8388609))).read(input()), 'FISCAL_ARTIFACT_STORAGE_BODY_LIMIT');
  await rejects(() => port(async () => xml(Buffer.alloc(0))).read(input()), 'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
  await rejects(() => port(async () => new Response(bytes, { headers: { 'Content-Type': 'text/xml' } })).read(input()), 'FISCAL_ARTIFACT_STORAGE_HTTP_REJECTED');
  await rejects(() => port(async () => xml(bytes, { 'Content-Length': '8388609' })).read(input()), 'FISCAL_ARTIFACT_STORAGE_BODY_INVALID');
});

test('bounds acknowledgement/error bodies and sanitizes provider, driver and malformed JSON errors', async () => {
  for (const status of [200, 400]) {
    await rejects(() => port(async () => new Response('x'.repeat(8193), { status, headers: { 'Content-Type': 'application/json' } })).putImmutable(upload()), 'FISCAL_ARTIFACT_STORAGE_BODY_LIMIT');
  }
  const sensitive = 'SYNTHETIC_RAW_PROVIDER_DETAILS';
  await rejects(() => port(async () => { throw new Error(sensitive); }).read(input()), 'FISCAL_ARTIFACT_STORAGE_IO_FAILED');
  await assert.rejects(() => port(async () => new Response('{' + sensitive, { status: 400, headers: { 'Content-Type': 'application/json' } })).putImmutable(upload()), error => {
    assert.doesNotMatch(String(error) + JSON.stringify(error), /SYNTHETIC_RAW_PROVIDER_DETAILS|synthetic-storage-service-key/); return true;
  });
});

test('whole-call deadline covers stalled body and late headers; abort cancels without a retry', async () => {
  let cancelled = false, calls = 0;
  const stalled = port(async () => { calls++; return xml(new ReadableStream({ cancel() { cancelled = true; } })); });
  await rejects(() => stalled.read(input({ deadline: Date.now() + 25 })), 'FISCAL_ARTIFACT_STORAGE_TIMEOUT');
  assert.equal(cancelled, true); assert.equal(calls, 1);
  let release, lateCancelled = false;
  const late = port(() => new Promise(resolve => { release = resolve; }));
  await rejects(() => late.read(input({ deadline: Date.now() + 25 })), 'FISCAL_ARTIFACT_STORAGE_TIMEOUT');
  release(xml(new ReadableStream({ cancel() { lateCancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(lateCancelled, true);
  const controller = new AbortController(); let seen;
  const aborting = port(async (_, options) => { seen = options.signal; return xml(new ReadableStream()); });
  const result = aborting.read(input({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await rejects(() => result, 'FISCAL_ARTIFACT_STORAGE_ABORTED'); assert.equal(seen.aborted, true);
});

test('expired deadlines and already aborted calls never invoke the fetch port', async () => {
  let calls = 0; const storage = port(async () => { calls++; return xml(); });
  await rejects(() => storage.read(input({ deadline: Date.now() - 1 })), 'FISCAL_ARTIFACT_STORAGE_DEADLINE_INVALID');
  const controller = new AbortController(); controller.abort();
  await rejects(() => storage.read(input({ signal: controller.signal })), 'FISCAL_ARTIFACT_STORAGE_ABORTED');
  assert.equal(calls, 0);
});

test('GET captures its validated path, deadline and cancellation source before the first await', async () => {
  const original = new AbortController(), replacement = new AbortController();
  let destination;
  const storage = port(async url => { destination = url; return xml(); });
  const mutable = input({signal:original.signal});
  const pending = storage.read(mutable);
  mutable.key = '../unvalidated-path'; mutable.bucket = 'another-bucket';
  mutable.deadline = 0; mutable.signal = replacement.signal; replacement.abort();
  const result = await pending;
  assert.equal(destination, `${projectUrl}/storage/v1/object/authenticated/brufap-fiscal-artifacts/${key}`);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
  assert.equal(original.signal.aborted, false);
});

test('POST snapshots bytes and all immutable write options before caller mutation', async () => {
  const callerBytes = Buffer.from(bytes), candidateKey = key.replace('jobs/', 'candidates/');
  let sent, destination, retainedBody;
  const storage = port(async (url, options) => {
    destination = url; sent = Buffer.from(options.body); retainedBody = options.body;
    assert.equal(options.headers['x-upsert'], 'false'); assert.equal(options.headers['If-None-Match'], '*');
    return Response.json({}, {status:201});
  });
  const mutable = upload({key:candidateKey, bytes:callerBytes});
  const pending = storage.putImmutable(mutable);
  callerBytes.fill(120); mutable.bytes = Buffer.from('replaced'); mutable.key = '../unvalidated-path';
  mutable.contentType = 'text/html'; mutable.upsert = true; mutable.ifNoneMatch = null; mutable.deadline = 0;
  assert.deepEqual(await pending, {status:201,requires_readback:true});
  assert.equal(destination, `${projectUrl}/storage/v1/object/brufap-fiscal-artifacts/${candidateKey}`);
  assert.deepEqual(sent, bytes); assert.ok(retainedBody.every(byte => byte === 0));
  assert.ok(callerBytes.every(byte => byte === 120));
});

test('GET and POST retain cancellation and remove the original listener after signal property replacement', async () => {
  for (const writing of [false, true]) {
    const original = new AbortController(), replacement = new AbortController();
    let removed = 0, removedReplacement = 0, cancelled = false, observedSignal;
    const originalRemove = original.signal.removeEventListener.bind(original.signal);
    original.signal.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
    const replacementRemove = replacement.signal.removeEventListener.bind(replacement.signal);
    replacement.signal.removeEventListener = (...args) => { removedReplacement++; return replacementRemove(...args); };
    const storage = port(async (_, options) => {
      observedSignal = options.signal;
      return new Response(new ReadableStream({cancel(){cancelled=true;}}), {headers:{'Content-Type':writing?'application/json':'application/octet-stream'}});
    });
    const mutable = writing ? upload({signal:original.signal}) : input({signal:original.signal});
    const pending = writing ? storage.putImmutable(mutable) : storage.read(mutable);
    const rejected = rejects(() => pending, 'FISCAL_ARTIFACT_STORAGE_ABORTED');
    mutable.signal = replacement.signal; mutable.deadline = Date.now() + 100000;
    await new Promise(resolve => setImmediate(resolve)); original.abort(); await rejected;
    assert.equal(observedSignal.aborted,true); assert.equal(cancelled,true);
    assert.equal(removed,1); assert.equal(removedReplacement,0); assert.equal(replacement.signal.aborted,false);
  }
});

test('accessors, hidden unknown options, symbols and inherited required properties fail before fetch', async () => {
  let calls = 0, getterCalls = 0;
  const storage = port(async () => { calls++; return xml(); });
  for (const field of ['bucket','key','signal','deadline','bytes','contentType']) {
    const mutable = upload();
    Object.defineProperty(mutable, field, {enumerable:true, get(){getterCalls++;throw new Error('SYNTHETIC_ACCESSOR_PRIVATE');}});
    await rejects(() => storage.putImmutable(mutable), 'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  }
  const hidden = input(); Object.defineProperty(hidden,'unknown',{value:true});
  const symbol = input(); symbol[Symbol('unknown')] = true;
  for(const value of [hidden,symbol,Object.create(input())])await rejects(() => storage.read(value),'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  const deceptive = new Proxy(input(), {ownKeys(){throw new Error('SYNTHETIC_ACCESSOR_PRIVATE');}});
  await rejects(() => storage.read(deceptive),'FISCAL_ARTIFACT_STORAGE_INPUT_INVALID');
  assert.equal(calls,0); assert.equal(getterCalls,0);
});
