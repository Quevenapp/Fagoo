import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { conditionText, monthOf, salesReportQuery, serviceCondition, defaultSalesParams } from '../src/lib/document-reports-model.ts';

// 202610200130 Relatórios de vendas e de serviço (RealDocuments → DocumentReports) with a synthetic controller; no DOM, no network.
const actor = '20000000-0000-4000-8000-000000000132', contact = '30000000-0000-4000-8000-000000000132';
const PORTAL = { 'react-dom': 'export const createPortal=child=>child;' };
function server({ kind = 'sales_orders', role = 'vendas', reply } = {}) {
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push(path);
      if (path === '/v1/documentos') return { read: [kind], write: [], data_mode: 'erp_native' };
      if (/\/(relatorio-vendas|curva-abc|relatorio-os|relatorio-ocorrencias)/.test(path)) return reply(path, options);
      if (path.includes('?')) return { kind, items: [], limit: 100, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
  };
  return { calls, controller, reports: () => calls.filter(path => /relatorio|curva/.test(path)), become: value => { snapshot = value; } };
}
const mount = (srv, kind, search) => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: kind }, { location: `/documentos-empresa?tipo=${kind}&acao=relatorios${search}`, expandChildren: ['DocumentReports', 'Catalog', 'SalesReportView', 'AbcReportView', 'ServiceReportView', 'ServiceOccurrenceView'] });
const sales = query => ({ report: 'sales', from: query.get('from'), to: query.get('to'), group: query.get('group'), subgroup: query.get('subgroup'), item_values: query.get('group') === 'product', include_freight: query.get('include_freight') === 'true',
  groups: [{ key: contact, label: 'Cliente sintético', sales: 2, items: '3.500000', amount: '1234.56', subgroups: [] }], group_count: 1, truncated: false, totals: { sales: 2, items: '3.500000', amount: '1234.56' }, data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' });

test('the model builds the Origin parameters and conditions exactly', () => {
  assert.deepEqual(monthOf('2026-02-15'), { from: '2026-02-01', to: '2026-02-28' }); assert.deepEqual(monthOf('2026-01-10', -1), { from: '2025-12-01', to: '2025-12-31' });
  const params = { ...defaultSalesParams('2026-10-20'), subgroup: 'product', statuses: ['open'], includeFreight: false, state: 'SP', city: ' Piracicaba ', firstPurchase: true };
  assert.equal(String(salesReportQuery(params)), 'from=2026-10-01&to=2026-10-31&group=contact&order=name&include_freight=false&subgroup=product&status=open&city=Piracicaba&state=SP&first_purchase=true');
  assert.throws(() => salesReportQuery({ ...params, subgroup: 'contact' }), /sub agrupamento diferente/);
  assert.throws(() => salesReportQuery({ ...params, from: '2026-11-01' }), /anterior ou igual/);
  assert.deepEqual(serviceCondition('date', '05/10/2026'), { column: 'date', value: '2026-10-05' });
  assert.deepEqual(serviceCondition('total', '1.234,50'), { column: 'total', value: '1234.50' });
  assert.deepEqual(serviceCondition('status', 'Aprovada'), { column: 'status', value: 'approved' });
  assert.throws(() => serviceCondition('number', '012'), /sem zeros/); assert.throws(() => serviceCondition('date', '31/02/2026'), /dd\/mm\/aaaa/);
  assert.equal(conditionText({ column: 'date', value: '2026-10-05' }), 'Data: 05/10/2026');
});

test('Relatórios de vendas: the catalog in the Origin order, available cards open the report, the others say why', async () => {
  const srv = server({ reply: () => { throw new AccessError(500); } }), view = await mount(srv, 'sales_orders', '');
  try {
    assert.match(view.text(), /Relatórios de vendas/);
    for (const title of ['Relatório de Separação (Picking)', 'Relatório Complementar de Comissões', 'Notas Fiscais ICMS DIFAL', 'Evolução do Faturamento', 'Relatório de Romaneio']) assert.match(view.text(), new RegExp(title.replace(/[()]/g, '\\$&')));
    assert.equal(view.nodes().filter(n => n.type === 'button' && String(n.props.className).includes('document-report-card')).length, 9, 'Romaneio (271), Vendas, bairro, curva ABC and the five Relatórios de Notas Fiscais (362)');
    view.nodes().find(n => n.type === 'button' && String(n.props.className).includes('document-report-card') && /Relatório de Vendas Agrupado por bairro/.test(JSON.stringify(n.props.children))).props.onClick(); await view.flush();
    assert.equal(new URLSearchParams(view.location().search).get('relatorio'), 'bairro');
  } finally { view.unmount(); }
});

test('Relatório de Vendas: parameters, Visualizar, exact values and the print sheet; a late answer for another user is dropped', async () => {
  let release; const srv = server({ reply: path => { const query = new URLSearchParams(path.split('?')[1]); if (query.get('order') === 'sales') return new Promise(resolve => { release = () => resolve(sales(query)); }); return sales(query); } });
  const view = await mount(srv, 'sales_orders', '&relatorio=vendas');
  try {
    await view.change('report-group', 'product'); await view.click('Outras opções de pesquisa ›');
    await view.change('report-subgroup', 'contact'); view.input('report-freight').props.onChange({ target: { checked: false } }); await view.flush();
    await view.submit();
    const query = new URLSearchParams(srv.reports().at(-1).split('?')[1]);
    assert.deepEqual([query.get('group'), query.get('subgroup'), query.get('include_freight')], ['product', 'contact', 'false']);
    assert.match(view.text(), /Cliente sintético/); assert.match(view.text(), /1\.234,56/); assert.match(view.text(), /3,5/);
    assert.match(view.text(), /Valor = total dos itens/);
    await view.click('Imprimir');
    const sheet = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'ReportPrint');
    assert.equal(sheet.props.title, 'Relatório de Vendas'); assert.match(sheet.props.subtitle, /^01\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}$/);
    sheet.props.onClose(); await view.flush();
    await view.change('report-order', 'sales'); await view.submit();
    srv.become({ phase: 'ready', membership: { user_id: '20000000-0000-4000-8000-000000000999', role: 'vendas' } });
    release(); await view.flush();
    assert.match(view.text(), /A sessão mudou durante a consulta/); assert.doesNotMatch(view.text(), /1\.234,56/);
  } finally { view.unmount(); }
});

test('curva ABC opens on the last 30 days and shows the classes', async () => {
  const srv = server({ reply: path => { const query = new URLSearchParams(path.split('?')[1]); return { report: 'abc', from: query.get('from'), to: query.get('to'), items: [{ position: 1, product_id: null, description: 'Bucha', code: 'B1', quantity: '10', amount: '90.00', percent: '90.00', accumulated: '90.00', class: 'A' }, { position: 2, product_id: null, description: 'Arruela', code: null, quantity: '1', amount: '10.00', percent: '10.00', accumulated: '100.00', class: 'B' }], item_count: 2, truncated: false, total: '100.00', data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' }; } });
  const view = await mount(srv, 'sales_orders', '&relatorio=curva-abc');
  try {
    const query = new URLSearchParams(srv.reports()[0].split('?')[1]);
    assert.equal((Date.parse(`${query.get('to')}T00:00:00Z`) - Date.parse(`${query.get('from')}T00:00:00Z`)) / 86_400_000, 29);
    assert.match(view.text(), /Bucha/); assert.match(view.text(), /90,00/); assert.match(view.text(), /Curva A: itens que somam até 80%/);
  } finally { view.unmount(); }
});

test('Relatório de Ordem de Serviço: Coluna + Valor conditions, Registros nesta exibição and the Origin empty text; Ocorrências por OS', async () => {
  let rows = [{ id: '40000000-0000-4000-8000-000000000001', number: '7', name: 'Cliente OS', date: '2026-10-10', parts: '20.00', services: '75.00', total: '95.00', status: 'open' }];
  const srv = server({ kind: 'service_orders', reply: path => path.includes('relatorio-os') ? { report: 'service_orders', rows, row_count: rows.length, truncated: false, data_mode: 'erp_native', operational_effects: false, kind: 'service_orders' }
    : { report: 'service_occurrences', from: new URLSearchParams(path.split('?')[1]).get('from'), to: new URLSearchParams(path.split('?')[1]).get('to'), rows: [{ document_id: '40000000-0000-4000-8000-000000000001', number: '7', name: 'Cliente OS', occurred_on: '2026-10-12', occurred_time: '09:30', text: 'Peça encomendada', status_before: 'open', status_after: null, actor_name: 'Ana', actor_role: 'vendas' }], row_count: 1, truncated: false, data_mode: 'erp_native', operational_effects: false, kind: 'service_orders' } });
  const view = await mount(srv, 'service_orders', '&relatorio=os');
  try {
    await view.change('service-column', 'name'); await view.change('service-value', 'cliente'); await view.click('+');
    await view.change('service-column', 'date'); await view.change('service-value', '10/10/2026'); await view.click('+');
    assert.match(view.text(), /Nome: cliente/); assert.match(view.text(), /Data: 10\/10\/2026/);
    await view.click('Visualizar');
    assert.deepEqual(JSON.parse(new URLSearchParams(srv.reports().at(-1).split('?')[1]).get('condicoes')), [{ column: 'name', value: 'cliente' }, { column: 'date', value: '2026-10-10' }]);
    assert.match(view.text(), /Registros nesta exibição1/); assert.match(view.text(), /95,00/);
    rows = []; await view.click('Visualizar');
    assert.match(view.text(), /A consulta não retornou nenhum registro\. Verifique os filtros utilizados nas opções das colunas disponíveis para este relatório customizado ou clique no botão Visualizar\./);
    // 202610200238 (wave E): Configurar opens the gerenciador de relatórios customizados.
    assert.equal(view.find(n => n.type === 'test-router-link' && n.props.children === 'Configurar').props.to, '/preferencias/sistema/relatorios-customizados');
  } finally { view.unmount(); }
  const other = await mount(srv, 'service_orders', '&relatorio=ocorrencias');
  try { await other.submit(); assert.match(other.text(), /Peça encomendada/); assert.match(other.text(), /Ana/); } finally { other.unmount(); }
  const catalog = await mount(srv, 'service_orders', '');
  try { assert.match(catalog.text(), /Relatório de Ocorrências por Ordem de Serviço/); assert.match(catalog.text(), /CRIAR RELATÓRIO/); assert.equal(catalog.find(n => n.type === 'test-router-link' && n.props.children === 'CRIAR RELATÓRIO').props.to, '/preferencias/sistema/relatorios-customizados'); } finally { catalog.unmount(); }
});

test('a report of another kind or an unknown report is refused; the list offers Ferramentas de apoio', async () => {
  const srv = server({ reply: () => ({}) }), view = await mount(srv, 'sales_orders', '&relatorio=os');
  try { assert.match(view.text(), /Relatório não encontrado/); } finally { view.unmount(); }
  const list = await mountComponent('RealDocuments.tsx', { controller: server({ reply: () => ({}) }).controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders', expandChildren: ['NativeListLayout', 'DocumentList'] });
  try { assert.match(list.text(), /Ferramentas de apoio/); assert.match(list.text(), /Ver relatórios de vendas/); assert.match(list.text(), /Acesse os parâmetros de pedidos de venda/); } finally { list.unmount(); }
});

test('"Não considerar pedidos com nota fiscal gerada" is for the profiles that read the FAGOO notas', async () => {
  for (const [role, enabled] of [['vendas', false], ['estoque', false], ['fiscal', true], ['admin', true]]) {
    const srv = server({ role, reply: path => sales(new URLSearchParams(path.split('?')[1])) }), view = await mount(srv, 'sales_orders', '&relatorio=vendas');
    try {
      await view.click('Outras opções de pesquisa ›');
      const box = view.input('report-without-invoice');
      assert.equal(box.props.disabled, !enabled, role);
      if (enabled) { box.props.onChange({ target: { checked: true } }); await view.flush(); }
      await view.submit();
      assert.equal(new URLSearchParams(srv.reports().at(-1).split('?')[1]).get('without_invoice'), enabled ? 'true' : null, role);
    } finally { view.unmount(); }
  }
});
