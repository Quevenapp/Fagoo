import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveEFixture, migrationText } from './helpers/fiscal-wave-e-fixture.mjs';
import { orderSourceRecord } from '../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import { invoiceRecord, invoiceTotals, normalizeInvoiceInput } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { draftToInput, orderDraft, compositionNotices, splitComposition } from '../../../apps/erp/src/lib/fiscal-invoice-form-model.ts';

// 202610200254 on PGlite over every published migration, synthetic data only: "Gerar nota fiscal" reads the Detalhes de pagamento
// of the pedido (tPag / indPag), the Forma and Detalhes of each parcel (card group) and splits compositions into their components
// when "Desmembrar produtos ... em uma estrutura na nota fiscal" is on. Nothing is emitted, numbered or posted.
let f, contact, part, screw, kit, virtualKit, card, nature, warehouse;
const code = expected => error => error.code === expected;
const recordVersion = async id => Number(await f.scalar('select version v from erp_catalog.record where id=$1', [id]));
const compose = async (id, items, stock_type = 'physical') => f.rpc('erp_stock_product_compose', { p_user_id: f.users.admin, p_id: id, p_expected_version: await recordVersion(id), p_command_id: randomUUID(),
  p_data: { name: await f.scalar('select name v from erp_catalog.record where id=$1', [id]) }, p_acknowledged: null,
  p_composition: { expected_version: 0, stock_type, post_mode: stock_type === 'virtual' ? 'components' : 'product', items } });
const sale = async (body = {}) => {
  const r = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: { date: '2026-10-20', contact_id: contact.id, warehouse_id: warehouse.id, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', commercial: null,
    items: [{ product_id: kit.id, description: 'Kit sintético 254', detailed_description: null, code: 'KIT-254', unit: 'KT', quantity: '2', unit_price: '50', discount_percent: '0' }], installments: [], ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.value)); return r.value.document;
};
const source = async (id, user = f.users.fiscal) => f.call(`/v1/notas-fiscais/pedido/${id}?model=55`, 'GET', undefined, user);
const details = over => ({ account_id: null, payment_type: null, card_brand: null, integration_type: null, acquirer_cnpj: null, authorization_code: null, received_amount: null, fee_amount: null, commission_fee_amount: null, ...over });
before(async () => {
  f = await fiscalWaveEFixture();
  await f.company();
  await f.setPreference('suprimentos-estoque', 'estoque.nf_estoque_negativo', true).catch(() => null);
  contact = await f.catalog('contacts', { name: 'Cliente sintético 254', person_type: 'J', document: '12345678000190', state: 'SP', city: 'São Paulo', postal_code: '01001000', street: 'Rua Sintética', number: '10', district: 'Centro' });
  warehouse = await f.catalog('warehouses', { name: 'Depósito 254' });
  part = await f.catalog('products', { name: 'Peça A 254', code: 'A-254', unit: 'UN', kind: 'P', format: 'S', price: '30', ncm: '84714900' });
  screw = await f.catalog('products', { name: 'Parafuso B 254', code: 'B-254', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '73181500' });
  kit = await f.catalog('products', { name: 'Kit sintético 254', code: 'KIT-254', unit: 'KT', kind: 'P', format: 'E', price: '50', ncm: '84714900' });
  virtualKit = await f.catalog('products', { name: 'Kit virtual 254', code: 'KV-254', unit: 'KT', kind: 'P', format: 'E', price: '40', ncm: '84714900' });
  await compose(kit.id, [{ component_id: part.id, quantity: '1' }, { component_id: screw.id, quantity: '2' }]);
  await compose(virtualKit.id, [{ component_id: screw.id, quantity: '4' }], 'virtual');
  card = (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,applicable,card_brand,card_integration,card_cnpj,active,created_by,updated_by) values('Cartão crédito 254','03','contas','recebimentos','02','2','11222333000181',true,$1,$1) returning id", [f.users.admin])).rows[0].id;
  nature = (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: { description: 'Venda 254', direction: '1', crt: '1' } } })).nature;
});
after(() => f?.close());

test('254: entry points and helpers keep the SECURITY DEFINER / service_role rule and the replaced body was hash-checked', async () => {
  const signature = 'public.erp_fiscal_invoice_order_source_v3(uuid,uuid,text)';
  for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, signature]), false, role);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true);
  assert.equal(await f.scalar('select proconfig::text v from pg_proc where oid=$1::regprocedure', [signature]), '{search_path=pg_catalog}');
  for (const helper of ['erp_fiscal_invoices.order_source_v3(uuid,text)', 'erp_fiscal_invoices.order_composition(uuid,boolean,boolean)', 'erp_fiscal_invoices.payment_input(jsonb)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [helper]), false, helper);
  const block = (await migrationText('202610200254_fiscal_order_source_v3.sql')).match(/do \$\$declare r record;begin[\s\S]*?end\$\$;/)[0];
  await assert.rejects(() => f.db.exec(block), error => error.message === 'fiscal_order_source_254_previous_definition_changed');
});

test('254: Detalhes de pagamento, the Forma and the Detalhes of each parcel go to the note (tPag, indPag and the card group)', async () => {
  const doc = await sale({ payment_means: '17', payment_indicator: '1', items: [{ product_id: part.id, description: 'Peça A 254', detailed_description: null, code: 'A-254', unit: 'UN', quantity: '1', unit_price: '100', discount_percent: '0' }],
    installments: [
      { due_date: '2026-11-20', amount: '60.00', method: 'Cartão', payment_method_id: card, details: details({ authorization_code: 'AUT-254', received_amount: '58.00', fee_amount: '2.00' }) },
      { due_date: '2026-12-20', amount: '40.00', method: 'Combinar', details: null }] });
  const got = await source(doc.id);
  assert.equal(got.status, 200, JSON.stringify(got.value));
  const s = orderSourceRecord(got.value);
  assert.deepEqual(s.payment, { means: '17', indicator: '1' });
  assert.equal(s.installments[0].payment_method.id, card); assert.equal(s.installments[0].details.authorization_code, 'AUT-254');
  assert.equal(Object.hasOwn(s.installments[0].details, 'account_id'), false, 'the conta financeira stays in the pedido');
  assert.equal(s.installments[1].payment_method, null);
  const draft = orderDraft(s, { model: '55', direction: '1' }, null, '2026-10-20');
  assert.equal(draft.payment.indicator, '1');
  const [first, second] = draft.payment.installments;
  assert.deepEqual([first.method, first.payment_method_id, first.card], ['03', card, { brand: '02', integration: '2', cnpj: '11222333000181', authorization: 'AUT-254', received: '58.00', fee: '2.00' }]);
  assert.deepEqual([second.method, second.payment_method_id, second.card], ['17', undefined, null], 'without forma nor details the Método de pagamento of the pedido is the tPag');
  // The note keeps the Forma de pagamento of the pedido (payment.indicator) through the Worker, the database and the browser contract.
  const input = { ...draftToInput({ ...draft, nature_id: nature.id, nature_description: nature.description, series: '1', issue_date: '2026-10-20' }) };
  const saved = await f.call('/v1/notas-fiscais', 'POST', { command_id: randomUUID(), invoice: input, orders: [doc.id] }, f.users.fiscal);
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const record = invoiceRecord(saved.value.invoice);
  assert.equal(record.payment.indicator, '1'); assert.equal(record.payment.installments[0].card.authorization, 'AUT-254');
  const read = await f.call(`/v1/notas-fiscais/${record.id}`, 'GET', undefined, f.users.fiscal);
  assert.equal(read.value.invoice.payment.indicator, '1');
  // Without the indicator nothing changes in what is stored; a forged value is refused by the database and by the contract.
  const plain = await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: { ...input, payment: { ...input.payment, indicator: undefined } } } });
  assert.equal(Object.hasOwn(plain.invoice.payment, 'indicator'), false);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: { ...input, payment: { ...input.payment, indicator: '2' } } } }), code('22023'));
  assert.throws(() => normalizeInvoiceInput({ ...input, payment: { ...input.payment, indicator: '2' } }));
});

test('254: "Desmembrar produtos ... Físico / Virtual" puts the components on the note and keeps the total of the pedido', async () => {
  const doc = await sale({ items: [
    { product_id: kit.id, description: 'Kit sintético 254', detailed_description: null, code: 'KIT-254', unit: 'KT', quantity: '2', unit_price: '50', discount_percent: '10' },
    { product_id: virtualKit.id, description: 'Kit virtual 254', detailed_description: null, code: 'KV-254', unit: 'KT', quantity: '1', unit_price: '40', discount_percent: '0' }] });
  // Preference off (Origin default): no composition is sent and the kit stays whole.
  let s = orderSourceRecord((await source(doc.id)).value);
  assert.deepEqual(s.items.map(i => i.composition), [null, null]);
  await f.setPreference('vendas-vendas', 'vendas.desmembrar_fisico', true);
  s = orderSourceRecord((await source(doc.id)).value);
  assert.equal(s.items[0].composition.stock_type, 'physical'); assert.equal(s.items[1].composition, null, 'the virtual one follows its own preference');
  assert.deepEqual(s.items[0].composition.components.map(c => [c.product_id, c.quantity, c.price]), [[part.id, '1.000000', '30.0000'], [screw.id, '2.000000', '10.0000']]);
  await f.setPreference('vendas-vendas', 'vendas.desmembrar_virtual', true);
  s = orderSourceRecord((await source(doc.id)).value);
  const ctx = (await f.call('/v1/notas-fiscais/contexto?model=55', 'GET', undefined, f.users.fiscal)).value;
  const draft = orderDraft(s, { model: '55', direction: '1' }, { ...ctx, item_discount: true }, '2026-10-20');
  // Kit: 2 × 50 = 100.00 with 10.00 of discount, shared 30:20 by the sale price of the components → 60.00 and 40.00.
  assert.deepEqual(draft.items.map(i => [i.product_id, i.quantity, i.unit_price, i.discount ?? null, i.code, i.ncm]), [
    [part.id, '2', '30', '6.00', 'A-254', '84714900'], [screw.id, '4', '10', '4.00', 'B-254', '73181500'], [screw.id, '4', '10', null, 'B-254', '73181500']]);
  const input = draftToInput({ ...draft, nature_id: nature.id, nature_description: nature.description, series: '1', issue_date: '2026-10-20' });
  const totals = invoiceTotals(normalizeInvoiceInput(input)).totals;
  assert.equal(totals.total, s.totals.total, 'the note keeps the total of the pedido');
  assert.deepEqual(compositionNotices(s), []);
  // A structure whose component became inactive is not split, and the form says why.
  await f.db.query('update erp_catalog.record set active=false where id=$1', [part.id]);
  const blocked = orderSourceRecord((await source(doc.id)).value);
  assert.equal(blocked.items[0].composition.problem, 'component_unavailable');
  assert.equal(orderDraft(blocked, { model: '55', direction: '1' }, null, '2026-10-20').items[0].product_id, kit.id);
  assert.match(compositionNotices(blocked)[0], /não foi desmembrada porque um componente está inativo/);
  await f.db.query('update erp_catalog.record set active=true where id=$1', [part.id]);
  await f.setPreference('vendas-vendas', 'vendas.desmembrar_fisico', false);
  await f.setPreference('vendas-vendas', 'vendas.desmembrar_virtual', false);
});

test('254: splitComposition keeps exact cents and refuses what cannot be split exactly', () => {
  const item = (quantity, gross, components) => ({ position: 1, product_id: kit.id, description: 'Kit', code: 'K', unit: 'KT', quantity, unit_price: '1', gross, discount: '0.00', total: gross, product: null,
    composition: { stock_type: 'physical', problem: null, components: components.map(([quantity, price], i) => ({ position: i + 1, product_id: [part.id, screw.id, contact.id][i], description: `C${i}`, code: null, unit: 'UN', quantity, price,
      product: { kind: 'P', ncm: null, gtin: null, gtin_tax: null, cest: null, origin: null, gross_weight: null, net_weight: null, volumes: null } })) } });
  // 3 × kit of 10.00 with components priced 1:1:1 → 10.00 split as 3.33, 3.33, 3.34 (truncated, last takes the remainder).
  const three = splitComposition(item('1', '10.00', [['1', '1'], ['1', '1'], ['1', '1']]), 0n);
  assert.deepEqual(three.items.map(i => i.unit_price), ['3.33', '3.33', '3.34']);
  // Without prices the quantities weigh; a quantity with more than four decimals keeps the kit.
  assert.deepEqual(splitComposition(item('1', '9.00', [['1', null], ['2', null]]), 0n).items.map(i => [i.quantity, i.unit_price]), [['1', '3'], ['2', '3']]);
  assert.equal(splitComposition(item('0.333333', '3.33', [['0.5', '1']]), 0n).problem, 'quantity_precision');
  assert.equal(splitComposition({ ...item('1', '1.00', [['1', '1']]), composition: null }, 0n).items, null);
});

test('254: profiles that do not read the pedido kind still get 403, and the old v2 keeps answering', async () => {
  const doc = await sale({});
  for (const user of [f.users.consulta, f.users.vendas]) assert.equal((await source(doc.id, user)).status, 403);
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_order_source_v3', { p_user_id: f.users.fiscal, p_document_id: doc.id, p_model: '99' }), code('22023'));
  const v2 = await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: doc.id, p_model: '55' });
  assert.equal(Object.hasOwn(v2, 'payment'), false);
  assert.equal(orderSourceRecord(v2).payment.means, null, 'the browser contract still reads the v2 answer');
});

test('254: a pedido of a foreign contact is no longer refused: the note opens as Exportação (v2 keeps the refusal)', async () => {
  const abroad = await f.catalog('contacts', { name: 'Cliente estrangeiro 254', person_type: 'E', document: 'PASS-254', state: 'EX', city: 'Montevideo' });
  const r = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: { date: '2026-10-20', contact_id: abroad.id, warehouse_id: warehouse.id, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', commercial: null,
    items: [{ product_id: part.id, description: 'Peça A 254', detailed_description: null, code: 'A-254', unit: 'UN', quantity: '1', unit_price: '30', discount_percent: '0' }], installments: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.value));
  const v2 = orderSourceRecord(await f.rpc('erp_fiscal_invoice_order_source_v2', { p_user_id: f.users.fiscal, p_document_id: r.value.document.id, p_model: '55' }));
  assert.deepEqual(v2.reasons.map(x => x.code), ['international']);
  const s = orderSourceRecord((await source(r.value.document.id)).value);
  assert.equal(s.eligible, true); assert.deepEqual(s.reasons, []);
  const draft = orderDraft(s, { model: '55', direction: '1' }, null, '2026-10-20');
  assert.deepEqual([draft.issue_type, draft.recipient.person_type, draft.recipient.foreign_id, draft.recipient.state], ['E', 'E', 'PASS-254', 'EX']);
  const saved = await f.call('/v1/notas-fiscais', 'POST', { command_id: randomUUID(), invoice: draftToInput({ ...draft, nature_id: nature.id, nature_description: nature.description, series: '1' }), orders: [r.value.document.id] }, f.users.fiscal);
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.invoice.issue_type, 'E');
});
