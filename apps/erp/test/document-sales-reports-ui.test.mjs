import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { choiceHas, defaultRomaneioParams, defaultSalesParams, readSalesOptions, romaneioAddressText, romaneioQuery, salesReportQuery, toggleChoice } from '../src/lib/document-reports-model.ts';

// 202610200271 Relatório de Vendas (Vendedor, Fornecedor, Depósito, Categorias, Tipo de contato, Tags, Data do faturamento, Exibir lucro) and the
// Relatório de Romaneio, with a synthetic controller; no DOM, no network.
const actor = '20000000-0000-4000-8000-000000000271';
const id = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OPTIONS = { report: 'sales_options', contact_types: [{ id: id(1), label: 'Cliente' }, { id: id(2), label: 'Atacado' }], tags: [{ id: id(3), name: 'Grupo › Linha' }], tag_count: 1,
  sellers: [{ id: id(4), name: 'Vendedora Sintética' }], seller_count: 1, profit_visible: true, invoice_visible: true, data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' };
const CATEGORIES = { kind: 'sales_orders', category_kind: 'receivable', items: [{ id: id(5), name: 'Vendas', parent_id: null, depth: 1 }, { id: id(6), name: 'Balcão', parent_id: id(5), depth: 2 }], total_count: 2, default: null, has_more: false, data_mode: 'erp_native', operational_effects: false };
function server({ role = 'admin', options = () => ({ ...OPTIONS, profit_visible: role !== 'vendas', invoice_visible: ['admin', 'fiscal'].includes(role) }), reply } = {}) {
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async documents(path, request = {}) {
      calls.push(path);
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: [], data_mode: 'erp_native' };
      if (path === '/v1/documentos/sales_orders/relatorio-vendas/opcoes') return options();
      if (path === '/v1/documentos/sales_orders/categorias') return CATEGORIES;
      if (/\/(relatorio-vendas|romaneio)\?/.test(path)) return reply(path, request);
      if (path.includes('?')) return { kind: 'sales_orders', items: [], limit: 100, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products', 'warehouses'], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
  };
  return { calls, controller, last: name => new URLSearchParams(calls.filter(path => path.includes(`/${name}?`)).at(-1)?.split('?')[1] ?? ''), become: value => { snapshot = value; } };
}
const mount = (srv, report) => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: 'sales_orders' }, { location: `/documentos-empresa?tipo=sales_orders&acao=relatorios&relatorio=${report}`, expandChildren: ['DocumentReports', 'SalesReportView', 'RomaneioView', 'Checklist'] });
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const sales = (query, extra = {}) => ({ report: 'sales', from: query.get('from'), to: query.get('to'), date_type: query.get('date_type') ?? 'date', group: query.get('group'), subgroup: query.get('subgroup'), item_values: false, include_freight: true,
  show_profit: query.get('show_profit') === 'true', profit_base: query.get('profit_base'), groups: [{ key: id(9), label: 'Cliente sintético', sales: 2, items: '3', amount: '100.00', cost: '40.00', profit: '60.00', subgroups: [] }], group_count: 1, truncated: false,
  totals: { sales: 2, items: '3', amount: '100.00', cost: '40.00', profit: '60.00', items_without_cost: 1 }, data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders', ...extra });

test('model: the 271 parameters, the Origin checkbox lists and the romaneio query', () => {
  const all = [id(1), id(2)];
  let choice = toggleChoice(null, all, id(1), false);
  assert.deepEqual(choice, { ids: [id(2)], none: true });
  assert.equal(choiceHas(choice, id(1)), false); assert.equal(choiceHas(choice, '', true), true);
  assert.equal(toggleChoice(choice, all, id(1), true), null, 'every box checked again is no filter');
  choice = toggleChoice(null, all, '', false, true);
  assert.deepEqual(choice, { ids: all, none: false });
  const params = { ...defaultSalesParams('2026-10-20'), seller: id(4), supplier: { id: id(7), name: 'Fornecedor' }, warehouse: { id: id(8), name: 'Depósito' }, categories: [id(5)], contactTypes: { ids: [id(2)], none: true },
    tags: { ids: [], none: true }, showProfit: true, profitBase: 'last_purchase_until', dateType: 'invoice' };
  assert.equal(String(salesReportQuery(params)), `from=2026-10-01&to=2026-10-31&group=contact&order=name&include_freight=true&date_type=invoice&seller_id=${id(4)}&supplier_id=${id(7)}&warehouse_id=${id(8)}&categories=${id(5)}&contact_types=${id(2)}&contact_untyped=true&tags=&untagged=true&show_profit=true&profit_base=last_purchase_until`);
  assert.throws(() => salesReportQuery({ ...params, contactTypes: { ids: [], none: false } }), /ao menos um tipo de contato/);
  assert.throws(() => salesReportQuery({ ...params, tags: { ids: [], none: false } }), /ao menos uma tag/);
  assert.throws(() => salesReportQuery({ ...params, tags: { ids: Array.from({ length: 101 }, (_, i) => id(100 + i)), none: false } }), /até 100 tags/);
  assert.equal(String(salesReportQuery(defaultSalesParams('2026-10-20'))), 'from=2026-10-01&to=2026-10-31&group=contact&order=name&include_freight=true', 'nothing new by default');
  assert.equal(String(romaneioQuery({ ...defaultRomaneioParams('2026-10-20'), dateType: 'ship_date', status: 'open', carrier: { id: id(7), name: 'T' } })), `from=2026-10-01&to=2026-10-31&date_type=ship_date&status=open&carrier_id=${id(7)}`);
  assert.throws(() => romaneioQuery({ ...defaultRomaneioParams('2026-10-20'), from: '2025-01-01' }), /até um ano/);
  assert.equal(romaneioAddressText({ source: 'delivery', name: null, street: 'Rua Um', number: '1', complement: null, district: 'Centro', city: 'Campinas', state: 'SP', postal_code: '13000-000' }), 'Rua Um, 1 · Centro · Campinas/SP · CEP 13000-000');
  assert.equal(romaneioAddressText({ source: 'contact', name: null, street: null, number: null, complement: null, district: null, city: null, state: null, postal_code: null }), 'Endereço não informado');
  assert.throws(() => readSalesOptions({ ...OPTIONS, report: 'sales' }), /REPORT_INVALID/);
  assert.equal(readSalesOptions(OPTIONS).sellers[0].name, 'Vendedora Sintética');
});

test('Relatório de Vendas: Exibir lucro with Utilizar como base, Vendedor, Categorias, Tipo de contato and Tags reach the query; Custo and Lucro columns', async () => {
  const srv = server({ reply: path => sales(new URLSearchParams(path.split('?')[1])) }), view = await mount(srv, 'vendas');
  try {
    await settle(view); await view.click('Outras opções de pesquisa ›');
    const profit = view.input('report-profit');
    assert.equal(profit.props.disabled, false);
    profit.props.onChange({ target: { checked: true } }); await view.flush();
    const base = view.nodes().find(n => n.type === 'select' && n.props.id === 'report-profit-base');
    // Leva H (374): the cost history and the cost applied on the operation are bases now.
    assert.deepEqual(base.props.children.map(o => [o.props.value, o.props.disabled]), [['cost', undefined], ['last_purchase', undefined], ['last_purchase_until', undefined], ['cost_until', undefined], ['applied', undefined]]);
    assert.match(view.text(), /para vendas antigas, use as bases até a data do pedido ou o custo aplicado na operação/);
    await view.change('report-profit-base', 'last_purchase');
    await view.change('report-seller', id(4));
    view.input(`report-category-${id(6)}`).props.onChange({ target: { checked: true } }); await view.flush();
    view.input(`report-type-${id(1)}`).props.onChange({ target: { checked: false } }); await view.flush();
    view.input('report-tag-none').props.onChange({ target: { checked: false } }); await view.flush();
    assert.equal(view.input('report-date-type').props.children[1].props.disabled, false, 'admin reads the Data do faturamento');
    await view.submit();
    const query = srv.last('relatorio-vendas');
    assert.deepEqual(['show_profit', 'profit_base', 'seller_id', 'categories', 'contact_types', 'contact_untyped', 'tags', 'untagged'].map(key => query.get(key)), ['true', 'last_purchase', id(4), id(6), id(2), 'true', id(3), null]);
    assert.match(view.text(), /Custo/); assert.match(view.text(), /Lucro/); assert.match(view.text(), /R\$ 60,00/);
    assert.match(view.text(), /Lucro = Valor − preço da última compra × quantidade; 1 item sem preço base entrou com custo zero\./);
    // Desmarcar todas leaves no tipo de contato: the screen says so instead of asking.
    await view.click('Desmarcar todas');
    const before = srv.calls.length; await view.submit();
    assert.match(view.text(), /Marque ao menos um tipo de contato/); assert.equal(srv.calls.length, before);
  } finally { view.unmount(); }
});

test('Exibir lucro and Data do faturamento follow the profile; options that fail keep the report usable', async () => {
  const srv = server({ role: 'vendas', reply: path => sales(new URLSearchParams(path.split('?')[1])) }), view = await mount(srv, 'vendas');
  try {
    await settle(view); await view.click('Outras opções de pesquisa ›');
    assert.equal(view.input('report-profit').props.disabled, true);
    assert.match(view.text(), /Disponível para os perfis que consultam os pedidos de compra/);
    assert.equal(view.input('report-date-type').props.children[1].props.disabled, true, 'Data do faturamento is for admin and fiscal');
    await view.submit(); assert.equal(srv.last('relatorio-vendas').get('show_profit'), null);
  } finally { view.unmount(); }
  const broken = server({ options: () => { throw new AccessError(503); }, reply: path => sales(new URLSearchParams(path.split('?')[1])) }), other = await mount(broken, 'vendas');
  try {
    await settle(other); await other.click('Outras opções de pesquisa ›');
    assert.equal(other.input('report-profit').props.disabled, true); assert.equal(other.input('report-seller').props.disabled, true);
    assert.match(other.text(), /Não foi possível carregar as opções do relatório/);
    await other.submit(); assert.match(other.text(), /Cliente sintético/, 'Visualizar still works');
  } finally { other.unmount(); }
});

test('Relatório de Romaneio: parameters, pedidos with address, transportador, volumes, peso and items, print; a late answer for another user is dropped', async () => {
  let release;
  const romaneio = query => ({ report: 'romaneio', from: query.get('from'), to: query.get('to'), date_type: query.get('date_type') ?? 'date', row_count: 1, truncated: false, totals: { orders: 1, volumes: '2.000000', gross_weight: '12.500000' },
    rows: [{ id: id(20), number: '15', status: 'open', date: '2026-10-05', expected_date: null, ship_date: '2026-10-07', contact_name: 'Cliente Romaneio', phone: '(19) 3333-0000',
      address: { source: 'delivery', name: 'Galpão', street: 'Rua da Entrega', number: '200', complement: null, district: 'Vila F', city: 'Campinas', state: 'SP', postal_code: '13000-000' },
      carrier: 'Transportadora F', freight_mode: '1', volumes: '2.000000', gross_weight: '12.500000', items: [{ code: 'PF-1', description: 'Produto do romaneio', unit: 'CX', quantity: '3.000000' }] }],
    data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' });
  const srv = server({ reply: path => { const query = new URLSearchParams(path.split('?')[1]); if (query.get('status') === 'verified') return new Promise(resolve => { release = () => resolve(romaneio(query)); }); return romaneio(query); } });
  const view = await mount(srv, 'romaneio');
  try {
    await settle(view);
    assert.match(view.text(), /Relatório de Romaneio/);
    await view.change('romaneio-date-type', 'ship_date'); await view.submit();
    assert.equal(srv.last('romaneio').get('date_type'), 'ship_date');
    for (const text of ['Pedido nº 15', 'Cliente Romaneio', 'Endereço de entrega', 'Galpão · Rua da Entrega, 200 · Vila F · Campinas/SP · CEP 13000-000', 'Transportadora F', '1 - Contratação do Frete por conta do Destinatário (FOB)', 'Produto do romaneio', '12,5 kg'])
      assert.ok(view.text().includes(text), text);
    await view.click('Imprimir');
    const sheet = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'ReportPrint');
    assert.equal(sheet.props.title, 'Relatório de Romaneio'); assert.match(sheet.props.subtitle, /^Data saída: /);
    sheet.props.onClose(); await view.flush();
    await view.change('romaneio-status', 'verified'); await view.submit();
    srv.become({ phase: 'ready', membership: { user_id: '20000000-0000-4000-8000-000000000999', role: 'admin' } });
    release(); await view.flush();
    assert.match(view.text(), /A sessão mudou durante a consulta/); assert.doesNotMatch(view.text(), /Cliente Romaneio/);
  } finally { view.unmount(); }
});
