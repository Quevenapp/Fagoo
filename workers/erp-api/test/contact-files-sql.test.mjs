import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsCFixture } from './helpers/documents-c-fixture.mjs';
import { createHandler } from '../src/index.mjs';

// 202610200170 (Foto e Anexos de Clientes e fornecedores) on PGlite through the real Worker, with an in-memory Storage.
// Synthetic bytes and contacts only.
let f, handler, contact;
const files = new Map();
const env = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const text = new TextEncoder().encode('Contrato social sintético.\n');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  f = await documentsCFixture({ upto: '202610200170' });
  await f.db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain'])");
  contact = await f.catalog('contacts', { name: 'Cliente com anexos' });
  handler = createHandler({ fetchImpl: async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
    const object = /^\/storage\/v1\/object\/(?:authenticated\/)?erp-attachments\/(.+)$/.exec(pathname);
    if (object) {
      if (options.method === 'POST') {
        if (files.has(object[1])) return new Response(null, { status: 409 });
        const bytes = new Uint8Array(await new Response(options.body).arrayBuffer()); files.set(object[1], bytes);
        await f.db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)', ['erp-attachments', object[1], JSON.stringify({ size: bytes.length, mimetype: options.headers['Content-Type'] })]);
        return new Response(null, { status: 200 });
      }
      const bytes = files.get(object[1]); return bytes ? new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }) : new Response(null, { status: 404 });
    }
    try { return Response.json(await f.rpc(pathname.split('/').at(-1), JSON.parse(options.body))); }
    catch (e) { return Response.json({ code: e.code, message: 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); }
  } });
});
after(() => f?.close());
const base = id => `/v1/anexos-cadastros/contatos/${id ?? contact.id}`;
async function call(path, method = 'GET', body, user = f.users.admin, type = 'application/json') {
  const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }), env);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let value = null; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* bytes */ }
  return { status: response.status, value, bytes, type: response.headers.get('Content-Type') };
}
const send = async (purpose, bytes, mime, filename, user = f.users.admin) => {
  const reserved = await call(base(), 'POST', { command_id: randomUUID(), purpose, filename, mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes) }, user);
  if (reserved.status !== 200) return reserved;
  return call(`${base()}/${reserved.value.attachment.id}/upload`, 'PUT', bytes, user, mime);
};

test('170 grants', async () => {
  for (const fn of ['erp_attachment_contact_list(uuid,uuid)', 'erp_attachment_contact_reserve(uuid,uuid,uuid,text,text,text,integer,text)', 'erp_attachment_contact_object(uuid,uuid,uuid,boolean)',
    'erp_attachment_contact_claim(uuid,uuid,uuid,uuid)', 'erp_attachment_contact_finish(uuid,uuid,uuid,uuid,text,integer)', 'erp_attachment_contact_stop(uuid,uuid,uuid,boolean,uuid)', 'erp_attachment_contact_delete(uuid,uuid,uuid,uuid)']) {
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", ['public.' + fn]), true, fn);
    assert.equal(await f.scalar("select has_function_privilege('authenticated',$1,'EXECUTE') v", ['public.' + fn]), false, fn);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', ['public.' + fn]), true, fn);
  }
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_attachments.contact_authorize(uuid,uuid,boolean)','EXECUTE') v"), false);
  assert.equal(await f.scalar("select has_table_privilege('service_role','erp_attachments.contact_file','SELECT') v"), false);
});

test('Anexos: reserve, upload checked by SHA-256, list with the owner, download, logical deletion and its replay', async () => {
  const uploaded = await send('attachment', text, 'text/plain', 'contrato.txt');
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.value));
  const id = uploaded.value.attachment.id;
  assert.deepEqual([uploaded.value.attachment.status, uploaded.value.attachment.purpose, uploaded.value.attachment.filename], ['ready', 'attachment', 'anexo-contrato.txt']);
  const listed = await call(base(), 'GET', undefined, f.users.consulta);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.items.map(item => item.id), [id]); assert.equal(listed.value.photo, null);
  const download = await call(`${base()}/${id}/download`, 'GET', undefined, f.users.consulta);
  assert.equal(download.status, 200); assert.equal(download.type, 'application/octet-stream'); assert.deepEqual([...download.bytes], [...text]);
  assert.equal((await call(`${base()}/${id}/exclusao`, 'POST', { command_id: randomUUID() }, f.users.consulta)).status, 403, 'consulta does not delete');
  const command = randomUUID();
  const deleted = await call(`${base()}/${id}/exclusao`, 'POST', { command_id: command });
  assert.equal(deleted.status, 200); assert.deepEqual([deleted.value.attachment.deleted, deleted.value.replayed], [true, false]);
  assert.equal((await call(`${base()}/${id}/exclusao`, 'POST', { command_id: command })).value.replayed, true);
  assert.equal((await call(`${base()}/${id}/exclusao`, 'POST', { command_id: randomUUID() })).status, 409, 'already deleted');
  assert.deepEqual((await call(base())).value.items, []);
  assert.equal((await call(`${base()}/${id}/download`)).status, 409, 'a deleted file is not delivered');
  assert.equal(await f.scalar("select count(*)::int v from erp_attachments.contact_file_audit where file_id=$1", [id]), 3, 'reserve, finalize and delete are audited');
});

test('Foto: PNG or JPEG up to 2 MB; a new foto replaces the previous; reservations can be cancelled; refusals', async () => {
  assert.equal((await send('photo', text, 'text/plain', 'foto.txt')).status, 400, 'a foto is an image');
  const first = await send('photo', png, 'image/png', 'foto.png');
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.equal((await call(base())).value.photo.id, first.value.attachment.id);
  const second = await send('photo', png, 'image/png', 'nova.png');
  assert.equal((await call(base())).value.photo.id, second.value.attachment.id);
  assert.equal(await f.scalar('select deleted_at is not null v from erp_attachments.contact_file where id=$1', [first.value.attachment.id]), true, 'the previous foto is kept, logically deleted');
  const reserved = await call(base(), 'POST', { command_id: randomUUID(), purpose: 'photo', filename: 'outra.png', mime_type: 'image/png', size_bytes: png.length, sha256: sha(png) });
  assert.deepEqual((await call(base())).value.pending_photos.map(item => item.id), [reserved.value.attachment.id]);
  const aborted = await call(`${base()}/${reserved.value.attachment.id}/abort`, 'POST', {});
  assert.equal(aborted.value.attachment.status, 'aborted');
  assert.equal((await send('attachment', text, 'text/plain', 'x.txt', f.users.consulta)).status, 403);
  assert.equal((await call(base(randomUUID()))).status, 404);
  assert.equal((await call(base(), 'POST', { command_id: randomUUID(), purpose: 'attachment', filename: 'x.txt', mime_type: 'text/plain', size_bytes: 1, sha256: 'x' })).status, 400);
  const wrong = await call(base(), 'POST', { command_id: randomUUID(), purpose: 'attachment', filename: 'y.txt', mime_type: 'text/plain', size_bytes: text.length, sha256: sha(text) });
  const other = text.slice(); other[0] = 0x63;
  assert.equal((await call(`${base()}/${wrong.value.attachment.id}/upload`, 'PUT', other, f.users.admin, 'text/plain')).status, 409, 'bytes that differ from the reservation are refused');
});

test('Anexos dos documentos: owner in the list and "Excluir selecionados" (logical, audited, replayed by command)', async () => {
  const doc = await f.create('sales_orders');
  const docBase = `/v1/documentos/sales_orders/${doc.id}/anexos`;
  const reserved = await call(docBase, 'POST', { command_id: randomUUID(), filename: 'pedido.txt', mime_type: 'text/plain', size_bytes: text.length, sha256: sha(text) });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.value));
  const id = reserved.value.attachment.id;
  assert.equal((await call(`${docBase}/${id}/upload`, 'PUT', text, f.users.admin, 'text/plain')).value.attachment.status, 'ready');
  const listed = await call(docBase);
  assert.deepEqual(listed.value.items.map(item => [item.id, item.deleted, Object.hasOwn(item, 'owner_name')]), [[id, false, true]]);
  assert.equal((await call(`${docBase}/${id}/exclusao`, 'POST', { command_id: randomUUID() }, f.users.consulta)).status, 403);
  const command = randomUUID();
  const deleted = await call(`${docBase}/${id}/exclusao`, 'POST', { command_id: command });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.value));
  assert.deepEqual([deleted.value.attachment.deleted, deleted.value.replayed], [true, false]);
  assert.equal((await call(`${docBase}/${id}/exclusao`, 'POST', { command_id: command })).value.replayed, true);
  assert.deepEqual((await call(docBase)).value.items, []);
  assert.equal((await call(`${docBase}/${id}/download`)).status, 409, 'a deleted attachment is not delivered');
  assert.equal(await f.scalar("select count(*)::int v from erp_attachments.audit where attachment_id=$1 and action='delete'", [id]), 1);
  assert.equal(await f.scalar("select has_function_privilege('authenticated','public.erp_attachment_delete(uuid,text,uuid,uuid,uuid)','EXECUTE') v"), false);
});
