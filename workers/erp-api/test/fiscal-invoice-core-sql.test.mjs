import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import * as dto from '../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';

// 112 on PGlite with synthetic data only. Saving a note never emits, reserves a number or creates effects.
const migration = async name => readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const code = expected => error => error.code === expected;
let f, nature, entryNature;
const execute = (action, data, { user = f.users.admin, command = randomUUID() } = {}) => f.rpc('erp_fiscal_invoice_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const item = (over = {}) => ({ product_id: f.product.id, description: 'Peça sintética', code: 'P-1', unit: 'UN', quantity: '2', unit_price: '50', ncm: '84713012', cfop: '5102',
  icms: { origin: '0', situation: '102' }, pis: { situation: '49' }, cofins: { situation: '49' }, ...over });
const invoice = (over = {}) => ({ model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: nature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1',
  final_consumer: false, recipient: { contact_id: f.contact.id, name: 'Cliente sintético', person_type: 'J', document: '12345678000190', state: 'SP' },
  items: [item(), item({ description: 'Outra peça sintética', quantity: '1', unit_price: '50' })], ...over });
const create = (data, options) => execute('create', { invoice: data }, options);
const KEY = digits => { let sum = 0, weight = 2; for (let i = digits.length - 1; i >= 0; i--) { sum += Number(digits[i]) * weight; weight = weight === 9 ? 2 : weight + 1; } const dv = 11 - (sum % 11); return digits + String(dv >= 10 ? 0 : dv); };

before(async () => {
  f = await fixture({ apply: false });
  for (const name of ['202610160016_company', '202610160022_fiscal_drafts', '202610160035_fiscal_item_preparation', '202610160040_fiscal_tax_preparation', '202610160046_fiscal_numbering',
    '202610200111_fiscal_operation_natures', '202610200112_fiscal_invoice_core',
    // 141 extends the item groups (Armamento, Veículo); the descriptors below are the current ones.
    '202610200141_fiscal_item_groups_nature_review']) await f.db.exec(await migration(name));
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1)", [f.users.admin]);
  await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)", [f.users.admin]);
  await f.db.query("insert into erp_fiscal_numbering.series(issuer_cnpj,cuf,model,environment,series,first_number,next_number,version,identity_version,enabled,exclusive_use_confirmed,reference) values('11222333000181','35','55','2',2,1,42195,3,1,true,true,'Série sintética')");
  const natures = async (data) => (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: data } })).nature;
  nature = await natures({ description: 'Venda sintética', direction: '1', crt: '1', presence: '1', rules: [{ tax: 'icms', data: { situation: '102', cfop: '5102' } }] });
  entryNature = await natures({ description: 'Compra sintética', direction: '0', crt: '1', presence: '9' });
  await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'set_default', p_data: { id: nature.id, expected_version: 1, code: 'S' } });
});
after(() => f?.close());

test('112 entry points are SECURITY DEFINER for service_role only; native notes stay with admin and fiscal', async () => {
  for (const signature of ['public.erp_fiscal_invoice_get(uuid,uuid)', 'public.erp_fiscal_invoice_context(uuid,text)', 'public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
  }
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_fiscal_invoices.invoice_input(jsonb)','EXECUTE') value"), false);
  assert.deepEqual(await f.scalar('select erp_fiscal_invoices.invoice_specs() value'), JSON.parse(JSON.stringify({ recipient: dto.RECIPIENT_SPEC, export: dto.EXPORT_SPEC, import: dto.IMPORT_SPEC,
    addition: dto.ADDITION_SPEC, reference: dto.REFERENCE_SPEC, transport: dto.TRANSPORT_SPEC, carrier: dto.CARRIER_SPEC, vehicle: dto.VEHICLE_SPEC, volumes: dto.VOLUMES_SPEC,
    // The forma de pagamento of the parcel arrives with 202610200219 (checked in fiscal-invoice-wave-d-sql).
    delivery: dto.DELIVERY_SPEC, installment: (({ payment_method_id, ...rest }) => rest)(dto.INSTALLMENT_SPEC), card: dto.CARD_SPEC, authorized: dto.AUTHORIZED_SPEC, intermediary: dto.INTERMEDIARY_SPEC,
    // The item discount arrives with 202610200176 (checked in fiscal-invoice-order-sql); 112 knows the rest of the item.
    item: (({ discount, ...rest }) => rest)(dto.ITEM_SPEC), item_groups: dto.ITEM_GROUPS })));
  const created = (await create(invoice(), { user: f.users.fiscal })).invoice;
  for (const user of [f.users.consulta, f.users.vendas, f.users.estoque, f.users.financeiro, randomUUID()]) {
    await assert.rejects(() => f.rpc('erp_fiscal_invoice_get', { p_user_id: user, p_id: created.id }), code('42501'));
    await assert.rejects(() => create(invoice(), { user }), code('42501'));
    await assert.rejects(() => f.rpc('erp_fiscal_invoice_context', { p_user_id: user, p_model: '55' }), code('42501'));
  }
});

test('own note: homologation, Pendente, no number, exact item totals, allocation and totals in cents', async () => {
  const out = await create(invoice({ freight: '10', insurance: '0.03', discount: '15', items: [item({ quantity: '2', unit_price: '33.335' }), item({ quantity: '1.5', unit_price: '20',
    icms: { origin: '0', situation: '101', credit_rate: '1.25', credit_value: '1.11' }, ipi: { situation: '50', base: '30.00', rate: '10', value: '3' } })] }));
  const record = out.invoice;
  assert.equal(out.emission_enabled, false); assert.equal(out.production_enabled, false); assert.equal(out.operational_effects, false); assert.equal(out.writable, true);
  assert.equal(record.environment, '2'); assert.equal(record.status, 1); assert.equal(record.number, null); assert.equal(record.access_key, null); assert.equal(record.nature_description, 'Venda sintética');
  assert.deepEqual(record.items.map(i => [i.quantity, i.unit_price, i.total]), [['2.0000', '33.3350000000', '66.67'], ['1.5000', '20.0000000000', '30.00']]);
  assert.deepEqual(record.items.map(i => i.allocated), [{ freight: '6.89', insurance: '0.02', other_expenses: '0.00', discount: '10.34' }, { freight: '3.11', insurance: '0.01', other_expenses: '0.00', discount: '4.66' }]);
  assert.equal(record.totals.products, '96.67'); assert.equal(record.totals.ipi, '3.00'); assert.equal(record.totals.credit, '1.11');
  assert.equal(record.totals.total, '94.70', '96.67 - 15 + 10 + 0.03 + 3.00 IPI');
  assert.deepEqual(record.items[1].ipi, { situation: '50', base: '30.00', rate: '10.0000', value: '3.00' });
  assert.equal(record.transport.mode, 'none'); assert.equal(record.transport.freight_by, '9');
  assert.equal(await f.scalar('select count(*)::int value from erp_stock.movement'), 0, 'no stock effect');
  assert.equal(await f.scalar('select count(*)::int value from erp_finance.title'), 0, 'no finance effect');
});

test('production and authorization cannot be reached through the table or the RPC', async () => {
  const record = (await create(invoice())).invoice;
  await assert.rejects(() => create(invoice({ number: '10' })), code('22023'), 'own notes get their number only when the homologation series reserves it');
  await assert.rejects(() => create(invoice({ environment: '1' })), code('22023'));
  await assert.rejects(() => f.db.query("update erp_fiscal_invoices.invoice set environment='1',version=version+1 where id=$1", [record.id]), error => ['23514', '40001'].includes(error.code));
  await assert.rejects(() => f.db.query("update erp_fiscal_invoices.invoice set protocol='135260000000001',version=version+1 where id=$1", [record.id]), code('42501'));
  await assert.rejects(() => f.db.query('delete from erp_fiscal_invoices.invoice where id=$1', [record.id]), code('42501'));
  for (const fn of ['erp_fiscal_drafts.draft', 'erp_fiscal_numbering.series']) assert.match(await f.scalar(`select pg_get_constraintdef(oid) value from pg_constraint where conrelid='${fn}'::regclass and pg_get_constraintdef(oid) like '%environment%'`), /'2'/);
});

test('third-party note (Emitida por Terceiros) is registered without environment and with a checked access key', async () => {
  const digits = `3526101122233300018155001000000123${'1'}${'12345678'}`;
  const key = KEY(digits.slice(0, 43));
  const out = await create(invoice({ direction: '0', issue_type: 'T', series: '1', number: '123', access_key: key, nature_id: entryNature.id, presence: '9',
    items: [item({ cfop: '1102', ipi: { situation: '49' } })] }));
  assert.equal(out.invoice.environment, null); assert.equal(out.invoice.status, 8); assert.equal(out.invoice.number, 123); assert.equal(out.invoice.access_key, key);
  await assert.rejects(() => create(invoice({ direction: '0', issue_type: 'T', series: '1', number: '123', access_key: key, nature_id: entryNature.id, items: [item({ cfop: '1102' })] })), code('23505'), 'same key twice');
  await assert.rejects(() => create(invoice({ direction: '0', issue_type: 'T', series: '1', number: '124', access_key: key.slice(0, 43) + String((Number(key[43]) + 1) % 10), nature_id: entryNature.id, items: [item({ cfop: '1102' })] })), code('22023'), 'wrong DV');
  await assert.rejects(() => create(invoice({ direction: '0', issue_type: 'T', series: '1', nature_id: entryNature.id, items: [item({ cfop: '1102' })] })), code('22023'), 'number required');
  await assert.rejects(() => create(invoice({ direction: '0', issue_type: 'N', nature_id: nature.id })), code('22023'), 'exit nature on an entry note');
  await assert.rejects(() => create(invoice({ direction: '0', issue_type: 'X', series: '1', number: '9', nature_id: entryNature.id })), code('22023'), 'XML import types need the importer');
  await assert.rejects(() => create(invoice({ issue_type: 'S', series: '1', number: '9' })), code('22023'));
});

test('validation follows the Origin form: recipient, CST by regime, IPI by direction, references, intermediary, NFC-e', async () => {
  const bad = [
    invoice({ recipient: { name: 'Sem tipo' } }), invoice({ recipient: { name: 'X', person_type: 'J', document: '12345678901' } }), invoice({ items: [] }),
    invoice({ items: [item({ icms: { situation: '00' } })] }), invoice({ crt: '3', items: [item({ icms: { situation: '102' } })] }), invoice({ items: [item({ ipi: { situation: '00' } })] }),
    invoice({ items: [item({ icms: { origin: '0', situation: '102', unknown: '1' } })] }), invoice({ items: [item({ quantity: '0' })] }), invoice({ items: [item({ unit_price: '1.12345678901' })] }),
    invoice({ references: [{ type: 'nfe', key: '1'.repeat(44) }] }), invoice({ references: [{ type: 'ecf' }] }), invoice({ references: [{ type: 'nf01', number: '1' }] }),
    invoice({ intermediary: { present: true, cnpj: '12345678000190' } }), invoice({ discount: '150.01' }), invoice({ export: { exit_state: 'SP' } }),
    invoice({ import_declaration: { number: '1' } }), invoice({ purpose: '1', credit_debit_type: '01' }), invoice({ nature_id: null }), invoice({ issue_date: null }),
    invoice({ model: '65', issue_type: 'C', presence: '2', final_consumer: true }), invoice({ model: '65', issue_type: 'C', presence: '1', final_consumer: false }),
    invoice({ model: '65', issue_type: 'N' }), invoice({ authorized_xml: [{ name: 'Sem documento' }] }), invoice({ transport: { mode: 'none', carrier: { name: 'Transportadora' } } }),
    invoice({ payment: { installments: [{ amount: '10' }] } }), invoice({ recipient: { name: 'X', person_type: 'J', contact_id: randomUUID() } }),
  ];
  for (const [index, data] of bad.entries()) await assert.rejects(() => create(data), code('22023'), `case ${index}`);
  const key = KEY(`3526101122233300018155001000000777${'1'}12345678`.slice(0, 43));
  const ok = (await create(invoice({ references: [{ type: 'nfe', key }, { type: 'nf01', year_month: '2610', number: '15', series: '0' }], intermediary: { present: true, cnpj: '12345678000190', identification: 'loja-sintetica' },
    authorized_xml: [{ name: 'Contador sintético', document: '98765432100' }], transport: { mode: 'manual', freight_by: '1', carrier: { name: 'Transportadora sintética', state: 'SP' }, vehicle: { plate: 'ABC1D23', state: 'SP' },
      volumes: { quantity: '2', gross_weight: '1.5', species: 'caixas' }, delivery: { name: 'Entrega sintética', state: 'RJ' } },
    payment: { condition: '30 60', installments: [{ days: '30', date: '2026-11-19', amount: '50', method: '15' }, { days: '60', date: '2026-12-19', amount: '100.00', method: '03', card: { integration: '2', brand: '01' } }] } }))).invoice;
  assert.equal(ok.references.length, 2); assert.equal(ok.transport.volumes.gross_weight, '1.500'); assert.equal(ok.payment.installments[0].amount, '50.00'); assert.equal(ok.payment.installments[1].card.brand, '01');
  await assert.rejects(() => create(invoice({ references: [{ type: 'nfe', key }, { type: 'nfe', key }] })), code('22023'), 'Esta chave já foi adicionada');
  const nfce = (await create(invoice({ model: '65', issue_type: 'C', presence: '1', final_consumer: true, recipient: {} }))).invoice;
  assert.equal(nfce.model, '65'); assert.equal(nfce.environment, '2'); assert.deepEqual(nfce.recipient, {});
  const exportNote = (await create(invoice({ issue_type: 'E', recipient: { name: 'Buyer', person_type: 'E', foreign_id: 'A1', state: 'EX' }, export: { exit_state: 'SP', exit_place: 'Porto de Santos' } }))).invoice;
  assert.deepEqual(exportNote.export, { exit_state: 'SP', exit_place: 'Porto de Santos' });
  const importNote = (await create(invoice({ direction: '0', issue_type: 'I', nature_id: entryNature.id, presence: '9', items: [item({ cfop: '3102', ii: { situation: 'T', base: '10', rate: '60', value: '6' } })],
    import_declaration: { number: 'DI-1', registration_date: '2026-10-01', transport_route: '1', intermediation: '1', additions: [{ number: '1', sequence: '1', manufacturer: 'Fab' }] } }))).invoice;
  assert.equal(importNote.import_declaration.additions.length, 1); assert.equal(importNote.totals.ii, '6.00'); assert.equal(importNote.totals.total, '106.00');
});

test('update with expected version, idempotent commands, editable situations and logical deletion with audit', async () => {
  const created = (await create(invoice())).invoice;
  const command = randomUUID(), data = { id: created.id, expected_version: 1, invoice: invoice({ additional_info: 'Pedido 12', items: [item({ quantity: '3' })] }) };
  const first = await execute('update', data, { command });
  assert.equal(first.invoice.version, 2); assert.equal(first.invoice.totals.products, '150.00'); assert.equal(first.replayed, false);
  assert.equal((await execute('update', data, { command })).replayed, true);
  await assert.rejects(() => execute('update', { ...data, invoice: invoice() }, { command }), code('40001'));
  await assert.rejects(() => execute('update', data), code('40001'), 'stale version');
  await assert.rejects(() => execute('update', { id: created.id, expected_version: 2, invoice: invoice({ model: '65', issue_type: 'C', final_consumer: true }) }), code('22023'), 'model is immutable');
  await f.db.query('update erp_fiscal_invoices.invoice set status=6,version=version+1 where id=$1', [created.id]);
  const authorized = await f.rpc('erp_fiscal_invoice_get', { p_user_id: f.users.admin, p_id: created.id });
  assert.equal(authorized.writable, false);
  await assert.rejects(() => execute('update', { id: created.id, expected_version: 3, invoice: invoice() }), code('40001'), 'Autorizada is not editable');
  await assert.rejects(() => execute('delete', { id: created.id, expected_version: 3, reason: 'x' }), code('22023'));
  const deleted = (await execute('delete', { id: created.id, expected_version: 3, reason: 'Nota de teste sintética' })).invoice;
  assert.ok(deleted.deleted_at); assert.equal(deleted.delete_reason, 'Nota de teste sintética'); assert.equal(deleted.version, 4);
  await assert.rejects(() => execute('delete', { id: created.id, expected_version: 4, reason: 'Outra vez' }), code('40001'));
  assert.deepEqual((await f.db.query('select action from erp_fiscal_invoices.audit where entity_id=$1 order by id', [created.id])).rows.map(r => r.action), ['create', 'update', 'delete']);
  assert.deepEqual((await f.db.query('select version from erp_fiscal_invoices.invoice_revision where invoice_id=$1 order by version', [created.id])).rows.map(r => r.version), [1, 2, 4]);
  await assert.rejects(() => f.db.query('delete from erp_fiscal_invoices.invoice_revision where invoice_id=$1', [created.id]), code('42501'));
});

test('deletion always carries its reason, in the RPC and in the table', async () => {
  const created = (await create(invoice())).invoice;
  for (const data of [{ id: created.id, expected_version: 1 }, { id: created.id, expected_version: 1, reason: null }, { id: created.id, expected_version: 1, reason: ' \n ' }, { id: created.id, expected_version: 1, reason: 'ab' }])
    await assert.rejects(() => execute('delete', data), code('22023'), JSON.stringify(data));
  await assert.rejects(() => f.db.query('update erp_fiscal_invoices.invoice set deleted_at=now(),deleted_by=$2,version=version+1 where id=$1', [created.id, f.users.admin]), code('23514'));
  assert.equal(await f.scalar('select deleted_at is null value from erp_fiscal_invoices.invoice where id=$1', [created.id]), true);
  assert.equal((await execute('delete', { id: created.id, expected_version: 1, reason: 'Motivo sintético' })).invoice.delete_reason, 'Motivo sintético');
});

test('origin orders: sales orders on exit notes, purchase orders on entry notes; context shows series and defaults', async () => {
  const order = await f.order();
  const linked = (await execute('create', { invoice: invoice(), orders: [order.id, order.id] })).invoice;
  assert.deepEqual(linked.orders.map(o => [o.id, o.kind, o.number]), [[order.id, 'sales_orders', order.number]]);
  const purchase = await f.order({ kind: 'purchase_orders' });
  await assert.rejects(() => execute('create', { invoice: invoice(), orders: [purchase.id] }), code('22023'));
  const entry = (await execute('create', { invoice: invoice({ direction: '0', issue_type: 'T', number: '55', nature_id: entryNature.id, items: [item({ cfop: '1102' })] }), orders: [purchase.id] })).invoice;
  assert.deepEqual(entry.orders.map(o => o.kind), ['purchase_orders']);
  const context = await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '55' });
  assert.deepEqual(context.series, [{ series: 2, next_number: 42195, enabled: true }]);
  assert.deepEqual(context.company, { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true });
  assert.equal(context.defaults.S.id, nature.id); assert.equal(context.emission_enabled, false); assert.equal(context.production_enabled, false);
  assert.deepEqual((await f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '65' })).series, []);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_context', { p_user_id: f.users.fiscal, p_model: '57' }), code('22023'));
});
