import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { batchSituationTargets, readSituations, situationTargets, transitionActions, transitionNote, actionsAllowed, rowAt, runnableTargets } from '../src/lib/document-situations-model.ts';
import { documentListQuery, documentRowActions, listIndicators, reasonRequired, statusBatchPlan, EMPTY_LIST_FILTERS } from '../src/lib/document-list-model.ts';

// 202610200163 Gerenciador de transições in the document screens: situações, filters, badges, ⋮ and the editor. No DOM, no network.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const custom = '40000000-0000-4000-8000-000000000163', closing = '40000000-0000-4000-8000-000000000164';
const actor = '20000000-0000-4000-8000-000000000163', contact = '30000000-0000-4000-8000-000000000163';
const situationsPage = {
  kind: 'sales_orders', adopted: true, occurrence_date_editable: false, data_mode: 'erp_native', operational_effects: false,
  situations: [
    { key: 'open', base_status: 'open', name: 'Em aberto', color: '#e6a700', default: true, active: true },
    { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false, active: true },
    { key: 'verified', base_status: 'verified', name: 'Verificado', color: '#7e57c2', default: true, active: true },
    { key: 'cancelled', base_status: 'cancelled', name: 'Cancelado', color: '#d32f2f', default: true, active: true },
    { key: closing, base_status: 'fulfilled', name: 'Entregue', color: '#00aa00', default: false, active: false },
    ...['draft', 'in_progress', 'partially_fulfilled', 'fulfilled'].map(key => ({ key, base_status: key, name: key, color: '#607d8b', default: true, active: true })),
  ],
  transitions: [
    { from: 'open', to: custom, active: true, actions: [] }, { from: 'open', to: 'verified', active: true, actions: ['post_stock'] },
    { from: 'open', to: 'cancelled', active: false, actions: [] }, { from: custom, to: 'verified', active: true, actions: [] }, { from: 'open', to: closing, active: true, actions: [] },
  ],
};
const model = readSituations(situationsPage, 'sales_orders');
const row = (n, over = {}) => ({ id: id(n), kind: 'sales_orders', number: String(n + 160), version: 3, status: 'open', date: '2026-10-20', total: '10.00', contact_id: contact, contact_name: `Cliente ${n}`, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
  expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false,
  fiscal_draft: null, internal_notes: null, invoice: null, pendencies: false, service_order_number: null, template_name: null, invoice_linked: false,
  situation: { key: 'open', base_status: 'open', name: 'Em aberto', color: '#e6a700', default: true }, ...over });

test('targets follow the active transitions to active situações, the effects guards and the profile of each action', () => {
  assert.deepEqual(situationTargets(model, 'sales_orders', row(1)), [custom, 'verified']);
  const inCustom = row(2, { situation: { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false } });
  assert.deepEqual(situationTargets(model, 'sales_orders', inCustom), ['verified']);
  // With stock posted only the forward moves of the guards remain (279: open→verified is one of them; not with contas).
  assert.deepEqual(situationTargets(model, 'sales_orders', row(3, { stock_active: true })), [custom, 'verified']);
  assert.deepEqual(situationTargets(model, 'sales_orders', row(3, { finance_active: true })), [custom]);
  assert.deepEqual(batchSituationTargets(model, 'sales_orders'), [custom, 'verified']);
  assert.deepEqual(transitionActions(model, 'sales_orders', 'open', 'verified'), ['post_stock']);
  assert.equal(actionsAllowed(['post_stock'], 'vendas'), false); assert.equal(actionsAllowed(['post_stock'], 'estoque'), true); assert.equal(actionsAllowed(['post_finance'], 'financeiro'), true);
  assert.match(transitionNote(['post_stock']), /Lançar estoque/);
  assert.equal(reasonRequired('sales_orders', custom, 'open', model), false);
  assert.equal(reasonRequired('sales_orders', custom, 'cancelled', model), true);
  assert.equal(rowAt(model, 'sales_orders', row(4), custom).status, 'open');
  // Without the model (database before 163) the domain transitions stay.
  assert.ok(situationTargets(null, 'sales_orders', row(5)).includes('cancelled'));
  assert.throws(() => readSituations({ ...situationsPage, kind: 'purchase_orders' }, 'sales_orders'));
});

test('list query, ⋮ and batch plan use exact situação keys', () => {
  const params = documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, statuses: ['open', custom] }, { situations: true });
  assert.equal(params.get('situation'), `open,${custom}`); assert.equal(params.get('status'), null);
  assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, statuses: [custom] }));
  const actions = documentRowActions('sales_orders', row(6), { role: 'vendas', writable: true, situations: model }).filter(action => action.action === 'status');
  assert.deepEqual(actions.map(action => [action.label, action.enabled]), [['Aguardando pagamento', true], ['Verificado', false]]);
  assert.match(actions[1].title, /seu perfil não faz esses lançamentos/);
  const plan = statusBatchPlan('sales_orders', [row(7), row(8, { situation: { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false } })], custom, '', model, 'vendas');
  assert.deepEqual([plan.eligible.map(item => item.id), plan.skipped.map(item => item.message)], [[id(7)], ['Já está nesta situação.']]);
  // The "nota vinculada" of the other profiles hides the Origin actions without telling the nota.
  const linked = row(9, { invoice_linked: true });
  assert.deepEqual(listIndicators(linked).filter(item => item.key === 'N').map(item => item.title), ['Pedido com nota fiscal vinculada']);
  assert.equal(documentRowActions('sales_orders', linked, { role: 'estoque', writable: false }).some(action => action.label === 'Lançar estoque'), false);
  // The server refuses Gerar ordem serviço for a pedido with nota: the profiles that only see the flag get it disabled too.
  const os = documentRowActions('sales_orders', linked, { role: 'vendas', writable: true, serviceWritable: true }).find(action => action.action === 'sales_to_service');
  assert.deepEqual([os.enabled, os.title], [false, 'O pedido já tem nota fiscal.']);
  // The occurrences modal offers only the transitions whose actions the profile runs (open→verified posts stock).
  assert.deepEqual(runnableTargets(model, 'sales_orders', 'open', situationTargets(model, 'sales_orders', row(10)), 'vendas'), [custom]);
  assert.deepEqual(runnableTargets(model, 'sales_orders', 'open', situationTargets(model, 'sales_orders', row(10)), 'admin'), [custom, 'verified']);
});

test('the list reads the situações first, filters by exact keys, shows the custom badge and moves by key', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native' };
      if (path === '/v1/documentos/sales_orders/situacoes') return situationsPage;
      if (path.endsWith('/status')) return { kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', number: '161', status: 'open', version: 4, situation: { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false } }, effects: [], replayed: false, data_mode: 'erp_native', operational_effects: false };
      if (path.endsWith('/ocorrencias') && options.method === 'POST') return { kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', number: '161', status: 'open', version: 4, situation: { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false } }, occurrence: { id: id(50), sequence: 1, occurred_on: '2026-10-20', occurred_time: '10:00', text: null, status_before: 'open', status_after: null, next_contact: null, actor_id: actor, actor_role: 'vendas', document_version: 4, recorded_at: '2026-10-20T13:00:00Z' }, replayed: false, data_mode: 'erp_native', operational_effects: false };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'sales_orders', items: [row(1), row(2, { situation: { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false } })], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 2, total_amount: '20.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders', expandChildren: ['NativeListLayout', 'DocumentList', 'DocumentStatusBadge', 'Modal'], modules: { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' } });
  try {
    const situationsRead = calls.findIndex(call => call.path.endsWith('/situacoes')), firstList = calls.findIndex(call => call.path.startsWith('/v1/documentos/sales_orders?'));
    assert.ok(situationsRead >= 0 && situationsRead < firstList, 'the situações are read before the first page');
    // Situação filter: active situações (the inactive "Entregue" is not offered) with the custom one by name.
    assert.ok(view.input(`documents-status-${custom}`));
    assert.throws(() => view.input(`documents-status-${closing}`));
    assert.ok(view.nodes().some(n => n.type === 'span' && n.props.children === 'Aguardando pagamento' && /background/i.test(JSON.stringify(n.props.style ?? {}))));
    await view.change(`documents-status-${custom}`, true);
    await view.submit();
    const filtered = calls.filter(call => call.path.startsWith('/v1/documentos/sales_orders?')).at(-1);
    assert.equal(new URLSearchParams(filtered.path.split('?')[1]).get('situation'), custom);
    // ⋮ of the first row: the custom target moves by key through the occurrence modal.
    const menus = view.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'RowMenu');
    const item = menus[0].props.items.find(entry => entry.label === 'Aguardando pagamento');
    assert.equal(menus[0].props.items.find(entry => entry.label === 'Verificado').disabled, true);
    item.onClick(); await view.flush();
    assert.ok(view.nodes().some(n => n.props?.['aria-label'] === 'Alterando situação para Aguardando pagamento'));
    assert.match(view.text(), /Em aberto → Aguardando pagamento/);
    await view.click('Alterar situação');
    const post = calls.find(call => call.method === 'POST' && call.path.endsWith('/ocorrencias'));
    assert.equal(post.body.status, custom);
    assert.match(view.text(), /situação alterada para Aguardando pagamento/);
  } finally { view.unmount(); }
});

test('occurrences modal: custom names, the date and time locked by Preferências and the note of a transition with actions', async () => {
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async documents(path) { if (path.endsWith('/ocorrencias')) return { kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', number: '161', status: 'open', version: 3, situation: { key: custom, base_status: 'open', name: 'Aguardando pagamento', color: '#ff8800', default: false } },
      items: [{ id: id(51), sequence: 1, occurred_on: '2026-10-20', occurred_time: '09:00', text: null, status_before: 'open', status_after: null, next_contact: null, actor_id: actor, actor_role: 'admin', document_version: 3, recorded_at: '2026-10-20T12:00:00Z', situation_before: { key: 'open', name: 'Em aberto', color: '#e6a700' }, situation_after: { key: custom, name: 'Aguardando pagamento', color: '#ff8800' } }],
      has_more: false, can_write: true, date_editable: false, data_mode: 'erp_native', operational_effects: false }; throw new AccessError(404); } };
  const view = await mountComponent('DocumentOccurrences.tsx', { controller, kind: 'sales_orders', documentId: id(1), label: 'Pedido 161', targets: () => ['verified'], reasonNeeded: () => false, onClose() {},
    situationLabel: key => model.situations.find(item => item.key === key)?.name ?? key, transitionNote: (from, to) => transitionNote(transitionActions(model, 'sales_orders', 'open', to)) });
  try {
    assert.match(view.text(), /Em aberto → Aguardando pagamento/);
    assert.equal(view.input('occurrence-date').props.readOnly, true);
    assert.match(view.text(), /ative “Permite a edição da data e hora das ocorrências”/);
    assert.equal(view.input('occurrence-status').props.value, custom);
    await view.change('occurrence-status', 'verified');
    assert.match(view.text(), /Esta transição também executa: Lançar estoque/);
  } finally { view.unmount(); }
});
