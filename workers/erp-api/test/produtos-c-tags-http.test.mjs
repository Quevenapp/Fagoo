import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { productRegistryFixture } from './helpers/product-registry-fixture.mjs';
import { produtosFixture } from './helpers/produtos-c-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf } from './helpers/produtos-c-http.mjs';

// HTTP of the tags (migration 153): typed tags, contact tags and the Tags / Lista de preço filters of the contacts list. Strict
// input before the database, the worker against the real SQL in PGlite and closed shapes after it. Synthetic data only.
const uuid = 'b0000000-0000-4000-8000-000000000001', other = 'b0000000-0000-4000-8000-000000000002';

test('153 routes: contact tags under /v1/cadastros/contatos, the contatos routes unchanged', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/contatos/tags'), { product: 'contact-tags', scope: 'list', entity: 'contacts', id: null });
  assert.deepEqual(catalogRoute(`/v1/cadastros/contatos/${uuid.toUpperCase()}/tags`), { product: 'contact-tags', scope: 'contact', entity: 'contacts', id: uuid });
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/contatos/tags')), ['GET']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/contatos/${uuid}/tags`)), ['GET', 'PATCH']);
  assert.equal(catalogRoute(`/v1/cadastros/contatos/${uuid}`).contact, 'contact');
  assert.equal(catalogRoute('/v1/cadastros/contatos').contact, 'contacts');
  assert.equal(catalogRoute('/v1/cadastros/contatos/x/tags'), null);
});

test('153 strict input: contact tags, tag types and the contact list filters are refused before the database', async () => {
  const { handler, calls } = fakeHandler({});
  const bad = [
    ['/v1/cadastros/contatos/tags', 'GET'], ['/v1/cadastros/contatos/tags?ids=x', 'GET'], [`/v1/cadastros/contatos/tags?ids=${uuid},${uuid.toUpperCase()}`, 'GET'],
    [`/v1/cadastros/contatos/tags?ids=${Array.from({ length: 101 }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`, 'GET'],
    [`/v1/cadastros/contatos/${uuid}/tags?x=1`, 'GET'],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'replace', tag_ids: [] }],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'add', expected_version: 1, tag_ids: [uuid] }],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'add', tag_ids: [] }],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'replace', expected_version: -1, tag_ids: [] }],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'replace', expected_version: 0, tag_ids: [uuid, uuid] }],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'remove', tag_ids: [uuid] }],
    [`/v1/cadastros/contatos/${uuid}/tags`, 'POST', { command_id: randomUUID(), mode: 'add', tag_ids: [uuid] }],
    ['/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'A', tag_type: 'pessoas' } }],
    ['/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'A', tag_type: 'products' } }],
    [`/v1/cadastros/taxonomias/tags/${uuid}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { name: 'A', tag_type: 'contacts' } }],
    ['/v1/cadastros/contatos?page=1&tag=VIP', 'GET'], ['/v1/cadastros/contatos?page=1&price_list_id=x', 'GET'], ['/v1/cadastros/contatos/exportar?tag=1', 'GET'],
  ];
  for (const [path, method, body] of bad) assert.ok([400, 405].includes((await handler(request(path, method, body), env)).status), `${method} ${path}`);
  assert.equal(calls.filter(call => !call.url.endsWith('/auth/v1/user')).length, 0);
});

test('153 the contacts list switches to the tagged functions only with the new filters', async () => {
  const page = { entity: 'contacts', items: [], page: 1, size: 100, total: 0, sort: 'created_desc', situation: 'latest', scoped: false, data_mode: 'erp_native' };
  const { handler, calls } = fakeHandler(page);
  assert.equal((await handler(request('/v1/cadastros/contatos?page=1'), env)).status, 200);
  assert.equal((await handler(request(`/v1/cadastros/contatos?page=1&tag=none&price_list_id=${uuid.toUpperCase()}`), env)).status, 200);
  const rpcs = calls.filter(call => !call.url.endsWith('/auth/v1/user'));
  assert.deepEqual(rpcs.map(rpcOf), ['erp_catalog_contact_page', 'erp_catalog_contact_page_tagged']);
  const args = JSON.parse(rpcs[1].body);
  assert.deepEqual([args.p_tag, args.p_price_list_id], ['none', uuid]);
  assert.equal(Object.hasOwn(JSON.parse(rpcs[0].body), 'p_tag'), false, 'the contatos page keeps its arguments');
  const exportPage = { scope: 'contacts_export', kind: 'contacts', items: [], offset: 0, limit: 100, total: 0, data_mode: 'erp_native' };
  const exporter = fakeHandler(exportPage);
  assert.equal((await exporter.handler(request(`/v1/cadastros/contatos/exportar?tag=${uuid}`), env)).status, 200);
  assert.equal(rpcOf(exporter.calls.at(-1)), 'erp_catalog_contact_export_tagged');
});

test('153 closed shapes: unexpected answers of the contact tags and of the typed taxonomy are 502', async () => {
  const set = { contact_id: uuid, version: 1, tag_ids: [other], tags: [{ id: other, name: 'VIP', group_id: null, group_name: null }] };
  for (const value of [{ entity: 'contacts', items: [{ ...set, version: -1 }], data_mode: 'erp_native' }, { entity: 'contacts', items: [{ ...set, tags: [] }], data_mode: 'erp_native' },
    { entity: 'contacts', items: [{ ...set, contact_id: other }], data_mode: 'erp_native' }, { entity: 'contacts', items: [set], extra: 1, data_mode: 'erp_native' },
    { entity: 'contacts', items: [{ ...set, tags: [{ ...set.tags[0], name: 'x'.repeat(101) }] }], data_mode: 'erp_native' }])
    assert.equal((await fakeHandler(value).handler(request(`/v1/cadastros/contatos/tags?ids=${uuid}`), env)).status, 502, JSON.stringify(value));
  assert.equal((await fakeHandler({ entity: 'contacts', items: [], data_mode: 'erp_native' }).handler(request(`/v1/cadastros/contatos/${uuid}/tags`), env)).status, 404, 'an invisible contact reads as missing');
  const saved = { entity: 'contacts', contact: { ...set, tag_ids: [], tags: [] }, changed: true, replayed: false, data_mode: 'erp_native' };
  assert.equal((await fakeHandler(saved).handler(request(`/v1/cadastros/contatos/${uuid}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'add', tag_ids: [other] }), env)).status, 502, 'an add must answer the added tag');
  const item = { id: uuid, kind: 'tags', parent_id: null, name: 'VIP', version: 1, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', tag_type: 'contacts', children: 0, products: 0, contacts: 2 };
  assert.equal((await fakeHandler({ kind: 'tags', items: [item], data_mode: 'erp_native' }).handler(request('/v1/cadastros/taxonomias/tags'), env)).status, 200);
  for (const wrong of [{ ...item, tag_type: null }, { ...item, tag_type: 'people' }, (({ contacts, ...rest }) => rest)(item), { ...item, contacts: -1 }])
    assert.equal((await fakeHandler({ kind: 'tags', items: [wrong], data_mode: 'erp_native' }).handler(request('/v1/cadastros/taxonomias/tags'), env)).status, 502, JSON.stringify(wrong));
  assert.equal((await fakeHandler({ kind: 'categories', items: [{ ...item, kind: 'categories', tag_type: 'products' }], data_mode: 'erp_native' }).handler(request('/v1/cadastros/taxonomias/categorias-produtos'), env)).status, 502);
});

test('153 the worker before the migration: the typed taxonomy answer is required (documented 502 against the production SQL)', async () => {
  const f = await productRegistryFixture({ lane: [] });
  try {
    const { call } = realHandler(f);
    await f.taxonomySave('tags', { name: 'Promoção' });
    assert.equal((await call('/v1/cadastros/taxonomias/tags')).status, 502, 'the API is published after migration 153 (banco -> API -> ERP)');
  } finally { await f.close(); }
});

test('153 worker and SQL agree: typed tags, contact tags, Marcadores and the tagged contacts list', async () => {
  const f = await produtosFixture();
  try {
    const { call, calls } = realHandler(f);
    const group = await call('/v1/cadastros/taxonomias/grupos-tags', 'POST', { command_id: randomUUID(), data: { name: 'Segmento', tag_type: 'contacts' } });
    assert.equal(group.status, 200, JSON.stringify(group.data)); assert.equal(group.data.item.tag_type, 'contacts');
    const tag = (await call('/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'Atacado', parent_id: group.data.item.id } })).data.item;
    assert.equal(tag.tag_type, 'contacts');
    assert.equal((await call('/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'Linha', tag_type: 'products' } }, 'financeiro')).status, 403);
    assert.deepEqual((await call('/v1/cadastros/taxonomias/tags', 'GET', undefined, 'financeiro')).data.items.map(item => item.name), ['Atacado']);
    const contact = await f.contact({ name: 'Cliente HTTP' }), second = await f.contact({ name: 'Cliente sem tag' });
    const command = randomUUID();
    const saved = await call(`/v1/cadastros/contatos/${contact.id}/tags`, 'PATCH', { command_id: command, mode: 'replace', expected_version: 0, tag_ids: [tag.id.toUpperCase()] }, 'financeiro');
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual([saved.data.contact.version, saved.data.contact.tags.map(item => [item.name, item.group_name]), saved.data.replayed], [1, [['Atacado', 'Segmento']], false]);
    assert.equal((await call(`/v1/cadastros/contatos/${contact.id}/tags`, 'PATCH', { command_id: command, mode: 'replace', expected_version: 0, tag_ids: [tag.id.toUpperCase()] }, 'financeiro')).data.replayed, true);
    assert.equal((await call(`/v1/cadastros/contatos/${contact.id}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'replace', expected_version: 0, tag_ids: [] })).status, 409);
    assert.equal((await call(`/v1/cadastros/contatos/${contact.id}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'add', tag_ids: [tag.id] }, 'consulta')).status, 403);
    const added = await call(`/v1/cadastros/contatos/${second.id}/tags`, 'PATCH', { command_id: randomUUID(), mode: 'add', tag_ids: [tag.id] });
    assert.deepEqual([added.data.changed, added.data.contact.version], [true, 1]);
    const markers = await call(`/v1/cadastros/contatos/tags?ids=${contact.id},${second.id}`, 'GET', undefined, 'consulta');
    assert.deepEqual(markers.data.items.map(item => [item.contact_id, item.tags.map(t => t.name)]), [[contact.id, ['Atacado']], [second.id, ['Atacado']]]);
    assert.deepEqual((await call(`/v1/cadastros/contatos/${contact.id}/tags`)).data.contact.tag_ids, [tag.id]);
    assert.equal((await call(`/v1/cadastros/contatos/${randomUUID()}/tags`)).status, 404);
    const page = await call(`/v1/cadastros/contatos?page=1&situation=all&sort=name_asc&tag=${tag.id}`);
    assert.equal(page.status, 200, JSON.stringify(page.data)); assert.deepEqual(page.data.items.map(item => item.name), ['Cliente HTTP', 'Cliente sem tag']);
    assert.equal(calls.at(-1).name, 'erp_catalog_contact_page_tagged');
    assert.equal((await call('/v1/cadastros/contatos?page=1&situation=all&tag=none')).data.total, 0);
    const exported = await call(`/v1/cadastros/contatos/exportar?situation=all&tag=${tag.id}`);
    assert.equal(exported.status, 200, JSON.stringify(exported.data)); assert.equal(exported.data.total, 2);
    const removed = await call(`/v1/cadastros/taxonomias/tags/${tag.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: 1 }, 'financeiro');
    assert.deepEqual([removed.status, removed.data.deleted, removed.data.products], [200, true, 2]);
  } finally { await f.close(); }
});
