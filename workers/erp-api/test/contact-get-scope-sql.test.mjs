// Synthetic data only. 202610200293: "Contato acessível somente ao vendedor vinculado" in the legacy read GET /v1/cadastros/contacts/{id}
// (erp_catalog_get). PGlite with every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f;
before(async () => { f = await documentsEFixture(); });
after(async () => f?.close());

test('privileges: the replaced erp_catalog_get keeps running only for service_role', async () => {
  const sig = 'public.erp_catalog_get(uuid,text,uuid)';
  const row = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0];
  assert.deepEqual([row.prosecdef, row.proconfig], [true, ['search_path=pg_catalog']]);
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
});

test('the seller of the user reads only its contacts; administrador, unscoped users and products are unchanged', async () => {
  const sellerId = await f.seller(f.users.vendas, { allow: true, name: 'Vendedor do escopo G' });
  const mine = await f.catalog('contacts', { name: 'Cliente do vendedor G' }), other = await f.catalog('contacts', { name: 'Cliente de outro vendedor G' });
  await f.assign(mine.id, sellerId);
  const read = (id, user = f.users.vendas) => f.call(`/v1/cadastros/contacts/${id}`, 'GET', undefined, user);
  assert.equal((await read(other.id)).status, 200, 'without the preference everyone reads every contact');
  await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', true);
  try {
    const own = await read(mine.id);
    assert.deepEqual([own.status, own.value.record?.id], [200, mine.id]);
    const foreign = await read(other.id);
    assert.deepEqual([foreign.status, foreign.value.error?.code], [404, 'ERP_NOT_FOUND'], JSON.stringify(foreign.value));
    assert.doesNotMatch(JSON.stringify(foreign.value), /Cliente de outro vendedor/);
    assert.equal((await read(other.id, f.users.admin)).status, 200, 'the administrador is never scoped');
    assert.equal((await read(other.id, f.users.consulta)).status, 200, 'a user without a seller is not scoped');
    assert.equal((await f.call(`/v1/cadastros/products/${f.product.id}`, 'GET', undefined, f.users.vendas)).status, 200);
    assert.equal((await read(randomUUID())).status, 404);
  } finally { await f.setPreference('cadastros-contatos', 'contatos.acesso_vendedor', false); }
});
