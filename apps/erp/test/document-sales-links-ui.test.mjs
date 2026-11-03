import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { documentRowActions, listIndicators } from '../src/lib/document-list-model.ts';

// 202610200131 on the real list and editor: nota de origem, pendências, Limpar avisos and Gerar ordem serviço. No DOM, no network.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000133', contact = '30000000-0000-4000-8000-000000000133';
const row = (n, over = {}) => ({ id: id(n), kind: 'sales_orders', number: String(n + 80), version: 2, status: 'open', date: '2026-10-20', total: '10.00', contact_id: contact, contact_name: `Cliente ${n}`, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, invoice: null, pendencies: false, service_order_number: null, ...over });
const MODAL = { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' };
const menu = (view, rowId) => { const rows = view.nodes().filter(n => n.type === 'tr' && String(n.props.className).startsWith('documents-row')); return view.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'RowMenu')[rows.findIndex(tr => tr.key === rowId)].props.items; };

test('the row tells the nota of origin, the OS generated and the pendências; with a nota the Origin actions disappear', () => {
  const invoiced = row(1, { invoice: { model: '55', number: '321', series: '1', issue_date: '2026-10-19', authorized: true }, service_order_number: '12', pendencies: true });
  assert.deepEqual(listIndicators(invoiced).map(item => [item.key, item.title]), [['N', 'Origem NF 321 - Data: 19/10/2026'], ['O', 'Ordem de serviço 12'], ['PEND', 'Este pedido contém pendências']]);
  assert.equal(listIndicators(row(2, { invoice: { model: '65', number: null, series: '1', issue_date: '2026-10-19', authorized: false } }))[0].letter.color, 'darkgreen');
  const labels = documentRowActions('sales_orders', invoiced, { role: 'admin', writable: true, serviceWritable: true }).map(action => action.label);
  for (const hidden of ['Gerar nota fiscal', 'Gerar NFC-e', 'Lançar estoque', 'Lançar contas']) assert.equal(labels.includes(hidden), false, hidden);
  assert.ok(labels.includes('Limpar avisos'));
  const free = documentRowActions('sales_orders', row(3), { role: 'admin', writable: true, serviceWritable: true });
  assert.equal(free.find(action => action.label === 'Gerar ordem serviço').enabled, true);
  assert.equal(documentRowActions('sales_orders', row(3), { role: 'estoque', writable: false, serviceWritable: false }).find(action => action.label === 'Gerar ordem serviço').enabled, false);
  assert.equal(documentRowActions('sales_orders', invoiced, { role: 'admin', writable: true, serviceWritable: true }).find(action => action.label === 'Gerar ordem serviço').title, 'Ordem de serviço 12 já gerada.');
  const old = { ...row(4) }; delete old.pendencies;
  assert.match(documentRowActions('sales_orders', old, { role: 'admin', writable: true, serviceWritable: true }).find(action => action.label === 'Gerar ordem serviço').title, /atualização do banco/);
});

test('⋮ Gerar ordem serviço is reviewed, sent once and opens the new OS; Limpar avisos rereads the list', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/v1/documentos') return { read: ['sales_orders', 'service_orders'], write: ['sales_orders', 'service_orders'], data_mode: 'erp_native' };
      if (path.endsWith('/gerar-os')) return { sale: { id: id(1), kind: 'sales_orders', version: 2 }, service_order: { id: id(90), kind: 'service_orders', number: '15', version: 1, status: 'open' }, replayed: false, data_mode: 'erp_native', operational_effects: false };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'sales_orders', items: [row(1, { pendencies: true })], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 1, total_amount: '10.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders', expandChildren: ['NativeListLayout', 'DocumentList', 'Modal'], modules: MODAL });
  try {
    const lists = () => calls.filter(call => call.path.startsWith('/v1/documentos/sales_orders?')).length, before = lists();
    menu(view, id(1)).find(item => item.label === 'Limpar avisos').onClick(); await view.flush();
    assert.equal(lists(), before + 1);
    menu(view, id(1)).find(item => item.label === 'Gerar ordem serviço').onClick(); await view.flush();
    assert.match(view.text(), /A ordem de serviço será criada em Em aberto/);
    assert.equal(calls.some(call => call.path.endsWith('/gerar-os')), false, 'nothing is created before the confirmation');
    await view.click('Confirmar criação da OS');
    const post = calls.find(call => call.path.endsWith('/gerar-os'));
    assert.deepEqual([post.method, post.body.expected_version], ['POST', 2]); assert.match(post.body.command_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(view.location().search)), { tipo: 'service_orders', documento: id(90) });
  } finally { view.unmount(); }
});

test('the editor of a saved pedido shows the pendências by section, with Ocultar/Mostrar', async () => {
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }),
    async documents(path) { if (path.endsWith('/pendencias')) return { kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', number: '81', status: 'open', version: 2 }, pendencies: [{ section: 'Cliente', message: 'O campo CPF/CNPJ é obrigatório' }, { section: 'Cliente', message: 'O campo CEP é obrigatório' }, { section: 'Produto Bucha', message: 'O campo NCM é obrigatório' }], data_mode: 'erp_native', operational_effects: false }; throw new AccessError(404); } };
  const view = await mountComponent('DocumentPendencies.tsx', { controller, documentId: id(1), version: 2 });
  try {
    assert.match(view.text(), /Atenção — Este pedido possui pendências cadastrais para emissão de nota fiscal\./);
    assert.match(view.text(), /ClienteO campo CPF\/CNPJ é obrigatórioO campo CEP é obrigatórioProduto BuchaO campo NCM é obrigatório/);
    await view.click('Ocultar'); assert.doesNotMatch(view.text(), /CPF\/CNPJ/); await view.click('Mostrar'); assert.match(view.text(), /CPF\/CNPJ/);
  } finally { view.unmount(); }
  const empty = await mountComponent('DocumentPendencies.tsx', { controller: { getSnapshot: controller.getSnapshot, async documents() { throw new AccessError(404); } }, documentId: id(1), version: 2 });
  try { assert.equal(empty.text(), '', 'a database before 131 shows nothing'); } finally { empty.unmount(); }
});

test('⋮ Gerar ordem serviço refused by the server (nota visible only to admin/fiscal) explains why and keeps the list', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/v1/documentos') return { read: ['sales_orders', 'service_orders'], write: ['sales_orders', 'service_orders'], data_mode: 'erp_native' };
      if (path.endsWith('/gerar-os')) throw new AccessError(400);
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'sales_orders', items: [row(1)], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 1, total_amount: '10.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders', expandChildren: ['NativeListLayout', 'DocumentList', 'Modal'], modules: MODAL });
  try {
    menu(view, id(1)).find(item => item.label === 'Gerar ordem serviço').onClick(); await view.flush();
    await view.click('Confirmar criação da OS');
    assert.equal(calls.filter(call => call.path.endsWith('/gerar-os')).length, 1);
    assert.match(view.text(), /A ordem de serviço não foi gerada: o pedido tem nota fiscal vinculada ou está cancelado\./);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(view.location().search)), { tipo: 'sales_orders' }, 'no OS is opened');
    assert.equal(view.nodes().some(n => n.props?.children === 'Conferir resultado'), false, 'a definitive refusal is not uncertain');
  } finally { view.unmount(); }
});
