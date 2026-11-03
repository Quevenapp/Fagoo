import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/index.mjs';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { productRegistryFixture } from './helpers/product-registry-fixture.mjs';

// HTTP of the products lane (migrations 119-120): strict routes and bodies before the database, the worker against the real SQL
// in PGlite, and closed response shapes (an unexpected upstream shape is a 502, never forwarded).
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', ALLOWED_ORIGINS: 'https://erp.example.test' };
const uuid = 'b0000000-0000-4000-8000-000000000001';

function realHandler(f) {
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: f.users[options.headers.Authorization.split('-').at(-1)] }));
    const name = new URL(url).pathname.split('/').at(-1), args = Object.entries(JSON.parse(options.body)); calls.push(name);
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
  return { call, calls };
}
function fakeHandler(result) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, body: options.body });
    return new Response(JSON.stringify(url.endsWith('/auth/v1/user') ? { id: 'a0000000-0000-4000-8000-000000000001' } : result)); } }) };
}
const request = (path, method = 'GET', body) => new Request(`https://api.example.test${path}`, { method, headers: { Authorization: 'Bearer synthetic-user', Origin: 'https://erp.example.test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

test('routes and methods of the products lane', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/taxonomias/categorias-produtos'), { product: 'taxonomy', entity: 'products', kind: 'categories', id: null, remove: false });
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/taxonomias/tags')), ['GET', 'POST']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/taxonomias/grupos-produtos/${uuid}`)), ['PATCH']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/taxonomias/grupos-tags/${uuid}/excluir`)), ['POST']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/products/${uuid}/deleted`)), ['PATCH']);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/products/exportacao')), ['GET']);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/products/completo')), ['POST']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/products/${uuid}/completo`)), ['GET', 'PATCH']);
  assert.deepEqual(catalogRoute(`/v1/cadastros/products/${uuid}`), { entity: 'products', id: uuid, active: false }, 'the 006 route is unchanged');
  for (const path of ['/v1/cadastros/taxonomias/marcas', '/v1/cadastros/taxonomias/tags/x', `/v1/cadastros/contacts/${uuid}/deleted`, '/v1/cadastros/taxonomias'])
    assert.equal(catalogRoute(path)?.product, undefined, path);
});

test('strict bodies and queries are refused before the database', async () => {
  const { handler, calls } = fakeHandler({});
  const bad = [
    ['/v1/cadastros/taxonomias/categorias-produtos?x=1', 'GET'],
    ['/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: 'x', data: { name: 'A' } }],
    ['/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'x'.repeat(51) } }],
    ['/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'A', color: 'red' } }],
    ['/v1/cadastros/taxonomias/grupos-tags', 'POST', { command_id: randomUUID(), data: { name: 'A', parent_id: uuid } }],
    [`/v1/cadastros/taxonomias/tags/${uuid}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { name: 'A', parent_id: uuid } }],
    [`/v1/cadastros/taxonomias/tags/${uuid}/excluir`, 'POST', { command_id: randomUUID() }],
    [`/v1/cadastros/products/${uuid}/deleted`, 'PATCH', { command_id: randomUUID(), expected_version: 1, deleted: 'yes' }],
    ['/v1/cadastros/products/exportacao?limit=251', 'GET'], ['/v1/cadastros/products/exportacao?include_deleted=1', 'GET'], ['/v1/cadastros/products/exportacao?situation=all', 'GET'],
    ['/v1/cadastros/products?page=1&situation=all', 'GET'], ['/v1/cadastros/products?page=1&situation=latest&type=kits', 'GET'], ['/v1/cadastros/products?page=1&situation=latest&tag=x', 'GET'],
    ['/v1/cadastros/products?page=1&situation=latest&period=expiry', 'GET'], ['/v1/cadastros/products?page=1&situation=latest&item_type=11', 'GET'],
    ['/v1/cadastros/products?page=1&situation=latest&kind=P', 'GET'], ['/v1/cadastros/products?page=1&situation=latest&situation=active', 'GET'],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'A', tax_percent: 12.5 } }],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'A', suppliers: [{ supplier_id: uuid }] } }],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'A', images: [{ url: 'http://inseguro.test/a.png' }] } }],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'A', active: 'false' } }],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'A', expiry_date: '2026-02-30' } }],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { active: true } }],
    ['/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'A' }, acknowledged_warnings: ['duplicate_document'] }],
    [`/v1/cadastros/products/${uuid}/completo`, 'PATCH', { command_id: randomUUID(), data: { name: 'A' } }],
    ['/v1/cadastros/products', 'POST', { command_id: randomUUID(), data: { name: 'A', notes: 'detail only on the complete route' } }],
  ];
  for (const [path, method, body] of bad) assert.equal((await handler(request(path, method, body), env)).status, 400, `${method} ${path} ${JSON.stringify(body)}`);
  assert.equal(calls.filter(call => !call.url.endsWith('/auth/v1/user')).length, 0);
});

test('unexpected upstream shapes are refused with 502', async () => {
  for (const [path, result] of [
    ['/v1/cadastros/taxonomias/tags', { kind: 'categories', items: [], data_mode: 'erp_native' }],
    ['/v1/cadastros/taxonomias/tags', { kind: 'tags', items: [{ id: uuid, kind: 'tags', parent_id: null, name: 'A', version: 1, created_at: 'x', updated_at: 'x', children: 0, products: 0 }], data_mode: 'erp_native' }],
    ['/v1/cadastros/taxonomias/tags', { kind: 'tags', items: [{ id: uuid, kind: 'tags', parent_id: null, name: 'A', version: 1, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', children: 0, products: 0, secret: 1 }], data_mode: 'erp_native' }],
  ]) assert.equal((await fakeHandler(result).handler(request(path), env)).status, 502);
  const productLists = item => ({ product_id: uuid, items: [{ id: uuid, name: 'Atacado', list_type: 'rates', rule: 'Desconto 10 %', list_price: '9.00', ...item }], data_mode: 'erp_native' });
  assert.equal((await fakeHandler(productLists({})).handler(request(`/v1/cadastros/products/${uuid}/listas-precos`), env)).status, 200);
  for (const item of [{ name: '' }, { name: 'L'.repeat(121) }, { rule: 'R'.repeat(61) }, { list_price: '9.0' }])
    assert.equal((await fakeHandler(productLists(item)).handler(request(`/v1/cadastros/products/${uuid}/listas-precos`), env)).status, 502, JSON.stringify(item));
  const record = { id: uuid, entity: 'products', version: 1, active: true, name: 'P', code: null, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', source: null };
  assert.equal((await fakeHandler({ entity: 'products', record: { ...record, tax_percent: '12.5' }, data_mode: 'erp_native' }).handler(request(`/v1/cadastros/products/${uuid}/completo`), env)).status, 502, 'decimals must be canonical');
  assert.equal((await fakeHandler({ entity: 'products', record: { ...record, images: [{ url: 'javascript:alert(1)' }] }, data_mode: 'erp_native' }).handler(request(`/v1/cadastros/products/${uuid}/completo`), env)).status, 502);
  const old = await fakeHandler({ entity: 'products', record, data_mode: 'erp_native' }).handler(request(`/v1/cadastros/products/${uuid}/completo`), env);
  assert.equal(old.status, 200, 'a record without the 119 detail (old replay) reads as null');
  const body = await old.json(); assert.equal(body.record.suppliers, null); assert.equal(body.record.expiry_date, null);
});

test('worker and SQL agree: taxonomy, product detail, deleted flag, v2 page and export', async () => {
  const f = await productRegistryFixture();
  try {
    const { call, calls } = realHandler(f);
    const created = await call('/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'Ferragens' } });
    assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(created.data.saved, true);
    const category = created.data.item;
    const sub = await call('/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'Parafusos', parent_id: category.id.toUpperCase() } });
    assert.equal(sub.data.item.parent_id, category.id);
    assert.deepEqual((await call('/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'ferragens' } })).data, { kind: 'categories', saved: false, reason: 'duplicate_name', data_mode: 'erp_native', replayed: false });
    const renamed = await call(`/v1/cadastros/taxonomias/categorias-produtos/${category.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { name: 'Ferragens e fixação' } });
    assert.equal(renamed.data.item.version, 2);
    assert.equal((await call(`/v1/cadastros/taxonomias/categorias-produtos/${category.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { name: 'Outro' } })).status, 409);
    assert.equal((await call('/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'Sem acesso' } }, 'consulta')).status, 403);
    const tag = (await call('/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'Promoção' } })).data.item;
    const list = await call('/v1/cadastros/taxonomias/categorias-produtos', 'GET', undefined, 'consulta');
    assert.deepEqual(list.data.items.map(item => [item.name, item.children]), [['Ferragens e fixação', 1], ['Parafusos', 0]]);

    const supplier = (await f.save('contacts', { name: 'Fornecedor HTTP', roles: ['supplier'] })).id;
    const command = randomUUID();
    const data = { name: 'Parafuso HTTP', code: 'HTTP-1', price: '2.5', unit: 'UN', kind: 'P', format: 'S', active: false, category_id: sub.data.item.id, tag_ids: [tag.id], expiry_date: '2027-01-31',
      complementary_description: 'Linha 1\nLinha 2', tax_percent: '4.5', item_type: '00', images: [{ url: 'https://exemplo.test/a.png' }], dun_codes: [{ code: '17891234567892', quantity: '6' }],
      suppliers: [{ supplier_id: supplier, description: 'No fornecedor', code: 'F-9', purchase_price: '1.9', cost_price: '2.0000000001', warranty_months: '6', is_default: true }] };
    const product = await call('/v1/cadastros/products/completo', 'POST', { command_id: command, data });
    assert.equal(product.status, 200, JSON.stringify(product.data));
    const record = product.data.record;
    assert.equal(record.active, false); assert.equal(record.tax_percent, '4.5000'); assert.equal(record.cost_price, '2.0000000001'); assert.equal(record.suppliers[0].supplier_name, 'Fornecedor HTTP');
    assert.equal(calls.at(-1), 'erp_catalog_product_save');
    assert.equal((await call('/v1/cadastros/products/completo', 'POST', { command_id: command, data })).data.replayed, true);
    const read = await call(`/v1/cadastros/products/${record.id}/completo`, 'GET', undefined, 'consulta');
    assert.deepEqual(read.data.record, record); assert.equal(calls.at(-1), 'erp_catalog_product_get');
    const checked = await call('/v1/cadastros/products/check', 'POST', { id: record.id, data: { ...data, code: 'HTTP-2' } });
    assert.equal(checked.status, 200, JSON.stringify(checked.data)); assert.deepEqual(checked.data.warnings, []);
    const price = await call(`/v1/cadastros/products/${record.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { price: '3' } });
    assert.equal(price.data.record.price, '3.0000'); assert.equal(calls.at(-1), 'erp_catalog_save', 'the inline price keeps the 006 save');
    assert.equal((await call(`/v1/cadastros/products/${record.id}/completo`)).data.record.suppliers.length, 1, 'a price-only save keeps the detail');
    const legacy = await call(`/v1/cadastros/products/${record.id}`); assert.equal(legacy.data.record.suppliers, undefined, 'the 006 read stays lean');

    const page = await call('/v1/cadastros/products?page=1&situation=inactive&category=' + sub.data.item.id + '&tag=' + tag.id + '&period=expiry&from=2027-01-01&to=2027-01-31&type=simple&item_type=00&images=yes&supplier_id=' + supplier + '&supplier_code=f-9');
    assert.equal(page.status, 200, JSON.stringify(page.data)); assert.deepEqual(page.data.items.map(item => item.name), ['Parafuso HTTP']);
    assert.deepEqual([page.data.items[0].thumbnail, page.data.items[0].cost_price, page.data.items[0].deleted], ['https://exemplo.test/a.png', '2.0000000001', false]);
    // 202610220008: the Origin observed balance is read in one batch right after the native page.
    assert.deepEqual(calls.slice(-2), ['erp_catalog_product_page_v2', 'erp_stock_mirror_product_summary']);
    assert.equal((await call('/v1/cadastros/products?page=1')).status, 200, 'the 096 page keeps working'); assert.equal(calls.at(-1), 'erp_catalog_product_page');

    const removed = await call(`/v1/cadastros/products/${record.id}/deleted`, 'PATCH', { command_id: randomUUID(), expected_version: 2, deleted: true });
    assert.equal(removed.status, 200, JSON.stringify(removed.data)); assert.ok(removed.data.record.deleted_at);
    assert.equal((await call(`/v1/cadastros/products/${record.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 3, data: { price: '4' } })).status, 409, 'deleted products are read-only');
    assert.equal((await call(`/v1/cadastros/products/${record.id}/active`, 'PATCH', { command_id: randomUUID(), expected_version: 3, active: true })).status, 409);
    assert.deepEqual((await call('/v1/cadastros/products?page=1&situation=deleted')).data.items.map(item => [item.name, item.deleted]), [['Parafuso HTTP', true]]);
    const exported = await call('/v1/cadastros/products/exportacao?limit=10&include_deleted=true&situation=latest');
    assert.equal(exported.status, 200, JSON.stringify(exported.data));
    const row = exported.data.items.find(item => item.id === record.id);
    assert.deepEqual([row.supplier.name, row.category, row.tags, row.images], ['Fornecedor HTTP', 'Parafusos', ['Promoção'], ['https://exemplo.test/a.png']]);
    assert.ok(!(await call('/v1/cadastros/products/exportacao')).data.items.some(item => item.id === record.id));

    const gone = await call(`/v1/cadastros/taxonomias/categorias-produtos/${category.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: 2 });
    assert.deepEqual(gone.data, { kind: 'categories', id: category.id, deleted: false, reason: 'has_children', data_mode: 'erp_native', replayed: false });
    const tagGone = await call(`/v1/cadastros/taxonomias/tags/${tag.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: 1 });
    assert.deepEqual([tagGone.data.deleted, tagGone.data.products], [true, 1]);
  } finally { await f.close(); }
});

test('price lists: strict HTTP, the worker against the SQL of 121 and closed responses', async () => {
  const { handler, calls } = fakeHandler({});
  const listData = { name: 'Atacado', category: 'other', list_type: 'rates', factor: '10', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: [] };
  for (const [path, method, body] of [
    ['/v1/cadastros/listas-precos?tipo=x', 'GET'], ['/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, factor: 10 } }],
    ['/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, regions: ['XX'] } }],
    [`/v1/cadastros/listas-precos/${uuid}/itens`, 'POST', { command_id: randomUUID(), expected_version: 1, change: { adjust: { action: 'fix', unit: 'percent', value: '1' } } }],
    [`/v1/cadastros/listas-precos/${uuid}?limit=101`, 'GET'], [`/v1/cadastros/listas-precos/${uuid}/clonar`, 'POST', { command_id: randomUUID(), name: '' }],
  ]) assert.equal((await handler(request(path, method, body), env)).status, 400, `${method} ${path}`);
  assert.equal(calls.filter(call => !call.url.endsWith('/auth/v1/user')).length, 0);
  const f = await productRegistryFixture();
  try {
    const { call } = realHandler(f);
    const product = (await f.productSave({ name: 'Parafuso', code: 'P1', price: '10.1250' })).record.id;
    const created = await call('/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: listData });
    assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(created.data.list.rule, 'Desconto 10 %');
    const list = created.data.list;
    const added = await call(`/v1/cadastros/listas-precos/${list.id}/itens`, 'POST', { command_id: randomUUID(), expected_version: 1, change: { add: [product] } });
    assert.equal(added.status, 200, JSON.stringify(added.data)); assert.equal(added.data.list.products, 1);
    const detail = await call(`/v1/cadastros/listas-precos/${list.id}?q=paraf`, 'GET', undefined, 'consulta');
    assert.deepEqual(detail.data.items.map(item => [item.name, item.product_price, item.list_price]), [['Parafuso', '10.1250', '9.11']]);
    assert.deepEqual((await call(`/v1/cadastros/products/${product}/listas-precos`)).data.items.map(item => [item.name, item.list_price]), [['Atacado', '9.11']]);
    assert.deepEqual((await call('/v1/cadastros/listas-precos?tipo=rates')).data.items.map(item => item.name), ['Atacado']);
    assert.equal((await call('/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: listData })).data.reason, 'duplicate_name');
    assert.equal((await call(`/v1/cadastros/listas-precos/${list.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: listData })).status, 409);
    const clone = await call(`/v1/cadastros/listas-precos/${list.id}/clonar`, 'POST', { command_id: randomUUID(), name: 'Atacado 2' });
    assert.equal(clone.data.list.products, 1);
    assert.equal((await call(`/v1/cadastros/listas-precos/${clone.data.list.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: 1 })).data.deleted, true);
    assert.equal((await call('/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, name: 'Sem acesso' } }, 'consulta')).status, 403);
  } finally { await f.close(); }
});
