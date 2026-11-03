import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';
import { titleNet, standardColumns } from '../src/lib/finance-title-list.ts';
import { settleInitial } from '../src/lib/finance-settle.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 175: Forma de pagamento na gaveta (juros, multa e conta da forma), Líquido e a tarifa sugerida na baixa.
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = id(500), CONTACT = id(800), CARD = id(700);
const title = (extra = {}) => ({ id: id(1), kind: 'receivable', version: 4, group_id: id(9000), installment: 1, installments: 1, contact_id: CONTACT, contact_name: 'Cliente sintético', category_id: null, category_name: null, description: 'Venda', source_reference: null, issued_on: '2026-01-01', due_on: '2026-02-01', amount_cents: '10000', settled_cents: '0', balance_cents: '10000', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null,
  competence_on: '2026-01-01', account_id: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-02-01', deleted_at: null, payment_method_id: CARD, payment_method_name: 'Cartão sintético', payment_fee_cents: '390', ...extra });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);

test('175 Líquido discounts the taxa of the forma until a tarifa is registered; the first recebimento suggests it as tarifa', () => {
  assert.deepEqual(standardColumns('receivable', 'open'), ['history', 'payment_method', 'due']);
  assert.equal(titleNet({ amount_cents: '10000', payments: { fee_cents: '0' }, payment_fee_cents: '390' }), '9610');
  assert.equal(titleNet({ amount_cents: '10000', payments: { fee_cents: '250' }, payment_fee_cents: '390' }), '9750', 'a tarifa registered wins');
  assert.equal(titleNet({ amount_cents: '10000', payments: { fee_cents: '0' } }), '10000');
  const state = settleInitial('receivable', [title()], '2026-01-10');
  assert.deepEqual([state.rows[0].fee, state.rows[0].value], ['3,90', '96,10']);
  assert.equal(settleInitial('receivable', [title()], '2026-01-10', true).rows[0].fee, '0,00', 'a baixa parcial starts without tarifa');
  assert.equal(settleInitial('payable', [title({ kind: 'payable' })], '2026-01-10').rows[0].fee, '0,00');
});

test('175 the gaveta offers the formas of the kind and brings their juros, multa and conta financeira', async () => {
  const calls = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(2), role: 'financeiro' } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts'], write: ['contacts'] }; throw new Error(path); },
    async finance(path, options = {}) {
      calls.push({ path, ...options, body: options.body ? structuredClone(options.body) : undefined });
      const url = new URL(path, 'https://synthetic.invalid');
      if (options.method === 'POST') return { entity: 'titles', data_mode: 'erp_native', action: 'title_create', replayed: false, group_id: id(70), items: [title()] };
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: ACCOUNT, name: 'Banco sintético', kind: 'bank', active: true }] };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      if (url.pathname === '/v1/financeiro/formas-pagamento') return { entity: 'payment_methods', kind: url.searchParams.get('kind'), items: [{ id: CARD, description: 'Cartão sintético', payment_type: '03', account_id: ACCOUNT, interest_rate: '1.2350', fine_rate: '2.0000', fee_type: 'aliquota', fee_rate: '3.5000', fee_fixed: null, is_default: false }], data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    } };
  const view = await mountComponent('FinanceTitleDrawer.tsx', { controller, kind: 'receivable', mode: 'create', title: null, onClose() {}, onSaved() {} }, { expandChildren: ['DrawerField', 'CategoryTreePicker', 'TreeList'] });
  try {
    assert.equal(calls.find(call => call.path.startsWith('/v1/financeiro/formas-pagamento')).path, '/v1/financeiro/formas-pagamento?kind=receivable');
    await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/formas-pagamento?kind=receivable'));
    view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'CatalogPicker').props.onSelect({ id: CONTACT, name: 'Cliente sintético' }); await view.flush();
    await view.click('Pagamento');
    assert.deepEqual(view.nodes().filter(node => node.type === 'option' && node.props.value === CARD).map(text), ['Cartão sintético']);
    await view.change(field(view, 'Forma de Pagamento').props.id, CARD);
    assert.deepEqual([field(view, 'Juros mensal (%)').props.value, field(view, 'Multa (%)').props.value, field(view, 'Conta Financeira').props.value], ['1,24', '2,00', ACCOUNT]);
    await view.click('Cabeçalho');
    await view.change(field(view, 'Valor (R$) *').props.id, '100,00'); await view.change(field(view, 'Vencimento *').props.id, '2099-02-01'); await view.change(field(view, 'Histórico').props.id, 'Venda no cartão');
    await view.submit(); for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    const post = calls.find(call => call.method === 'POST');
    assert.deepEqual([post.body.data.payment_method_id, post.body.data.interest_month_bp, post.body.data.penalty_bp, post.body.data.account_id], [CARD, 124, 200, ACCOUNT]);
    await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/title_create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post.body) }));
  } finally { view.unmount(); }
});

test('175 baixa: a conta without conta financeira starts from the default account and the forma suggests the tarifa (CTT-139, CTT-161)', async () => {
  const BANK = id(501), CASH = id(502), calls = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(2), role: 'financeiro' } }),
    async finance(path, options = {}) {
      calls.push({ path, ...options, body: options.body ? structuredClone(options.body) : undefined });
      const url = new URL(path, 'https://synthetic.invalid');
      if (options.method === 'POST') return { entity: 'borderos', action: 'settle_batch', replayed: false, items: [{}], borderos: [{}] };
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: BANK, name: 'Banco sintético', kind: 'bank', active: true }, { id: CASH, name: 'Caixa sintético', kind: 'cash', active: true }] };
      if (url.pathname === '/v1/financeiro/contas-financeiras') return { entity: 'financial_accounts', page: 1, limit: 100, total: 2, data_mode: 'erp_native', items: [{ id: BANK, default_movements: false, active: true }, { id: CASH, default_movements: true, active: true }] };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      throw new Error(`Unexpected ${path}`);
    } };
  const view = await mountComponent('FinanceSettleDrawer.tsx', { controller, kind: 'receivable', titles: [title({ version: 2 })], onClose() {}, onSaved() {} }, { expandChildren: ['SettleField', 'CategoryTreePicker', 'TreeList'] });
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.deepEqual([field(view, 'Conta financeira').props.value, field(view, 'Tarifa').props.value, field(view, 'Valor recebido').props.value], [CASH, '3,90', '96,10']);
    assert.equal(view.guard().changed, false, 'the default does not mark the baixa as changed');
    await view.submit();
    const item = calls.find(call => call.method === 'POST').body.data.items[0];
    assert.deepEqual([item.account_id, item.fee_cents, item.principal_cents], [CASH, '390', '10000']);
  } finally { view.unmount(); }
});
