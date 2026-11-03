import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { groupedApiPath, groupedParams, groupedRange, groupedRoute } from '../src/lib/finance-grouped-billing-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 174: Faturamento agrupado (clientes do período, seleção de vendas, GERAR CONTAS e os gerados).
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', ALFA = id(10), BETA = id(11), D1 = id(20), D2 = id(21), D3 = id(22);
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()), MONTH = TODAY.slice(0, 7);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const lastButton = async (view, label) => { const found = view.nodes().filter(node => node.type === 'button' && text(node) === label).at(-1); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const settle = async view => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const role = state => ({ phase: 'ready', membership: { user_id: actor, role: state } });
const docs = { [ALFA]: [{ id: D1, number: '7', date: TODAY, total_cents: '10000', version: 2 }, { id: D2, number: '8', date: TODAY, total_cents: '5001', version: 2 }], [BETA]: [{ id: D3, number: '9', date: TODAY, total_cents: '3000', version: 2 }] };
const billing = { id: id(30), number: '1', contact_id: ALFA, contact_name: 'Alfa Sintética', issued_on: TODAY, condition: '30 60', total_cents: '15001', state: 'active', version: 1, created_at: '2026-10-20T12:00:00Z', deletable: true,
  documents: [{ id: D1, number: '7', total_cents: '10000' }, { id: D2, number: '8', total_cents: '5001' }], titles: [{ id: id(40), position: 1, due_on: TODAY, amount_cents: '7501', settled_cents: '0', cancelled: false }, { id: id(41), position: 2, due_on: TODAY, amount_cents: '7500', settled_cents: '0', cancelled: false }] };

function server({ post = () => { throw new Error('no post'); }, session = role('financeiro') } = {}) {
  const calls = [], state = { session };
  const controller = {
    getSnapshot: () => state.session, subscribe: () => () => {}, retry() {},
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') return { read: true, write: state.session.membership.role !== 'consulta', data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call, calls.filter(item => item.method === 'POST' && item.path === path).length);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/faturamento-agrupado') return { entity: 'grouped_billing_candidates', from: url.searchParams.get('from'), to: url.searchParams.get('to'), selected: url.searchParams.has('documents'), page: 1, limit: 100, total: 2,
        items: [{ contact_id: ALFA, contact_name: 'Alfa Sintética', documents: 2, total_cents: '15001' }, { contact_id: BETA, contact_name: 'Beta Sintética', documents: 1, total_cents: '3000' }], data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/faturamento-agrupado/documentos') { const contact = url.searchParams.get('contact'); return { entity: 'grouped_billing_documents', contact_id: contact, total: docs[contact].length, items: docs[contact], data_mode: 'erp_native' }; }
      if (url.pathname === '/v1/financeiro/faturamento-agrupado/gerados') return { entity: 'grouped_billings', from: null, to: null, page: 1, limit: 100, total: 1, items: [billing], data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST') };
}
const EXPAND = ['BusyGuard', 'Modal', 'NativeListLayout', 'AppliedChips', 'DocumentsModal', 'BatchDialog'];
const mount = (source, location = '/financeiro-empresa?area=faturamento-agrupado') => mountComponent('FinanceGroupedBilling.tsx', { controller: source.controller }, { location, expandChildren: EXPAND });

test('174 Faturamento agrupado model: Período (Do mês | Do dia | De um período), the pedidos selecionados and the Worker paths', async () => {
  const route = groupedRoute(new URLSearchParams('area=faturamento-agrupado&periodo=periodo&from=2026-10-01&to=2026-10-15&q=Alfa'), TODAY);
  assert.deepEqual(groupedRange(route), { from: '2026-10-01', to: '2026-10-15' });
  assert.equal(groupedParams(route, TODAY).toString(), 'area=faturamento-agrupado&periodo=periodo&from=2026-10-01&to=2026-10-15&q=Alfa');
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test${groupedApiPath(route)}`))).args, { p_from: '2026-10-01', p_to: '2026-10-15', p_documents: null, p_query: 'Alfa', p_page: 1, p_limit: 100 });
  const month = groupedRoute(new URLSearchParams('area=faturamento-agrupado&mes=2026-02'), TODAY);
  assert.deepEqual(groupedRange(month), { from: '2026-02-01', to: '2026-02-28' });
  const selected = groupedRoute(new URLSearchParams(`area=faturamento-agrupado&pedidos=${D1},${D2}`), TODAY);
  assert.deepEqual((await parseFinanceRoute(new Request(`https://api.example.test${groupedApiPath(selected)}`))).args.p_documents, [D1, D2]);
  for (const bad of ['periodo=ano', 'mes=2026-13', 'from=2026-10-10&to=2026-10-01', 'pedidos=x', 'aba=outra', 'extra=1']) assert.throws(() => groupedRoute(new URLSearchParams(bad), TODAY), /inválidos/, bad);
});

test('174 GERAR CONTAS validates the selection and the Condição, uses the pedidos chosen in the modal and recovers with the same command', async () => {
  const done = call => ({ action: 'grouped_billing_generate', replayed: false, entity: 'grouped_billings', items: call.body.data.items.map(() => billing), data_mode: 'erp_native' });
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return done(call); } }), view = await mount(source);
  try {
    await settle(view);
    assert.equal(source.calls.find(call => call.path?.startsWith?.('/v1/financeiro/faturamento-agrupado')).path, `/v1/financeiro/faturamento-agrupado?from=${MONTH}-01&to=${groupedRange(groupedRoute(new URLSearchParams(''), TODAY)).to}`);
    assert.deepEqual(view.nodes().filter(node => node.type === 'th').map(text), ['Seleção', 'Cliente', 'Itens', 'Valor Total', 'Condição']);
    await lastButton(view, 'GERAR CONTAS'); assert.match(view.text(), /Nenhum cliente foi selecionado\./);
    view.find(node => node.props?.['aria-label'] === 'Selecionar Alfa Sintética').props.onChange(); await view.flush();
    await lastButton(view, 'GERAR CONTAS'); assert.match(view.text(), /Informe a condição de pagamento de Alfa Sintética\./);
    await view.change(`grouped-condition-${ALFA}`, '30 60');
    await lastButton(view, '2 Venda(s)'); await settle(view);
    assert.match(view.text(), /Seleção de notas fiscais e vendas/); assert.match(view.text(), /Venda nº 7/); assert.match(view.text(), /2 item\(s\) · Total R\$ 150,01/);
    view.find(node => node.props?.['aria-label'] === 'Selecionar venda nº 8').props.onChange(); await view.flush();
    assert.match(view.text(), /1 item\(s\) · Total R\$ 100,00/);
    await lastButton(view, 'Ok');
    assert.match(view.text(), /1 de 2 Venda\(s\)/);
    await lastButton(view, 'GERAR CONTAS'); await settle(view);
    assert.match(view.text(), /Conferir resultado/);
    await lastButton(view, 'Conferir resultado'); await settle(view);
    const [first, second] = source.posts();
    assert.deepEqual(second.body, first.body, 'the same command_id and body are replayed');
    assert.deepEqual(first.body.data, { items: [{ contact_id: ALFA, document_ids: [D1], total_cents: '10000', condition: '30 60', days: [30, 60] }] });
    await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/grouped_billing_generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first.body) }));
    assert.match(view.text(), /Contas geradas para 1 cliente/);
  } finally { view.unmount(); }
});

test('174 Listar Faturamentos Gerados shows the contas and Excluir selecionados goes through the batch; consulta only reads', async () => {
  const source = server({ post: call => ({ action: 'grouped_billing_delete', replayed: false, entity: 'grouped_billings', record: { id: call.body.data.id, deleted: true }, data_mode: 'erp_native' }) });
  const view = await mount(source, '/financeiro-empresa?area=faturamento-agrupado&aba=gerados');
  try {
    await settle(view);
    assert.match(view.text(), /Faturamentos agrupados/); assert.match(view.text(), /Venda nº 7, Venda nº 8/); assert.match(view.text(), /1\/2/);
    view.find(node => node.props?.['aria-label'] === 'Selecionar Alfa Sintética').props.onChange(); await view.flush();
    await lastButton(view, 'Excluir selecionados');
    await lastButton(view, 'Excluir'); await settle(view);
    assert.deepEqual(source.posts()[0].body.data, { id: billing.id, expected_version: 1 });
  } finally { view.unmount(); }
  const reader = server({ session: role('consulta') }), readOnly = await mount(reader);
  try { await settle(readOnly); assert.equal(readOnly.nodes().some(node => node.type === 'button' && text(node) === 'GERAR CONTAS'), false); } finally { readOnly.unmount(); }
});
