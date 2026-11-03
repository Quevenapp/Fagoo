import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../src/index.mjs';

test('HTTP catalog and migrations 006/023 agree on DTOs, price precision, replay, CAS, archive and database role checks', async () => {
  const db = new PGlite();
  const admin = 'a0000000-0000-4000-8000-000000000001'; const viewer = 'a0000000-0000-4000-8000-000000000002';
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: '' };
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);');
    for (const name of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql','202610160006_erp_catalog.sql','202610160023_product_details.sql']) await db.exec(await readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await db.query('INSERT INTO auth.users(id) VALUES($1),($2)', [admin, viewer]);
    await db.query("INSERT INTO erp_access.membership(user_id,role) VALUES($1,'admin'),($2,'consulta')", [admin, viewer]);
    const handler = createHandler({ fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: options.headers.Authorization.endsWith('viewer') ? viewer : admin }));
      const name = new URL(url).pathname.split('/').at(-1); const args = Object.entries(JSON.parse(options.body));
      await db.exec('SET ROLE service_role');
      try {
        const result = await db.query(`SELECT public.${name}(${args.map(([key], index) => `${key} => $${index + 1}`).join(',')}) AS value`, args.map(([key, value]) => key === 'p_data' ? JSON.stringify(value) : value));
        return new Response(JSON.stringify(result.rows[0].value));
      } catch (error) { return new Response(JSON.stringify({ code: error.code, message: 'private SQL details' }), { status: 400 }); }
      finally { await db.exec('RESET ROLE'); }
    } });
    const call = async (path, method = 'GET', data, actor = 'admin') => {
      const result = await handler(new Request(`https://api.example.test${path}`, { method, headers: { Authorization: `Bearer synthetic-${actor}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }), env);
      return { status: result.status, data: await result.json() };
    };
    assert.deepEqual((await call('/v1/cadastros')).data.write, ['contacts','products','warehouses']);
    const command = crypto.randomUUID();
    const input = { command_id: command, data: { name: 'Produto sintético', price: '12345678901234.1234', ncm: '12345678' } };
    const created = await call('/v1/cadastros/products', 'POST', input); assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(created.data.record.price, '12345678901234.1234'); assert.equal(created.data.record.version, 1);
    const replay = await call('/v1/cadastros/products', 'POST', input); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.record.id, created.data.record.id);
    const path = `/v1/cadastros/products/${created.data.record.id}`;
    const updated = await call(path, 'PATCH', { command_id: crypto.randomUUID(), expected_version: 1, data: { name: 'Produto atualizado' } }); assert.equal(updated.status, 200); assert.equal(updated.data.record.version, 2);
    assert.equal((await call(path, 'PATCH', { command_id: crypto.randomUUID(), expected_version: 1, data: { name: 'Versão antiga' } })).status, 409);
    assert.equal((await call(`${path}/active`, 'PATCH', { command_id: crypto.randomUUID(), expected_version: 2, active: false })).data.record.active, false);
    const list = await call('/v1/cadastros/products?active=false'); assert.equal(list.status, 200); assert.equal(list.data.items.length, 1);
    assert.equal((await call(path)).data.record.name, 'Produto atualizado');
    assert.equal((await call('/v1/cadastros/products', 'POST', { ...input, command_id: crypto.randomUUID() }, 'viewer')).status, 403);
    const contact = await call('/v1/cadastros/contacts', 'POST', { command_id: crypto.randomUUID(), data: { name: 'Contato sintético', document: '12.ABC.345/01DE-35', roles: ['supplier'] } }); assert.equal(contact.status, 200); assert.deepEqual(contact.data.record.roles, ['supplier']);
    const warehouse = await call('/v1/cadastros/warehouses', 'POST', { command_id: crypto.randomUUID(), data: { name: 'Depósito sintético', description: 'Sem movimentação' } }); assert.equal(warehouse.status, 200);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM origin_sync.raw_record')).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM erp_catalog.audit')).rows[0].count, 5);
  } finally { await db.close(); }
});
