import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { contactNotes, listingGroups, moneyInWords, numberInWords, paidValue, receiptGroups, receiptRows } from '../src/lib/finance-print.ts';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { defaultTitlePeriod, emptyFinanceRoute } from '../src/lib/finance-list-route.ts';

// Synthetic data only. Recibo, comprovante de pagamento and listagem simples/agrupada of contas.
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TODAY = todaySP(), PERIOD = defaultTitlePeriod(TODAY);
const payments = (extra = {}) => ({ settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false, ...extra });
const row = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 1, group_id: id(900), installment: 1, installments: 1, contact_id: id(800 + (n % 2)), contact_name: n % 2 ? 'Beta Sintética' : 'Alfa Sintética', category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null, issued_on: PERIOD.from, due_on: TODAY, amount_cents: '12345', settled_cents: '0', balance_cents: '12345', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null,
  competence_on: PERIOD.from, account_id: null, account_name: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: TODAY, deleted_at: null, remittance: null, imported: false, payments: payments(), ...extra });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
const company = { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 2, data: { legal_name: 'FAGOO Sintética Ltda', trade_name: 'FAGOO', cnpj: '00.000.000/0001-91', street: 'Rua Sintética', number: '1', complement: null, district: 'Centro', city: 'Cidade Sintética', state: 'SP' } } };

test('valor por extenso in Portuguese, without floating point', () => {
  assert.deepEqual(['1', '100', '101', '12345', '100000', '120000', '123456', '100000000', '150000000', '2000000000', '0'].map(moneyInWords), ['um centavo', 'um real', 'um real e um centavo', 'cento e vinte e três reais e quarenta e cinco centavos', 'mil reais', 'mil e duzentos reais',
    'mil duzentos e trinta e quatro reais e cinquenta e seis centavos', 'um milhão de reais', 'um milhão e quinhentos mil reais', 'vinte milhões de reais', 'zero real']);
  assert.equal(numberInWords(999_999_999_999_999n).startsWith('novecentos e noventa e nove trilhões'), true);
  for (const bad of ['-1', '1.5', '1000000000000000', '']) assert.throws(() => moneyInWords(bad));
});

test('recibos group the selected contas by contato; paid contas print what was paid', () => {
  const paid = row(1, { settled_cents: '12345', balance_cents: '0', status: 'paid', payments: payments({ settled_on: '2026-10-10', interest_cents: '100', penalty_cents: '200', discount_cents: '45' }) });
  assert.equal(paidValue(paid), '12600'); assert.equal(paidValue(row(2)), '12345', 'an open conta prints its valor');
  const groups = receiptGroups([paid, row(2), row(3), row(4)]);
  assert.deepEqual(groups.map(group => [group.contact_name, group.lines.length, group.total_cents, group.settled_on]), [['Beta Sintética', 2, '24945', '2026-10-10'], ['Alfa Sintética', 2, '24690', null]]);
  const listing = listingGroups([row(2), row(1), row(3, { cancelled: true, status: 'cancelled' })], true);
  assert.deepEqual(listing.groups.map(group => [group.name, group.rows.length, group.amount_cents, group.balance_cents]), [['Alfa Sintética', 1, '12345', '12345'], ['Beta Sintética', 2, '24690', '12345']]);
  assert.deepEqual([listing.count, listing.amount_cents, listing.balance_cents], [3, '37035', '24690']);
});

function controllerFor({ pages = [[row(1), row(2)]], total = 2, failCompany = false } = {}) {
  const calls = [];
  return { calls, controller: {
    async company(path) { calls.push(path); if (failCompany) throw new Error('offline'); return structuredClone(company); },
    async finance(path) {
      calls.push(path); const url = new URL(path, 'https://synthetic.invalid'), number = Number(url.searchParams.get('page')), items = pages[number - 1] ?? [];
      return { entity: 'titles', data_mode: 'erp_native', kind: 'receivable', option: url.searchParams.get('option'), page: number, limit: 100, order: 'due_asc', total, totals: { count: total, amount_cents: '0', balance_cents: '0', fee_cents: '0' }, items: structuredClone(items) };
    },
  } };
}
const mount = (source, props) => mountComponent('FinancePrintPreview.tsx', { controller: source.controller, kind: 'receivable', onClose() {}, ...props }, {});

test('recibo preview shows the company, the contato, the value in words and the lines; Imprimir waits for the company', async () => {
  const source = controllerFor({ failCompany: true }), view = await mount(source, { print: { mode: 'receipts', source: { kind: 'rows', rows: [row(2)] } } });
  try {
    assert.equal(buttons(view, 'Imprimir')[0].disabled, true); assert.match(view.text(), /Não foi possível conferir a identificação da empresa/);
  } finally { view.unmount(); }
  const ok = controllerFor(), receipt = await mount(ok, { print: { mode: 'receipts', source: { kind: 'rows', rows: [row(2), row(4)] } } });
  try {
    assert.equal(buttons(receipt, 'Imprimir')[0].disabled, false);
    assert.match(receipt.text(), /RECIBO/); assert.match(receipt.text(), /FAGOO Sintética Ltda/);
    assert.match(receipt.text(), /Recebemos de Alfa Sintética a importância de R\$ 246,90 \(duzentos e quarenta e seis reais e noventa centavos\), referente a:/);
    assert.match(receipt.text(), /Conta 2.*Conta 4/s); assert.ok(ok.calls.every(path => !path.includes('/financeiro/')), 'rows already shown are not read again');
  } finally { receipt.unmount(); }
  const proof = await mount(controllerFor(), { kind: 'payable', print: { mode: 'receipts', source: { kind: 'rows', rows: [row(5, { kind: 'payable', settled_cents: '12345', balance_cents: '0', status: 'paid', payments: payments({ settled_on: '2026-10-12' }) })] } } });
  try { assert.match(proof.text(), /COMPROVANTE DE PAGAMENTO/); assert.match(proof.text(), /Pagamos a Beta Sintética/); assert.match(proof.text(), /Data do pagamento: 12\/10\/2026/); } finally { proof.unmount(); }
});

test('listagem of the filter reads every page before printing; a too large filter asks to narrow it', async () => {
  const many = Array.from({ length: 100 }, (_, index) => row(index + 10)), source = controllerFor({ pages: [many, [row(200)]], total: 101 });
  const view = await mount(source, { print: { mode: 'listing', grouped: true, source: { kind: 'route', route: emptyFinanceRoute('receivable') } } });
  try {
    const reads = source.calls.filter(path => path.startsWith('/v1/financeiro/titles?'));
    assert.deepEqual(reads.map(path => new URL(path, 'https://x.invalid').searchParams.get('page')), ['1', '2']);
    assert.match(view.text(), /Contas a receber agrupadas por cliente/); assert.match(view.text(), /101 contas/); assert.match(view.text(), /Cliente: Alfa Sintética/); assert.match(view.text(), /Subtotal/);
    assert.match(view.text(), /Total: R\$ 12\.468,45/);
  } finally { view.unmount(); }
  const huge = await mount(controllerFor({ pages: [Array.from({ length: 100 }, (_, index) => row(index + 10))], total: 5001 }), { print: { mode: 'listing', source: { kind: 'route', route: emptyFinanceRoute('receivable') } } });
  try { assert.match(huge.text(), /A listagem tem 5\.001 contas/); assert.equal(buttons(huge, 'Imprimir')[0].disabled, true); } finally { huge.unmount(); }
});

test('a recibo never covers a cancelled conta, and a comprovante only a paid conta a pagar; the preview says what was left out', async () => {
  const cancelled = row(6, { cancelled: true, status: 'cancelled' }), deleted = row(8, { cancelled: true, status: 'cancelled', deleted_at: '2026-10-20T10:00:00Z' });
  assert.deepEqual(receiptRows('receivable', [row(2), cancelled, deleted]).rows.map(item => item.id), [id(2)]);
  const unpaid = row(7, { kind: 'payable' }), paid = row(9, { kind: 'payable', settled_cents: '12345', balance_cents: '0', status: 'paid', payments: payments({ settled_on: '2026-10-12' }) });
  assert.deepEqual(receiptRows('payable', [unpaid, paid]), { rows: [paid], skipped: 1 });
  const view = await mount(controllerFor(), { print: { mode: 'receipts', source: { kind: 'rows', rows: [row(2), cancelled] } } });
  try {
    assert.match(view.text(), /1 conta ficou de fora: contas canceladas não recebem recibo/); assert.doesNotMatch(view.text(), /Conta 6/);
    assert.match(view.text(), /a importância de R\$ 123,45/);
  } finally { view.unmount(); }
  const none = await mount(controllerFor(), { kind: 'payable', print: { mode: 'receipts', source: { kind: 'rows', rows: [unpaid] } } });
  try {
    assert.match(none.text(), /Nenhuma conta para imprimir/); assert.match(none.text(), /o comprovante é só de contas pagas/); assert.equal(buttons(none, 'Imprimir')[0].disabled, true);
    assert.doesNotMatch(none.text(), /Pagamos a/);
  } finally { none.unmount(); }
});

test('FIN-015 Imprimir observação do contato: the listagem reads the Observações of each contato and prints them under the contato or the conta', async () => {
  const notes = { [id(800)]: 'Ligar antes de cobrar.', [id(801)]: null }, reads = [];
  const source = controllerFor();
  source.controller.catalog = async path => { reads.push(path); const contact = path.split('/').at(-1); return { entity: 'contacts', record: { id: contact, name: 'x', notes: notes[contact] }, data_mode: 'erp_native' }; };
  const grouped = await mount(source, { print: { mode: 'listing', grouped: true, notes: true, source: { kind: 'route', route: emptyFinanceRoute('receivable') } } });
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await grouped.flush(); }
    assert.deepEqual(reads.sort(), [`/v1/cadastros/contacts/${id(800)}`, `/v1/cadastros/contacts/${id(801)}`].sort(), 'one read per contato');
    assert.match(grouped.text(), /Cliente: Alfa SintéticaObservações: Ligar antes de cobrar\./); assert.doesNotMatch(grouped.text(), /Beta SintéticaObservações/);
    assert.equal(buttons(grouped, 'Imprimir')[0].disabled, false);
  } finally { grouped.unmount(); }
  const failing = controllerFor(); failing.controller.catalog = async () => { throw new Error('offline'); };
  const view = await mount(failing, { print: { mode: 'listing', notes: true, source: { kind: 'route', route: emptyFinanceRoute('receivable') } } });
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.match(view.text(), /Não foi possível ler as observações dos contatos/); assert.equal(buttons(view, 'Imprimir')[0].disabled, true, 'nothing is printed without the observações asked for');
  } finally { view.unmount(); }
  assert.throws(() => contactNotes({ entity: 'contacts', record: { id: id(1), notes: 'x'.repeat(4001) } }, id(1))); assert.equal(contactNotes({ entity: 'contacts', record: { id: id(1), notes: ' a ' } }, id(1)), 'a');
});
