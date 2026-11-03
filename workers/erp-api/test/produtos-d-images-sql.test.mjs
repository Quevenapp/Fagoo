import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { produtosDFixture } from './helpers/produtos-d-fixture.mjs';
import { createHandler } from '../src/index.mjs';
import { attachmentRoute, attachmentMethods } from '../src/attachments.mjs';

// 202610200193 (Imagens armazenadas do produto) on PGlite through the real Worker, with an in-memory Storage. Synthetic bytes only.
let f, handler, product, other;
const files = new Map();
let failNextPost = false;
const env = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ALLOWED_ORIGINS: 'https://synthetic.invalid' };
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 255, 217]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  f = await produtosDFixture();
  await f.db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain'])");
  product = await f.product({ name: 'Cadeira com fotos' }); other = await f.product({ name: 'Outro produto' });
  handler = createHandler({ fetchImpl: async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/auth/v1/user')) return Response.json({ id: options.headers.Authorization.slice(7) });
    const object = /^\/storage\/v1\/object\/(?:authenticated\/)?erp-attachments\/(.+)$/.exec(pathname);
    if (object) {
      if (options.method === 'POST') {
        if (files.has(object[1])) return new Response(null, { status: 409 });
        const bytes = new Uint8Array(await new Response(options.body).arrayBuffer()); files.set(object[1], bytes);
        await f.db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)', ['erp-attachments', object[1], JSON.stringify({ size: bytes.length, mimetype: options.headers['Content-Type'] })]);
        if (failNextPost) { failNextPost = false; throw new Error('lost answer'); }
        return new Response(null, { status: 200 });
      }
      const bytes = files.get(object[1]); return bytes ? new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }) : new Response(null, { status: 404 });
    }
    try { return Response.json(await f.rpc(pathname.split('/').at(-1), JSON.parse(options.body))); }
    catch (e) { return Response.json({ code: e.code, message: 'SANITIZE_SYNTHETIC_SQL_ERROR' }, { status: 400 }); }
  } });
});
after(() => f?.close());
const base = (id = product.id) => `/v1/anexos-cadastros/produtos/${id}`;
async function call(path, method = 'GET', body, user = f.users.admin, type = 'application/json') {
  const response = await handler(new Request('https://api.synthetic.invalid' + path, { method, headers: { Authorization: 'Bearer ' + user, Origin: 'https://synthetic.invalid', ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) }), env);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let value = null; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* bytes */ }
  return { status: response.status, value, bytes, type: response.headers.get('Content-Type') };
}
const reserve = (bytes, mime, filename, { user = f.users.admin, id = product.id, command = randomUUID() } = {}) =>
  call(base(id), 'POST', { command_id: command, filename, mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes) }, user);
const send = async (bytes, mime, filename, options) => {
  const reserved = await reserve(bytes, mime, filename, options);
  if (reserved.status !== 200) return reserved;
  return call(`${base(options?.id)}/${reserved.value.image.id}/upload`, 'PUT', bytes, options?.user ?? f.users.admin, mime);
};

test('193 routes, grants and the private tables', async () => {
  assert.deepEqual(attachmentRoute(`/v1/anexos-cadastros/produtos/${product.id}/ordem`), { owner: 'product', productId: product.id, id: null, action: 'order' });
  assert.deepEqual(attachmentMethods(attachmentRoute(`/v1/anexos-cadastros/produtos/${product.id}`)), ['GET', 'POST']);
  assert.equal(attachmentRoute('/v1/anexos-cadastros/produtos/x'), null);
  for (const fn of ['erp_catalog_product_images(uuid,uuid)', 'erp_catalog_product_image_reserve(uuid,uuid,uuid,text,text,integer,text)', 'erp_catalog_product_image_object(uuid,uuid,uuid,boolean)',
    'erp_catalog_product_image_claim(uuid,uuid,uuid,uuid)', 'erp_catalog_product_image_finish(uuid,uuid,uuid,uuid,text,integer)', 'erp_catalog_product_image_stop(uuid,uuid,uuid,boolean,uuid)',
    'erp_catalog_product_image_delete(uuid,uuid,uuid,uuid)', 'erp_catalog_product_image_order(uuid,uuid,uuid,uuid[])']) {
    const rows = await f.rows(`select prosecdef d,proconfig c,has_function_privilege('service_role',oid,'EXECUTE') s,has_function_privilege('authenticated',oid,'EXECUTE') a,has_function_privilege('anon',oid,'EXECUTE') n from pg_proc where oid='public.${fn}'::regprocedure`);
    assert.deepEqual([rows[0].d, rows[0].c, rows[0].s, rows[0].a, rows[0].n], [true, ['search_path=pg_catalog'], true, false, false], fn);
  }
  for (const table of ['product_stored_image', 'product_image_audit', 'product_image_command']) assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_catalog.${table}','SELECT') v`), false, table);
});

test('193 upload checked by SHA-256 and signature, list in order, download, reorder, deletion and their replays', async () => {
  const first = await send(png, 'image/png', 'frente.png');
  assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.deepEqual([first.value.image.status, first.value.image.position, first.value.image.filename, first.value.replayed], ['ready', 1, 'anexo-frente.png', false]);
  const second = await send(jpeg, 'image/jpeg', 'Lado B.JPEG');
  assert.deepEqual([second.status, second.value.image.position, second.value.image.filename], [200, 2, 'anexo-Lado-B.jpg']);
  const listed = await call(base(), 'GET', undefined, f.users.consulta);
  assert.deepEqual([listed.status, listed.value.items.map(item => item.id), listed.value.stored_bytes, listed.value.limit], [200, [first.value.image.id, second.value.image.id], String(png.length + jpeg.length), 20]);
  const download = await call(`${base()}/${first.value.image.id}/download`, 'GET', undefined, f.users.vendas);
  assert.deepEqual([download.status, download.type, [...download.bytes]], [200, 'application/octet-stream', [...png]]);
  // The same upload again answers the ready image; the upload of another product's image is refused.
  assert.equal((await call(`${base()}/${first.value.image.id}/upload`, 'PUT', png, f.users.admin, 'image/png')).value.replayed, true);
  assert.equal((await call(`${base(other.id)}/${first.value.image.id}/download`)).status, 404);
  // Order: every ready image once; the same command replays; a stale list is refused.
  const command = randomUUID(), body = { command_id: command, ids: [second.value.image.id, first.value.image.id] };
  const ordered = await call(`${base()}/ordem`, 'POST', body);
  assert.deepEqual([ordered.status, ordered.value.items.map(item => [item.id, item.position]), ordered.value.replayed], [200, [[second.value.image.id, 1], [first.value.image.id, 2]], false]);
  assert.equal((await call(`${base()}/ordem`, 'POST', body)).value.replayed, true);
  assert.equal((await call(`${base()}/ordem`, 'POST', { command_id: randomUUID(), ids: [first.value.image.id] })).status, 409, 'every image must be in the order');
  assert.equal((await call(`${base()}/ordem`, 'POST', { command_id: command, ids: [first.value.image.id, second.value.image.id] })).status, 409, 'same command, other body');
  // Deletion: logical, audited, replayed; the next image moves up.
  const remove = randomUUID();
  const deleted = await call(`${base()}/${second.value.image.id}/exclusao`, 'POST', { command_id: remove });
  assert.deepEqual([deleted.status, deleted.value.image.deleted, deleted.value.image.position], [200, true, null]);
  assert.equal((await call(`${base()}/${second.value.image.id}/exclusao`, 'POST', { command_id: remove })).value.replayed, true);
  assert.deepEqual((await call(base())).value.items.map(item => [item.id, item.position]), [[first.value.image.id, 1]]);
  assert.equal((await call(`${base()}/${second.value.image.id}/download`)).status, 409, 'a deleted image is not delivered');
  assert.deepEqual((await f.rows('select action from erp_catalog.product_image_audit where product_id=$1 order by id', [product.id])).map(row => row.action),
    ['reserve', 'finalize', 'reserve', 'finalize', 'order', 'delete']);
  assert.equal(await f.scalar('select version v from erp_catalog.record where id=$1', [product.id]), product.version, 'images do not change the product version');
});

test('193 refusals: types, sizes, bytes, permissions, deleted products, quota and a lost storage answer', async () => {
  const fresh = await f.product({ name: 'Mesa' });
  assert.equal((await reserve(png, 'image/gif', 'a.gif', { id: fresh.id })).status, 400);
  assert.equal((await call(base(fresh.id), 'POST', { command_id: randomUUID(), filename: 'a.png', mime_type: 'image/png', size_bytes: 2 * 1024 * 1024 + 1, sha256: sha(png) })).status, 400);
  assert.equal((await reserve(png, 'image/png', 'a.png', { id: fresh.id, user: f.users.vendas })).status, 403, 'vendas reads, does not write products');
  const wrong = await reserve(png, 'image/png', 'a.png', { id: fresh.id });
  assert.equal((await call(`${base(fresh.id)}/${wrong.value.image.id}/upload`, 'PUT', jpeg, f.users.admin, 'image/png')).status, 400, 'size of the reservation');
  const fake = new Uint8Array(png.length).fill(7);
  const fakeReserved = await reserve(fake, 'image/png', 'b.png', { id: fresh.id });
  assert.equal((await call(`${base(fresh.id)}/${fakeReserved.value.image.id}/upload`, 'PUT', fake, f.users.admin, 'image/png')).status, 415, 'not a PNG');
  assert.equal((await call(`${base(fresh.id)}/${fakeReserved.value.image.id}/abort`, 'POST', {})).value.image.status, 'aborted');
  // The storage answer is lost but the object is there: the upload is confirmed by reading it back.
  failNextPost = true;
  const recovered = await send(png, 'image/png', 'c.png', { id: fresh.id });
  assert.deepEqual([recovered.status, recovered.value.image.status], [200, 'ready']);
  const gone = await f.product({ name: 'Excluído' });
  await f.rpc('erp_catalog_product_set_deleted', { p_user_id: f.users.admin, p_id: gone.id, p_expected_version: gone.version, p_command_id: randomUUID(), p_deleted: true });
  assert.equal((await reserve(png, 'image/png', 'd.png', { id: gone.id })).status, 409, 'a deleted product gets no image');
  assert.equal((await call(base(gone.id))).status, 200, 'but its images are still listed');
  // Quota: 20 ready or reserved images per product.
  const many = await f.product({ name: 'Muitas fotos' });
  for (let i = 0; i < 20; i++) assert.equal((await reserve(png, 'image/png', `f${i}.png`, { id: many.id })).status, 200);
  assert.equal((await reserve(png, 'image/png', 'f20.png', { id: many.id })).status, 409);
  assert.equal((await call(base(randomUUID()))).status, 404);
});
