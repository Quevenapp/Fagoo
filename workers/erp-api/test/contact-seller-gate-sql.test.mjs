// Cadastros › Vendedores, documentos lane wave E (migration 241): "Visualizar horários de acesso" of the seller reaches the
// per-request access gate. The seller save answers whether the users linked before and now need the gate, and the Worker writes
// app_metadata.brufap_access_gate in Supabase Auth; a lost flag is "unconfirmed" and the same command writes it again.
// PGlite with every migration and the real Worker. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentsEFixture } from './helpers/documents-e-fixture.mjs';
import { sellerAccessGates } from '../src/contacts.mjs';

let f;
test.before(async () => { f = await documentsEFixture(); });
test.after(async () => { await f?.close(); });
const SETTINGS = { user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {}, commission_rule: 'parcial', commission_mode: 'fixa',
  commission_rate: null, commission_bands: [], discount_limit: '0', notes: null };
const WINDOWS = [{ start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }];

test('privileges: the replaced save runs only for service_role; the gate reader for nobody', async () => {
  const fn = 'public.erp_catalog_seller_save(uuid,uuid,integer,integer,uuid,jsonb,jsonb,jsonb)';
  assert.deepEqual((await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [fn])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'execute') v`, [fn]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'execute') v", [fn]), true);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar(`select has_function_privilege('${role}','erp_catalog.seller_access_gates(jsonb)','execute') v`), false);
});

test('the seller save writes the access-gate flag of the linked users; a lost flag repeats with the same command', async () => {
  f.auth.calls.length = 0;
  const created = await f.call('/v1/cadastros/vendedores', 'POST', { command_id: randomUUID(), contact: { name: 'Vendedora com horário' }, settings: { ...SETTINGS, user_id: f.users.vendas, access_hours_enabled: true, access_windows: WINDOWS } });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  assert.deepEqual(f.auth.calls, [{ user: f.users.vendas, method: 'PUT', body: { app_metadata: { brufap_access_gate: true } } }]);
  assert.equal(created.value.access_gates, undefined, 'the flags stay in the Worker');
  // Moving the seller to another user turns the gate off for the first one and on for the second.
  f.auth.calls.length = 0;
  const seller = created.value.seller, contact = created.value.contact;
  const command = randomUUID(), body = { command_id: command, expected_version: seller.version, contact_expected_version: contact.version, contact: { name: 'Vendedora com horário' },
    settings: { ...SETTINGS, user_id: f.users.vendas2, access_hours_enabled: true, access_windows: WINDOWS } };
  f.auth.fail = true;
  const lost = await f.call(`/v1/cadastros/vendedores/${seller.id}`, 'PATCH', body);
  assert.equal(lost.status, 503); assert.equal(lost.value.error.code, 'ERP_RESULT_UNCONFIRMED');
  f.auth.fail = false; f.auth.calls.length = 0;
  const again = await f.call(`/v1/cadastros/vendedores/${seller.id}`, 'PATCH', body);
  assert.equal(again.status, 200, JSON.stringify(again.value)); assert.equal(again.value.replayed, true);
  assert.deepEqual(f.auth.calls.map(c => [c.user, c.body.app_metadata.brufap_access_gate]).sort(), [[f.users.vendas, false], [f.users.vendas2, true]].sort());
  // Without hours the second user no longer needs the gate.
  f.auth.calls.length = 0;
  const current = await f.call(`/v1/cadastros/vendedores/${seller.id}`);
  const off = await f.call(`/v1/cadastros/vendedores/${seller.id}`, 'PATCH', { command_id: randomUUID(), expected_version: current.value.seller.version, contact_expected_version: current.value.contact.version,
    contact: { name: 'Vendedora com horário' }, settings: { ...SETTINGS, user_id: f.users.vendas2 } });
  assert.equal(off.status, 200);
  assert.deepEqual(f.auth.calls.map(c => [c.user, c.body.app_metadata.brufap_access_gate]), [[f.users.vendas2, false]]);
  // A user with own windows (Sistema › Usuários) keeps the gate when the seller has none.
  await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',true,$2::jsonb,null,1,clock_timestamp(),$3)", [f.users.vendas2, JSON.stringify(WINDOWS), f.users.admin]);
  f.auth.calls.length = 0;
  const later = await f.call(`/v1/cadastros/vendedores/${seller.id}`);
  assert.equal((await f.call(`/v1/cadastros/vendedores/${seller.id}`, 'PATCH', { command_id: randomUUID(), expected_version: later.value.seller.version, contact_expected_version: later.value.contact.version,
    contact: { name: 'Vendedora com horário' }, settings: { ...SETTINGS, user_id: f.users.vendas2, notes: 'Outra nota' } })).status, 200);
  assert.deepEqual(f.auth.calls.map(c => [c.user, c.body.app_metadata.brufap_access_gate]), [[f.users.vendas2, true]]);
});

test('the Worker reads the access gates strictly (absent before 241)', () => {
  assert.deepEqual(sellerAccessGates({}), []);
  const user = '10000000-0000-4000-8000-000000000001';
  assert.deepEqual(sellerAccessGates({ access_gates: [{ user_id: user, gate_required: true }] }), [{ user_id: user, gate_required: true }]);
  for (const bad of [{ access_gates: {} }, { access_gates: [{ user_id: 'x', gate_required: true }] }, { access_gates: [{ user_id: user, gate_required: 'sim' }] },
    { access_gates: [{ user_id: user, gate_required: true }, { user_id: user, gate_required: false }] }, { access_gates: [{ user_id: user, gate_required: true, extra: 1 }] }])
    assert.throws(() => sellerAccessGates(bad));
});

test('Transportador picker: the carriers and the contacts without a type (mirrored from the Origin), not the customers', async () => {
  const name = 'Transporte sintético';
  const typed = await f.catalog('contacts', { name: `${name} tipado` }), untyped = await f.catalog('contacts', { name: `${name} sem tipo` }), customer = await f.catalog('contacts', { name: `${name} cliente` });
  for (const [id, roles] of [[typed.id, ['carrier']], [untyped.id, []], [customer.id, ['customer']]]) await f.db.query('update erp_catalog.contact set roles=$2 where record_id=$1', [id, roles]);
  const page = await f.call(`/v1/cadastros/contatos/opcoes?${new URLSearchParams({ q: name, papel: 'transportador', limit: '25' })}`);
  assert.equal(page.status, 200, JSON.stringify(page.value));
  assert.deepEqual(page.value.items.map(item => item.id).sort(), [typed.id, untyped.id].sort());
  // Other roles keep the exact match.
  const customers = await f.call(`/v1/cadastros/contatos/opcoes?${new URLSearchParams({ q: name, papel: 'cliente', limit: '25' })}`);
  assert.deepEqual(customers.value.items.map(item => item.id), [customer.id]);
  assert.equal(await f.scalar("select has_function_privilege('authenticated','public.erp_catalog_contact_options(uuid,text,text,text,integer)','execute') v"), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_catalog_contact_options(uuid,text,text,text,integer)','execute') v"), true);
});
