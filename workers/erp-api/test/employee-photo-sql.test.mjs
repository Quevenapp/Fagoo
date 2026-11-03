// Synthetic data only. 202610200272: the Foto of the Funcionário through the real Worker on PGlite (every migration), with an
// in-memory Storage, as the Foto of Clientes e fornecedores (170). Administrator only.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';
import { createHandler } from '../src/index.mjs';

let f, handler, employee, other;
const files = new Map();
const env = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const KEYS = ['rg', 'job_title', 'pis', 'ctps', 'code', 'phone', 'mobile', 'email', 'emergency_phone', 'postal_code', 'state', 'city', 'district', 'street', 'number', 'complement', 'birth_date', 'admission_date', 'salary', 'notes'];
const person = (name, cpf) => ({ name, cpf, ...Object.fromEntries(KEYS.map(key => [key, null])) });
before(async () => {
  f = await documentsEFixture();
  await f.db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain']) on conflict(id) do nothing");
  const save = async data => (await f.rpc('erp_catalog_employee_save', { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).item.id;
  employee = await save(person('Funcionária Sintética', '52998224725'));
  other = await save(person('Funcionário Sintético Dois', '11144477735'));
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
const base = id => `/v1/anexos-cadastros/funcionarios/${id ?? employee}`;
async function call(path, method = 'GET', body, user = f.users.admin, type = 'application/json') {
  const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }), env);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let value = null; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* bytes */ }
  return { status: response.status, value, bytes };
}
const reserve = (bytes, mime, filename, extra = {}, user = f.users.admin, id) => call(base(id), 'POST', { command_id: randomUUID(), purpose: 'photo', filename, mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes), ...extra }, user);
const send = async (bytes, mime, filename, user = f.users.admin) => {
  const reserved = await reserve(bytes, mime, filename, {}, user);
  if (reserved.status !== 200) return reserved;
  return call(`${base()}/${reserved.value.attachment.id}/upload`, 'PUT', bytes, user, mime);
};

test('272 grants: the public RPCs only for service_role; tables and helpers for nobody', async () => {
  for (const fn of ['erp_attachment_employee_list(uuid,uuid)', 'erp_attachment_employee_reserve(uuid,uuid,uuid,text,text,integer,text)', 'erp_attachment_employee_object(uuid,uuid,uuid,boolean)',
    'erp_attachment_employee_claim(uuid,uuid,uuid,uuid)', 'erp_attachment_employee_finish(uuid,uuid,uuid,uuid,text,integer)', 'erp_attachment_employee_stop(uuid,uuid,uuid,boolean,uuid)', 'erp_attachment_employee_delete(uuid,uuid,uuid,uuid)']) {
    const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', ['public.' + fn])).rows[0];
    assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']], fn);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", ['public.' + fn]), true, fn);
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, 'public.' + fn]), false, `${role} ${fn}`);
  }
  for (const fn of ['erp_attachments.employee_authorize(uuid,uuid,boolean)', 'erp_attachments.employee_dto(uuid,boolean)', 'erp_attachments.employee_row(uuid,uuid,boolean)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), false, fn);
  for (const table of ['erp_attachments.employee_file', 'erp_attachments.employee_file_audit']) assert.equal(await f.scalar("select has_table_privilege('service_role',$1,'SELECT') v", [table]), false, table);
});

test('Foto do funcionário: send, read back checked by SHA-256, replace, remove; replays and refusals', async () => {
  assert.deepEqual((await call(base())).value, { employee_id: employee, items: [], photo: null, pending_photos: [], data_mode: 'erp_native' });
  const first = await send(png, 'image/png', 'retrato.png');
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.deepEqual([first.value.attachment.status, first.value.attachment.filename, first.value.attachment.purpose], ['ready', 'anexo-retrato.png', 'photo']);
  const photo = first.value.attachment;
  assert.equal(files.has(`employees/${employee}/${photo.id}/${sha(png)}`), true, 'immutable key under employees/');
  const listed = await call(base());
  assert.deepEqual([listed.value.photo.id, listed.value.photo.owner_name !== undefined], [photo.id, true]);
  const download = await call(`${base()}/${photo.id}/download`);
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(download.bytes), Buffer.from(png));
  // Replay of the same reservation command answers the same row.
  const command = randomUUID(), body = { command_id: command, purpose: 'photo', filename: 'nova.jpg', mime_type: 'image/jpeg', size_bytes: jpeg.length, sha256: sha(jpeg) };
  const reserved = await call(base(), 'POST', body), again = await call(base(), 'POST', body);
  assert.deepEqual([reserved.value.replayed, again.value.replayed, again.value.attachment.id], [false, true, reserved.value.attachment.id]);
  assert.equal((await call(base(), 'POST', { ...body, filename: 'outra.jpg' })).status, 409, 'same command with another body');
  assert.equal((await call(base())).value.pending_photos.length, 1);
  const uploaded = await call(`${base()}/${reserved.value.attachment.id}/upload`, 'PUT', jpeg, f.users.admin, 'image/jpeg');
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.value));
  const now = await call(base());
  assert.deepEqual([now.value.photo.id, now.value.pending_photos.length], [reserved.value.attachment.id, 0], 'a new foto replaces the previous one');
  assert.equal(await f.scalar('select deleted_at is not null v from erp_attachments.employee_file where id=$1', [photo.id]), true, 'the previous foto is kept, logically deleted');
  assert.equal((await call(`${base()}/${photo.id}/download`)).status, 409, 'a deleted foto is never delivered');
  // Remover foto: once, with replay.
  const removal = randomUUID(), current = now.value.photo.id;
  const removed = await call(`${base()}/${current}/exclusao`, 'POST', { command_id: removal });
  const replay = await call(`${base()}/${current}/exclusao`, 'POST', { command_id: removal });
  assert.deepEqual([removed.status, removed.value.attachment.deleted, replay.value.replayed], [200, true, true]);
  assert.equal((await call(base())).value.photo, null);
  assert.deepEqual((await f.rows('select action from erp_attachments.employee_file_audit where file_id=$1 order by id', [current])).map(r => r.action), ['reserve', 'finalize', 'delete']);
  await assert.rejects(() => f.db.query('update erp_attachments.employee_file_audit set action=$1', ['abort']), /erp_attachment_immutable/);
  await assert.rejects(() => f.db.query('delete from erp_attachments.employee_file where id=$1', [current]), /erp_attachment_no_delete/);
});

test('only PNG or JPEG up to 2 MB, only the administrator, only the funcionário of the route', async () => {
  assert.equal((await reserve(png, 'application/pdf', 'doc.pdf')).status, 400);
  assert.equal((await reserve(png, 'image/png', 'grande.png', { size_bytes: 2 * 1024 * 1024 + 1 })).status, 400);
  assert.equal((await reserve(png, 'image/png', 'foto.png', { purpose: 'attachment' })).status, 400, 'a funcionário has only the foto');
  assert.equal((await reserve(png, 'image/png', 'foto.png', { extra: 1 })).status, 400);
  // Bytes that are not a PNG are refused before the storage.
  const fake = new TextEncoder().encode('não é uma imagem');
  const reserved = await reserve(fake, 'image/png', 'falsa.png');
  assert.equal((await call(`${base()}/${reserved.value.attachment.id}/upload`, 'PUT', fake, f.users.admin, 'image/png')).status, 415);
  assert.equal((await call(`${base()}/${reserved.value.attachment.id}/abort`, 'POST', {})).value.attachment.status, 'aborted');
  for (const user of [f.users.vendas, f.users.financeiro, f.users.estoque, f.users.consulta, f.users.fiscal]) {
    assert.equal((await call(base(), 'GET', undefined, user)).status, 403);
    assert.equal((await reserve(png, 'image/png', 'foto.png', {}, user)).status, 403);
  }
  assert.equal((await call(base(randomUUID()))).status, 404);
  const mine = await send(png, 'image/png', 'outra.png');
  assert.equal((await call(`${base(other)}/${mine.value.attachment.id}/download`)).status, 404, 'a foto of another funcionário is not found');
  assert.equal((await call(`${base()}?x=1`)).status, 400);
  assert.equal((await call(base(), 'PUT', png, f.users.admin, 'image/png')).status, 405);
});
