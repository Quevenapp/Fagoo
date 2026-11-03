import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveEFixture, migrationText } from './helpers/fiscal-wave-e-fixture.mjs';
import { itemHistoryRecord } from '../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import { pricingRecord, pricingStates } from '../../../apps/erp/src/lib/fiscal-invoice-pricing.ts';

// 202610200252 (letra P "Preços atualizados" of the entry notes) and 202610200253 (item history by a fiscal index of the Origin
// mirror) on PGlite, over every published migration. Synthetic data only; nothing is emitted, posted or transmitted.
const code = expected => error => error.code === expected;
const message = (expected, errcode) => error => error.message === expected && (!errcode || error.code === errcode);
let f, supplier, client, product, other, buyNature, saleNature;
const execute = (data, user = f.users.fiscal) => f.rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: 'create', p_data: data });
const entry = (items, over = {}) => ({ invoice: { model: '55', direction: '0', issue_type: 'T', number: String(Math.floor(Math.random() * 900000) + 1), series: '1', nature_id: buyNature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', final_consumer: false,
  recipient: { contact_id: supplier.id, name: 'Fornecedor sintético 252', person_type: 'J', document: '22333444000155', state: 'SP' }, items, ...over } });
const prices = (items, user = f.users.admin, command = randomUUID()) => f.rpc('erp_catalog_product_prices_update', { p_user_id: user, p_command_id: command, p_supplier_id: supplier.id, p_items: items }).then(value => ({ value, command }));
const version = async id => Number(await f.scalar('select version v from erp_catalog.record where id=$1', [id]));
const record = (invoice, command, user = f.users.fiscal) => f.rpc('erp_fiscal_invoice_pricing_record', { p_user_id: user, p_invoice_id: invoice, p_catalog_command_id: command });
before(async () => {
  f = await fiscalWaveEFixture();
  await f.company();
  supplier = await f.catalog('contacts', { name: 'Fornecedor sintético 252', person_type: 'J', document: '22333444000155', state: 'SP' });
  client = await f.catalog('contacts', { name: 'Cliente sintético 253', person_type: 'J', document: '12345678000190', state: 'SP' });
  product = await f.catalog('products', { name: 'Peça sintética 252', code: 'P-252', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '84714900' });
  other = await f.catalog('products', { name: 'Outra peça 252', code: 'P-252B', unit: 'UN', kind: 'P', format: 'S', price: '5', ncm: '84714900' });
  const nature = async data => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  buyNature = await nature({ description: 'Compra 252', direction: '0', crt: '1', presence: '9' });
  saleNature = await nature({ description: 'Venda 253', direction: '1', crt: '1' });
});
after(() => f?.close());

test('252: new entry points are SECURITY DEFINER for service_role only and the table is private and append-only', async () => {
  for (const signature of ['public.erp_fiscal_invoice_pricing_record(uuid,uuid,uuid)', 'public.erp_fiscal_invoice_pricing_states(uuid,uuid[])']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`, [signature]), false, `${role} ${signature}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [signature]), true);
    assert.equal(await f.scalar('select proconfig::text v from pg_proc where oid=$1::regprocedure', [signature]), '{search_path=pg_catalog}');
  }
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await f.scalar("select has_table_privilege($1,'erp_fiscal_invoices.invoice_pricing','SELECT') v", [role]), false, role);
});

test('252: the confirmed "Atualizar preços" of the cadastro is recorded on the entry note once, by the same user, over its products only', async () => {
  const note = (await execute(entry([{ product_id: product.id, description: 'Peça sintética 252', quantity: '2', unit_price: '10' }]))).invoice;
  const { command } = await prices([{ product_id: product.id, expected_version: await version(product.id), price: '13.0000', cost_price: '10.0000' }]);
  const first = await record(note.id, command, f.users.admin);
  assert.deepEqual([first.invoice_id, first.catalog_command_id, first.products, first.replayed], [note.id, command, 1, false]);
  const again = await record(note.id, command, f.users.admin);
  assert.deepEqual([again.replayed, again.recorded_at], [true, first.recorded_at], 'the same command again returns the same mark');
  // Another user cannot claim the command; a command of a product outside the note, or no command at all, records nothing.
  await assert.rejects(() => record(note.id, command, f.users.fiscal), message('erp_fiscal_invoice_pricing_conflict', '40001'));
  const other_note = (await execute(entry([{ product_id: product.id, description: 'Peça sintética 252', quantity: '1', unit_price: '10' }]))).invoice;
  await assert.rejects(() => record(other_note.id, command, f.users.fiscal), message('erp_fiscal_invoice_pricing_unmatched', '22023'), 'the command belongs to the admin');
  const outside = await prices([{ product_id: other.id, expected_version: await version(other.id), price: '6.0000' }]);
  await assert.rejects(() => record(note.id, outside.command, f.users.admin), message('erp_fiscal_invoice_pricing_unmatched', '22023'));
  await assert.rejects(() => record(note.id, randomUUID(), f.users.admin), message('erp_fiscal_invoice_pricing_unmatched', '22023'));
  // A command of another kind of the cadastro (a plain product save) is not an "Atualizar preços".
  const save = randomUUID();
  await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: 'products', p_id: product.id, p_expected_version: await version(product.id), p_command_id: save, p_data: { name: 'Peça sintética 252', code: 'P-252', unit: 'UN', kind: 'P', format: 'S', price: '13', ncm: '84714900' } }).catch(() => null);
  await assert.rejects(() => record(note.id, save, f.users.admin), message('erp_fiscal_invoice_pricing_unmatched', '22023'));
  const exit = (await execute({ invoice: { ...entry([]).invoice, direction: '1', issue_type: 'N', number: undefined, nature_id: saleNature.id, presence: '1', items: [{ product_id: product.id, description: 'Peça', quantity: '1', unit_price: '10' }] } })).invoice;
  await assert.rejects(() => record(exit.id, command, f.users.admin), code('P0002'), 'only entry notes');
  for (const user of [f.users.consulta, f.users.vendas, f.users.estoque]) await assert.rejects(() => record(note.id, command, user), code('42501'));
  await assert.rejects(() => f.db.query('update erp_fiscal_invoices.invoice_pricing set products=2'), message('erp_fiscal_invoice_history_immutable'));
  // The list reads the marks of its page; reading profiles only.
  const states = await f.rpc('erp_fiscal_invoice_pricing_states', { p_user_id: f.users.consulta, p_invoice_ids: [note.id, other_note.id] });
  assert.deepEqual(pricingStates(states, [note.id, other_note.id]).map(s => [s.invoice_id, s.products, s.count]), [[note.id, 1, 1]]);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_pricing_states', { p_user_id: f.users.vendas, p_invoice_ids: [note.id] }), code('42501'));
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_pricing_states', { p_user_id: f.users.fiscal, p_invoice_ids: [] }), code('22023'));
});

test('252: Worker routes check the body and the answer; the browser model refuses a forged mark', async () => {
  const note = (await execute(entry([{ product_id: product.id, description: 'Peça sintética 252', quantity: '3', unit_price: '10' }]))).invoice;
  const { command } = await prices([{ product_id: product.id, expected_version: await version(product.id), price: '14.0000', cost_price: '10.0000' }]);
  const ok = await f.call(`/v1/notas-fiscais/${note.id}/precos`, 'POST', { catalog_command_id: command });
  assert.equal(ok.status, 200, JSON.stringify(ok.value));
  assert.equal(pricingRecord(ok.value, note.id, command).products, 1);
  assert.throws(() => pricingRecord(ok.value, note.id, randomUUID()));
  assert.equal((await f.call(`/v1/notas-fiscais/${note.id}/precos`, 'POST', { catalog_command_id: command, extra: 1 })).status, 400);
  assert.equal((await f.call(`/v1/notas-fiscais/${note.id}/precos`, 'POST', { catalog_command_id: 'x' })).status, 400);
  assert.equal((await f.call(`/v1/notas-fiscais/${note.id}/precos`, 'GET')).status, 405);
  const states = await f.call(`/v1/notas-fiscais/precos?ids=${note.id}`, 'GET', undefined, f.users.consulta);
  assert.equal(states.status, 200, JSON.stringify(states.value));
  assert.equal(pricingStates(states.value, [note.id])[0].invoice_id, note.id);
  assert.equal((await f.call(`/v1/notas-fiscais/precos?ids=${Array.from({ length: 101 }, () => randomUUID()).join(',')}`)).status, 400);
  assert.equal((await f.call(`/v1/notas-fiscais/precos?ids=${note.id}&x=1`)).status, 400);
  assert.equal((await f.call('/v1/notas-fiscais/precos', 'POST', { ids: [note.id] })).status, 405);
  assert.equal((await f.call(`/v1/notas-fiscais/precos?ids=${note.id}`, 'GET', undefined, f.users.vendas)).status, 403);
});

const seedOrigin = async (entity, id, payload, hash = 'd'.repeat(64)) => {
  await f.db.query("insert into origin_sync.resource_state(resource) values('fiscal_wave_e_test') on conflict do nothing");
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,'fiscal_wave_e_test',$2,$3::jsonb,$4) on conflict(entity,source_id) do update set payload=excluded.payload,version_hash=excluded.version_hash,changed_at=clock_timestamp()", [entity, id, JSON.stringify(payload), hash]);
};
test('253: the item history reads the fiscal index of the Origin mirror, newest first, 20 at most, with the answer of 218', async () => {
  await seedOrigin('contacts', '8253', { id: 8253, nome: 'Cliente sintético 253' });
  await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts' and source_id='8253'");
  await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) select entity,source_id,$1,version_hash,version_hash,'synced' from origin_sync.raw_record where entity='contacts' and source_id='8253'", [client.id]);
  const objects = await f.scalar("select count(*)::int v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='origin_sync'");
  await seedOrigin('nfe', '92531', { tipo: 1, numero: '000531', serie: 1, dataEmissao: '2030-02-05 10:00:00', contato: { id: 8253 }, itens: [{ codigo: 'P-252', quantidade: 3, valor: 10, valorTotal: 30 }, { codigo: 'OUTRO', quantidade: 1, valor: 1, valorTotal: 1 }] });
  await seedOrigin('nfe', '92532', { tipo: 0, numero: 532, serie: 1, dataEmissao: '2030-02-06 10:00:00', contato: { id: 8253 }, itens: [{ codigo: 'P-252', quantidade: 1, valor: 9, valorTotal: 9 }] });
  await seedOrigin('nfce', '92533', { numero: 533, serie: 2, dataEmissao: '2030-02-07 10:00:00', contato: { id: 8253 }, itens: [{ codigo: 'P-252', quantidade: 2, valor: 8, valorTotal: 16 }] });
  await seedOrigin('nfe', '92534', { tipo: 1, numero: 534, serie: 1, dataEmissao: '2030-02-08 10:00:00', contato: { id: 9999 }, itens: [{ codigo: 'P-252', quantidade: 1, valor: 9, valorTotal: 9 }] });
  const history = async (direction = '1', user = f.users.fiscal) => f.rpc('erp_fiscal_invoice_item_history', { p_user_id: user, p_contact_id: client.id, p_product_id: product.id, p_direction: direction });
  const exit = await history();
  assert.deepEqual(exit.items, [
    { origin: 'origin', id: '92533', number: 533, series: 2, issue_date: '2030-02-07', issue_type: null, quantity: '2', unit_price: '8', total: '16.00' },
    { origin: 'origin', id: '92531', number: 531, series: 1, issue_date: '2030-02-05', issue_type: null, quantity: '3', unit_price: '10', total: '30.00' }]);
  assert.doesNotThrow(() => itemHistoryRecord(exit, { contactId: client.id, productId: product.id, direction: '1' }));
  assert.deepEqual((await history('0', f.users.admin)).items.map(i => i.id), ['92532']);
  // A later change of the mirror is seen on the next consultation (version_hash and changed_at), with no change in origin_sync.
  await seedOrigin('nfe', '92531', { tipo: 1, numero: '000531', serie: 1, dataEmissao: '2030-02-05 10:00:00', contato: { id: 8253 }, itens: [{ codigo: 'P-252', quantidade: 4, valor: 10, valorTotal: 40 }] }, 'e'.repeat(64));
  assert.deepEqual((await history()).items.find(i => i.id === '92531')?.quantity, '4');
  assert.equal(await f.scalar("select count(*)::int v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='origin_sync'"), objects, 'no object added to origin_sync');
  // Bounded: one consultation indexes at most 300 changed notes; the next one goes on from there; 20 rows at most come back.
  const many = Array.from({ length: 305 }, (_, i) => i);
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) select 'nfe','fiscal_wave_e_test',(93000+n)::text,jsonb_build_object('tipo',1,'numero',1000+n,'serie',1,'dataEmissao','2031-01-01 10:00:00','contato',jsonb_build_object('id',8253),'itens',jsonb_build_array(jsonb_build_object('codigo','P-252','quantidade',1,'valor',1,'valorTotal',1))),repeat('f',64) from unnest($1::int[]) n", [many]);
  const indexed = () => f.scalar("select count(*)::int v from erp_fiscal_invoices.origin_item_source where source_id::bigint>=93000");
  const page = await history();
  assert.equal(page.items.length, 20);
  assert.equal(await indexed(), 300);
  await history();
  assert.equal(await indexed(), 305);
  // Another consultation already updating the index is never waited for.
  assert.ok(Date.parse(await f.scalar('select refreshed_at::text v from erp_fiscal_invoices.origin_item_state')) > 0);
});

test('253: the replaced body was hash-checked and the helpers stay private', async () => {
  for (const role of ['anon', 'authenticated', 'public', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,'erp_fiscal_invoices.origin_items_refresh(integer)','EXECUTE') v", [role]), false, role);
  for (const table of ['origin_item_source', 'origin_item_index', 'origin_item_state']) assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_fiscal_invoices.${table}','SELECT') v`), false, table);
  const block = (await migrationText('202610200253_fiscal_item_history_index.sql')).match(/do \$\$declare r record;begin[\s\S]*?end\$\$;/)[0];
  await assert.rejects(() => f.db.exec(block), message('fiscal_history_253_previous_definition_changed'));
});
