import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { addDays } from '../src/lib/origin-list.ts';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';

// 202610200129: Pedidos de compra on the real list (RealDocuments → DocumentList), Exibir totais and Remover ocorrência. No DOM, no network.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000129', contact = '30000000-0000-4000-8000-000000000129';
const today = (() => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-'); })();
const row = (n, over = {}) => ({ id: id(n), kind: 'purchase_orders', number: String(n + 40), version: 2, status: 'open', date: today, total: n === 1 ? '10.05' : '0.10', contact_id: contact, contact_name: `Fornecedor sintético ${n}`, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: null, fiscal_draft: null, internal_notes: null, ...over });
const component = (view, name) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name);
const recorder = () => { const calls = { downloads: [] }; globalThis.__comprasDownloads = calls; return calls; };
const DOWNLOAD = { '../lib/document-download': 'export const downloadText=(...args)=>globalThis.__comprasDownloads.downloads.push(args);export const openExternal=()=>{};' };
// The real Modal moves focus with the DOM; this stub keeps its title, actions and content in the tree.
const MODAL = { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' };
const preferenceView = (pageId, values) => { const page = preferencePage(pageId); return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role: 'estoque', can_manage: false, directory: null,
  items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: '2026-10-20T12:00:00Z' } : { key: field.key, value: field.default, version: 0, updated_at: null }) }; };

function server({ kind = 'purchase_orders', rows = [row(1), row(2)], role = 'estoque', preferences = null, occurrences = null } = {}) {
  const calls = [];
  const page = path => { const q = new URLSearchParams(path.split('?')[1]), number = Number(q.get('page'));
    return { kind, items: rows, limit: Number(q.get('limit')), page: number, order: q.get('order') ?? 'date_desc', has_more: false, next_cursor: null, total_count: rows.length, total_amount: '10.15', data_mode: 'erp_native', operational_effects: false }; };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/v1/documentos') return { read: [kind], write: [kind], data_mode: 'erp_native' };
      // 202610200166: without the export route (a database before 166) the month export keeps the CSV of the list.
      if (path.includes('/exportacao?')) throw new AccessError(404);
      if (path.includes('?')) return page(path);
      if (occurrences) return occurrences(path, options);
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
    ...(preferences ? { async preferences(path) { calls.push({ path, method: 'GET' }); return preferences; } } : {}),
  };
  return { calls, controller, lists: () => calls.filter(call => call.path.startsWith(`/v1/documentos/${kind}?`)).map(call => call.path) };
}
const mount = (srv, kind = 'purchase_orders', expand = [], modules = {}) => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: kind }, { location: `/documentos-empresa?tipo=${kind}`, expandChildren: ['NativeListLayout', 'DocumentList', ...expand], modules });
const select = row => view => view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === `Selecionar Pedido de compra ${row.number} · ${row.contact_name}`).props.onClick({ shiftKey: false });

test('pedidos de compra open on Em aberto and the last 30 days; Situação is one choice; Limpar filtros restores the defaults', async () => {
  const srv = server(), view = await mount(srv, 'purchase_orders', ['AppliedChips']);
  try {
    const first = new URLSearchParams(srv.lists()[0].split('?')[1]);
    assert.deepEqual([first.get('status'), first.get('date_from'), first.get('date_to')], ['open', addDays(today, -29), today]);
    assert.match(view.text(), /Situação: Em aberto/);
    const options = view.input('documents-status-single').props.children.flat().filter(Boolean).map(option => option.props.children);
    assert.deepEqual(options, ['Todas', 'Em aberto', 'Atendido', 'Cancelado', 'Em andamento', 'Atendido parcialmente']);
    await view.change('documents-status-single', ''); await view.submit();
    assert.equal(new URLSearchParams(srv.lists().at(-1).split('?')[1]).has('status'), false, 'Todas');
    await view.click('Limpar filtros');
    assert.equal(new URLSearchParams(srv.lists().at(-1).split('?')[1]).get('status'), 'open');
    assert.equal(view.input('documents-search').props.placeholder, 'Pesquisa por nome, número do pedido ou ordem de compra');
    assert.equal(view.nodes().some(n => n.props?.title === 'Imprimir listagem de pedidos de compra'), true);
    assert.equal(view.nodes().filter(n => String(n.props?.['aria-label'] ?? '').startsWith('Visualizar ocorrências')).length, 2, 'clock on every row');
  } finally { view.unmount(); }
});

test('a selection shows the chip “Selecionados: N cadastro” and Informações with the exact Valor; the month export needs no selection', async () => {
  const downloads = recorder(), srv = server(), view = await mount(srv, 'purchase_orders', ['AppliedChips', 'Modal'], { ...DOWNLOAD, ...MODAL });
  try {
    await view.change('documents-origin', 'brufap'); await view.submit();
    select(row(1))(view); await view.flush(); select(row(2))(view); await view.flush();
    assert.match(view.text(), /Selecionados: 2 cadastros/);
    assert.match(view.text(), /Valor/); assert.match(view.text(), /10,15/);
    assert.equal(view.button('Exportar para a planilha').disabled, true);
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Remover filtro Selecionados: 2 cadastros').props.onClick(); await view.flush();
    assert.doesNotMatch(view.text(), /Selecionados: 2/);
    await view.click('Exportar para a planilha');
    await view.change('documents-export-month', '02'); await view.change('documents-export-year', '2028');
    await view.click('Download');
    const read = new URLSearchParams(srv.lists().at(-1).split('?')[1]);
    assert.deepEqual([read.get('date_from'), read.get('date_to'), read.has('status')], ['2028-02-01', '2028-02-29', false], 'the whole month, any situação');
    assert.equal(downloads.downloads.at(-1)[0], 'pedidos-de-compra-2028-02.csv');
    assert.match(downloads.downloads.at(-1)[1], /Fornecedor sintético 1/);
  } finally { view.unmount(); }
});

test('an empty search shows the Origin “Nenhum resultado encontrado.”', async () => {
  const srv = server({ rows: [] }), view = await mount(srv);
  try { assert.match(view.text(), /Nenhum resultado encontrado\.Verifique se as palavras estão corretas ou busque por outros termos\./); }
  finally { view.unmount(); }
});

test('Exibir totais em listas: users outside the list do not see the Valor total of the pedidos', async () => {
  const hidden = server({ kind: 'sales_orders', rows: [row(1, { kind: 'sales_orders' })], role: 'vendas', preferences: preferenceView('vendas-vendas', { 'vendas.exibir_totais_usuarios': ['20000000-0000-4000-8000-000000000999'] }) });
  const view = await mount(hidden, 'sales_orders');
  try {
    assert.equal(hidden.calls.some(call => call.path === '/v1/preferencias/vendas-vendas'), true); assert.doesNotMatch(view.text(), /Valor total/);
    // Imprimir listagem follows the same preference as the Informações panel.
    component(view, 'ToolButton').props.onClick(); await view.flush();
    assert.equal(component(view, 'DocumentListPrint').props.snapshot.total_amount, null);
  }
  finally { view.unmount(); }
  const shown = server({ kind: 'sales_orders', rows: [row(1, { kind: 'sales_orders' })], role: 'vendas', preferences: preferenceView('vendas-vendas', { 'vendas.exibir_totais_usuarios': [actor] }) });
  const other = await mount(shown, 'sales_orders');
  try { assert.match(other.text(), /Valor total/); } finally { other.unmount(); }
});

test('Ocorrências: names from Sistema › Usuários and “Remover ocorrência” confirmed first, with Conferir resultado when unconfirmed', async () => {
  const occurrence = (n, extra = {}) => ({ id: `40000000-0000-4000-8000-00000000000${n}`, sequence: n, occurred_on: '2026-10-20', occurred_time: '10:0' + n, text: `Ocorrência ${n}`, status_before: 'open', status_after: null, next_contact: null, actor_id: actor, actor_role: 'estoque', document_version: 2, recorded_at: '2026-10-20T13:00:00Z', ...extra });
  let items = [occurrence(2, { actor_name: 'Ana Sintética' }), occurrence(1, { actor_name: null })], lose = true;
  const reply = (path, options) => {
    if (path.endsWith('/exclusao')) { if (lose) { lose = false; throw new AccessError(503); } const removed = path.split('/').at(-2); items = items.filter(item => item.id !== removed); return { kind: 'purchase_orders', replayed: true, removed_id: removed, document: { id: id(1), kind: 'purchase_orders', number: '41', status: 'open', version: 2 }, data_mode: 'erp_native', operational_effects: false }; }
    void options; return { kind: 'purchase_orders', document: { id: id(1), kind: 'purchase_orders', number: '41', status: 'open', version: 2 }, items, has_more: false, can_write: true };
  };
  const srv = server({ occurrences: reply }), view = await mount(srv, 'purchase_orders', ['DocumentOccurrences', 'Modal'], MODAL);
  try {
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Visualizar ocorrências de Pedido de compra 41 · Fornecedor sintético 1').props.onClick({ stopPropagation() {} }); await view.flush();
    assert.match(view.text(), /Ana Sintética/); assert.match(view.text(), /Você/, 'without a name, the own user is “Você”');
    assert.match(view.text(), /Atualize a situação do pedido de compra\. Ex\.: Atendido\./);
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Remover ocorrência 2').props.onClick(); await view.flush();
    assert.match(view.text(), /Confirma exclusão definitiva da ocorrência\?/);
    await view.click('Sim');
    assert.match(view.text(), /Não foi possível confirmar a remoção/);
    const first = srv.calls.filter(call => call.path.endsWith('/exclusao')).at(-1).body.command_id;
    await view.click('Conferir resultado');
    const retry = srv.calls.filter(call => call.path.endsWith('/exclusao')).at(-1);
    assert.equal(retry.body.command_id, first, 'the same command is repeated');
    assert.match(view.text(), /Ocorrência removida\./); assert.doesNotMatch(view.text(), /Ocorrência 2/);
  } finally { view.unmount(); }
});

test('Mais ações › Imprimir etiquetas reads the selected pedidos again and opens the labels of their products (202610200240)', async () => {
  const product = '50000000-0000-4000-8000-000000000240';
  const read = path => { const docId = path.split('/').at(-1), n = Number(docId.slice(-12));
    return { kind: 'purchase_orders', document: { id: docId, kind: 'purchase_orders', number: String(n + 40), status: 'open', version: 2, items: [{ product_id: product, description: 'Item sintético', code: 'ETQ-1', product_snapshot: { id: product, version: 1, name: 'Produto sintético', price: '3.5000', gtin: null } }, { product_id: null, description: 'Frete', code: null, product_snapshot: null }] } }; };
  const srv = server({ occurrences: read }), view = await mount(srv, 'purchase_orders');
  try {
    const button = () => view.nodes().find(n => n.type === 'button' && n.props.title === 'Selecione os pedidos na listagem.' || n.type === 'button' && n.props.title === 'Etiquetas dos produtos dos pedidos de compra selecionados');
    assert.equal(button().props.disabled, true, 'nothing selected');
    select(row(1))(view); await view.flush(); select(row(2))(view); await view.flush();
    assert.equal(button().props.disabled, false);
    button().props.onClick(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.deepEqual(srv.calls.filter(call => /\/v1\/documentos\/purchase_orders\/[0-9a-f-]{36}$/.test(call.path)).map(call => call.path), [`/v1/documentos/purchase_orders/${id(1)}`, `/v1/documentos/purchase_orders/${id(2)}`]);
    const labels = component(view, 'ProductLabels');
    assert.ok(labels, 'ProductLabels opened');
    assert.deepEqual(labels.props.products.map(p => [p.id, p.name, p.code, p.price]), [[product, 'Produto sintético', 'ETQ-1', '3.5000']], 'each product once, free items left out');
  } finally { view.unmount(); }
});
