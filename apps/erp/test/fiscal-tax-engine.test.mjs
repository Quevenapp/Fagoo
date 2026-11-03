import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateInvoiceTaxes, matchRule, fillVariables, infoVariables } from '../../../packages/fiscal-core/src/tax-engine.mjs';
import { normalizeInvoiceInput, invoiceTotals } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { ICMS_CST, ICMS_CSOSN, PIS_CST, IPI_CST, labelOf } from '../../../packages/fiscal-core/src/tax-tables.mjs';
import { CST_ICMS, CSOSN, CST_PIS, CST_IPI } from '../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';

// "Cálculo automático": rule choice and exact tax values (synthetic natures and items only).
const rule = (tax, data, over = {}) => ({ tax, position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], data, additional_info: null, fiscal_info: null, ...over });
const P1 = '10000000-0000-4000-8000-000000000001', N1 = '20000000-0000-4000-8000-000000000001';
const base = (items, over = {}) => normalizeInvoiceInput({ model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: N1, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1',
  recipient: { name: 'Cliente', person_type: 'J', document: '12345678000190', state: 'SP' }, items, ...over });

test('tables cover every code of the field contract with Origin labels', () => {
  assert.deepEqual(ICMS_CST.map(([c]) => c), [...CST_ICMS]); assert.deepEqual(ICMS_CSOSN.map(([c]) => c).slice(0, 10), [...CSOSN]);
  assert.deepEqual(PIS_CST.map(([c]) => c), [...CST_PIS]); assert.deepEqual(IPI_CST.map(([c]) => c), [...CST_IPI]);
  assert.equal(labelOf(ICMS_CST, '00'), '00 Tributada integralmente'); assert.equal(labelOf(ICMS_CST, 'zz'), 'zz');
});

test('rule choice: listed product beats NCM prefix beats any product; a listed state beats Qualquer estado', () => {
  const rules = [rule('icms', { situation: '102' }), rule('icms', { situation: '101' }, { position: 2, destinations: ['RJ'] }), rule('icms', { situation: '500' }, { position: 3, product_scope: 'ncm', ncms: ['8471'] }),
    rule('icms', { situation: '900' }, { position: 4, product_scope: 'ncm', ncms: ['847130'] }), rule('icms', { situation: '201' }, { position: 5, product_scope: 'products', product_ids: [P1] })];
  assert.equal(matchRule(rules, 'icms', { state: 'SP', productId: null, ncm: null }).data.situation, '102');
  assert.equal(matchRule(rules, 'icms', { state: 'RJ', productId: null, ncm: null }).data.situation, '101');
  assert.equal(matchRule(rules, 'icms', { state: 'SP', productId: null, ncm: '84713012' }).data.situation, '900', 'longest NCM prefix');
  assert.equal(matchRule(rules, 'icms', { state: 'SP', productId: P1, ncm: '84713012' }).data.situation, '201');
  assert.equal(matchRule(rules, 'pis', { state: 'SP', productId: null, ncm: null }), null);
});

test('Simples credit, ICMS ST over IPI and MVA, PIS/COFINS without ICMS and fixed approximate taxes, all in exact cents', () => {
  const nature = { id: N1, include_freight_ipi_base: false, others: { approx_tax_type: 'fixed', approx_tax_rate: '13.4500' }, additional_info: 'Base ICMS [VALOR_BASE_ICMS] ICMS {VALOR_ICMS} ST [VALOR_ICMS_ST] [DESCONHECIDA]', fiscal_info: null,
    rules: [rule('icms', { situation: '201', cfop: '5401', rate: '18', credit_rate: '1.25', st_rate: '18', st_mva: '40' }), rule('ipi', { situation: '50', rate: '10' }),
      rule('pis', { situation: '01', rate: '0.65' }), rule('cofins', { situation: '01', rate: '3' })] };
  const invoice = base([{ description: 'Peça', quantity: '3', unit_price: '33.3333333333', ncm: '84713012' }], { freight: '10', discount: '0.01' });
  const { invoice: out } = calculateInvoiceTaxes(invoice, { natures: { [N1]: nature }, settings: { exclude_icms_pis_cofins: true }, options: { simplesCreditMessage: true } });
  const item = out.items[0];
  assert.equal(item.cfop, '5401'); assert.equal(out.cfop, '5401');
  // total 100.00, freight 10.00, discount 0.01 => 109.99
  assert.deepEqual(item.icms, { situation: '201', credit_rate: '1.2500', credit_value: '1.37', st_mva: '40.0000', st_base_rate: '100.0000', st_base: '167.99', st_rate: '18.0000', st_value: '10.44' });
  assert.deepEqual(item.ipi, { situation: '50', base_rate: '100.0000', base: '100.00', rate: '10.0000', value: '10.00' });
  assert.equal(item.pis.value, '0.59', '(109.99 - 19.80 own ICMS) × 0.65%'); assert.equal(item.cofins.value, '2.71');
  assert.deepEqual(item.others, { ibpt_rate: '13.4500', approx_taxes: '13.45' });
  assert.equal(out.nature_additional_info.startsWith('Base ICMS 0,00 ICMS 0,00 ST 10,44 [DESCONHECIDA]'), true);
  assert.match(out.nature_additional_info, /PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R\$ 1,37, CORRESPONDENTE À ALÍQUOTA DE 1,25%/);
  const totals = invoiceTotals(normalizeInvoiceInput(out));
  assert.equal(totals.totals.total, '130.43', '100.00 - 0.01 + 10.00 freight + 10.00 IPI + 10.44 ST');
});

test('regime normal: reduction, deferral, FCP; untouched groups and typed values when no rule applies', () => {
  const nature = { id: N1, others: {}, rules: [rule('icms', { situation: '20', rate: '12', base_rate: '41.67', fcp_rate: '2' }), rule('icms', { situation: '51', rate: '18', deferral_rate: '33.33' }, { position: 2, destinations: ['MG'] })] };
  const one = calculateInvoiceTaxes(base([{ description: 'A', quantity: '1', unit_price: '1000', icms: { origin: '1', situation: '00' }, ipi: { situation: '99', value: '5.00' } }], { crt: '3' }), { natures: { [N1]: nature } }).invoice.items[0];
  assert.deepEqual(one.icms, { origin: '1', situation: '20', base_rate: '41.6700', base: '416.70', rate: '12.0000', value: '50.00', fcp_rate: '2.0000', fcp_value: '8.33' });
  assert.deepEqual(one.ipi, { situation: '99', value: '5.00' }, 'no IPI rule: typed values stay');
  const mg = calculateInvoiceTaxes(base([{ description: 'B', quantity: '2', unit_price: '50' }], { crt: '3', recipient: { name: 'Cliente', person_type: 'J', state: 'MG' } }), { natures: { [N1]: nature } }).invoice.items[0];
  assert.deepEqual(mg.icms, { situation: '51', deferral_rate: '33.3300', base_rate: '100.0000', base: '100.00', rate: '18.0000', value: '12.00' });
  const variables = infoVariables({ ...base([{ description: 'B', quantity: '1', unit_price: '1' }]), items: [mg] });
  assert.equal(variables.VALOR_DIFERIMENTO, '6,00'); assert.equal(fillVariables('Diferido [VALOR_DIFERIMENTO]', variables), 'Diferido 6,00');
});

// ---- Second wave (2026-10-20): discount type, pauta, ST modes, desoneração, PIS/COFINS ST, per-unit values, DIFAL, import base, texts ----
const one = (data = {}) => [{ description: 'Peça', quantity: '2', unit_price: '50', ...data }];
const run = (rules, invoiceOver = {}, context = {}, natureOver = {}) => calculateInvoiceTaxes(base(invoiceOver.items ?? one(), { crt: '3', ...invoiceOver }), { natures: { [N1]: { id: N1, others: {}, rules, ...natureOver } }, ...context }).invoice;

test('Tipo desconto: Incondicional reduces the IPI and ST bases, Condicional neither, unset keeps the first engine', () => {
  const rules = [rule('icms', { situation: '10', rate: '18', st_rate: '18', st_mva: '40' }), rule('ipi', { situation: '50', rate: '10' })];
  const unconditional = run(rules, { discount: '10', items: one({ discount_type: 'I' }) }).items[0];
  assert.equal(unconditional.ipi.base, '90.00'); assert.equal(unconditional.ipi.value, '9.00');
  assert.equal(unconditional.icms.value, '16.20'); assert.equal(unconditional.icms.st_base, '138.60'); assert.equal(unconditional.icms.st_value, '8.75');
  const conditional = run(rules, { discount: '10', items: one({ discount_type: 'C' }) }).items[0];
  assert.equal(conditional.ipi.value, '10.00'); assert.equal(conditional.icms.st_base, '154.00'); assert.equal(conditional.icms.st_value, '11.52');
  const unset = run(rules, { discount: '10' }).items[0];
  assert.equal(unset.ipi.base, '100.00', 'IPI base stays gross'); assert.equal(unset.icms.st_base, '140.00', '(100 + 10 IPI - 10) × 1.40');
  assert.equal(run(rules, { discount: '10' }, {}, { others: { discount_type: 'I' } }).items[0].ipi.value, '9.00', 'the nature default applies when the item has none');
});

test('Modalidade BC: pauta and preço tabelado use quantity × value; ST by pauta, lista and operation value', () => {
  assert.deepEqual(run([rule('icms', { situation: '00', rate: '12', bc_mode: '1', pauta_value: '30' })]).items[0].icms, { situation: '00', bc_mode: '1', base_rate: '100.0000', base: '60.00', rate: '12.0000', value: '7.20' });
  assert.equal(run([rule('icms', { situation: '00', rate: '12', bc_mode: '2', pauta_value: '30' })]).items[0].icms.base, '60.00');
  assert.equal(run([rule('icms', { situation: '00', rate: '12', bc_mode: '3', pauta_value: '30' })]).items[0].icms.base, '100.00', 'valor da operação ignores the pauta');
  const pauta = run([rule('icms', { situation: '10', rate: '12', st_bc_mode: '5', st_pauta_value: '80', st_rate: '18' })]).items[0].icms;
  assert.equal(pauta.st_base, '160.00'); assert.equal(pauta.st_value, '16.80'); assert.equal(pauta.st_mva, undefined);
  assert.equal(run([rule('icms', { situation: '10', rate: '12', st_bc_mode: '1', st_pauta_value: '70', st_rate: '18' })]).items[0].icms.st_base, '140.00', 'lista negativa (valor)');
  const operation = run([rule('icms', { situation: '10', rate: '12', st_bc_mode: '6', st_mva: '40', st_rate: '18' })]).items[0].icms;
  assert.equal(operation.st_base, '100.00', 'valor da operação has no MVA'); assert.equal(operation.st_value, '6.00');
});

test('ICMS desonerado, PIS ST and COFINS ST, IPI per unit, PIS per quantity and monophase ad rem', () => {
  assert.deepEqual(run([rule('icms', { situation: '40', rate: '18', deson_reason: '9' })]).items[0].icms, { situation: '40', deson_reason: '9', deson_value: '18.00' });
  const reduced = run([rule('icms', { situation: '20', rate: '18', base_rate: '50', deson_reason: '9', deson_deduct: true })]).items[0].icms;
  assert.equal(reduced.value, '9.00'); assert.equal(reduced.deson_value, '9.00'); assert.equal(reduced.deson_deduct, true);
  assert.equal(run([rule('icms', { situation: '40', rate: '18' })], { items: one({ icms: { situation: '40', deson_value: '3.00' } }) }).items[0].icms.deson_value, '3.00', 'without a reason the typed value stays');
  const st = run([rule('icms', { situation: '00', rate: '18', st_pis_rate: '0.65', st_cofins_rate: '3' })]).items[0].icms;
  assert.deepEqual([st.pis_st_base, st.pis_st_rate, st.pis_st_value, st.cofins_st_base, st.cofins_st_value], ['100.00', '0.6500', '0.65', '100.00', '3.00']);
  const units = run([rule('ipi', { situation: '50' }), rule('pis', { situation: '03' }), rule('cofins', { situation: '03' })],
    { items: [{ description: 'Peça', quantity: '4', unit_price: '25', ipi: { unit_value: '1.5' }, pis: { unit_value: '0.1234' }, cofins: { unit_value: '0.5687' } }] }).items[0];
  assert.equal(units.ipi.value, '6.00'); assert.equal(units.pis.value, '0.49'); assert.equal(units.cofins.value, '2.27');
  assert.equal(run([rule('icms', { situation: '02' })], { items: one({ icms: { situation: '02', mono_qty: '10', mono_rate: '1.12' } }) }).items[0].icms.mono_value, '11.20');
});

test('DIFAL partilha for a non-contributor consumer in another state follows the global mode and the per-UF table', () => {
  const rules = [rule('icms', { situation: '00', rate: '7', difal_internal_rate: '18', difal_fcp_rate: '2' })];
  const mg = { recipient: { name: 'Consumidor', person_type: 'F', document: '12345678909', state: 'MG', ie_indicator: '9' }, final_consumer: true };
  const options = { companyState: 'SP' };
  const goods = run(rules, mg, { settings: { difal_default: 'goods' }, options }).items[0].icms;
  assert.deepEqual([goods.difal_base, goods.difal_dest_value, goods.difal_origin_value, goods.difal_fcp_value, goods.difal_interstate_rate, goods.difal_share_rate], ['100.00', '11.00', '0.00', '2.00', '7.0000', '100.0000']);
  const inside = run(rules, mg, { settings: { difal_default: 'inside' }, options }).items[0].icms;
  assert.deepEqual([inside.difal_base, inside.difal_dest_value, inside.difal_fcp_value], ['113.41', '13.41', '2.27'], '(100 - 7) ÷ 0.82, × 18% - 7');
  const validated = run(rules, mg, { settings: { difal_default: 'validated' }, options }).items[0].icms;
  assert.equal(validated.difal_interstate_rate, '7.0000'); assert.equal(validated.difal_dest_value, undefined);
  assert.equal(run(rules, mg, { settings: { difal_default: 'none' }, options }).items[0].icms.difal_interstate_rate, undefined);
  assert.equal(run(rules, mg, { settings: { difal_default: 'inside' }, difalByState: { MG: 'goods' }, options }).items[0].icms.difal_dest_value, '11.00', 'DIFAL por UF wins');
  assert.equal(run(rules, mg, { settings: { difal_default: 'inside' }, difalByState: { MG: 'double_base' }, options }).items[0].icms.difal_dest_value, undefined, 'state-specific bases stay as typed');
  for (const [over, why] of [[{ ...mg, recipient: { ...mg.recipient, ie_indicator: '1' } }, 'contributor'], [{ ...mg, recipient: { ...mg.recipient, state: 'SP' } }, 'same state'], [{ ...mg, final_consumer: false }, 'not final consumer']])
    assert.equal(run(rules, over, { settings: { difal_default: 'goods' }, options }).items[0].icms.difal_dest_value, undefined, why);
  assert.equal(run([rule('icms', { situation: '00', rate: '18', difal_internal_rate: '18' })], mg, { settings: { difal_default: 'goods' }, options }).items[0].icms.difal_interstate_rate, undefined, '18% is not an interstate rate');
});

test('import notes: II and IPI first, ICMS on customs value + duty (+ IPI when "Somar IPI") grossed up by "Somar ICMS"; PIS on the customs value', () => {
  const rules = [rule('ii', { situation: 'T', rate: '10' }), rule('ipi', { situation: '00', rate: '10' }), rule('icms', { situation: '00', rate: '18' }), rule('pis', { situation: '01', rate: '2.1' })];
  const over = { direction: '0', issue_type: 'I', recipient: { name: 'Fornecedor exterior', person_type: 'E', state: 'EX' }, items: [{ description: 'Importado', quantity: '1', unit_price: '1000', ii: { customs_expense: '50' } }] };
  const added = run(rules, over, { settings: { ipi_in_icms_import: true } }, { others: { add_icms: true } }).items[0];
  assert.equal(added.ii.value, '100.00'); assert.equal(added.ipi.base, '1100.00'); assert.equal(added.ipi.value, '110.00');
  assert.equal(added.icms.base, '1475.61', '(1000 + 100 + 110) ÷ 0.82'); assert.equal(added.icms.value, '265.61'); assert.equal(added.pis.base, '1000.00');
  const plain = run(rules, over, {}, { others: { add_icms: true } }).items[0];
  assert.equal(plain.icms.base, '1341.46', 'without "Somar IPI"'); assert.equal(plain.icms.value, '241.46');
  const expenses = run(rules, over, {}, { others: { add_other_expenses: true } }).items[0];
  assert.equal(expenses.icms.base, '1150.00', 'customs expense added, no gross-up');
});

test('retained ST from the sale data and the texts of informações complementares follow their settings', () => {
  const sn = [rule('icms', { situation: '500', retained_rate: '18', retained_base_rate: '100' })];
  assert.deepEqual(run(sn, { crt: '1' }, { settings: { st_retained_from_sale: true } }).items[0].icms, { situation: '500', ret_base_rate: '100.0000', ret_base: '100.00', ret_rate: '18.0000', ret_value: '18.00' });
  assert.deepEqual(run(sn, { crt: '1' }).items[0].icms, { situation: '500' }, 'off: values stay as typed');
  const credit = [rule('icms', { situation: '101', credit_rate: '2' })];
  const items = one({ others: { purchase_order: 'OC-77' }, icms: { complementary_info: 'Texto do ICMS do item' }, ipi: { fiscal_info: 'Texto fiscal do IPI' } });
  const transport = { mode: 'none', freight_by: '9', tracking_code: 'BR123' };
  const quiet = run(credit, { crt: '1', items, transport });
  assert.equal(quiet.nature_additional_info, 'Texto do ICMS do item', 'credit message, tracking and order only when the preferences ask');
  assert.equal(quiet.nature_fiscal_info, 'Texto fiscal do IPI');
  const loud = run(credit, { crt: '1', items, transport }, { options: { simplesCreditMessage: true, trackingInInfo: true, purchaseOrderInInfo: true } });
  assert.match(loud.nature_additional_info, /^Texto do ICMS do item PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R\$ 2,00, CORRESPONDENTE À ALÍQUOTA DE 2%.* Código de rastreio: BR123 Ordem de compra: OC-77$/);
});
