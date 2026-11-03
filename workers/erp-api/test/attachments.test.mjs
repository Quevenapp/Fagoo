import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { attachmentRoute, attachmentMethods, executeAttachmentRoute, createAttachmentStorage, ATTACHMENT_BUCKET_CONFIG } from '../src/attachments.mjs';
import { attachmentFilename, attachmentHash, boundedAttachmentBytes, validateAttachmentContent, MAX_ATTACHMENT_BYTES } from '../src/attachment-content.mjs';
import { createHandler } from '../src/index.mjs';

let db, contact;
const users = {};
const textBytes = new TextEncoder().encode('Anexo inteiramente fictício.\n');
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const sqlError = code => error => error.code === code;
const httpError = status => error => error.status === status;
async function rpc(name, args) {
  await db.exec('set role service_role');
  try {
    const entries = Object.entries(args);
    return await scalar(`select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) value`, entries.map(([, value]) => value));
  } finally { await db.exec('reset role'); }
}
async function document(kind = 'sales_orders') {
  const result = await rpc('erp_document_save', { p_user_id: users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: JSON.stringify({ date: '2024-10-15', contact_id: contact.id, items: [{ description: 'Item fictício', unit: 'UN', quantity: '1', unit_price: '1' }] }) });
  return result.document;
}
const args = (doc, id) => ({ p_user_id: users.admin, p_kind: doc.kind, p_document_id: doc.id, ...(id ? { p_id: id } : {}) });
async function reserve(doc, options = {}) {
  return rpc('erp_attachment_reserve', { ...args(doc), p_command_id: options.command || randomUUID(), p_filename: 'anexo-ficticio.txt', p_mime_type: 'text/plain', p_size_bytes: textBytes.length, p_sha256: await attachmentHash(textBytes), ...options.override });
}
const path = (doc, id, action) => `/v1/documentos/${doc.kind}/${doc.id}/anexos${id ? `/${id}/${action}` : ''}`;
const req = (url, method = 'GET', body, type = 'application/json') => new Request(`https://api.example.test${url}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': type }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) } : {}) });
function memoryStorage() {
  const files = new Map(), operations = [];
  return {
    files, operations,
    put: async (key, bytes, mime) => {
      operations.push(['put', key]);
      if (files.has(key)) return false;
      files.set(key, bytes.slice());
      await db.query("insert into storage.objects(bucket_id,name,metadata) values('erp-attachments',$1,$2::jsonb)", [key, JSON.stringify({ size: bytes.length, mimetype: mime })]);
      return true;
    },
    get: async key => {
      operations.push(['get', key]);
      const bytes = files.get(key); return bytes ? new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }) : new Response(null, { status: 404 });
    },
  };
}
async function run(request, storage = memoryStorage(), userId = users.admin, rpcImpl = rpc) {
  return executeAttachmentRoute(request, attachmentRoute(new URL(request.url).pathname), { userId, rpc: rpcImpl, storage });
}
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;
    grant select,insert on storage.objects to anon,authenticated;
    create policy synthetic_broad_policy on storage.objects for all to anon,authenticated using(true) with check(true);`);
  for (const suffix of ['0001_origin_sync', '0002_origin_quotes_nfce', '0004_erp_access', '0005_origin_auxiliary_catalogs', '0006_erp_catalog', '0008_erp_documents', '0012_erp_attachments']) {
    await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`, import.meta.url), 'utf8'));
  }
  const b = ATTACHMENT_BUCKET_CONFIG;
  await db.query('insert into storage.buckets values($1,$2,$3,$4,$5)', [b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types]);
  for (const role of ['admin', 'vendas', 'estoque', 'consulta', 'fiscal', 'financeiro', 'inactive']) {
    users[role] = randomUUID(); await db.query('insert into auth.users values($1)', [users[role]]);
    await db.query('insert into erp_access.membership(user_id,role,active) values($1,$2,$3)', [users[role], role === 'inactive' ? 'admin' : role, role !== 'inactive']);
  }
  contact = (await rpc('erp_catalog_save', { p_user_id: users.admin, p_entity: 'contacts', p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: JSON.stringify({ name: 'Contato fictício anexos' }) })).record;
});
after(async () => db?.close());

test('private ACL, restrictive Storage policy and document roles prevent direct access and IDOR', async () => {
  const sale = await document(), purchase = await document('purchase_orders');
  const attachment = (await reserve(sale)).attachment;
  const privateRows = (await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_attachments' and c.relkind='r'")).rows;
  assert.equal(privateRows.length, 2); assert.ok(privateRows.every(row => row.relrowsecurity));
  for (const role of ['anon', 'authenticated', 'service_role']) for (const table of ['attachment', 'audit']) assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') value", [role, `erp_attachments.${table}`]), false);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(() => scalar('select public.erp_attachment_list($1,$2,$3) value', [users.admin, sale.kind, sale.id]), sqlError('42501'));
      await assert.rejects(() => db.query("insert into storage.objects(bucket_id,name) values('erp-attachments','forged')"), sqlError('42501'));
    } finally { await db.exec('reset role'); }
  }
  for (const role of ['consulta', 'financeiro', 'fiscal', 'estoque', 'inactive']) await assert.rejects(() => reserve(sale, { override: { p_user_id: users[role] } }), sqlError('42501'));
  await reserve(sale, { override: { p_user_id: users.vendas } });
  await reserve(purchase, { override: { p_user_id: users.estoque } });
  await assert.rejects(() => reserve(purchase, { override: { p_user_id: users.vendas } }), sqlError('42501'));
  await assert.rejects(() => rpc('erp_attachment_object', { ...args(purchase, attachment.id), p_write: true }), sqlError('P0002'));
  await assert.rejects(() => rpc('erp_attachment_list', { ...args(sale), p_kind: 'purchase_orders' }), sqlError('P0002'));
});

test('reservation replay binds actor and all metadata; abort never frees the lifetime document quota', async () => {
  const doc = await document(), command = randomUUID();
  const first = await reserve(doc, { command });
  assert.equal((await reserve(doc, { command })).attachment.id, first.attachment.id);
  assert.equal((await reserve(doc, { command })).replayed, true);
  await assert.rejects(() => reserve(doc, { command, override: { p_size_bytes: textBytes.length + 1 } }), sqlError('40001'));
  await assert.rejects(() => reserve(doc, { command, override: { p_user_id: users.vendas } }), sqlError('40001'));
  await rpc('erp_attachment_stop', { ...args(doc, first.attachment.id), p_abort: true });
  assert.equal((await reserve(doc, { command })).attachment.status, 'aborted');
  for (let i = 1; i < 100; i++) await reserve(doc);
  await assert.rejects(() => reserve(doc), sqlError('54000'));
  assert.equal((await rpc('erp_attachment_list', args(doc))).items.length, 100);
});

test('leases reject competing upload/abort and finalize requires exact stored object metadata', async () => {
  const doc = await document(), a = (await reserve(doc)).attachment, lease = randomUUID();
  const claimed = await rpc('erp_attachment_claim', { ...args(doc, a.id), p_lease: lease });
  await assert.rejects(() => rpc('erp_attachment_claim', { ...args(doc, a.id), p_lease: randomUUID() }), sqlError('40001'));
  await assert.rejects(() => rpc('erp_attachment_stop', { ...args(doc, a.id), p_abort: true }), sqlError('40001'));
  const finish = () => rpc('erp_attachment_finish', { ...args(doc, a.id), p_lease: lease, p_sha256: a.sha256, p_size_bytes: a.size_bytes });
  await assert.rejects(finish, sqlError('40001'));
  await db.query("insert into storage.objects(bucket_id,name,metadata) values('erp-attachments',$1,$2::jsonb)", [claimed.object_key, JSON.stringify({ size: a.size_bytes + 1, mimetype: a.mime_type })]);
  await assert.rejects(finish, sqlError('40001'));
  await db.query("update storage.objects set metadata=$2::jsonb where name=$1", [claimed.object_key, JSON.stringify({ size: a.size_bytes, mimetype: a.mime_type })]);
  assert.equal((await finish()).attachment.status, 'ready');
  assert.equal((await finish()).replayed, true);
  await assert.rejects(() => db.query('delete from erp_attachments.attachment where id=$1', [a.id]), sqlError('40001'));
  await assert.rejects(() => db.query("update erp_attachments.attachment set sha256=repeat('0',64) where id=$1", [a.id]), sqlError('40001'));
});

test('expired leases permit retries but stale tokens cannot finalize or release the new owner', async () => {
  const doc = await document(), a = (await reserve(doc)).attachment, oldLease = randomUUID(), nextLease = randomUUID();
  await rpc('erp_attachment_claim', { ...args(doc, a.id), p_lease: oldLease });
  await db.query("update erp_attachments.attachment set lease_until=clock_timestamp()-interval '1 second' where id=$1", [a.id]);
  await rpc('erp_attachment_claim', { ...args(doc, a.id), p_lease: nextLease });
  await rpc('erp_attachment_stop', { ...args(doc, a.id), p_abort: false, p_lease: oldLease });
  assert.equal(await scalar('select lease_token::text value from erp_attachments.attachment where id=$1', [a.id]), nextLease);
  await assert.rejects(() => rpc('erp_attachment_finish', { ...args(doc, a.id), p_lease: oldLease, p_sha256: a.sha256, p_size_bytes: a.size_bytes }), sqlError('40001'));
  await rpc('erp_attachment_stop', { ...args(doc, a.id), p_abort: false, p_lease: nextLease });
  assert.equal((await rpc('erp_attachment_stop', { ...args(doc, a.id), p_abort: true })).attachment.status, 'aborted');
  await assert.rejects(() => rpc('erp_attachment_claim', { ...args(doc, a.id), p_lease: randomUUID() }), sqlError('40001'));
});

test('end-to-end reserve/upload/download returns safe DTO and verifies bytes before marking ready', async () => {
  const doc = await document(), storage = memoryStorage();
  const reserved = await run(req(path(doc), 'POST', { command_id: randomUUID(), filename: '../../Cotação 01.txt', mime_type: 'text/plain', size_bytes: textBytes.length, sha256: await attachmentHash(textBytes) }), storage);
  const a = reserved.body.attachment;
  assert.equal(a.filename, 'anexo-Cotacao-01.txt');
  assert.equal(a.object_key, undefined); assert.equal(a.actor, undefined);
  const uploaded = await run(req(path(doc, a.id, 'upload'), 'PUT', textBytes, 'text/plain'), storage);
  assert.equal(uploaded.body.attachment.status, 'ready');
  assert.deepEqual(storage.operations.map(op => op[0]), ['put', 'get']);
  assert.equal((await run(req(path(doc, a.id, 'upload'), 'PUT', textBytes, 'text/plain'), storage)).body.replayed, true);
  assert.equal(storage.operations.filter(op => op[0] === 'put').length, 1);
  const download = await run(req(path(doc, a.id, 'download')), storage, users.consulta);
  assert.deepEqual(download.bytes, textBytes);
  assert.equal(download.headers['Content-Type'], 'application/octet-stream');
  assert.equal(download.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(download.headers['Cache-Control'], 'no-store');
  assert.equal(download.headers['Content-Disposition'], 'attachment; filename="anexo-Cotacao-01.txt"');
  const list = await run(req(path(doc)), storage, users.consulta);
  assert.equal(list.body.items[0].status, 'ready');
  assert.doesNotMatch(JSON.stringify(list), /object_key|lease_token|request_hash|service_role/);
});

test('ambiguous upload or finalize failure is recoverable without overwriting or duplicating objects', async () => {
  const doc = await document(), a = (await reserve(doc)).attachment, storage = memoryStorage(), put = storage.put;
  storage.put = async (...params) => { await put(...params); throw new Error('synthetic disconnect'); };
  let failure = true;
  const flaky = async (name, params) => { if (name === 'erp_attachment_finish' && failure) { failure = false; throw new Error('synthetic unavailable'); } return rpc(name, params); };
  await assert.rejects(() => run(req(path(doc, a.id, 'upload'), 'PUT', textBytes, 'text/plain'), storage, users.admin, flaky));
  assert.equal(await scalar('select status value from erp_attachments.attachment where id=$1', [a.id]), 'reserved');
  assert.equal(await scalar('select lease_token value from erp_attachments.attachment where id=$1', [a.id]), null);
  assert.equal((await run(req(path(doc, a.id, 'upload'), 'PUT', textBytes, 'text/plain'), storage)).body.attachment.status, 'ready');
  assert.equal(storage.files.size, 1);
});

test('wrong body hash is rejected before Storage and corrupt stored bytes never finalize or download', async () => {
  const doc = await document(), a = (await reserve(doc)).attachment, storage = memoryStorage();
  const wrong = textBytes.slice(); wrong[0] ^= 1;
  await assert.rejects(() => run(req(path(doc, a.id, 'upload'), 'PUT', wrong, 'text/plain'), storage), httpError(409));
  assert.equal(storage.operations.length, 0);
  const put = storage.put;
  storage.put = async (key, bytes, mime) => { await put(key, bytes, mime); storage.files.set(key, wrong); return true; };
  await assert.rejects(() => run(req(path(doc, a.id, 'upload'), 'PUT', textBytes, 'text/plain'), storage), httpError(502));
  assert.equal(await scalar('select status value from erp_attachments.attachment where id=$1', [a.id]), 'reserved');
  await assert.rejects(() => run(req(path(doc, a.id, 'download')), storage), sqlError('40001'));
});

test('membership revocation during download blocks delivery; forged storage path is rejected before fetch', async () => {
  const doc = await document(), a = (await reserve(doc)).attachment, storage = memoryStorage();
  await run(req(path(doc, a.id, 'upload'), 'PUT', textBytes, 'text/plain'), storage);
  const originalGet = storage.get;
  storage.get = async key => { await db.query('update erp_access.membership set active=false where user_id=$1', [users.consulta]); return originalGet(key); };
  try { await assert.rejects(() => run(req(path(doc, a.id, 'download')), storage, users.consulta), sqlError('42501')); }
  finally { await db.query('update erp_access.membership set active=true where user_id=$1', [users.consulta]); }
  const count = storage.operations.length;
  await assert.rejects(() => run(req(path(doc, a.id, 'download')), storage, users.admin, async (name, params) => ({ ...await rpc(name, params), object_key: 'documents/../../other' })), httpError(502));
  assert.equal(storage.operations.length, count);
});

test('bucket safety and metadata limits fail closed', async () => {
  const doc = await document();
  for (const override of [{ p_size_bytes: 0 }, { p_size_bytes: MAX_ATTACHMENT_BYTES + 1 }, { p_filename: '../bad.txt' }, { p_mime_type: 'text/html' }, { p_sha256: 'abc' }]) await assert.rejects(() => reserve(doc, { override }), sqlError('22023'));
  await db.exec("update storage.buckets set public=true where id='erp-attachments'");
  try { await assert.rejects(() => reserve(doc), sqlError('55000')); }
  finally { await db.exec("update storage.buckets set public=false where id='erp-attachments'"); }
});

test('content identification rejects mismatches and XML hazards without rendering or interpreting document actions', () => {
  const encode = value => new TextEncoder().encode(value);
  for (const content of ['<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>', '<x><bad></x>', '<x a="1" a="2"/>', '<?unsafe x?><x/>', '<x><![CDATA[unsafe]]></x>', '<html/>', '<x>&unknown;</x>', '<a>'.repeat(82) + '</a>'.repeat(82)]) assert.throws(() => validateAttachmentContent(encode(content), 'application/xml'), httpError(415));
  validateAttachmentContent(encode('<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><valor>1 &amp; 2</valor></NFe>'), 'application/xml');
  validateAttachmentContent(encode('%PDF-1.7\nSynthetic encrypted/compressed PDF envelope\n%%EOF\n'), 'application/pdf');
  for (const [content, mime] of [[encode('<html/>'), 'application/pdf'], [encode('%PDF-1.7\nmissing end'), 'application/pdf'], [new Uint8Array([0xff, 0xfe]), 'text/plain'], [encode('<html>bad</html>'), 'text/plain'], [textBytes, 'image/jpeg'], [textBytes, 'image/png']]) assert.throws(() => validateAttachmentContent(content, mime), httpError(415));
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
  validateAttachmentContent(png, 'image/png');
  assert.throws(() => validateAttachmentContent(png.subarray(0, png.length - 1), 'image/png'), httpError(415));
  assert.throws(() => attachmentFilename('nota.xml', 'application/pdf'), httpError(400));
  assert.equal(attachmentFilename('foto.JPEG', 'image/jpeg'), 'anexo-foto.jpg');
});

test('body size/timeout, route parameters and injected metadata are rejected', async () => {
  await assert.rejects(() => boundedAttachmentBytes(new Response('oversize'), 2), httpError(400));
  await assert.rejects(() => boundedAttachmentBytes(new Response(new ReadableStream({ pull() {} })), 1, { timeoutMs: 5 }), httpError(408));
  assert.equal(attachmentRoute('/v1/documentos/sales_orders/bad/anexos'), null);
  const doc = await document();
  assert.deepEqual(attachmentMethods(attachmentRoute(path(doc, randomUUID(), 'upload'))), ['PUT']);
  const data = { command_id: randomUUID(), filename: 'file.txt', mime_type: 'text/plain', size_bytes: textBytes.length, sha256: await attachmentHash(textBytes) };
  for (const value of [{ ...data, object_key: 'evil' }, { ...data, user_id: users.admin }, { ...data, size_bytes: '1' }, { ...data, mime_type: 'text/html' }]) await assert.rejects(() => run(req(path(doc), 'POST', value)), httpError(400));
  await assert.rejects(() => run(req(path(doc) + '?public=true')), httpError(400));
});

test('Storage transport pins origin/path, never follows redirects, never upserts and never exposes upstream errors', async () => {
  const key = `documents/${randomUUID()}/${randomUUID()}/${'a'.repeat(64)}`, calls = [];
  const storage = createAttachmentStorage({ baseUrl: 'https://abcdefghijklmnopqrst.supabase.co', key: 'synthetic-server-key', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('private error body', { status: 400 }); } });
  assert.equal(await storage.put(key, textBytes, 'text/plain'), false);
  assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.headers['x-upsert'], 'false');
  assert.equal(calls[0].url, `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/erp-attachments/${key}`);
  await assert.rejects(() => storage.get('../outside'), httpError(502)); assert.equal(calls.length, 1);
  const redirect = createAttachmentStorage({ baseUrl: 'https://abcdefghijklmnopqrst.supabase.co', key: 'synthetic-server-key', fetchImpl: async () => new Response(null, { status: 307, headers: { Location: 'https://untrusted.example' } }) });
  await assert.rejects(() => redirect.get(key), error => error.code === 'ERP_ATTACHMENT_STORAGE_UNAVAILABLE' && !error.message.includes('synthetic-server-key'));
  assert.throws(() => createAttachmentStorage({ baseUrl: 'http://localhost', key: 'synthetic-server-key' }), httpError(503));
});

test('Worker routing authenticates attachments, permits only PUT upload preflight and keeps download headers', async () => {
  const doc = await document(), storage = memoryStorage(), origin = 'https://erp.example.test';
  const env = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: origin };
  let anonymous = false, actor = users.admin;
  const handler = createHandler({ fetchImpl: async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/auth/v1/user') return Response.json({ id: actor, is_anonymous: anonymous });
    if (route.startsWith('/rest/v1/rpc/')) {
      try { return Response.json(await rpc(route.split('/').at(-1), JSON.parse(options.body))); }
      catch (error) { return Response.json({ code: error.code, message: 'private database diagnostics' }, { status: 400 }); }
    }
    if (route.startsWith('/storage/v1/object/authenticated/erp-attachments/')) return storage.get(route.slice('/storage/v1/object/authenticated/erp-attachments/'.length));
    if (route.startsWith('/storage/v1/object/erp-attachments/')) return Response.json({}, { status: await storage.put(route.slice('/storage/v1/object/erp-attachments/'.length), options.body, options.headers['Content-Type']) ? 200 : 400 });
    throw new Error('Unexpected upstream');
  } });
  const authenticated = request => { const headers = new Headers(request.headers); headers.set('Authorization', 'Bearer synthetic-user-token'); headers.set('Origin', origin); return new Request(request, { headers }); };
  assert.equal((await handler(req(path(doc)), env)).status, 401);
  const reserved = await handler(authenticated(req(path(doc), 'POST', { command_id: randomUUID(), filename: 'teste.txt', mime_type: 'text/plain', size_bytes: textBytes.length, sha256: await attachmentHash(textBytes) })), env);
  assert.equal(reserved.status, 200); const a = (await reserved.json()).attachment;
  const uploadPath = path(doc, a.id, 'upload');
  const preflight = await handler(new Request(`https://api.example.test${uploadPath}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Authorization,Content-Type' } }), env);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'PUT');
  const uploaded = await handler(authenticated(req(uploadPath, 'PUT', textBytes, 'text/plain')), env);
  assert.equal(uploaded.status, 200);
  const downloaded = await handler(authenticated(req(path(doc, a.id, 'download'))), env);
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(downloaded.headers.get('Content-Type'), 'application/octet-stream'); assert.equal(downloaded.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(downloaded.headers.get('Content-Disposition'), /^attachment;/); assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), textBytes);
  const count = storage.operations.length; anonymous = true;
  assert.equal((await handler(authenticated(req(path(doc, a.id, 'download'))), env)).status, 403);
  anonymous = false; actor = users.inactive;
  const denied = await handler(authenticated(req(path(doc, a.id, 'download'))), env);
  assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /private database|synthetic-server-key/);
  assert.equal(storage.operations.length, count);
});
