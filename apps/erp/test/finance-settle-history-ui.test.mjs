import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { settleBatchData, settleInitial, SETTLE_NOTE_LIMIT } from '../src/lib/finance-settle.ts';

// Synthetic data only. 249: the Histórico of the "Baixa de lançamentos" takes 2,000 characters and starts with the whole
// histórico of the conta, read from the conta when it passes the 240 characters the listagem carries.
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BANK = id(500);
const TODAY = todaySP(), past = days => new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const LONG = `Conta 1 ${'com histórico longo '.repeat(70)}fim`.trim();
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 2, group_id: id(9000), installment: 1, installments: 1, contact_id: id(800), contact_name: `Cliente ${n}`, category_id: null, category_name: null, description: `Conta ${n}`, source_reference: `NF ${n}`, issued_on: past(90), due_on: past(30), amount_cents: '10000', settled_cents: '0', balance_cents: '10000', cancelled: false, status: 'open', overdue: true, document_linked: false, origin: null,
  competence_on: past(90), account_id: BANK, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: past(30), deleted_at: null, ...extra });
const detail = record => ({ entity: 'titles', data_mode: 'erp_native', record, account: { id: BANK, name: 'Banco sintético', active: true }, billing: null, original: null, origin: null, imported: false, settled_before: false, history: LONG });
const page = (entity, items) => ({ entity, data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items });
function server({ hold = false } = {}) {
  const calls = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(1), role: 'financeiro' } }),
    async finance(path, options = {}) {
      calls.push({ path, ...options, body: options.body ? structuredClone(options.body) : undefined });
      if (options.method === 'POST') return { entity: 'borderos', action: 'settle_batch', replayed: false, items: [{}], borderos: [{}] };
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === `/v1/financeiro/titles/${id(1)}/detalhe`) { if (hold) await held; return detail(title(1, { long_history: true })); }
      if (url.pathname === '/v1/financeiro/accounts') return page('accounts', [{ id: BANK, name: 'Banco sintético', kind: 'bank', active: true }]);
      if (url.pathname === '/v1/financeiro/categorias-arvore') return { entity: 'category_tree', kind: url.searchParams.get('kind'), items: [], data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, release: () => release(), posts: () => calls.filter(call => call.method === 'POST'), details: () => calls.filter(call => call.path.endsWith('/detalhe')) };
}
const mount = (source, titles) => mountComponent('FinanceSettleDrawer.tsx', { controller: source.controller, kind: 'receivable', titles, onClose: () => {}, onSaved: () => {} }, { expandChildren: ['SettleField', 'CategoryTreePicker', 'TreeList'] });
const note = view => view.find(node => node.props.id === 'finance-settle-note');

test('249 the Histórico takes 2,000 characters and the model refuses more', () => {
  assert.equal(SETTLE_NOTE_LIMIT, 2000);
  const state = settleInitial('receivable', [title(1)], TODAY);
  assert.equal(settleBatchData('receivable', { ...state, note: 'h'.repeat(2000), rows: state.rows.map(row => ({ ...row, account_id: BANK })) }, [title(1)], TODAY).note, 'h'.repeat(2000));
  assert.throws(() => settleBatchData('receivable', { ...state, note: 'h'.repeat(2001) }, [title(1)], TODAY), /O histórico aceita até 2\.000 caracteres\./);
});

test('249 a conta with a long histórico starts the baixa with the whole text, not as an unsaved change', async () => {
  const source = server(), view = await mount(source, [title(1, { long_history: true })]);
  try {
    await view.flush();
    assert.equal(source.details().length, 1, 'the whole histórico is read from the conta');
    assert.equal(note(view).props.value, LONG); assert.equal(note(view).props.maxLength, 2000);
    assert.match(view.text(), new RegExp(`${LONG.length} de 2\\.000 caracteres`));
    assert.equal(view.guard().changed, false, 'the prefill is not a change of the user');
    await view.submit();
    assert.equal(source.posts().length, 1); assert.equal(source.posts()[0].body.data.note, LONG);
  } finally { view.unmount(); }
});

test('249 the Histórico typed while the conta is read is kept; short ones and several contas read nothing', async () => {
  const source = server({ hold: true }), view = await mount(source, [title(1, { long_history: true })]);
  try {
    await view.change('finance-settle-note', 'Histórico do usuário');
    source.release(); await view.flush();
    assert.equal(note(view).props.value, 'Histórico do usuário'); assert.equal(view.guard().changed, true);
  } finally { view.unmount(); }
  const plain = server(), short = await mount(plain, [title(1)]);
  try { await short.flush(); assert.equal(plain.details().length, 0); assert.equal(note(short).props.value, 'Conta 1'); assert.match(short.text(), /7 de 2\.000 caracteres/); } finally { short.unmount(); }
  const many = server(), several = await mount(many, [title(1, { long_history: true }), title(2)]);
  try { await several.flush(); assert.equal(many.details().length, 0); assert.equal(note(several).props.value, ''); } finally { several.unmount(); }
});
