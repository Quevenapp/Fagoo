import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessController, AccessError } from '../src/lib/real-access.ts';
import { attachmentFileType, attachmentPath, fileHash, resumableFile, MAX_FILE_BYTES } from '../src/lib/attachment-model.ts';
const uid = 'a0000000-0000-4000-8000-000000000001', doc = 'b0000000-0000-4000-8000-000000000001', att = 'c0000000-0000-4000-8000-000000000001';
const session = { access_token: 'synthetic-token', user: { id: uid } };
const me = { user_id: uid, role: 'admin', resources: [], data_mode: 'staging_readonly' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const auth = () => ({ getSession: async () => ({ data: { session }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) });
const path = action => attachmentPath('sales_orders', doc, action ? att : undefined, action);
const status = code => error => error instanceof AccessError && error.status === code;

test('attachment file model keeps exact size/hash identity and limits names/extensions before selecting content', async () => {
  const bytes = new Blob(['fictício']); const sha = await fileHash(bytes);
  assert.match(sha, /^[a-f0-9]{64}$/);
  assert.equal(attachmentFileType({ name: 'nota.XML', size: bytes.size }), 'application/xml');
  assert.equal(attachmentFileType({ name: 'foto.jpeg', size: 1 }), 'image/jpeg');
  for (const file of [{ name: 'app.html', size: 1 }, { name: 'x.txt', size: 0 }, { name: 'x.txt', size: MAX_FILE_BYTES + 1 }, { name: 'x\n.txt', size: 1 }]) assert.throws(() => attachmentFileType(file));
  const row = { status: 'reserved', size_bytes: bytes.size, sha256: sha, mime_type: 'text/plain' };
  assert.equal(resumableFile(row, bytes.size, sha, 'text/plain'), true);
  assert.equal(resumableFile({ ...row, status: 'ready' }, bytes.size, sha, 'text/plain'), false);
  assert.equal(resumableFile(row, bytes.size, '0'.repeat(64), 'text/plain'), false);
});

test('controller constrains routes and sends binary body only to the authenticated upload route', async () => {
  const calls = []; const controller = createAccessController(auth(), 'https://api.example.test', async (url, options) => {
    if (url.endsWith('/me')) return Response.json(me); calls.push({ url, options });
    return url.endsWith('/download') ? new Response('fictício', { headers: { 'Content-Type': 'application/octet-stream' } }) : Response.json({ data_mode: 'erp_native' });
  });
  const stop = controller.start(); await tick();
  try {
    await controller.attachments(path(), { method: 'POST', body: { filename: 'teste.txt' } });
    const blob = new Blob(['fictício']); await controller.attachments(path('upload'), { method: 'PUT', body: blob, contentType: 'text/plain' });
    assert.equal(calls[1].options.body, blob); assert.equal(calls[1].options.headers['Content-Type'], 'text/plain');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-token'); assert.equal(calls[1].options.redirect, 'error');
    const downloaded = await controller.attachments(path('download'), { download: true });
    assert.ok(downloaded instanceof Blob); assert.equal(downloaded.type, 'application/octet-stream');
    const count = calls.length;
    for (const invalid of [path() + '?raw=true', path() + '/../outside', 'https://untrusted.example', path().replace('/anexos', '/%2e%2e/anexos')]) await assert.rejects(() => controller.attachments(invalid), status(400));
    await assert.rejects(() => controller.attachments(path('upload'), { method: 'PUT', body: new Blob(['x']), contentType: 'text/html' }), status(400));
    await assert.rejects(() => controller.attachments(path('upload'), { method: 'PUT', body: 'not-a-blob', contentType: 'text/plain' }), status(400));
    await assert.rejects(() => controller.attachments(path('download')), status(400));
    assert.equal(calls.length, count);
  } finally { stop(); }
});

test('controller bounds downloads and rejects inline response types', async () => {
  for (const headers of [{ 'Content-Type': 'text/html' }, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(MAX_FILE_BYTES + 1) }]) {
    const controller = createAccessController(auth(), 'https://api.example.test', async url => url.endsWith('/me') ? Response.json(me) : new Response('x', { headers }));
    const stop = controller.start(); await tick();
    try { await assert.rejects(() => controller.attachments(path('download'), { download: true }), status(502)); }
    finally { stop(); }
  }
});

test('logout aborts a binary request and suppresses its late result', async () => {
  let finish, signal;
  const controller = createAccessController(auth(), 'https://api.example.test', async (url, options) => {
    if (url.endsWith('/me')) return Response.json(me); signal = options.signal; return new Promise(resolve => { finish = resolve; });
  });
  const stop = controller.start(); await tick();
  const pending = controller.attachments(path('download'), { download: true }); await tick();
  await controller.logout(); assert.equal(signal.aborted, true);
  finish(new Response('fictício', { headers: { 'Content-Type': 'application/octet-stream' } }));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(controller.getSnapshot().phase, 'signed_out'); stop();
});

test('caller cancellation stops binary upload without losing the authenticated session', async () => {
  let finish, signal;
  const controller = createAccessController(auth(), 'https://api.example.test', async (url, options) => {
    if (url.endsWith('/me')) return Response.json(me); signal = options.signal; return new Promise(resolve => { finish = resolve; });
  });
  const stop = controller.start(); await tick(); const request = new AbortController();
  const pending = controller.attachments(path('upload'), { method: 'PUT', body: new Blob(['fictício']), contentType: 'text/plain', signal: request.signal });
  await tick(); request.abort(); assert.equal(signal.aborted, true); finish(Response.json({}));
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(controller.getSnapshot().phase, 'ready'); stop();
});
