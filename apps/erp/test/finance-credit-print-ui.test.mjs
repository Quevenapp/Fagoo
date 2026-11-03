import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { creditModels, creditNumber, creditRows, dateInWords } from '../src/lib/finance-print.ts';
import { storedPreferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';
import { readFinancePreferences } from '../src/lib/finance-preferences.ts';

// Synthetic data only. Preferências > Finanças applied to the prints: cabeçalho do recibo and the título de crédito
// (duplicata, nota promissória or both) of ⋮ Imprimir duplicata.
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payments = { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false };
const row = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 1, group_id: id(900), installment: 1, installments: 1, contact_id: id(800), contact_name: 'Alfa Sintética', category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null, issued_on: '2026-10-20', due_on: '2026-11-10', amount_cents: '123456', settled_cents: '0', balance_cents: '123456', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null,
  competence_on: '2026-10-20', account_id: null, account_name: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-11-10', deleted_at: null, remittance: null, imported: false, payments, ...extra });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const company = { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 2, data: { legal_name: 'FAGOO Sintética Ltda', trade_name: 'FAGOO', cnpj: '00.000.000/0001-91', street: 'Rua Sintética', number: '1', complement: null, district: 'Centro', city: 'Cidade Sintética', state: 'SP' } } };
const contact = { entity: 'contacts', data_mode: 'erp_native', record: { id: id(800), name: 'Alfa Sintética', document: '11.222.333/0001-81', street: 'Avenida Teste', number: '100', complement: 'Sala 2', district: 'Bairro Sintético', city: 'Outra Cidade', state: 'MG', postal_code: '30000-000' } };
function controllerFor({ failContact = 0 } = {}) {
  const calls = [];
  return { calls, controller: {
    async company() { return structuredClone(company); },
    async catalog(path) { calls.push(path); if (failContact-- > 0) throw new Error('offline'); return structuredClone(contact); },
    async finance(path) { throw new Error(`Unexpected ${path}`); },
  } };
}
const mount = (source, props) => mountComponent('FinancePrintPreview.tsx', { controller: source.controller, kind: 'receivable', onClose() {}, ...props }, { expandChildren: ['Company'] });

test('título de crédito models, nº and the date in words', () => {
  assert.deepEqual([creditModels('duplicata'), creditModels('nota_promissoria'), creditModels('ambos'), creditModels(undefined)], [['duplicata'], ['nota_promissoria'], ['duplicata', 'nota_promissoria'], ['duplicata']], 'the FAGOO default is Duplicata');
  assert.equal(creditNumber(row(1, { source_reference: 'NF 77', installments: 3, installment: 2 })), 'NF 77/2'); assert.equal(creditNumber(row(1)), '10000000');
  assert.deepEqual([dateInWords('2026-11-10'), dateInWords('2026-01-01'), dateInWords('2031-12-21')], ['dez de novembro de dois mil e vinte e seis', 'primeiro de janeiro de dois mil e vinte e seis', 'vinte e um de dezembro de dois mil e trinta e um']);
  assert.throws(() => dateInWords('10/11/2026'));
  assert.deepEqual(creditRows([row(1), row(2, { cancelled: true, status: 'cancelled' }), row(3, { kind: 'payable' })]).rows.map(item => item.id), [id(1)]);
});

test('⋮ Imprimir duplicata prints the duplicata and the nota promissória with the sacado of the contact register', async () => {
  const source = controllerFor({ failContact: 1 });
  const view = await mount(source, { print: { mode: 'credit', models: ['duplicata', 'nota_promissoria'], source: { kind: 'rows', rows: [row(1, { source_reference: 'NF 77' }), row(2, { cancelled: true, status: 'cancelled' })] } } });
  try {
    await settle(view);
    assert.match(view.text(), /Não foi possível ler o cadastro dos contatos/); assert.equal(buttons(view, 'Imprimir')[0].disabled, true, 'a título de crédito is not printed without the sacado');
    await view.click('Tentar novamente'); await settle(view);
    assert.equal(buttons(view, 'Imprimir')[0].disabled, false); assert.deepEqual(source.calls, [`/v1/cadastros/contacts/${id(800)}`, `/v1/cadastros/contacts/${id(800)}`]);
    const content = view.text();
    assert.match(content, /DUPLICATA/); assert.match(content, /FAGOO Sintética Ltda/); assert.match(content, /Fatura nº.*NF 77.*R\$ 1\.234,56/s); assert.match(content, /11\.222\.333\/0001-81/); assert.match(content, /Avenida Teste, 100, Sala 2 · Bairro Sintético/);
    assert.match(content, /Outra Cidade \/ MG · CEP 30000-000/); assert.match(content, /mil duzentos e trinta e quatro reais e cinquenta e seis centavos/); assert.match(content, /Reconheço\(emos\) a exatidão desta DUPLICATA/);
    assert.match(content, /NOTA PROMISSÓRIA/); assert.match(content, /Ao\(s\) dez de novembro de dois mil e vinte e seis pagarei\(emos\) por esta única via de NOTA PROMISSÓRIA a FAGOO Sintética Ltda, CNPJ 00\.000\.000\/0001-91/);
    assert.match(content, /Pagável em Cidade Sintética \/ SP/); assert.match(content, /1 conta ficou de fora: contas canceladas não têm duplicata nem nota promissória/); assert.doesNotMatch(content, /Conta 2/);
    assert.match(content, /Duplicata e Nota promissória das contas escolhidas/);
  } finally { view.unmount(); }
});

test('the recibo shows the company header only when the preference is on', async () => {
  const off = await mount(controllerFor(), { receiptHeader: false, print: { mode: 'receipts', source: { kind: 'rows', rows: [row(1)] } } });
  try { await settle(off); assert.match(off.text(), /RECIBO/); assert.doesNotMatch(off.text(), /CNPJ: 00\.000\.000\/0001-91/); assert.doesNotMatch(off.text(), /com a identificação atual da empresa/); } finally { off.unmount(); }
  const on = await mount(controllerFor(), { receiptHeader: true, print: { mode: 'receipts', source: { kind: 'rows', rows: [row(1)] } } });
  try { await settle(on); assert.match(on.text(), /CNPJ: 00\.000\.000\/0001-91/); } finally { on.unmount(); }
});

test('the finance preferences are read with the page schema; an unreadable page keeps the FAGOO defaults', async () => {
  const page = storedPreferencePage('financas-receber');
  const response = { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: page.scope, role: 'financeiro', can_manage: false, directory: null,
    items: storedFields(page).map(field => field.key === 'financas.receber_titulo_credito' ? { key: field.key, value: 'ambos', version: 1, updated_at: '2026-10-20T12:00:00Z' } : { key: field.key, value: structuredClone(field.default), version: 0, updated_at: null }) };
  const values = await readFinancePreferences({ preferences: async () => structuredClone(response) }, 'receivable');
  assert.deepEqual(creditModels(values['financas.receber_titulo_credito']), ['duplicata', 'nota_promissoria']); assert.equal(values['financas.receber_cabecalho_recibo'], false);
  await assert.rejects(() => readFinancePreferences({ preferences: async () => ({ ...response, page: 'financas-pagar' }) }, 'receivable'));
});
