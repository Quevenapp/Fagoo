import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import { RULE_SPECS, NATURE_OTHERS, NATURE_RETENTIONS, TAX_SETTINGS_SPEC, checkValue, specObject } from '../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';

// 111 on PGlite with synthetic data only: natures, rules per tax, defaults and global tax settings.
const migration = async name => readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const code = expected => error => error.code === expected;
let f;
const execute = (action, data, { user = f.users.admin, command = randomUUID() } = {}) => f.rpc('erp_fiscal_nature_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const create = (data, options) => execute('create', { nature: data }, options);
const nature = (over = {}) => ({ description: 'Venda de mercadoria sintética', direction: '1', crt: '1', presence: '1', final_consumer: true,
  others: { discount_type: 'I', approx_tax_type: 'table' }, retentions: { csrf: false },
  rules: [{ tax: 'icms', destinations: [], product_scope: 'any', data: { situation: '102', cfop: '5102' } },
    { tax: 'icms', destinations: ['RJ', 'MG'], product_scope: 'ncm', ncms: ['8471'], data: { situation: '101', cfop: '6102', credit_rate: '1.25' } },
    { tax: 'pis', data: { situation: '49', rate: '0' } }], ...over });

before(async () => {
  f = await fixture({ apply: false });
  await f.db.exec(await migration('202610200111_fiscal_operation_natures'));
});
after(() => f?.close());

test('111 grants only service_role on SECURITY DEFINER entry points and keeps helpers private', async () => {
  const entry = ['public.erp_fiscal_nature_list(uuid,boolean,text,text,text,integer,integer)', 'public.erp_fiscal_nature_get(uuid,uuid)', 'public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb)',
    'public.erp_fiscal_tax_settings_get(uuid)', 'public.erp_fiscal_tax_settings_save(uuid,uuid,integer,jsonb,jsonb)'];
  for (const signature of entry) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false, `${role} ${signature}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
    assert.match(String(await f.scalar('select proconfig::text value from pg_proc where oid=$1::regprocedure', [signature])), /search_path=pg_catalog/);
  }
  for (const helper of ['erp_fiscal_invoices.nature_input(jsonb)', 'erp_fiscal_invoices.check_value(jsonb,text)', 'erp_fiscal_invoices.require_write(uuid)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
  assert.equal(await f.scalar("select count(*)::int value from pg_tables where schemaname='erp_fiscal_invoices' and not rowsecurity"), 0);
  assert.equal(await f.scalar("select has_schema_privilege('authenticated','erp_fiscal_invoices','USAGE') value"), false);
});

test('descriptors in SQL are exactly the JavaScript contract and normalize the same way', async () => {
  const specs = await f.scalar('select erp_fiscal_invoices.nature_specs() value');
  assert.deepEqual(specs, JSON.parse(JSON.stringify({ rules: RULE_SPECS, others: NATURE_OTHERS, retentions: NATURE_RETENTIONS, tax_settings: TAX_SETTINGS_SPEC })));
  const samples = [['d:4:3', '12.5'], ['d:2:13', '0'], ['t:10', '  texto  '], ['m:20', 'linha\nduas'], ['e:A|B', 'B'], ['x:^[0-9]{4}$', '5102'], ['u', 'ABCDEF01-2345-4789-8abc-def012345678'], ['a', '2026-02-28'], ['b', true], ['t:5', '   ']];
  for (const [descriptor, value] of samples) assert.deepEqual(await f.scalar('select erp_fiscal_invoices.check_value($1::jsonb,$2) value', [JSON.stringify(value), descriptor]), checkValue(value, descriptor), descriptor);
  for (const [descriptor, value] of [['d:4:3', '1234'], ['d:2:13', '1.234'], ['t:3', 'abcd'], ['e:A|B', 'C'], ['a', '2026-02-30'], ['b', 'true'], ['d:2:13', '-1'], ['t:10', 'a\u0001b']]) {
    await assert.rejects(() => f.scalar('select erp_fiscal_invoices.check_value($1::jsonb,$2) value', [JSON.stringify(value), descriptor]), code('22023'), descriptor);
    assert.throws(() => checkValue(value, descriptor), /FISCAL_VALUE_INVALID/, descriptor);
  }
  assert.deepEqual(await f.scalar('select erp_fiscal_invoices.spec_object($1::jsonb,$2::jsonb) value', [JSON.stringify({ rate: '7', base_rate: null }), JSON.stringify(RULE_SPECS.ipi)]), specObject({ rate: '7', base_rate: null }, RULE_SPECS.ipi));
});

test('profiles: admin and fiscal write, consulta only reads, other profiles and strangers are refused', async () => {
  const created = (await create(nature(), { user: f.users.fiscal })).nature;
  assert.equal(created.version, 1); assert.equal(created.rules.length, 3);
  await assert.rejects(() => create(nature(), { user: f.users.consulta }), code('42501'));
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, randomUUID()]) {
    await assert.rejects(() => f.rpc('erp_fiscal_nature_list', { p_user_id: user }), code('42501'));
    await assert.rejects(() => f.rpc('erp_fiscal_nature_get', { p_user_id: user, p_id: created.id }), code('42501'));
    await assert.rejects(() => f.rpc('erp_fiscal_tax_settings_get', { p_user_id: user }), code('42501'));
  }
  const read = await f.rpc('erp_fiscal_nature_get', { p_user_id: f.users.consulta, p_id: created.id });
  assert.equal(read.writable, false); assert.equal(read.nature.id, created.id);
  await f.db.query('update erp_access.membership set active=false where user_id=$1', [f.users.fiscal]);
  try { await assert.rejects(() => execute('update', { id: created.id, expected_version: 1, nature: nature() }, { user: f.users.fiscal }), code('42501')); }
  finally { await f.db.query('update erp_access.membership set active=true where user_id=$1', [f.users.fiscal]); }
});

test('rules: situation required, IPI by direction, destinations, NCM and up to ten existing products', async () => {
  const rule = data => nature({ rules: [{ tax: 'icms', data }] });
  await assert.rejects(() => create(rule({ cfop: '5102' })), code('22023'), 'Uma situação tributária válida deve ser selecionada.');
  await assert.rejects(() => create(rule({ situation: '00' })), code('22023'), 'CST of the normal regime is refused for a Simples nature');
  const normal = (await create(nature({ crt: '3', rules: [{ tax: 'icms', data: { situation: '00', rate: '18', deson_deduct: true } }] }))).nature;
  assert.deepEqual(normal.rules[0].data, { situation: '00', rate: '18.0000', deson_deduct: true });
  await assert.rejects(() => create(nature({ rules: [{ tax: 'ipi', data: { situation: '00' } }] })), code('22023'), 'entry IPI CST on an exit nature');
  const entry = (await create(nature({ direction: '0', description: 'Compra sintética', update_last_purchase_price: true, rules: [{ tax: 'ipi', data: { situation: '49', framing_code: '999' } }] }))).nature;
  assert.equal(entry.update_last_purchase_price, true);
  await assert.rejects(() => create(nature({ update_last_purchase_price: true })), code('22023'), 'only entry natures update purchase prices');
  for (const bad of [{ destinations: ['SP', 'SP'] }, { destinations: ['XX'] }, { product_scope: 'ncm', ncms: [] }, { product_scope: 'ncm', ncms: ['123'] }, { product_scope: 'products', product_ids: [randomUUID()] },
    { product_scope: 'any', ncms: ['8471'] }, { product_scope: 'products', product_ids: Array.from({ length: 11 }, () => f.product.id) }, { extra: true }])
    await assert.rejects(() => create(nature({ rules: [{ tax: 'pis', data: { situation: '49' }, ...bad }] })), code('22023'), JSON.stringify(bad));
  const scoped = (await create(nature({ rules: [{ tax: 'icms', destinations: ['SP', 'EX'], product_scope: 'products', product_ids: [f.product.id], data: { situation: '500' } }] }))).nature;
  assert.deepEqual(scoped.rules[0].destinations, ['EX', 'SP']); assert.deepEqual(scoped.rules[0].products.map(p => p.id), [f.product.id]);
  await assert.rejects(() => create(nature({ others: { unknown: true } })), code('22023'));
  await assert.rejects(() => create(nature({ description: 'x'.repeat(61) })), code('22023'));
});

test('update uses the expected version, repeats by command and keeps an immutable revision history', async () => {
  const created = (await create(nature({ description: 'Natureza versionada' }))).nature;
  const command = randomUUID(), data = { id: created.id, expected_version: 1, nature: nature({ description: 'Natureza versionada 2', rules: [{ tax: 'cofins', data: { situation: '49' } }] }) };
  const first = await execute('update', data, { command });
  assert.equal(first.nature.version, 2); assert.equal(first.replayed, false); assert.deepEqual(first.nature.rules.map(r => [r.tax, r.position]), [['cofins', 1]]);
  const again = await execute('update', data, { command });
  assert.equal(again.replayed, true); assert.equal(again.nature.version, 2);
  await assert.rejects(() => execute('update', { ...data, nature: nature({ description: 'Outra' }) }, { command }), code('40001'), 'same command, different body');
  await assert.rejects(() => execute('update', data, { command, user: f.users.fiscal }), code('40001'), 'same command, other actor');
  await assert.rejects(() => execute('update', data), code('40001'), 'stale expected_version');
  await assert.rejects(() => execute('update', { ...data, expected_version: 2, nature: nature({ direction: '0' }) }), code('22023'), 'direction is immutable');
  assert.deepEqual((await f.db.query("select version from erp_fiscal_invoices.nature_revision where nature_id=$1 order by version", [created.id])).rows.map(r => r.version), [1, 2]);
  await assert.rejects(() => f.db.query('update erp_fiscal_invoices.nature_revision set record=$2 where nature_id=$1', [created.id, '{}']), code('42501'));
  await assert.rejects(() => f.db.query('delete from erp_fiscal_invoices.nature where id=$1', [created.id]), code('42501'));
  assert.equal(await f.scalar("select count(*)::int value from erp_fiscal_invoices.audit where entity_id=$1", [created.id]), 2);
});

test('clone, defaults by direction, inactivation and the list with filters, pages and totals', async () => {
  const base = (await create(nature({ description: 'Venda padrão sintética' }))).nature;
  const copy = (await execute('clone', { id: base.id, expected_version: 1 })).nature;
  assert.equal(copy.description, 'Cópia de Venda padrão sintética'); assert.deepEqual(copy.rules.map(r => r.data), base.rules.map(r => r.data)); assert.notEqual(copy.id, base.id);
  await assert.rejects(() => execute('set_default', { id: base.id, expected_version: 1, code: 'E' }), code('22023'), 'purchase default on an exit nature');
  const withDefault = (await execute('set_default', { id: base.id, expected_version: 1, code: 'S' })).nature;
  assert.deepEqual(withDefault.defaults, ['S']); assert.equal(withDefault.version, 1, 'defaults do not bump the nature version');
  await assert.rejects(() => execute('set_default', { id: base.id, expected_version: 1, code: 'S' }), code('40001'));
  const moved = (await execute('set_default', { id: copy.id, expected_version: 1, code: 'S' })).nature;
  assert.deepEqual(moved.defaults, ['S']); assert.deepEqual((await f.rpc('erp_fiscal_nature_get', { p_user_id: f.users.admin, p_id: base.id })).nature.defaults, []);
  const inactive = (await execute('set_active', { id: copy.id, expected_version: 1, active: false })).nature;
  assert.equal(inactive.active, false); assert.deepEqual(inactive.defaults, [], 'inactivating drops its defaults');
  await assert.rejects(() => execute('set_default', { id: copy.id, expected_version: 2, code: 'VF' }), code('40001'));
  const active = await f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.consulta, p_query: 'padrão sintética' });
  assert.deepEqual(active.items.map(i => i.id), [base.id]); assert.equal(active.writable, false);
  const inactiveList = await f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.admin, p_active: false });
  assert.ok(inactiveList.items.some(i => i.id === copy.id));
  const paged = await f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.admin, p_limit: 1, p_page: 2, p_direction: '1' });
  assert.equal(paged.items.length, 1); assert.ok(paged.total_count >= 3); assert.equal(paged.page, 2);
  for (const args of [{ p_limit: 101 }, { p_page: 0 }, { p_direction: '2' }, { p_crt: '5' }, { p_query: 'x'.repeat(121) }])
    await assert.rejects(() => f.rpc('erp_fiscal_nature_list', { p_user_id: f.users.admin, ...args }), code('22023'));
});

test('global tax settings: defaults, versioned save, DIFAL per state limited to the allowed states', async () => {
  const initial = await f.rpc('erp_fiscal_tax_settings_get', { p_user_id: f.users.consulta });
  assert.equal(initial.version, 0); assert.equal(initial.settings.difal_default, 'inside'); assert.equal(initial.settings.exclude_icms_pis_cofins, false); assert.equal(initial.writable, false);
  const save = (expected, settings, states, command = randomUUID(), user = f.users.fiscal) => f.rpc('erp_fiscal_tax_settings_save', { p_user_id: user, p_command_id: command, p_expected_version: expected, p_settings: settings, p_difal_by_state: states });
  await assert.rejects(() => save(0, {}, {}, randomUUID(), f.users.consulta), code('42501'));
  const command = randomUUID();
  const saved = await save(0, { exclude_icms_pis_cofins: true, difal_default: 'goods' }, { MT: 'double_base', PB: 'single_base', SP: 'default' }, command);
  assert.equal(saved.version, 1); assert.deepEqual(saved.difal_by_state, { MT: 'double_base', PB: 'single_base' }); assert.equal(saved.settings.exclude_icms_pis_cofins, true);
  assert.equal((await save(0, { exclude_icms_pis_cofins: true, difal_default: 'goods' }, { MT: 'double_base', PB: 'single_base', SP: 'default' }, command)).replayed, true);
  await assert.rejects(() => save(0, {}, {}), code('40001'));
  for (const states of [{ SP: 'double_base' }, { MT: 'single_base' }, { XX: 'inside' }, { SP: 'unknown' }]) await assert.rejects(() => save(1, {}, states), code('22023'), JSON.stringify(states));
  await assert.rejects(() => save(1, { difal_default: 'double_base' }, {}), code('22023'));
  const read = await f.rpc('erp_fiscal_tax_settings_get', { p_user_id: f.users.admin });
  assert.equal(read.version, 1); assert.equal(read.settings.difal_default, 'goods');
});
