import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { rowActions, SCREENS, financeIndicator } from '../src/lib/fiscal-invoice-list-model.ts';
import { boletoTitleIds, invoiceFlags, invoicePreviewPath, reverseBlocked } from '../src/lib/fiscal-invoice-finance.ts';
import { originNumber, originPath, originText } from '../src/lib/finance-title-list.ts';
import { originBadge, LEDGER_ORIGIN } from '../src/lib/finance-statement-model.ts';
import { groupedDefaultChoice, groupedItemLabel, groupedToggle } from '../src/lib/finance-grouped-billing-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 247: ⋮ Lançar contas / Estornar contas / Emitir boletos of the notes of the Brufap, the letra C, the
// "Nota fiscal de origem" of the contas, the letra N of the extrato and the Faturamento agrupado with notes.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), NOTE = id(50), POSTING = id(60), T1 = id(70), T2 = id(71), CATEGORY = id(80), ACCOUNT = id(81);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const row = (extra = {}) => ({ id: NOTE, origin: 'brufap', status: 8, number: 4100, access_key: null, orders: [], xml_id: null, issue_type: 'T', ...extra });

test('247 ⋮ of a note of the FAGOO: Lançar contas, Estornar contas, Emitir boletos and the letra C follow the contas and the profile', () => {
  const config = SCREENS.nfe, actions = state => Object.fromEntries(rowActions(config, row(), { writable: true, finance: state }).filter(a => ['finance', 'boleto'].includes(a.id)).map(a => [a.id, [a.label, a.enabled, a.reason ?? null]]));
  assert.deepEqual(actions(null), { boleto: ['Emitir boletos', false, 'Conferindo as contas da nota…'], finance: ['Lançar contas', false, 'Conferindo as contas da nota…'] });
  assert.deepEqual(actions({ writable: true, posted: false, grouped: false }), { boleto: ['Emitir boletos', false, 'Os boletos saem das contas lançadas pela nota: use Lançar contas antes.'], finance: ['Lançar contas', true, null] });
  assert.deepEqual(actions({ writable: true, posted: true, grouped: false }), { boleto: ['Emitir boletos', true, null], finance: ['Estornar contas', true, null] });
  assert.deepEqual(actions({ writable: false, posted: true, grouped: false }).finance, ['Estornar contas', false, 'Somente administrador e financeiro lançam contas pela nota.']);
  assert.equal(actions({ writable: true, posted: false, grouped: true }).finance[1], false);
  const cancelled = rowActions(config, row({ status: 3 }), { writable: true, finance: { writable: true, posted: false, grouped: false } }).find(a => a.id === 'finance');
  assert.deepEqual([cancelled.enabled, cancelled.reason], [false, 'Nota cancelada ou denegada não lança contas.']);
  assert.equal(rowActions(config, row({ status: 3 }), { writable: true, finance: { writable: true, posted: true, grouped: false } }).find(a => a.id === 'finance').enabled, true, 'a cancelled note with contas may still estornar them');
  const entry = rowActions(SCREENS.entrada, row(), { writable: true, finance: { writable: true, posted: true, grouped: false } });
  assert.deepEqual(entry.filter(a => ['finance', 'boleto'].includes(a.id)).map(a => [a.id, a.enabled]), [['boleto', false], ['finance', true]]);
  const origin = rowActions(config, row({ origin: 'origin' }), { writable: true, finance: null }).find(a => a.id === 'finance');
  assert.equal(origin.enabled, false); assert.match(origin.reason, /Nota do Origin em consulta.*lançamentos continuam no Origin/);
  assert.deepEqual(financeIndicator(true), [{ text: 'C', color: 'green', title: 'Conta lançada pela NF' }]); assert.deepEqual(financeIndicator(false), []);
  assert.deepEqual([...invoiceFlags({ entity: 'invoice_finance_flags', data_mode: 'erp_native', items: [{ invoice_id: NOTE, posted: true, grouped: false, category_ids: [] }] }, [NOTE]).entries()], [[NOTE, { posted: true, grouped: false, category_ids: [] }]]);
  assert.throws(() => invoiceFlags({ entity: 'invoice_finance_flags', data_mode: 'erp_native', items: [{ invoice_id: id(99), posted: true, grouped: false, category_ids: [] }] }, [NOTE]));
});

test('247 the paths of the prévia and of the flags are accepted by the Worker', async () => {
  const path = invoicePreviewPath(NOTE, 3, CATEGORY, ACCOUNT);
  assert.equal(path, `/v1/financeiro/notas/${NOTE}/contas/previa?versao=3&categoria=${CATEGORY}&conta=${ACCOUNT}`);
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test${path}`))).args, { p_invoice_id: NOTE, p_expected_version: 3, p_category_id: CATEGORY, p_account_id: ACCOUNT });
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test${invoicePreviewPath(NOTE, 3, '', '')}`))).args, { p_invoice_id: NOTE, p_expected_version: 3, p_category_id: null, p_account_id: null });
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/notas-contas?ids=${NOTE}`))).args, { p_ids: [NOTE] });
});

const finance = (extra = {}) => ({ entity: 'invoice_finance', data_mode: 'erp_native', cash_movement_performed: false,
  invoice: { id: NOTE, version: 2, model: '55', direction: '1', kind: 'receivable', series: 1, number: '4100', status: 8, issue_date: '2026-10-10', total_cents: '10000', contact_id: id(2), contact_name: 'Cliente sintético', deleted: false },
  active_posting: null, titles: [], grouped_billing: null, orders_posted: [], blocked_reason: null, postings: [], writable: true, ...extra });
const posted = () => finance({ blocked_reason: 'erp_finance_invoice_already_posted',
  active_posting: { id: POSTING, invoice_id: NOTE, source_invoice_version: 2, group_id: id(61), state: 'active', version: 1, origin: 'manual', direction: 'receivable', model: '55', number: '4100', total_cents: '10000', installments: 2, category_id: null, created_at: '2026-10-11T12:00:00Z', reversed_at: null, reason: null },
  titles: [{ id: T1, position: 1, version: 1, due_on: '2026-11-10', amount_cents: '4000', settled_cents: '0', balance_cents: '4000', cancelled: false, category_id: null, account_id: null, payment_method_id: null, description: 'Nota fiscal nº 4100', cnab_linked: false },
    { id: T2, position: 2, version: 3, due_on: '2026-12-10', amount_cents: '6000', settled_cents: '0', balance_cents: '6000', cancelled: false, category_id: null, account_id: null, payment_method_id: null, description: 'Nota fiscal nº 4100', cnab_linked: false }] });
const preview = (category = null) => ({ data_mode: 'erp_native', cash_movement_performed: false, preview: { invoice_id: NOTE, invoice_version: 2, model: '55', direction: 'receivable', number: '4100', issued_on: '2026-10-10', contact_id: id(2), contact_name: 'Cliente sintético',
  total_cents: '10000', category_id: category, category_name: category ? 'Vendas por nota' : null, account_id: null, account_name: null, seller_id: null, preview_hash: (category ? 'b' : 'a').repeat(64),
  installments: [{ position: 1, amount_cents: '4000', due_on: '2026-11-10', method: '15', payment_method_id: null, payment_method_name: null, account_id: null, account_name: null }, { position: 2, amount_cents: '6000', due_on: '2026-12-10', method: null, payment_method_id: null, payment_method_name: null, account_id: null, account_name: null }] } });
function server({ read, post, role = 'admin' }) {
  const calls = [], state = { read };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {},
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (options.method === 'POST') return post(call, state);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === `/v1/financeiro/notas/${NOTE}/contas`) return structuredClone(state.read);
      if (url.pathname === `/v1/financeiro/notas/${NOTE}/contas/previa`) return preview(url.searchParams.get('categoria'));
      if (url.pathname === '/v1/financeiro/categories') return { entity: 'categories', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: CATEGORY, name: 'Vendas por nota', kind: 'receivable', active: true }] };
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: ACCOUNT, name: 'Itaú sintético', kind: 'bank', active: true }] };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, state, posts: () => calls.filter(call => call.method === 'POST') };
}
const mount = (source, props = {}) => mountComponent('FiscalInvoiceFinance.tsx', { controller: source.controller, invoiceId: NOTE, onClose: () => {}, onChanged: () => {}, ...props }, { expandChildren: ['Modal'] });

test('247 Lançar contas: the prévia follows the Categoria and the Destino, and an uncertain answer is checked with the same command', async () => {
  let attempts = 0, changed = 0;
  const source = server({ read: finance(), post: call => { attempts += 1; if (attempts === 1) throw new AccessError(503); return { action: 'invoice_finance_post', replayed: true, invoice_id: NOTE, invoice_version: 2, posting: posted().active_posting, titles: posted().titles, data_mode: 'erp_native', cash_movement_performed: false }; } });
  const view = await mount(source, { onChanged: () => { changed += 1; } });
  try {
    assert.match(view.text(), /Contas da Nota fiscal nº 4100/);
    assert.match(view.text(), /R\$ 40,00/); assert.match(view.text(), /R\$ 60,00/);
    await view.change('invoice-finance-category', CATEGORY);
    assert.ok(source.calls.some(call => call.path.includes(`categoria=${CATEGORY}`)), 'the prévia is read again with the Categoria');
    assert.match(view.text(), /Categoria: Vendas por nota/);
    await view.click('Lançar contas');
    assert.match(view.text(), /Use “Conferir resultado”/);
    const first = source.posts()[0];
    assert.deepEqual(first.body.data, { invoice_id: NOTE, expected_version: 2, preview_hash: 'b'.repeat(64), category_id: CATEGORY, account_id: null });
    source.state.read = posted();
    await view.click('Conferir resultado');
    assert.equal(source.posts()[1].body.command_id, first.body.command_id, 'the same command is sent again');
    assert.equal(changed, 1);
    assert.match(view.text(), /Contas a receber lançadas pela nota\./);
  } finally { view.unmount(); }
});

test('247 Estornar contas needs the motivo and sends the version of each conta; Emitir boletos opens Incluir Remessa with the open contas', async () => {
  const source = server({ read: posted(), post: call => ({ action: 'invoice_finance_reverse', replayed: false, invoice_id: NOTE, invoice_version: 2, posting: { ...posted().active_posting, state: 'reversed', version: 2, reversed_at: '2026-10-12T12:00:00Z', reason: 'Motivo' },
    titles: posted().titles.map(item => ({ ...item, cancelled: true })), data_mode: 'erp_native', cash_movement_performed: false }) });
  const view = await mount(source);
  try {
    assert.match(view.text(), /Contas a receber lançadas pela nota em 11\/10\/2026/);
    assert.equal(view.button('Estornar contas').disabled, true, 'without the motivo');
    await view.change('invoice-finance-reason', 'Estorno sintético');
    source.state.read = finance();
    await view.click('Estornar contas');
    assert.deepEqual(source.posts()[0].body.data, { invoice_id: NOTE, posting_id: POSTING, expected_version: 1, titles: [{ id: T1, version: 1 }, { id: T2, version: 3 }], reason: 'Estorno sintético' });
    assert.match(view.text(), /Contas da nota estornadas\./);
  } finally { view.unmount(); }
  const boletos = server({ read: posted(), post: () => { throw new Error('unexpected'); } });
  const again = await mount(boletos);
  try {
    await again.click('Emitir boletos');
    assert.deepEqual(again.navigations().at(-1), { search: `?titulos=${T1}%2C${T2}`, replace: false });
    assert.equal(again.location().pathname, '/cobranca-operacional');
  } finally { again.unmount(); }
  const settled = posted(); settled.titles[0].settled_cents = '100';
  assert.match(reverseBlocked({ ...settled, titles: settled.titles }), /contas com baixa/);
  assert.deepEqual(boletoTitleIds({ ...posted(), titles: posted().titles.map((item, index) => ({ ...item, cnab_linked: index === 0 })) }), [T2]);
});

test('247 a blocked note says why, and a profile without contas only reads', async () => {
  const blocked = server({ read: finance({ blocked_reason: 'erp_finance_invoice_order_posted', orders_posted: [{ document_id: id(9), kind: 'sales_orders', number: '77' }] }), post: () => { throw new Error('unexpected'); } });
  const view = await mount(blocked);
  try {
    assert.match(view.text(), /O pedido de origem já lançou as contas \(letra V\)/); assert.match(view.text(), /Pedidos com contas: nº 77/);
    assert.ok(!view.nodes().some(node => node.type === 'button' && text(node) === 'Lançar contas'));
    assert.ok(!blocked.calls.some(call => call.path.includes('/previa')), 'no prévia is asked for a blocked note');
  } finally { view.unmount(); }
  const reader = server({ read: finance({ writable: false }), role: 'fiscal', post: () => { throw new Error('unexpected'); } });
  const readOnly = await mount(reader);
  try {
    assert.match(readOnly.text(), /Somente administrador e financeiro lançam as contas pela nota/);
    assert.ok(!reader.calls.some(call => call.path.includes('/previa') || call.path.includes('/categories')));
  } finally { readOnly.unmount(); }
});

test('247 the conta says its Nota fiscal de origem, the extrato shows N and the Faturamento agrupado picks a note or its pedido, never both', () => {
  const invoice = { invoice_id: NOTE, kind: 'fiscal_invoices', model: '55', direction: '1', number: '4100' };
  assert.deepEqual([originText(invoice).field, originNumber(invoice), originPath(invoice)], ['Nota fiscal de origem', '#4100', `/historico-fiscal?modelo=55&nota=${NOTE}`]);
  assert.equal(originPath({ ...invoice, direction: '0' }), `/notas-entrada?nota=${NOTE}`);
  assert.equal(originNumber({ ...invoice, number: null }), '(sem número)');
  assert.deepEqual(originBadge({ line_kind: 'settlement', document: { kind: 'fiscal_invoices', number: '4100' }, title_kind: 'receivable' }), { text: 'N', color: '#7a5af8', title: 'Nota fiscal nº 4100' });
  assert.equal(LEDGER_ORIGIN.fiscal_invoices, 'Nota fiscal');
  const items = [{ id: id(1), kind: 'sales_orders', number: '7', date: '2026-09-01', total_cents: '100', version: 1 }, { id: id(2), kind: 'sales_orders', number: '8', date: '2026-09-02', total_cents: '200', version: 1 },
    { id: id(3), kind: 'fiscal_invoices', number: '4100', date: '2026-09-03', total_cents: '200', version: 1, orders: [id(2)] }, { id: id(4), kind: 'fiscal_invoices', number: null, date: '2026-09-04', total_cents: '50', version: 1, orders: [] }];
  assert.deepEqual(groupedDefaultChoice(items), [id(1), id(3), id(4)], 'the pedido of a listed note stays out');
  assert.deepEqual(groupedToggle(items, groupedDefaultChoice(items), id(2)), [id(1), id(4), id(2)], 'choosing the pedido leaves its note out');
  assert.deepEqual(groupedToggle(items, [id(2)], id(3)), [id(3)], 'choosing the note leaves its pedido out');
  assert.deepEqual(items.map(groupedItemLabel), ['Venda nº 7', 'Venda nº 8', 'Nota Fiscal nº 4100', 'Nota Fiscal (sem número)']);
});
