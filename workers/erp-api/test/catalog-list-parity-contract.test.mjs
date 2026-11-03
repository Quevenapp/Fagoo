import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/index.mjs';
import { catalogListParityFixture } from './helpers/catalog-list-parity-fixture.mjs';

// Worker → real SQL (migrations up to 087 + 096 in PGlite): the strict response validators accept what the RPCs return.
test('096 HTTP pages, check and confirmed saves agree with the SQL contract', async () => {
  const f = await catalogListParityFixture();
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: '' };
  try {
    const handler = createHandler({ fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: f.users[options.headers.Authorization.split('-').at(-1)] }));
      const name = new URL(url).pathname.split('/').at(-1), args = Object.entries(JSON.parse(options.body));
      await f.db.exec('SET ROLE service_role');
      try {
        const result = await f.db.query(`SELECT public.${name}(${args.map(([key], index) => `${key} => $${index + 1}`).join(',')}) AS value`, args.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
        return new Response(JSON.stringify(result.rows[0].value));
      } catch (error) { return new Response(JSON.stringify({ code: error.code, message: 'private SQL details' }), { status: 400 }); }
      finally { await f.db.exec('RESET ROLE'); }
    } });
    const call = async (path, method = 'GET', data, actor = 'admin') => {
      const response = await handler(new Request(`https://api.example.test${path}`, { method, headers: { Authorization: `Bearer synthetic-${actor}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }), env);
      return { status: response.status, data: await response.json() };
    };
    const created = [];
    for (const [entity, data] of [
      ['contacts', { name: 'Ána Ábaco', person_type: 'J', document: '11.222.333/0001-81', phone: '(19) 3434-1000', roles: ['customer'] }],
      ['contacts', { name: 'Bruno Fornecedor', person_type: 'F', document: '52998224725', roles: ['supplier'] }],
      ['products', { name: 'Parafuso Inox', code: 'PAR-10', unit: 'UN', kind: 'P', format: 'S', price: '1.1234567891' }],
      ['products', { name: 'Porca', code: 'POR-1', unit: 'UN', kind: 'P', format: 'S', price: '0.25' }],
      ['warehouses', { name: 'Geral' }],
    ]) {
      const result = await call(`/v1/cadastros/${entity}`, 'POST', { command_id: randomUUID(), data });
      assert.equal(result.status, 200, JSON.stringify(result.data)); created.push(result.data.record);
    }
    const [ana, , parafuso, , geral] = created;
    await f.stock(parafuso.id, geral.id, '4');

    const contacts = await call('/v1/cadastros/contacts?page=1&size=1&q=abaco');
    assert.equal(contacts.status, 200, JSON.stringify(contacts.data));
    assert.deepEqual([contacts.data.total, contacts.data.items.map(i => i.name)], [1, ['Ána Ábaco']]);
    assert.deepEqual((await call('/v1/cadastros/contacts?page=1&q=3434-1000')).data.items.map(i => i.id), [ana.id]);
    assert.deepEqual((await call('/v1/cadastros/contacts?page=1&role=supplier')).data.items.map(i => i.name), ['Bruno Fornecedor']);
    const products = await call(`/v1/cadastros/products?page=1&stock=positive&warehouse_id=${geral.id}`);
    assert.equal(products.status, 200, JSON.stringify(products.data));
    assert.deepEqual(products.data.items.map(i => [i.name, i.price, i.stock]), [['Parafuso Inox', '1.1234567891', { state: 'recorded', quantity: '4.000000', warehouse: { id: geral.id, state: 'recorded', quantity: '4.000000' } }]]);
    assert.equal(products.data.stock_visible, true);
    const all = await call('/v1/cadastros/products?page=1&sort=code_desc');
    assert.deepEqual(all.data.items.map(i => i.code), ['POR-1', 'PAR-10']);
    assert.deepEqual(all.data.items.find(i => i.code === 'POR-1').stock, { state: 'no_movements', quantity: null, warehouse: null });
    assert.equal((await call('/v1/cadastros/warehouses?page=1')).data.total, 1);
    assert.equal((await call('/v1/cadastros/products?page=1', 'GET', undefined, 'financeiro')).status, 403);
    assert.equal((await call('/v1/cadastros/contacts?limit=1&q=bruno')).data.items[0].name, 'Bruno Fornecedor', 'legacy cursor list keeps working');

    const check = await call('/v1/cadastros/products/check', 'POST', { id: null, data: { name: 'Cópia', code: 'par-10' } });
    assert.equal(check.status, 200, JSON.stringify(check.data));
    assert.deepEqual(check.data.warnings.map(w => [w.code, w.total, w.matches[0].id]), [['duplicate_code', 1, parafuso.id]]);
    assert.equal((await call('/v1/cadastros/products/check', 'POST', { data: { code: 'X' } }, 'consulta')).status, 403);
    const document = await call('/v1/cadastros/contacts/check', 'POST', { id: ana.id, data: { person_type: 'J', document: '11.222.333/0001-82' } });
    assert.deepEqual(document.data.warnings, [{ code: 'invalid_document', field: 'document', expected: 'cnpj' }]);

    const command = randomUUID(), copy = { command_id: command, data: { name: 'Cópia', code: 'par-10', unit: 'UN' } };
    assert.equal((await call('/v1/cadastros/products', 'POST', { ...copy, acknowledged_warnings: [] })).status, 409, 'an unconfirmed warning is refused');
    const saved = await call('/v1/cadastros/products', 'POST', { ...copy, acknowledged_warnings: ['duplicate_code'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.replayed, false);
    const replay = await call('/v1/cadastros/products', 'POST', { ...copy, acknowledged_warnings: ['duplicate_code'] });
    assert.equal(replay.data.replayed, true); assert.equal(replay.data.record.id, saved.data.record.id);
    const price = await call(`/v1/cadastros/products/${parafuso.id}`, 'PATCH', { command_id: randomUUID(), expected_version: parafuso.version, data: { price: '2,5'.replace(',', '.') } });
    assert.equal(price.status, 200); assert.equal(price.data.record.price, '2.5000'); assert.equal(price.data.record.code, 'PAR-10', 'price-only patch keeps other fields');
    assert.equal((await call(`/v1/cadastros/products/${parafuso.id}`, 'PATCH', { command_id: randomUUID(), expected_version: parafuso.version, data: { price: '3' } })).status, 409);
    assert.equal(await f.scalar("select count(*)::int v from erp_catalog.audit where action='warnings_acknowledged'"), 1);
  } finally { await f.close(); }
});
