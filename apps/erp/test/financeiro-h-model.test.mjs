import test from 'node:test';
import assert from 'node:assert/strict';
import { commonAccount, settleAccount } from '../src/lib/finance-settle.ts';
import { boletoMenu, sameRemittance, shareableCharge, whatsappMessage, BANK_OFF_REASON } from '../src/lib/finance-title-list.ts';
import { remittanceLimitText, remittanceCandidatesPath, remittanceCandidates } from '../src/lib/remittance-candidates-model.ts';
import { defaultMenu } from '../src/lib/payment-method-model.ts';
import { billingAddressText } from '../src/lib/contact-billing-model.ts';
import { commissionReportRoute, commissionReportPath, commissionReport } from '../src/lib/finance-commission-report.ts';
import { itemCommissions, readFrozenCommission, centsDecimal } from '../src/lib/document-commissions.ts';

// Leva H, lane financeiro: the models of the screens (synthetic data only).
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('CTT-161: the conta of the título first, then the company default; the grouped destino starts on the shared conta', () => {
  assert.equal(settleAccount(id(1), id(9)), id(1));
  assert.equal(settleAccount(null, id(9)), id(9));
  assert.equal(commonAccount([{ account_id: id(1) }, { account_id: id(1) }]), id(1));
  assert.equal(commonAccount([{ account_id: id(1) }, { account_id: id(2) }]), '');
  assert.equal(commonAccount([{ account_id: null }, { account_id: null }]), '');
});

test('FIN-044, FIN-052, FIN-176: share only a generated cobrança; the ⋮ follows the situação; bank operations stay off', () => {
  const open = { id: id(1), kind: 'receivable', cancelled: false, deleted_at: null, settled_cents: '0', balance_cents: '1000' };
  assert.equal(shareableCharge({ ...open, remittance: null }), false);
  assert.equal(shareableCharge({ ...open, remittance: { state: 'reserved', our_number: '1' } }), false);
  assert.equal(shareableCharge({ ...open, remittance: { state: 'ready', our_number: '12345678' } }), true);
  assert.equal(shareableCharge({ ...open, cancelled: true, remittance: { state: 'ready', our_number: '1' } }), false);
  assert.deepEqual(boletoMenu({ ...open, remittance: null }, true).map(i => i.label), ['Incluir em remessa']);
  assert.deepEqual(boletoMenu({ ...open, remittance: null }, false), []);
  assert.deepEqual(boletoMenu({ ...open, imported: true, remittance: null }, true), [], 'a conta imported from the Origin is billed there');
  const reserved = boletoMenu({ ...open, remittance: { id: id(7), state: 'reserved' } }, true);
  assert.deepEqual(reserved.map(i => [i.label, Boolean(i.disabled)]), [['Retomar remessa', false], ['Cancelar boleto', true], ['Retirar da remessa', true]]);
  assert.equal(reserved[1].title, BANK_OFF_REASON);
  assert.match(reserved[0].to, new RegExp(`remessa=${id(7)}`));
  assert.deepEqual(boletoMenu({ ...open, remittance: { id: id(7), state: 'reserved' } }, false), [], 'resuming is a write');
  assert.equal(boletoMenu({ ...open, remittance: { id: id(7), state: 'ready' } }, false)[0].label, 'Prévia do boleto (NÃO PAGAR)');
  assert.match(whatsappMessage({ contact_name: 'Cliente', description: 'Conta 1', balance_cents: '1000', due_on: '2026-11-10', remittance: { our_number: '123' } }), /nosso número 123/);
  const r = { id: id(7), sequence: 3, state: 'reserved' };
  assert.equal(sameRemittance([{ remittance: r }, { remittance: { ...r } }])?.id, id(7));
  assert.equal(sameRemittance([{ remittance: r }, { remittance: null }]), null);
  assert.equal(sameRemittance([]), null);
});

test('FIN-180, FIN-182: the candidates filters and the limit of 30 per remessa with additional lots', () => {
  assert.equal(remittanceCandidatesPath({ query: ' ana ', after: null, method: id(3), account: null, withoutAccount: false }), `/v1/financeiro/remessa-candidatos?limit=15&sem_conta=false&q=ana&forma=${id(3)}`);
  assert.match(remittanceLimitText(75, 10), /75 título\(s\).*até 30; 10 selecionado\(s\)\. Os demais ficam para 2 remessa\(s\) adicional\(is\)\./);
  assert.match(remittanceLimitText(0, 0), /Nenhum título/);
  const parsed = remittanceCandidates({ eligible_total: 1, remittance_limit: 30, payment_methods: [{ id: id(3), description: 'Pix', active: false, linked: true }],
    items: [{ id: id(1), payer_ready: true, account_id: null, account_name: null, payment_method_id: id(3), payment_method_name: 'Pix' }] });
  assert.equal(parsed.rows.get(id(1)).payment_method_name, 'Pix');
  assert.throws(() => remittanceCandidates({ eligible_total: 1, remittance_limit: 25, payment_methods: [], items: [] }));
});

test('CTT-130: the defaults offered follow the purpose and the state of the forma', () => {
  const both = { active: true, applicable: 'ambos', default_receipt: false, default_payment: false, default_return: true };
  assert.deepEqual(defaultMenu(both).map(i => i.label), ['Forma padrão de recebimentos', 'Forma padrão de pagamentos', 'Forma padrão de devoluções', 'Remover padrão de devoluções']);
  assert.deepEqual(defaultMenu({ ...both, applicable: 'pagamentos', default_return: false }).map(i => i.label), ['Forma padrão de pagamentos']);
  assert.ok(defaultMenu({ ...both, active: false }).slice(0, 3).every(i => i.disabled && i.title === 'Ative a forma antes.'));
});

test('CTT-050: the address the cobrança uses', () => {
  assert.equal(billingAddressText({ source: 'cobranca', postal_code: '13400-000', state: 'SP', city: 'Piracicaba', district: 'Centro', street: 'Rua A', number: '10', complement: 'sala 2', foreign_state: null }),
    'Rua A, 10 sala 2 - Centro - Piracicaba/SP - 13400-000');
  assert.equal(billingAddressText({ source: 'geral', postal_code: null, state: null, city: null, district: null, street: null, number: null, complement: null, foreign_state: null }), 'não informado');
});

test('VND-264: the report route and its answer', () => {
  const route = commissionReportRoute(new URLSearchParams('area=comissoes-relatorio&de=2026-10-01&ate=2026-10-21'), '2026-10-21');
  assert.equal(commissionReportPath(route), '/v1/financeiro/comissoes-relatorio?from=2026-10-01&to=2026-10-21&limit=100');
  assert.throws(() => commissionReportRoute(new URLSearchParams('de=2026-10-01&ate=2028-10-21'), '2026-10-21'), /até um ano/);
  assert.throws(() => commissionReportRoute(new URLSearchParams('situacao=x'), '2026-10-21'));
  const sums = { estimated_cents: '4500', adjusted_cents: '-2250', eligible_cents: '2250', paid_cents: '0' };
  const report = commissionReport({ entity: 'commission_report', from: '2026-10-01', to: '2026-10-21', total: 0, items: [], sellers: [{ seller_id: id(5), name: 'Vendedora', operations: 1, ...sums }], totals: sums }, route);
  assert.deepEqual([report.sellers[0].adjusted_cents, report.totals.eligible_cents], ['-2250', '2250']);
});

test('VND-117, PRF-124, VND-310: the estimate of the items and the frozen operation', () => {
  const totals = { items: [{ total: '600.00' }, { total: '400.00' }], gross: '1000.00', line_discount: '0.00', subtotal: '1000.00', discount: '100.00', freight: '50.00', other_expenses: '0.00', ipi: '20.00', icms_st: '10.00', total: '980.00' };
  const rule = additions => ({ seller_id: id(5), mode: 'fixa', rate: '5.0000', bands: [], additions });
  assert.deepEqual(itemCommissions([{}, {}], totals, rule(['desconto'])).map(r => r.value), ['27.00', '18.00'], 'net items after discount: 900 × 5% = 45');
  assert.deepEqual(itemCommissions([{}, {}], totals, rule(['desconto', 'frete', 'ipi', 'icms_st'])).map(r => r.value), ['29.40', '19.60'], '980 × 5% = 49');
  const frozen = readFrozenCommission({ document_id: id(1), operation: { document_id: id(1), rule: 'parcial', rate: '5.0000', base_cents: '90000', estimated_cents: '4500', adjusted_cents: '0', net_cents: '4500',
    received_cents: '0', total_cents: '98000', eligible_cents: '0', adjustments: [], policy: { version: 1, base: 'itens_liquidos', additions: ['desconto'] } }, items: [] }, id(1));
  assert.equal(frozen.operation.estimated_cents, '4500');
  assert.equal(centsDecimal('4500'), '45.00');
  assert.throws(() => readFrozenCommission({ document_id: id(2), operation: null, items: [] }, id(1)));
});
