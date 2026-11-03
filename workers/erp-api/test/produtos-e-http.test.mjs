import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { produtosEFixture } from './helpers/produtos-e-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf, upstream } from './helpers/produtos-c-http.mjs';

// HTTP of the produtos lane, wave E (migrations 234-236): the Componente of the product list, page and export, the stock scope
// of the export, the Campos Customizados screen with the user's permissions, the Marcadores (tags) of the notas fiscais and the
// Tags filter of the notes list. Strict input before the database, the worker against the real SQL in PGlite and closed shapes
// after it. Synthetic data only.
const uuid = 'e0000000-0000-4000-8000-000000000001', other = 'e0000000-0000-4000-8000-000000000002';
const tagSet = (id, extra = {}) => ({ invoice_id: id, version: 0, tag_ids: [], tags: [], ...extra });

test('234-236 routes: invoice tags, the custom fields screen and their methods', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/notas-fiscais/tags'), { product: 'invoice-tags', scope: 'list', entity: 'products', id: null });
  assert.deepEqual(catalogRoute(`/v1/cadastros/notas-fiscais/brufap/55/${uuid.toUpperCase()}/tags`), { product: 'invoice-tags', scope: 'note', entity: 'products', origin: 'brufap', model: '55', id: uuid });
  assert.deepEqual(catalogRoute('/v1/cadastros/notas-fiscais/origin/65/123/tags'), { product: 'invoice-tags', scope: 'note', entity: 'products', origin: 'origin', model: '65', id: '123' });
  for (const path of ['/v1/cadastros/notas-fiscais/origin/55/abc/tags', '/v1/cadastros/notas-fiscais/brufap/55/123/tags', '/v1/cadastros/notas-fiscais/outro/55/1/tags', '/v1/cadastros/notas-fiscais/origin/57/1/tags'])
    assert.equal(catalogRoute(path), null, path);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/notas-fiscais/tags')), ['GET']);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/notas-fiscais/origin/55/1/tags')), ['PATCH']);
});

test('234-236 strict input: refused before the database', async () => {
  const { handler, calls } = fakeHandler({});
  const bad = [
    // Componente only with the Tipo "Produtos com composição" and as a UUID.
    [`/v1/cadastros/products?page=1&situation=latest&component_id=${uuid}`], [`/v1/cadastros/products?page=1&situation=latest&type=simple&component_id=${uuid}`],
    ['/v1/cadastros/products?page=1&situation=latest&type=composition&component_id=x'], [`/v1/cadastros/products/exportacao?component_id=${uuid}`],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'fix', unit: 'amount', value: '1' }, filters: { component_id: uuid } }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'fix', unit: 'amount', value: '1' }, filters: { type: 'composition', component_id: 'x' } }],
    // Custom fields screen.
    ['/v1/cadastros/campos-customizados?tela=outra'], ['/v1/cadastros/campos-customizados?tela=produtos&modulo=produtos'],
    // Invoice tags.
    ['/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55'], ['/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=a'], ['/v1/cadastros/notas-fiscais/tags?origem=x&modelo=55&ids=1'],
    ['/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=59&ids=1'], ['/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=1,1'], ['/v1/cadastros/notas-fiscais/tags?origem=brufap&modelo=55&ids=1'],
    [`/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=${Array.from({ length: 101 }, (_, n) => n + 1).join(',')}`], ['/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=1&x=1'],
    ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), tag_ids: [] }], ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: 'x', expected_version: 0, tag_ids: [] }],
    ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), expected_version: -1, tag_ids: [] }], ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), expected_version: 0, tag_ids: ['x'] }],
    ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), expected_version: 0, tag_ids: [uuid, uuid.toUpperCase()] }],
    ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), expected_version: 0, tag_ids: Array.from({ length: 51 }, () => randomUUID()) }],
    ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), expected_version: 0, tag_ids: [], mode: 'add' }],
    ['/v1/cadastros/notas-fiscais/origin/55/1/tags?x=1', 'PATCH', { command_id: randomUUID(), expected_version: 0, tag_ids: [] }], ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'GET'],
    // Tags filter of the notes list.
    ['/v1/notas-fiscais?model=55&tag=x'], ['/v1/notas-fiscais?model=55&tag=none&tag=none'],
    // Taxonomy: an unknown Tipo.
    ['/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'X', tag_type: 'notas' } }],
  ];
  for (const [path, method = 'GET', body] of bad) assert.ok([400, 404, 405].includes((await handler(request(path, method, body), env)).status), `${method} ${path}`);
  assert.equal(upstream(calls).length, 0);
});

test('234-236 the right function with canonical arguments', async () => {
  const { handler, calls } = fakeHandler({});
  const sent = async (path, method, body) => { await handler(request(path, method, body), env); const call = upstream(calls).at(-1); return { rpc: rpcOf(call), args: JSON.parse(call.body) }; };
  let call = await sent(`/v1/cadastros/products?page=1&situation=latest&type=composition&component_id=${uuid.toUpperCase()}`);
  assert.deepEqual([call.rpc, call.args.p_component_id, call.args.p_custom, call.args.p_product_type], ['erp_catalog_product_page_v3', uuid, null, 'composition']);
  call = await sent(`/v1/cadastros/products?page=1&situation=latest&type=composition&component_id=${uuid}&custom=${encodeURIComponent(JSON.stringify([{ field_id: other, value: 'a' }]))}`);
  assert.deepEqual([call.rpc, call.args.p_custom], ['erp_catalog_product_page_v3', [{ field_id: other, value: 'a' }]]);
  call = await sent('/v1/cadastros/products?page=1&situation=latest&type=composition');
  assert.equal(call.rpc, 'erp_catalog_product_page_v2');
  call = await sent(`/v1/cadastros/products/exportacao?type=composition&component_id=${uuid}`);
  assert.deepEqual([call.rpc, call.args.p_component_id], ['erp_catalog_product_export_v2', uuid]);
  assert.equal((await sent('/v1/cadastros/products/exportacao')).rpc, 'erp_catalog_product_export');
  call = await sent('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'fix', unit: 'amount', value: '1' }, filters: { type: 'composition', component_id: uuid.toUpperCase() } });
  assert.deepEqual(call.args.p_filters, { product_type: 'composition', component_id: uuid });
  assert.deepEqual(await sent('/v1/cadastros/campos-customizados?tela=produtos'), { rpc: 'erp_catalog_custom_fields_screen', args: { p_user_id: 'a0000000-0000-4000-8000-000000000001' } });
  call = await sent(`/v1/cadastros/notas-fiscais/tags?origem=brufap&modelo=55&ids=${uuid.toUpperCase()},${other}`);
  assert.deepEqual([call.rpc, call.args.p_origin, call.args.p_model, call.args.p_ids], ['erp_catalog_invoice_tags', 'brufap', '55', [uuid, other]]);
  const command = randomUUID();
  call = await sent('/v1/cadastros/notas-fiscais/origin/65/77/tags', 'PATCH', { command_id: command.toUpperCase(), expected_version: 3, tag_ids: [uuid.toUpperCase()] });
  assert.deepEqual(call, { rpc: 'erp_catalog_invoice_tags_save', args: { p_user_id: 'a0000000-0000-4000-8000-000000000001', p_origin: 'origin', p_model: '65', p_id: '77', p_expected_version: 3, p_command_id: command, p_tag_ids: [uuid], p_mode: 'replace' } });
  call = await sent(`/v1/notas-fiscais?model=55&tag=${uuid.toUpperCase()}`);
  assert.deepEqual([call.rpc, call.args.p_tag], ['erp_catalog_invoice_list_tagged', uuid]);
  call = await sent('/v1/notas-fiscais?model=55');
  assert.deepEqual([call.rpc, Object.hasOwn(call.args, 'p_tag')], ['erp_fiscal_invoice_list', false]);
});

test('234-236 closed answers: unexpected shapes become 502', async () => {
  const status = async (answer, path, method, body) => (await fakeHandler(answer).handler(request(path, method, body), env)).status;
  const list = '/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=1,2';
  const good = { scope: 'invoice_tags', origin: 'origin', model: '55', data_mode: 'erp_native', items: [tagSet('1'), tagSet('2')] };
  assert.equal(await status(good, list), 200);
  for (const answer of [{ ...good, items: [tagSet('2'), tagSet('1')] }, { ...good, items: [tagSet('1')] }, { ...good, origin: 'brufap' }, { ...good, extra: 1 },
    { ...good, items: [tagSet('1', { version: 0, tag_ids: [uuid], tags: [{ id: uuid, name: 'A', group_id: null, group_name: null }] }), tagSet('2')] },
    { ...good, items: [tagSet('1', { version: 1, tag_ids: [uuid], tags: [] }), tagSet('2')] }, { ...good, items: [tagSet('1', { version: 1, tag_ids: [uuid], tags: [{ id: other, name: 'A', group_id: null, group_name: null }] }), tagSet('2')] }])
    assert.equal(await status(answer, list), 502, JSON.stringify(answer));
  const patch = ['/v1/cadastros/notas-fiscais/origin/55/1/tags', 'PATCH', { command_id: randomUUID(), expected_version: 2, tag_ids: [uuid] }];
  const saved = { scope: 'invoice_tags', origin: 'origin', model: '55', invoice: tagSet('1', { version: 3, tag_ids: [uuid], tags: [{ id: uuid, name: 'Urgente', group_id: null, group_name: null }] }), changed: true, replayed: false, data_mode: 'erp_native' };
  assert.equal(await status(saved, ...patch), 200);
  for (const answer of [{ ...saved, changed: false }, { ...saved, invoice: { ...saved.invoice, invoice_id: '2' } }, { ...saved, invoice: { ...saved.invoice, tag_ids: [], tags: [] } }, { ...saved, replayed: 'no' }])
    assert.equal(await status(answer, ...patch), 502, JSON.stringify(answer));
  const screen = { module: 'products', data_mode: 'erp_native', items: [], permissions: { insert_edit: true, delete: false } };
  assert.equal(await status(screen, '/v1/cadastros/campos-customizados?tela=produtos'), 200);
  for (const answer of [{ ...screen, permissions: undefined }, { ...screen, permissions: { insert_edit: 'sim', delete: false } }, { ...screen, permissions: { insert_edit: true, delete: false, view: true } }])
    assert.equal(await status(answer, '/v1/cadastros/campos-customizados?tela=produtos'), 502, JSON.stringify(answer));
  const exported = { entity: 'products', items: [], offset: 0, limit: 250, total: 0, stock_visible: true, data_mode: 'erp_native' };
  for (const [extra, code] of [[{}, 200], [{ stock_scope: 'considered_warehouses', stock_warehouse: null }, 200], [{ stock_scope: 'default_warehouse', stock_warehouse: { id: uuid, name: 'Geral' } }, 200],
    [{ stock_scope: 'default_warehouse', stock_warehouse: null }, 502], [{ stock_scope: 'considered_warehouses', stock_warehouse: { id: uuid, name: 'Geral' } }, 502], [{ stock_scope: 'outro' }, 502],
    [{ stock_scope: null }, 502], [{ stock_scope: 'default_warehouse', stock_warehouse: { id: 'x', name: 'Geral' } }, 502]])
    assert.equal(await status({ ...exported, ...extra }, '/v1/cadastros/products/exportacao'), code, JSON.stringify(extra));
  const taxonomy = { id: uuid, kind: 'tags', parent_id: null, name: 'Urgente', version: 1, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', tag_type: 'invoices', children: 0, products: 0, contacts: 0, invoices: 2 };
  assert.equal(await status({ kind: 'tags', items: [taxonomy], data_mode: 'erp_native' }, '/v1/cadastros/taxonomias/tags'), 200);
  for (const item of [{ ...taxonomy, invoices: undefined }, { ...taxonomy, invoices: -1 }, { ...taxonomy, tag_type: 'products' }])
    assert.equal(await status({ kind: 'tags', items: [item], data_mode: 'erp_native' }, '/v1/cadastros/taxonomias/tags'), 502, JSON.stringify(item));
});

test('234-236 worker and SQL agree: Componente, export stock, the custom fields screen and the Marcadores of the notes', async () => {
  const f = await produtosEFixture(); const { call } = realHandler(f);
  try {
    const component = await f.product({ name: 'Componente HTTP' });
    await f.compose(null, [[component, '2']], { data: { name: 'Kit HTTP' } });
    const page = await call(`/v1/cadastros/products?page=1&situation=latest&type=composition&component_id=${component.id}`, 'GET', undefined, 'vendas');
    assert.deepEqual([page.status, page.data.items.map(item => item.name)], [200, ['Kit HTTP']]);
    const main = await f.warehouse('Geral HTTP'); await f.launch(component.id, main.id, 'receipt', '4'); await f.setDefault(main.id);
    const exported = await call('/v1/cadastros/products/exportacao?q=Componente');
    assert.deepEqual([exported.status, exported.data.stock_scope, exported.data.stock_warehouse, exported.data.items[0].stock], [200, 'default_warehouse', { id: main.id, name: 'Geral HTTP' }, '4.000000']);
    const screen = await call('/v1/cadastros/campos-customizados?tela=produtos', 'GET', undefined, 'consulta');
    assert.deepEqual([screen.status, screen.data.permissions], [200, { insert_edit: false, delete: false }]);
    assert.equal((await call('/v1/cadastros/campos-customizados?tela=produtos', 'GET', undefined, 'financeiro')).status, 403);
    // Marcadores of a Origin note: the tag, the set, the list filter.
    await f.originNote('nfe', '8801', { tipo: 1, numero: 11, serie: 1, dataEmissao: '2026-10-15 10:00:00', situacao: 5, valorNota: 10, contato: { nome: 'Cliente HTTP' } });
    await f.originNote('nfe', '8802', { tipo: 1, numero: 12, serie: 1, dataEmissao: '2026-10-14 10:00:00', situacao: 5, valorNota: 20, contato: { nome: 'Outro HTTP' } });
    const tag = await call('/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'Urgente', tag_type: 'invoices' } }, 'fiscal');
    assert.deepEqual([tag.status, tag.data.item.tag_type, tag.data.item.invoices], [200, 'invoices', 0]);
    assert.equal((await call('/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'Outra', tag_type: 'invoices' } }, 'estoque')).status, 403);
    const read = await call('/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=8801,8802', 'GET', undefined, 'consulta');
    assert.deepEqual([read.status, read.data.items.map(item => item.version)], [200, [0, 0]]);
    const body = { command_id: randomUUID(), expected_version: 0, tag_ids: [tag.data.item.id] };
    const saved = await call('/v1/cadastros/notas-fiscais/origin/55/8801/tags', 'PATCH', body, 'fiscal');
    assert.deepEqual([saved.status, saved.data.changed, saved.data.invoice.version, saved.data.invoice.tags.map(t => t.name)], [200, true, 1, ['Urgente']]);
    const replay = await call('/v1/cadastros/notas-fiscais/origin/55/8801/tags', 'PATCH', body, 'fiscal');
    assert.deepEqual([replay.status, replay.data.replayed], [200, true]);
    assert.equal((await call('/v1/cadastros/notas-fiscais/origin/55/8802/tags', 'PATCH', { ...body, command_id: randomUUID() }, 'consulta')).status, 403);
    assert.equal((await call('/v1/cadastros/notas-fiscais/origin/55/8802/tags', 'PATCH', { ...body, command_id: randomUUID(), expected_version: 4 }, 'fiscal')).status, 409);
    assert.equal((await call('/v1/cadastros/notas-fiscais/origin/55/9999/tags', 'PATCH', { ...body, command_id: randomUUID() }, 'fiscal')).status, 404);
    const filtered = await call(`/v1/notas-fiscais?model=55&tag=${tag.data.item.id}`, 'GET', undefined, 'consulta');
    assert.deepEqual([filtered.status, filtered.data.items.map(item => item.id)], [200, ['8801']]);
    const untagged = await call('/v1/notas-fiscais?model=55&tag=none', 'GET', undefined, 'consulta');
    assert.deepEqual([untagged.status, untagged.data.items.map(item => item.id)], [200, ['8802']]);
    assert.equal((await call('/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=8801', 'GET', undefined, 'vendas')).status, 403);
  } finally { await f.close(); }
});

test('234-236 deploy order: the new worker against the production SQL (up to 233) refuses only the new routes', async () => {
  const f = await produtosEFixture({ lane: [] }); const { call } = realHandler(f);
  try {
    const component = await f.product({ name: 'Componente antigo' });
    assert.notEqual((await call(`/v1/cadastros/products?page=1&situation=latest&type=composition&component_id=${component.id}`)).status, 200);
    assert.equal((await call('/v1/cadastros/products?page=1&situation=latest&type=composition')).status, 200);
    // The 120 export of the old database answers without the stock scope: the sum of every warehouse.
    const exported = await call('/v1/cadastros/products/exportacao');
    assert.deepEqual([exported.status, exported.data.stock_scope, exported.data.stock_warehouse], [200, 'all_warehouses', null]);
    assert.equal((await call('/v1/cadastros/campos-customizados?tela=produtos')).status, 502);
    assert.equal((await call('/v1/cadastros/campos-customizados')).status, 200);
    assert.equal((await call('/v1/cadastros/notas-fiscais/tags?origem=origin&modelo=55&ids=1')).status, 502);
    assert.equal((await call('/v1/notas-fiscais?model=55&tag=none')).status, 502);
    assert.equal((await call('/v1/notas-fiscais?model=55')).status, 200);
    assert.equal((await call('/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'Antes de 236', tag_type: 'invoices' } }, 'fiscal')).status, 403, 'the old database refuses the type before any write');
  } finally { await f.close(); }
});
