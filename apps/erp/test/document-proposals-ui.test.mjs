import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { PROPOSAL_STATUS_OPTIONS, proposalStatusOption } from '../src/lib/document-list-model.ts';

// 202610200129-131 propostas: Origin single Situação list, Criar modelo, Clonar modelo, Novo a partir deste and Selecione o modelo.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000134', contact = '30000000-0000-4000-8000-000000000134';
const row = (n, over = {}) => ({ id: id(n), kind: 'sales_proposals', number: String(n + 60), version: 3, status: 'open', date: '2026-10-20', total: '10.00', contact_id: contact, contact_name: `Cliente ${n}`, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: null, fiscal_draft: null, internal_notes: null, invoice: null, pendencies: false, service_order_number: null, template_name: null, ...over });
const body = { date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item', code: null, unit: 'UN', quantity: '1', unit_price: '10', detailed_description: null }] };
const record = (n, extra = {}) => { const normalized = normalizeDocument('sales_proposals', { ...body, ...extra }); return { ...normalized, id: id(n), kind: 'sales_proposals', number: String(n + 60), version: 3, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null, effect_flags: { finance_active: false, stock_active: false }, contact_snapshot: { id: contact, version: 1, name: 'Cliente' }, items: normalized.items.map(item => ({ ...item, product_snapshot: null })) }; };
const preview = n => ({ source: { id: id(n), kind: 'sales_proposals', number: String(n + 60), version: 3 }, data: { date: '2026-10-20', contact_id: contact, warehouse_id: null, expected_date: null, valid_until: null, next_contact: null, template: false, items: [{ id: null, product_id: null, description: 'Item', code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0' }], installments: [], equipment: null, serial_number: null, technician: null, defect: null, solution: null, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', payment_terms: null, delivery_terms: null, notes: null, internal_notes: null },
  reset_fields: ['date', 'expected_date', 'valid_until', 'next_contact', 'installments', 'template', 'equipment', 'serial_number', 'technician', 'defect', 'solution'], persisted: false, data_mode: 'erp_native', operational_effects: false });
function server(rows) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push(path);
      if (path === '/v1/documentos') return { read: ['sales_proposals'], write: ['sales_proposals'], data_mode: 'erp_native' };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]), items = q.get('template') === 'true' ? rows.filter(item => item.template) : rows;
        return { kind: 'sales_proposals', items, limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: items.length, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false }; }
      const match = /\/v1\/documentos\/sales_proposals\/([0-9a-f-]{36})$/.exec(path);
      if (match) { const n = Number(match[1].slice(-12)); return { kind: 'sales_proposals', document: record(n, n === 2 ? { template: true, template_name: 'Modelo de instalação' } : {}), data_mode: 'erp_native', operational_effects: false }; }
      void options; throw new AccessError(404);
    },
    async documentCopy(path) { calls.push(path); return preview(Number(/([0-9a-f-]{36})\/preview$/.exec(path)[1].slice(-12))); },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [] }; },
  };
  return { calls, controller };
}
const mount = srv => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: 'sales_proposals' }, { location: '/documentos-empresa?tipo=sales_proposals', expandChildren: ['NativeListLayout', 'DocumentList'] });
const menu = (view, rowId) => { const rows = view.nodes().filter(n => n.type === 'tr' && String(n.props.className).startsWith('documents-row')); return view.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'RowMenu')[rows.findIndex(tr => tr.key === rowId)].props.items; };
const editor = view => view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Editor');

test('the Situação of the propostas is the Origin single list; Em aberto groups the open ones and Modelos the templates', () => {
  assert.deepEqual(PROPOSAL_STATUS_OPTIONS.map(option => option.label), ['Todas', 'Em aberto', 'Rascunho', 'Pendente', 'Aguardando', 'Aprovado', 'Não aprovado', 'Concluído', 'Cancelado', 'Modelos']);
  assert.equal(proposalStatusOption({ statuses: ['waiting', 'draft', 'pending', 'open'], template: null }), 'em-aberto');
  assert.equal(proposalStatusOption({ statuses: [], template: true }), 'modelos');
  assert.equal(proposalStatusOption({ statuses: ['open', 'approved'], template: null }), null);
});

test('Criar modelo and Clonar modelo open the reviewed copy as a modelo; Novo a partir deste and Selecione o modelo start a proposta', async () => {
  const srv = server([row(1), row(2, { template: true, template_name: 'Modelo de instalação' })]), view = await mount(srv);
  try {
    assert.deepEqual(menu(view, id(1)).filter(item => /modelo|Clonar|Novo/.test(item.label)).map(item => item.label), ['Clonar proposta', 'Criar modelo']);
    assert.deepEqual(menu(view, id(2)).filter(item => /modelo|Clonar|Novo/.test(item.label)).map(item => item.label), ['Novo a partir deste', 'Clonar modelo']);
    const select = view.input('documents-template-start');
    assert.deepEqual(select.props.children.flat().filter(Boolean).map(option => option.props.children), ['Selecione o modelo', 'Modelo de instalação']);
    menu(view, id(1)).find(item => item.label === 'Criar modelo').onClick(); await view.flush();
    let draft = editor(view).props.copyDraft;
    assert.deepEqual([draft.preview.source.id, draft.preview.data.template, draft.preview.data.template_name], [id(1), true, null]);
  } finally { view.unmount(); }
  const second = await mount(srv);
  try {
    menu(second, id(2)).find(item => item.label === 'Clonar modelo').onClick(); await second.flush();
    assert.deepEqual([editor(second).props.copyDraft.preview.data.template, editor(second).props.copyDraft.preview.data.template_name], [true, 'Modelo de instalação']);
  } finally { second.unmount(); }
  const third = await mount(srv);
  try {
    await third.change('documents-template-start', id(2));
    assert.deepEqual([editor(third).props.copyDraft.preview.source.id, editor(third).props.copyDraft.preview.data.template], [id(2), false], 'a new proposta from the modelo');
  } finally { third.unmount(); }
});
