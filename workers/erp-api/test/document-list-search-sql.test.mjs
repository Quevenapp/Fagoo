// Synthetic data only. 202610200289: the Lote filter (até 50 lotes separados por ;) and the Busca customizada (Adicionar filtros) of the
// document lists. PGlite with every migration and the real Worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';

let f, leite, lots;
const SIG = 'uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid';
before(async () => {
  f = await documentsEFixture();
  leite = await f.catalog('products', { name: 'Leite G289', unit: 'UN', kind: 'P', format: 'S', price: '10' });
  await f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: leite.id, p_expected_version: await f.recordVersion(leite.id), p_command_id: randomUUID(), p_data: { name: 'Leite G289', lot_control: true }, p_acknowledged: null });
  const lot = async code => (await f.rpc('erp_stock_lot_save', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_product_id: leite.id, p_lot_id: null, p_expected_version: 0, p_code: code })).lot.id;
  lots = { a: await lot('LT-289A'), b: await lot('LT-289B') };
});
after(async () => f?.close());
const list = (kind, params, user) => f.call(`/v1/documentos/${kind}?${new URLSearchParams({ page: '1', limit: '100', ...params })}`, 'GET', undefined, user);
const ids = response => response.value.items.map(item => item.id);
const search = conditions => JSON.stringify(conditions);

test('privileges and signature: the new erp_document_list replaces the one of 268; the helpers stay closed', async () => {
  assert.equal(await f.scalar('select to_regprocedure($1) is null v', [`public.erp_document_list(${SIG})`]), true);
  const sig = `public.erp_document_list(${SIG},text[],jsonb)`;
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  for (const fn of ['erp_documents.list_conditions(text,jsonb)', 'erp_documents.list_condition_value(erp_documents.document,text)', 'erp_documents.list_condition(text,text,text,text)', 'erp_documents.list_conditions_match(erp_documents.document,jsonb)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, fn]), false, `${role} ${fn}`);
});

test('Lote: the pedidos and OS with an item of one of the lots (up to 50, separated by ;, case-insensitive)', async () => {
  const withA = await f.create('sales_orders', { items: [f.line({ product_id: leite.id, quantity: '2', lots: [{ lot_id: lots.a, quantity: '2' }] })] });
  const withB = await f.create('sales_orders', { items: [f.line({ product_id: leite.id, quantity: '1', lots: [{ lot_id: lots.b, quantity: '1' }] })] });
  const without = await f.create('sales_orders', { items: [f.line({ product_id: leite.id })] });
  const one = await list('sales_orders', { lote: 'lt-289a' });
  assert.equal(one.status, 200, JSON.stringify(one.value));
  assert.deepEqual(ids(one), [withA.id]);
  assert.deepEqual(new Set(ids(await list('sales_orders', { lote: ' LT-289A ; lt-289b ;; ' }))), new Set([withA.id, withB.id]));
  assert.equal(ids(await list('sales_orders', { lote: 'LT-289A' })).includes(without.id), false);
  const os = await f.create('service_orders', { items: [f.line({ product_id: leite.id, group: 'part', quote: false, done: false, quantity: '1', lots: [{ lot_id: lots.b, quantity: '1' }] })] });
  assert.deepEqual(ids(await list('service_orders', { lote: 'LT-289B' })), [os.id]);
  assert.equal((await list('purchase_orders', { lote: 'LT-289A' })).status, 400);
  assert.equal((await list('sales_orders', { lote: Array.from({ length: 51 }, (_, i) => `L${i}`).join(';') })).status, 400);
  assert.equal((await list('sales_orders', { lote: ' ; ' })).status, 400);
});

test('Busca customizada: conditions campo/operador/valor over the fields of the list, all together', async () => {
  const contact = await f.catalog('contacts', { name: 'Cliente Busca G289', city: 'Campinas' });
  const big = await f.create('sales_orders', { contact_id: contact.id, notes: 'Entregar pela manhã', items: [f.line({ quantity: '3', unit_price: '100' })] });
  const small = await f.create('sales_orders', { contact_id: contact.id, notes: null, items: [f.line({ quantity: '1', unit_price: '5' })] });
  const run = async (conditions, expected) => { const r = await list('sales_orders', { busca: search(conditions) }); assert.equal(r.status, 200, JSON.stringify(r.value)); assert.deepEqual(new Set(ids(r)), new Set(expected), JSON.stringify(conditions)); };
  const mine = { field: 'contact_name', op: 'contains', value: 'busca g289' };
  await run([mine], [big.id, small.id]);
  await run([mine, { field: 'total', op: 'ge', value: '100' }], [big.id]);
  await run([mine, { field: 'notes', op: 'empty', value: null }], [small.id]);
  await run([mine, { field: 'notes', op: 'not_contains', value: 'manhã' }], [small.id]);
  await run([mine, { field: 'number', op: 'gt', value: big.number }], [small.id]);
  await run([mine, { field: 'contact_city', op: 'eq', value: 'CAMPINAS' }], [big.id, small.id]);
  await run([mine, { field: 'date', op: 'lt', value: '2026-10-20' }], []);
  // Strict: unknown field or operator, operator of another type, value of empty, bad decimal, more than 10 conditions.
  for (const bad of [[{ field: 'secret', op: 'eq', value: 'x' }], [{ field: 'total', op: 'contains', value: '1' }], [{ field: 'notes', op: 'empty', value: 'x' }],
    [{ field: 'total', op: 'gt', value: '1.234' }], [{ field: 'date', op: 'eq', value: '2026-02-30' }], Array.from({ length: 11 }, () => mine), [{ ...mine, extra: 1 }]])
    assert.equal((await list('sales_orders', { busca: search(bad) })).status, 400, JSON.stringify(bad));
  assert.equal((await list('sales_orders', { busca: '{not json' })).status, 400);
});

test('Busca customizada of the OS: the campos customizados by the type of their definition', async () => {
  const option = randomUUID();
  const insert = (type, name, options = '[]') => f.scalar(`insert into erp_documents.custom_field(kind,field_type,name,options,created_by,updated_by) values('service_orders',$1,$2,$3::jsonb,$4,$4) returning id::text v`, [type, name, options, f.users.admin]);
  const kind = await insert('list', 'Tipo G289', JSON.stringify([{ id: option, label: 'Garantia' }])), km = await insert('integer', 'Km G289');
  const a = await f.create('service_orders', { custom_fields: { [kind]: option, [km]: '1500' } });
  const b = await f.create('service_orders', { custom_fields: { [km]: '90' } });
  const run = async conditions => ids(await list('service_orders', { busca: search(conditions) }));
  assert.deepEqual(await run([{ field: `custom:${kind}`, op: 'eq', value: option }]), [a.id]);
  assert.deepEqual(new Set(await run([{ field: `custom:${km}`, op: 'ge', value: '90' }])), new Set([a.id, b.id]));
  assert.deepEqual(await run([{ field: `custom:${km}`, op: 'gt', value: '100' }]), [a.id]);
  assert.ok((await run([{ field: `custom:${kind}`, op: 'empty', value: null }])).includes(b.id));
  assert.equal((await list('service_orders', { busca: search([{ field: `custom:${kind}`, op: 'contains', value: 'x' }]) })).status, 400, 'a list compares by option');
  assert.equal((await list('service_orders', { busca: search([{ field: `custom:${randomUUID()}`, op: 'eq', value: 'x' }]) })).status, 400);
  assert.equal((await list('sales_orders', { busca: search([{ field: `custom:${km}`, op: 'eq', value: '1' }]) })).status, 400, 'only the OS has campos customizados');
});
