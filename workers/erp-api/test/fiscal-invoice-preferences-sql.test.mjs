import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { preferencesFixture } from './helpers/preferences-fixture.mjs';
import { laneUpTo } from './helpers/fiscal-lane.mjs';
import * as dto from '../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import { invoicePreferences, DEFAULT_INVOICE_PREFERENCES, natureRecord } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// 140 (Preferências › Notas Fiscais in the note context and list) and 141 (Armamento/Veículo groups, logical deletion of
// natures and the natures review) on PGlite, synthetic data only. Nothing here emits, transmits or posts effects.
const code = expected => error => error.code === expected;
let f;
const savePrefs = async (page, changes, user = f.users.admin) => {
  const current = await f.rpc('erp_preferences_page', { p_user_id: user, p_page: page });
  const version = key => current.items.find(i => i.key === key)?.version ?? 0;
  return f.rpc('erp_preferences_save', { p_user_id: user, p_command_id: randomUUID(), p_page: page, p_changes: Object.entries(changes).map(([key, value]) => ({ key, expected_version: version(key), value })) });
};
const nature = async (data, user = f.users.admin) => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
const natureCmd = (action, data, { user = f.users.admin, command = randomUUID() } = {}) => f.rpc('erp_fiscal_nature_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const list = (args = {}, user = f.users.admin) => f.rpc('erp_fiscal_invoice_list', { p_user_id: user, ...args });

before(async () => {
  // Published order (001-101, 1020 files of this lane), like the Preferências fixture; synthetic users only.
  const base = await preferencesFixture({ lane: laneUpTo('202610200141') });
  f = { ...base, scalar: async (text, args = []) => (await base.db.query(text, args)).rows[0]?.value };
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1)", [f.users.admin]);
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [f.users.admin]);
});
after(() => f?.close());

test('140 keeps the entry points SECURITY DEFINER for service_role only; the preference helpers are private', async () => {
  for (const signature of ['public.erp_fiscal_invoice_context(uuid,text)', 'public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text)',
    'public.erp_fiscal_nature_review_confirm(uuid,uuid,integer)', 'public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb)', 'public.erp_fiscal_nature_list(uuid,boolean,text,text,text,integer,integer)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false, `${role} ${signature}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
    assert.deepEqual(await f.scalar("select proconfig value from pg_proc where oid=$1::regprocedure", [signature]), ['search_path=pg_catalog']);
  }
  for (const helper of ['erp_fiscal_invoices.preference(text,text,jsonb)', 'erp_fiscal_invoices.invoice_preferences(text)', 'erp_fiscal_invoices.nature_review_record()'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
});

test('140 the note context carries the NF-e and NFC-e preferences, validated by the shared contract', async () => {
  const before = await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' });
  assert.deepEqual(invoicePreferences(before.preferences), { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] }, 'page defaults before anything is saved');
  await savePrefs('notas-nfe', { 'nfe.frete_por_conta': '1', 'nfe.especie_padrao': 'caixas', 'nfe.volume_padrao': 3, 'nfe.markup': '35.5', 'nfe.somar_peso': true, 'nfe.calcular_volume': true,
    'nfe.ipi_primeira_parcela': true, 'nfe.rastreio_infcpl': true, 'nfe.mensagem_credito_simples': true, 'nfe.validacao_opcional': ['parcelas'], 'nfe.grupo_retencao': true,
    'nfe.grupo_combustiveis': true, 'nfe.autxml_transportadora': true, 'nfe.autxml_pessoas': [{ document: '11222333000181', name: 'Contabilidade sintética' }], 'nfe.bloquear_edicao_estoque': true });
  await savePrefs('notas-nfce', { 'nfce.grupo_armamento': true, 'nfce.autxml_pessoas': [{ document: '12345678909', name: '' }] });
  const nfe = invoicePreferences((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' })).preferences);
  assert.deepEqual(nfe, { ...DEFAULT_INVOICE_PREFERENCES, freight_by: '1', species: 'caixas', volume_quantity: 3, markup: '35.5', sum_weight: true, compute_volume: true, ipi_first_installment: true,
    tracking_in_info: true, simples_credit_message: true, optional_installments: true, retention_group: true, fuel_group: true, autxml_carrier: true,
    autxml_people: [{ document: '11222333000181', name: 'Contabilidade sintética' }], block_edit_stock: true });
  const nfce = invoicePreferences((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.admin, p_model: '65' })).preferences);
  assert.equal(nfce.weapon_group, true); assert.equal(nfce.fuel_group, false, 'NFC-e reads its own groups'); assert.equal(nfce.retention_group, false, 'NFC-e has no retentions');
  assert.deepEqual(nfce.autxml_people, [{ document: '12345678909', name: '' }]); assert.equal(nfce.autxml_carrier, false); assert.equal(nfce.freight_by, '1', 'fill-in defaults come from NF-e');
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.consulta, p_model: '55' }), code('42501'));
});

test('140 the list carries "Exibir totais em listas de Notas Fiscais" for every reader', async () => {
  assert.equal((await list({ p_model: '55' }, f.users.consulta)).show_totals, true);
  await savePrefs('notas-nfe', { 'nfe.exibir_totais': false });
  for (const args of [{ p_model: '55' }, { p_model: '65' }, { p_model: '55', p_direction: '0' }, { p_model: '55', p_origin: 'brufap' }]) assert.equal((await list(args)).show_totals, false, JSON.stringify(args));
  assert.equal((await list({ p_model: '55' }, f.users.consulta)).show_totals, false);
  await savePrefs('notas-nfe', { 'nfe.exibir_totais': true });
});

test('141 item groups Armamento and Veículo are stored with the shared descriptors; anything else is refused', async () => {
  assert.deepEqual(await f.scalar('select erp_fiscal_invoices.invoice_specs() value'), JSON.parse(JSON.stringify({ recipient: dto.RECIPIENT_SPEC, export: dto.EXPORT_SPEC, import: dto.IMPORT_SPEC,
    addition: dto.ADDITION_SPEC, reference: dto.REFERENCE_SPEC, transport: dto.TRANSPORT_SPEC, carrier: dto.CARRIER_SPEC, vehicle: dto.VEHICLE_SPEC, volumes: dto.VOLUMES_SPEC,
    // The forma de pagamento of the parcel arrives with 202610200219 (checked in fiscal-invoice-wave-d-sql).
    delivery: dto.DELIVERY_SPEC, installment: (({ payment_method_id, ...rest }) => rest)(dto.INSTALLMENT_SPEC), card: dto.CARD_SPEC, authorized: dto.AUTHORIZED_SPEC, intermediary: dto.INTERMEDIARY_SPEC,
    // The item discount arrives with 202610200176 (checked in fiscal-invoice-order-sql).
    item: (({ discount, ...rest }) => rest)(dto.ITEM_SPEC), item_groups: dto.ITEM_GROUPS })));
  const sale = await nature({ description: 'Venda sintética 141', direction: '1', crt: '1', presence: '1' });
  const invoice = item => ({ model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: sale.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { name: 'Cliente sintético', person_type: 'J', document: '12345678000190', state: 'SP' }, items: [{ description: 'Item sintético', quantity: '1', unit_price: '10', ...item }] });
  const created = (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: invoice({
    weapon: { type: '0', description: 'Arma sintética', serial: 'S-1', barrel: 'C-1' }, vehicle: { operation: '1', chassis: '9BWZZZ377VT004251', model_year: '2026', species: '1', vin_condition: 'N', restriction: '0' } }) } })).invoice;
  assert.deepEqual(created.items[0].weapon, { type: '0', description: 'Arma sintética', serial: 'S-1', barrel: 'C-1' });
  assert.equal(created.items[0].vehicle.chassis, '9BWZZZ377VT004251');
  for (const bad of [{ weapon: { type: '2' } }, { weapon: { caliber: '38' } }, { vehicle: { chassis: 'curto' } }, { vehicle: { model_year: '26' } }])
    await assert.rejects(() => f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: invoice(bad) } }), code('22023'), JSON.stringify(bad));
});

test('141 "Excluir as operações selecionadas" deletes logically: gone from the list and defaults, kept in history, idempotent and final', async () => {
  const doomed = await nature({ description: 'Natureza a excluir', direction: '1', crt: '1', rules: [{ tax: 'icms', data: { situation: '102' } }] });
  await natureCmd('set_default', { id: doomed.id, expected_version: 1, code: 'VJ' });
  assert.ok((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.admin, p_model: '55' })).defaults.VJ);
  await assert.rejects(() => natureCmd('delete', { id: doomed.id, expected_version: 2 }), code('40001'), 'expected version');
  await assert.rejects(() => natureCmd('delete', { id: doomed.id, expected_version: 1 }, { user: f.users.consulta }), code('42501'));
  const command = randomUUID(), out = await natureCmd('delete', { id: doomed.id, expected_version: 1 }, { command });
  const record = natureRecord(out.nature);
  assert.equal(record.version, 2); assert.equal(record.active, false); assert.deepEqual(record.defaults, []); assert.equal(out.replayed, false);
  assert.equal((await natureCmd('delete', { id: doomed.id, expected_version: 1 }, { command })).replayed, true, 'same command replays');
  await assert.rejects(() => natureCmd('delete', { id: doomed.id, expected_version: 2 }, { command }), code('40001'), 'same id, other body');
  for (const active of [true, false]) assert.equal((await f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.admin, p_active: active })).items.some(n => n.id === doomed.id), false);
  assert.equal((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.admin, p_model: '55' })).defaults.VJ, undefined);
  await assert.rejects(() => f.rpc('erp_fiscal_nature_get', { p_user_id: f.users.admin, p_id: doomed.id }), code('P0002'));
  for (const [action, data] of [['delete', { id: doomed.id, expected_version: 2 }], ['set_active', { id: doomed.id, expected_version: 2, active: true }], ['clone', { id: doomed.id, expected_version: 2 }]])
    await assert.rejects(() => natureCmd(action, data), code('P0002'), action);
  await assert.rejects(() => f.db.query("update erp_fiscal_invoices.nature set description='x',version=version+1 where id=$1", [doomed.id]), /erp_fiscal_nature_deleted/);
  assert.equal(await f.scalar("select count(*)::integer value from erp_fiscal_invoices.nature_revision where nature_id=$1", [doomed.id]), 2, 'revision of the deletion kept');
  assert.equal(await f.scalar("select action value from erp_fiscal_invoices.audit where entity_id=$1 order by id desc limit 1", [doomed.id]), 'delete');
});

test('141 the natures review is one confirmation with CAS, idempotency, roles and audit', async () => {
  const confirm = (expected, { user = f.users.fiscal, command = randomUUID() } = {}) => f.rpc('erp_fiscal_nature_review_confirm', { p_user_id: user, p_command_id: command, p_expected_version: expected });
  assert.deepEqual((await f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.consulta })).review, { confirmed: false, version: 0, confirmed_at: null });
  await assert.rejects(() => confirm(0, { user: f.users.consulta }), code('42501'));
  await assert.rejects(() => confirm(1), code('40001'));
  const command = randomUUID(), first = await confirm(0, { command });
  assert.equal(first.review.confirmed, true); assert.equal(first.review.version, 1); assert.equal(first.action, 'confirm_review'); assert.equal(first.replayed, false);
  assert.equal((await confirm(0, { command })).replayed, true);
  await assert.rejects(() => confirm(0), code('40001'), 'stale version');
  assert.equal((await confirm(1, { user: f.users.admin })).review.version, 2, 'confirming again updates the date');
  const listed = (await f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.consulta })).review;
  assert.equal(listed.confirmed, true); assert.equal(listed.version, 2); assert.ok(Date.parse(listed.confirmed_at));
  assert.equal(await f.scalar("select count(*)::integer value from erp_fiscal_invoices.audit where action='confirm_review'"), 2);
  await assert.rejects(() => f.db.query('delete from erp_fiscal_invoices.audit'), /erp_fiscal_invoice_history_immutable/);
});
