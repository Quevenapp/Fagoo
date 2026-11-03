import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse, chooseCategory } from './helpers/finance-category-tree-fixture.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { rowAmounts, settleBatchData, settleInitial, suggestedValue, refreshRows } from '../src/lib/finance-settle.ts';

// Synthetic data only. 110 "Baixa de lançamentos": one or several contas, grouped or not, one settle_batch command.
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BANK = id(500), CASH = id(501), CATEGORY = id(600);
const TODAY = todaySP(), past = days => new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 2, group_id: id(9000), installment: 1, installments: 1, contact_id: id(800), contact_name: `Cliente ${n}`, category_id: null, category_name: null, description: `Conta ${n}`, source_reference: `NF ${n}`, issued_on: past(90), due_on: past(30), amount_cents: '10000', settled_cents: '0', balance_cents: '10000', cancelled: false, status: 'open', overdue: true, document_linked: false, origin: null,
  competence_on: past(90), account_id: BANK, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: past(30), deleted_at: null, ...extra });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const fields = (view, label) => view.nodes().filter(node => node.type === 'label' && text(node) === label).map(label => view.input(label.props.htmlFor));
const field = (view, label, index = 0) => fields(view, label)[index];
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
const switchOf = (view, label) => view.find(node => node.type === 'label' && text(node) === label).props.children.find(child => child?.type === 'input');
const page = (entity, items) => ({ entity, data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items });
function server({ post, role = 'financeiro' } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: id(1), role } } };
  const controller = {
    getSnapshot: () => state.session,
    async finance(path, options = {}) {
      calls.push({ path, ...options, body: options.body ? structuredClone(options.body) : undefined });
      if (options.method === 'POST') return post(calls.at(-1), calls.filter(call => call.method === 'POST').length);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return page('accounts', [{ id: BANK, name: 'Banco sintético', kind: 'bank', active: true }, { id: CASH, name: 'Caixa sintético', kind: 'cash', active: true }]);
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), [{ id: CATEGORY, name: 'Serviços', kind: 'receivable' }, { id: CATEGORY, name: 'Serviços', kind: 'payable' }]);
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), setRole(next) { state.session = { phase: 'ready', membership: { user_id: id(1), role: next } }; } };
}
const mount = (source, props) => {
  const events = { saved: [], closed: 0 };
  return mountComponent('FinanceSettleDrawer.tsx', { controller: source.controller, kind: 'receivable', titles: [title(1)], onClose: () => { events.closed++; }, onSaved: value => events.saved.push(value), ...props }, { expandChildren: ['SettleField', 'CategoryTreePicker', 'TreeList'] }).then(view => Object.assign(view, { events }));
};

test('110 a single conta: juros and multa from its percentuais, Valor recebido as the cash, Baixar Pagamento with recovery', async () => {
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return { entity: 'borderos', action: 'settle_batch', replayed: true, items: [{}], borderos: [{}] }; } });
  const view = await mount(source, { titles: [title(1, { interest_month_bp: 300, penalty_bp: 200 })] });
  try {
    assert.equal(switchOf(view, 'Lançamento agrupado').props.disabled, true); assert.equal(switchOf(view, 'Categoria única para todos registros').props.disabled, true);
    assert.equal(field(view, 'Destino').props.disabled, true, 'Destino only with Lançamento agrupado');
    assert.equal(field(view, 'Data do recebimento').props.value, TODAY); assert.equal(field(view, 'Taxas de Marketplace').disabled, true);
    // 3% a.m. × 30/30 × 100,00 = 3,00 de juros; multa 2% = 2,00; valor recebido sugerido = 105,00.
    assert.deepEqual([field(view, 'Juros').props.value, field(view, 'Multa').props.value, field(view, 'Valor recebido').props.value], ['3,00', '2,00', '105,00']);
    assert.equal(field(view, 'Valor total').props.value, 'R$ 105,00'); assert.equal(view.find(node => node.props.id === 'finance-settle-note').props.value, 'Conta 1', 'the histórico comes from the conta');
    assert.match(view.text(), /Cliente: Cliente 1 · Nº do documento: NF 1/); assert.match(view.text(), /Baixa total/);
    await view.change(field(view, 'Tarifa').props.id, '1,50');
    assert.equal(field(view, 'Valor recebido').props.value, '103,50', 'the tarifa leaves the valor recebido');
    await chooseCategory(view, field(view, 'Categoria').props.id, 'Serviços');
    await view.submit(); assert.equal(source.posts().length, 1); assert.equal(buttons(view, 'Conferir resultado').length, 1); assert.equal(view.guard().busy, true);
    await view.submit();
    const [first, second] = source.posts(); assert.equal(first.path, '/v1/financeiro/actions/settle_batch'); assert.deepEqual(second.body, first.body);
    assert.deepEqual(first.body.data, { kind: 'receivable', grouped: false, note: 'Conta 1', items: [{ id: id(1), expected_version: 2, account_id: BANK, category_id: CATEGORY, posted_on: TODAY, principal_cents: '10000', interest_cents: '300', penalty_cents: '200', discount_cents: '0', fee_cents: '150' }] });
    assert.deepEqual(view.events.saved, [{ items: 1, borderos: 1 }]);
  } finally { view.unmount(); }
});

test('110 baixa parcial starts without a value; validation refuses excess, missing conta and future dates without sending', async () => {
  const source = server({ post: () => ({ entity: 'borderos', action: 'settle_batch', replayed: false, items: [{}], borderos: [{}] }) });
  const view = await mount(source, { titles: [title(2, { account_id: null })], partial: true });
  try {
    assert.equal(field(view, 'Valor recebido').props.value, ''); await view.submit(); assert.match(view.text(), /Informe o valor recebido de Cliente 2/);
    await view.change(field(view, 'Valor recebido').props.id, '100,01'); await view.submit(); assert.match(view.text(), /supera o saldo/);
    await view.change(field(view, 'Valor recebido').props.id, '40,00'); assert.match(view.text(), /Baixa parcial · saldo após a baixa R\$ 60,00/);
    await view.submit(); assert.match(view.text(), /Selecione a conta financeira de Cliente 2/);
    await view.change(field(view, 'Conta financeira').props.id, CASH);
    await view.change(field(view, 'Data do recebimento').props.id, '2099-01-01'); await view.submit(); assert.match(view.text(), /não pode ser futura/);
    assert.equal(source.posts().length, 0);
    await view.change(field(view, 'Data do recebimento').props.id, TODAY); await view.submit();
    assert.deepEqual(source.posts()[0].body.data.items[0], { id: id(2), expected_version: 2, account_id: CASH, category_id: null, posted_on: TODAY, principal_cents: '4000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' });
  } finally { view.unmount(); }
});

test('110 selected contas a pagar: Lançamento agrupado needs a destino and one date; Utilizar data de vencimento settles each on its vencimento', async () => {
  const payable = [title(3, { kind: 'payable', due_on: past(10) }), title(4, { kind: 'payable', due_on: past(5), balance_cents: '5000', amount_cents: '5000' })];
  const source = server({ post: () => ({ entity: 'borderos', action: 'settle_batch', replayed: false, items: [{}, {}], borderos: [{}] }) });
  const view = await mount(source, { kind: 'payable', titles: payable });
  try {
    assert.ok(field(view, 'Data do pagamento')); assert.equal(fields(view, 'Valor pago').length, 2); assert.equal(fields(view, 'Taxas de Marketplace').length, 0);
    assert.equal(field(view, 'Valor total').props.value, 'R$ 150,00');
    switchOf(view, 'Lançamento agrupado').props.onChange({ target: { checked: true } }); await view.flush();
    assert.equal(field(view, 'Destino').props.disabled, false); assert.ok(fields(view, 'Conta financeira').every(node => node.props.disabled), 'each line follows the destino');
    // Leva H (CTT-161): the contas share their conta financeira, so the destino starts on it; cleared, it is required.
    assert.equal(field(view, 'Destino').props.value, BANK);
    await view.change(field(view, 'Destino').props.id, '');
    await view.submit(); assert.match(view.text(), /Selecione o destino/);
    await view.change(field(view, 'Destino').props.id, BANK);
    switchOf(view, 'Utilizar data de vencimento').props.onChange({ target: { checked: true } }); await view.flush();
    await view.submit(); assert.match(view.text(), /mesma data/); assert.equal(source.posts().length, 0);
    switchOf(view, 'Categoria única para todos registros').props.onChange({ target: { checked: true } }); await view.flush();
    await view.submit(); assert.match(view.text(), /Selecione a categoria única/);
    switchOf(view, 'Categoria única para todos registros').props.onChange({ target: { checked: false } }); await view.flush();
    switchOf(view, 'Lançamento agrupado').props.onChange({ target: { checked: false } }); await view.flush();
    await view.submit();
    assert.deepEqual(source.posts()[0].body.data, { kind: 'payable', grouped: false, note: null, items: [
      { id: id(3), expected_version: 2, account_id: BANK, category_id: null, posted_on: past(10), principal_cents: '10000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' },
      { id: id(4), expected_version: 2, account_id: BANK, category_id: null, posted_on: past(5), principal_cents: '5000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }] });
  } finally { view.unmount(); }
  const groupedSource = server({ post: () => ({ entity: 'borderos', action: 'settle_batch', replayed: false, items: [{}, {}], borderos: [{}] }) }), grouped = await mount(groupedSource, { kind: 'payable', titles: payable });
  try {
    switchOf(grouped, 'Lançamento agrupado').props.onChange({ target: { checked: true } }); switchOf(grouped, 'Categoria única para todos registros').props.onChange({ target: { checked: true } }); await grouped.flush();
    await grouped.change(grouped.find(node => node.props.id === 'finance-settle-note').props.id, 'Pagamento agrupado');
    await grouped.change(field(grouped, 'Destino').props.id, CASH); await chooseCategory(grouped, field(grouped, 'Categoria').props.id, 'Serviços'); await grouped.submit();
    const data = groupedSource.posts()[0].body.data;
    assert.deepEqual([data.grouped, data.account_id, data.category_id, data.note], [true, CASH, CATEGORY, 'Pagamento agrupado']);
    assert.deepEqual(data.items.map(item => [item.account_id, item.category_id, item.posted_on]), [[CASH, CATEGORY, TODAY], [CASH, CATEGORY, TODAY]]);
    assert.deepEqual(grouped.events.saved, [{ items: 2, borderos: 1 }]);
  } finally { grouped.unmount(); }
});

test('110 nothing is sent after a role change; a known 409 is not uncertain', async () => {
  const source = server({ post: () => { throw new AccessError(409); } }), view = await mount(source);
  try {
    source.setRole('consulta'); await view.submit(); assert.equal(source.posts().length, 0); assert.match(view.text(), /A baixa não foi enviada/);
    source.setRole('financeiro'); await view.submit(); assert.equal(source.posts().length, 1); assert.match(view.text(), /Uma das contas mudou/);
    assert.equal(buttons(view, 'Conferir resultado').length, 0); assert.equal(buttons(view, 'Baixar Pagamento').length, 1);
    await view.click('Cancelar'); assert.equal(view.events.closed, 1);
  } finally { view.unmount(); }
});

test('110 settle model: principal, suggested value and the grouped body in exact cents', () => {
  const receivable = title(5, { interest_month_bp: 100 }), row = settleInitial('receivable', [receivable], TODAY).rows[0];
  assert.equal(row.interest, '1,00'); assert.equal(row.value, '101,00');
  assert.deepEqual(rowAmounts('receivable', receivable, { ...row, fee: '2,00', value: '99,00' }), { principal_cents: '10000', interest_cents: '100', penalty_cents: '0', discount_cents: '0', fee_cents: '200', remaining_cents: '0' });
  assert.deepEqual(rowAmounts('payable', { ...receivable, kind: 'payable' }, { ...row, fee: '2,00', value: '103,00' }).principal_cents, '10000', 'paying, the tarifa adds to the valor pago');
  assert.equal(suggestedValue('payable', receivable, { interest: '0', penalty: '0', discount: '10,00', fee: '1,00' }), '91,00');
  assert.throws(() => rowAmounts('receivable', receivable, { ...row, value: '1,00', interest: '5,00' }), /superam/);
  const titles = [title(6), title(7)], state = { ...settleInitial('receivable', titles, TODAY), grouped: true, destination: BANK, singleCategory: true, category: CATEGORY, note: ' Lote ' };
  const body = settleBatchData('receivable', state, titles, TODAY);
  assert.deepEqual([body.grouped, body.account_id, body.category_id, body.note, body.items.map(item => [item.account_id, item.category_id, item.posted_on])], [true, BANK, CATEGORY, 'Lote', [[BANK, CATEGORY, TODAY], [BANK, CATEGORY, TODAY]]]);
  const moved = refreshRows('receivable', { ...settleInitial('receivable', [title(8, { interest_month_bp: 300 })], TODAY), postedOn: past(15) }, [title(8, { interest_month_bp: 300 })]);
  assert.equal(moved.rows[0].interest, '1,50', 'juros follow the date of the baixa');
  assert.throws(() => settleBatchData('receivable', { ...state, grouped: true, rows: state.rows.slice(0, 1) }, titles, TODAY), /duas ou mais/);
});
