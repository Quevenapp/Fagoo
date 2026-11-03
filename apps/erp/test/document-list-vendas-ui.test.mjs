import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Vendas wave 2 on the real list (RealDocuments → DocumentList) with a synthetic controller: no DOM, no network.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002', contact = '30000000-0000-4000-8000-000000000001';
const row = (n, over = {}) => ({ id: id(n), kind: 'sales_orders', number: String(n + 6), version: 3, status: 'open', date: '2026-10-16', total: '10.00', contact_id: contact, contact_name: `Cliente sintético ${n}`, created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, ...over });
const component = (view, name, index = 0) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name)[index];
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const menuItems = (view, rowId) => components(view, 'RowMenu')[view.nodes().filter(tr => tr.type === 'tr' && String(tr.props.className).startsWith('documents-row')).findIndex(tr => tr.key === rowId)].props.items;
const byLabel = (view, label) => view.find(n => n.type === 'button' && n.props['aria-label'] === label);
const recorder = () => { const calls = { downloads: [], opened: [] }; globalThis.__vendasDownloads = calls; return calls; };
const DOWNLOAD = { '../lib/document-download': 'export const downloadText=(...args)=>globalThis.__vendasDownloads.downloads.push(args);export const openExternal=url=>globalThis.__vendasDownloads.opened.push(url);' };

function server({ kind = 'sales_orders', rows = [row(1), row(2)], total, amount = '1234.56', role = 'admin', write = true, pageOf, get } = {}) {
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  const page = path => {
    const q = new URLSearchParams(path.split('?')[1]), number = Number(q.get('page'));
    const items = pageOf ? pageOf(number, q) : rows;
    return { kind, items, limit: Number(q.get('limit')), page: number, order: q.get('order') ?? 'date_desc', has_more: false, next_cursor: null, total_count: total ?? rows.length, total_amount: amount, data_mode: 'erp_native', operational_effects: false };
  };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async documents(path, options = {}) {
      const call = { path, method: options.method ?? 'GET' }; calls.push(call);
      if (path === '/v1/documentos') return { read: [kind], write: write ? [kind] : [], data_mode: 'erp_native' };
      if (path.includes('?')) return page(path);
      if (get) return get(call);
      throw new AccessError(404);
    },
    async catalog(path) { calls.push({ path, method: 'GET' }); if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
  };
  return { calls, controller, lists: () => calls.filter(call => call.path.startsWith(`/v1/documentos/${kind}?`)).map(call => call.path), become: value => { snapshot = value; } };
}
const mount = (srv, kind = 'sales_orders', expand = [], modules = {}) => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: kind }, { location: `/documentos-empresa?tipo=${kind}`, expandChildren: ['NativeListLayout', 'DocumentList', ...expand], modules });

test('search shows “Limpar o campo”, which clears the text and reapplies the list; the chip row always shows', async () => {
  const srv = server(), view = await mount(srv, 'sales_orders', ['AppliedChips']);
  try {
    assert.match(view.text(), /Nenhum filtro aplicado/);
    assert.equal(view.nodes().some(n => n.props?.['aria-label'] === 'Limpar o campo'), false, 'no clear button on an empty field');
    await view.change('documents-search', 'Cliente'); await view.submit();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1&q=Cliente');
    assert.equal(byLabel(view, 'Limpar o campo').props.title, 'Limpar o campo');
    byLabel(view, 'Limpar o campo').props.onClick(); await view.flush();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1'); assert.equal(view.input('documents-search').props.value, '');
    assert.match(view.text(), /Nenhum filtro aplicado/);
    await view.change('documents-search', 'rascunho'); const reads = srv.lists().length;
    byLabel(view, 'Limpar o campo').props.onClick(); await view.flush();
    assert.equal(srv.lists().length, reads, 'clearing text that was never applied does not reread the list');
  } finally { view.unmount(); }
});

test('situação uses the Origin colors: pedido badge, OS dot with the name, neutral proposal; info says Quantidade de Vendas', async () => {
  const srv = server({ rows: [row(1), row(2, { status: 'in_progress' })] }), view = await mount(srv, 'sales_orders', ['DocumentStatusBadge']);
  try {
    const badges = view.nodes().filter(n => n.type === 'span' && String(n.props.className).includes('document-status-color'));
    assert.deepEqual(badges.map(n => [n.props.children, n.props.style.backgroundColor, n.props.style.color]), [['Em aberto', '#E9DC40', '#1F2933'], ['Em andamento', '#0065F9', '#FFFFFF']]);
    assert.match(view.text(), /Quantidade de Vendas/);
  } finally { view.unmount(); }
  const os = server({ kind: 'service_orders', rows: [row(1, { kind: 'service_orders', status: 'waiting_parts' })] }), osView = await mount(os, 'service_orders', ['DocumentStatusBadge']);
  try {
    const dot = osView.find(n => n.type === 'span' && n.props.className === 'document-status-dot');
    assert.equal(dot.props.title, 'Aguardando componentes');
    assert.equal(osView.find(n => n.type === 'span' && n.props.className === 'document-status-dot-mark').props.style.color, '#241299');
    assert.match(osView.text(), /Aguardando componentes/, 'the name stays readable for screen readers');
  } finally { osView.unmount(); }
});

test('Imprimir listagem de vendas reads every page of the applied filter and opens one preview with the filtered totals', async () => {
  const all = Array.from({ length: 150 }, (_, index) => row(index + 1));
  const srv = server({ rows: all, total: 150, pageOf: number => all.slice((number - 1) * 100, number * 100) }), view = await mount(srv);
  try {
    await view.change('documents-search', 'Cliente'); await view.submit();
    const tool = component(view, 'ToolButton');
    assert.equal(tool.props.title, 'Imprimir listagem de vendas'); assert.equal(tool.props.disabled, false);
    tool.props.onClick(); await view.flush();
    assert.deepEqual(srv.lists().slice(-2), ['/v1/documentos/sales_orders?limit=100&page=1&q=Cliente', '/v1/documentos/sales_orders?limit=100&page=2&q=Cliente']);
    const preview = component(view, 'DocumentListPrint');
    assert.equal(preview.props.snapshot.rows.length, 150); assert.equal(preview.props.snapshot.total_amount, '1234.56');
    assert.deepEqual(preview.props.filters, ['Pesquisa: Cliente', 'Data do pedido: todo o período']);
    preview.props.onClose(); await view.flush(); assert.equal(component(view, 'DocumentListPrint'), undefined);
  } finally { view.unmount(); }
});

test('a page that changes during the read, a session change or an oversized filter never prints a partial list', async () => {
  let shrink = false;
  const all = Array.from({ length: 120 }, (_, index) => row(index + 1));
  const srv = server({ rows: all, total: 120, pageOf: number => number === 2 && shrink ? all.slice(100, 110) : all.slice((number - 1) * 100, number * 100) }), view = await mount(srv);
  try {
    shrink = true; component(view, 'ToolButton').props.onClick(); await view.flush();
    assert.match(view.text(), /A listagem mudou durante a leitura/); assert.equal(component(view, 'DocumentListPrint'), undefined);
    shrink = false; const original = srv.controller.documents.bind(srv.controller);
    srv.controller.documents = async (path, options) => { const value = await original(path, options); if (/page=1(&|$)/.test(path)) srv.become({ phase: 'ready', membership: { user_id: other, role: 'admin' } }); return value; };
    component(view, 'ToolButton').props.onClick(); await view.flush();
    assert.match(view.text(), /A sessão mudou durante a leitura/); assert.equal(component(view, 'DocumentListPrint'), undefined);
  } finally { view.unmount(); }
  const big = server({ rows: [row(1)], total: 6000 }), bigView = await mount(big);
  try {
    const reads = big.lists().length; component(bigView, 'ToolButton').props.onClick(); await bigView.flush();
    assert.equal(big.lists().length, reads, 'nothing is read beyond the safety limit'); assert.match(bigView.text(), /6\.000 registros\. Refine os filtros para até 5\.000/);
  } finally { bigView.unmount(); }
});

test('Mais ações › Exportar › Dados para planilha downloads the whole filtered set as CSV; propostas use “Exportar para a planilha”', async () => {
  const calls = recorder();
  const srv = server({ rows: [row(1, { contact_name: '=Cliente fórmula' }), row(2, { status: 'cancelled', total: '0.01' })], amount: '10.01' }), view = await mount(srv, 'sales_orders', [], DOWNLOAD);
  try {
    await view.click('Dados para planilha');
    assert.equal(calls.downloads.length, 1);
    const [filename, csv] = calls.downloads[0];
    assert.match(filename, /^pedidos-de-venda-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.match(csv, /"7";"16\/10\/2026";"";"'=Cliente fórmula";"10,00";"Em aberto";"FAGOO";"";"";""\r\n"8";"16\/10\/2026";"";"Cliente sintético 2";"0,01";"Cancelado";"FAGOO";"";"";""\r\n"Quantidade de Vendas";"2";"Valor total";"10,01"/);
    assert.match(view.text(), /Planilha gerada com 2 registros do filtro aplicado/);
  } finally { view.unmount(); }
  const proposals = server({ kind: 'sales_proposals', rows: [row(1, { kind: 'sales_proposals' })] }), proposalView = await mount(proposals, 'sales_proposals', [], DOWNLOAD);
  try { await proposalView.click('Exportar para a planilha'); assert.match(calls.downloads.at(-1)[0], /^propostas-comerciais-/); assert.equal(proposalView.nodes().some(n => n.type === 'h3' && n.props.children === 'Mais ações'), false); }
  finally { proposalView.unmount(); }
});

test('⋮ Enviar por WhatsApp rereads the saved document and opens wa.me with the client mobile; without a phone it explains', async () => {
  const calls = recorder();
  let mobile = '(19) 99876-5432';
  const document = () => ({ kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', number: '7', version: 3, date: '2026-10-16', contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético 1', mobile }, items: [{ description: 'Peça sintética', quantity: '2.000000', unit: 'UN', total: '10.00' }], totals: { total: '10.00' } } });
  const srv = server({ get: () => document() }), view = await mount(srv, 'sales_orders', [], DOWNLOAD);
  try {
    menuItems(view, id(1)).find(item => item.label === 'Enviar por WhatsApp').onClick(); await view.flush();
    assert.equal(srv.calls.at(-1).path, `/v1/documentos/sales_orders/${id(1)}`);
    assert.equal(calls.opened.length, 1); assert.match(calls.opened[0], /^https:\/\/wa\.me\/5519998765432\?text=Pedido%20de%20venda%20n%C2%BA%207/);
    assert.match(view.text(), /WhatsApp aberto com o resumo de Pedido 7/);
    mobile = '123'; menuItems(view, id(1)).find(item => item.label === 'Enviar por WhatsApp').onClick(); await view.flush();
    assert.equal(calls.opened.length, 1); assert.match(view.text(), /não tem celular ou telefone válido/);
  } finally { view.unmount(); }
  // The session changes while the saved version is read: nothing is opened and nothing is printed for the new user.
  let switched;
  const late = server({ get: call => { if (call.path === `/v1/documentos/sales_orders/${id(1)}`) switched.become({ phase: 'ready', membership: { user_id: other, role: 'admin' } }); return document(); } }); switched = late;
  mobile = '(19) 99876-5432';
  const lateView = await mount(late, 'sales_orders', [], DOWNLOAD);
  try {
    menuItems(lateView, id(1)).find(item => item.label === 'Enviar por WhatsApp').onClick(); await lateView.flush();
    assert.equal(calls.opened.length, 1, 'WhatsApp is not opened after the session changed'); assert.match(lateView.text(), /A sessão mudou durante a leitura/);
    late.become({ phase: 'ready', membership: { user_id: actor, role: 'admin' } });
    menuItems(lateView, id(1)).find(item => item.label === 'Imprimir comprovante').onClick(); await lateView.flush();
    assert.equal(component(lateView, 'DocumentPrintPreview'), undefined, 'no preview of a version read for another session');
  } finally { lateView.unmount(); }
});

test('vendas profile: no emission, stock or finance items in ⋮ and no NF-e batch button', async () => {
  const srv = server({ role: 'vendas' }), view = await mount(srv);
  try {
    const labels = menuItems(view, id(1)).map(item => item.label);
    for (const hidden of ['Gerar nota fiscal', 'Gerar NFC-e', 'Lançar estoque', 'Lançar contas']) assert.equal(labels.includes(hidden), false, hidden);
    assert.equal(view.nodes().some(n => n.type === 'button' && /Gerar NF-e dos pedidos selecionados/.test(JSON.stringify(n.props.children))), false);
  } finally { view.unmount(); }
});

test('a company without any order sees the Origin welcome cards; Nova venda opens the editor and Nova venda física opens the Frente de caixa', async () => {
  const srv = server({ rows: [], total: 0, amount: '0.00' }), view = await mount(srv);
  try {
    assert.match(view.text(), /Registre suas vendas facilmente no FAGOO\..*Registrar vendas manualmente.*Registrar vendas físicas/s);
    assert.equal(view.button('Nova venda física').disabled, false); assert.match(view.button('Nova venda física').props.title, /Frente de caixa/);
    await view.click('Nova venda');
    assert.ok(component(view, 'Editor'), 'Nova venda opens the same editor as + Incluir pedido');
  } finally { view.unmount(); }
  const filtered = server({ rows: [], total: 0, amount: '0.00' }), filteredView = await mount(filtered);
  try {
    await filteredView.change('documents-search', 'ninguém'); await filteredView.submit();
    assert.match(filteredView.text(), /Nenhum documento encontrado/); assert.doesNotMatch(filteredView.text(), /Registre suas vendas/);
  } finally { filteredView.unmount(); }
});

test('period calendars switch to month, year and decade views from the title and offer Hoje / Limpar', async () => {
  const applied = [];
  const view = await mountComponent('OriginList.tsx', { from: '2026-10-05', to: '2026-10-20', today: '2026-10-20', dateType: 'Data do pedido', dateTypes: ['Data do pedido'], prefixLabel: true, onApply: range => applied.push(range) }, { componentName: 'PeriodPicker', expandChildren: ['CalendarMonth'] });
  const footer = label => view.nodes().filter(n => n.type === 'button' && n.props.className === 'text-button' && n.props.children === label);
  const title = index => view.nodes().filter(n => n.type === 'button' && n.props.className === 'origin-calendar-title')[index];
  try {
    await view.click('Data do pedido: 05/10/2026 até 20/10/2026');
    assert.equal(title(0).props['aria-label'], 'Outubro 2026: alternar visão');
    title(0).props.onClick(); await view.flush();
    assert.match(view.text(), /2026.*Jan.*Fev.*Dez/s);
    await view.click('Mar'); assert.equal(title(0).props['aria-label'], 'Março 2026: alternar visão', 'a month opens its days');
    title(0).props.onClick(); await view.flush(); title(0).props.onClick(); await view.flush();
    assert.equal(title(0).props['aria-label'], '2020-2029: alternar visão');
    await view.click('2024'); assert.equal(title(0).props['aria-label'], '2024: alternar visão', 'a year opens its months');
    title(0).props.onClick(); await view.flush(); title(0).props.onClick(); await view.flush();
    assert.equal(title(0).props['aria-label'], '2000-2099: alternar visão'); assert.equal(title(0).props.disabled, false);
    // EST-009 (lane C): the century view is the top level, as in the Origin datepicker.
    title(0).props.onClick(); await view.flush();
    assert.equal(title(0).props['aria-label'], '2000-2999: alternar visão'); assert.equal(title(0).props.disabled, true, 'the century view is the top level');
    await view.click('2000'); assert.equal(title(0).props['aria-label'], '2000-2099: alternar visão', 'a century opens its decades');
    assert.equal(footer('Hoje').length, 2); assert.equal(footer('Limpar').length, 2);
    footer('Limpar')[0].props.onClick(); await view.flush(); await view.click('Filtrar');
    assert.deepEqual(applied.at(-1), { from: '', to: '2026-10-20', dateType: 'Data do pedido' });
    await view.click('Data do pedido: 05/10/2026 até 20/10/2026');
    footer('Limpar')[1].props.onClick(); await view.flush(); footer('Hoje')[0].props.onClick(); await view.flush(); await view.click('Filtrar');
    assert.deepEqual(applied.at(-1), { from: '2026-10-20', to: '', dateType: 'Data do pedido' }, 'Hoje uses the São Paulo business day given by the screen');
    assert.equal(title(0), undefined);
  } finally { view.unmount(); }
});

test('Filtrar has CEP, Bairro, Cidade, UF, Código de rastreio, Transportador and Nº do pedido de compra in Origin order; 1ª venda shows as a badge', async () => {
  const srv = server({ rows: [row(1, { first_sale: true, customer_po_number: null, ship_date: null, contact_email: null, contact_phone: null, contact_document: null, address: null, carrier_name: null })] }), view = await mount(srv);
  try {
    const order = view.nodes().filter(n => n.type === 'label' && /^documents-(filter|state)/.test(n.props.htmlFor ?? '')).map(n => n.props.children);
    // 202610200289: Lote (até 50 lotes separados por ;) comes after them.
    assert.deepEqual(order, ['CEP', 'Bairro', 'Cidade', 'UF', 'Código de rastreio', 'Transportador', 'Nº do pedido de compra', 'Lote']);
    await view.change('documents-filter-postalCode', '13400-12'); await view.change('documents-filter-district', ' Centro '); await view.change('documents-filter-trackingCode', 'BR1');
    await view.change('documents-filter-carrier', 'Transp'); await view.change('documents-filter-customerPo', 'PC-1'); await view.submit();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1&postal_code=1340012&district=Centro&tracking_code=BR1&carrier=Transp&customer_po_number=PC-1');
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['CEP: 13400-12', 'Bairro: Centro', 'Código de rastreio: BR1', 'Transportador: Transp', 'Nº do pedido de compra: PC-1']);
    const reads = srv.lists().length; await view.change('documents-filter-postalCode', '1340-0000-1'); await view.submit();
    assert.equal(srv.lists().length, reads); assert.match(view.text(), /Confira o filtro CEP/);
    assert.equal(view.find(n => n.type === 'span' && n.props.className === 'origin-tag documents-first-sale').props.children, '1ª venda');
    component(view, 'PeriodPicker').props.onApply({ from: '2026-10-01', to: '2026-10-31', dateType: 'Data de saída' }); await view.flush();
  } finally { view.unmount(); }
  const proposals = server({ kind: 'sales_proposals', rows: [row(1, { kind: 'sales_proposals', template: true })] }), proposalView = await mount(proposals, 'sales_proposals');
  try {
    // 202610200129: the Origin single list of the propostas; "Modelos" filters the templates.
    await proposalView.change('documents-proposal-status', 'modelos'); await proposalView.change('documents-filter-contactEmail', 'compras@'); await proposalView.submit();
    assert.equal(proposals.lists().at(-1), '/v1/documentos/sales_proposals?limit=100&page=1&contact_email=compras%40&template=true');
    assert.deepEqual(component(proposalView, 'AppliedChips').props.chips.map(chip => chip.label), ['Email do Cliente: compras@', 'Situação: Modelos']);
    component(proposalView, 'AppliedChips').props.chips[1].onRemove(); await proposalView.flush();
    assert.doesNotMatch(proposals.lists().at(-1), /template/);
  } finally { proposalView.unmount(); }
  const os = server({ kind: 'service_orders', rows: [row(1, { kind: 'service_orders' })] }), osView = await mount(os, 'service_orders');
  try {
    assert.deepEqual(component(osView, 'PeriodPicker').props.dateTypes, ['Período', 'Previstos para', 'Concluídos para', 'Data de Saída', 'Garantia']);
    component(osView, 'PeriodPicker').props.onApply({ from: '2026-10-01', to: '2026-10-31', dateType: 'Garantia' }); await osView.flush();
    assert.match(os.lists().at(-1), /date_type=warranty_until&date_from=2026-10-01&date_to=2026-10-31/);
    assert.equal(osView.input('documents-search').props.placeholder, 'Pesquisar por nome, e-mail, CEP, CPF/CNPJ ou n° da ordem');
  } finally { osView.unmount(); }
});

test('the clock “Visualizar ocorrências” opens the occurrences of the row and a change rereads the list', async () => {
  const srv = server({ rows: [row(1, { status: 'fulfilled', finance_active: true })] }), view = await mount(srv);
  try {
    byLabel(view, `Visualizar ocorrências de Pedido 7 · Cliente sintético 1`).props.onClick({ stopPropagation() {} }); await view.flush();
    const modal = component(view, 'DocumentOccurrences');
    assert.deepEqual([modal.props.kind, modal.props.documentId, modal.props.label], ['sales_orders', id(1), 'Pedido 7 · Cliente sintético 1']);
    assert.deepEqual(modal.props.targets('fulfilled'), [], 'active contas keep only the forward moves (none from Atendido)');
    assert.equal(modal.props.reasonNeeded('fulfilled', 'open'), true);
    const lists = srv.lists().length; modal.props.onClose(true); await view.flush();
    assert.equal(component(view, 'DocumentOccurrences'), undefined); assert.equal(srv.lists().length, lists + 1);
  } finally { view.unmount(); }
  const purchase = server({ kind: 'purchase_orders', rows: [row(1, { kind: 'purchase_orders' })] }), purchaseView = await mount(purchase, 'purchase_orders');
  // 202610200129: pedidos de compra have occurrences too.
  try { assert.equal(purchaseView.nodes().some(n => String(n.props?.['aria-label'] ?? '').startsWith('Visualizar ocorrências')), true, 'pedidos de compra show the clock'); }
  finally { purchaseView.unmount(); }
});

// 202610200104 settings: a controller that also answers /preferencias-listagem.
function viewServer({ kind = 'sales_orders', rows = [row(1, { customer_po_number: 'OC-1', address: 'Rua Sintética, 1 - Centro - Cidade/SP', ship_date: '2026-10-17', contact_email: null, contact_phone: null, contact_document: null, carrier_name: null, first_sale: false })], view = {}, post } = {}) {
  const srv = server({ kind, rows }); const original = srv.controller.documents.bind(srv.controller), saved = [];
  let current = { kind, custom_view: false, columns: kind === 'sales_orders' ? ['date', 'contact', 'total'] : [], default_statuses: kind === 'sales_proposals' ? ['draft', 'open', 'pending', 'waiting'] : kind === 'sales_orders' ? ['draft', 'open'] : ['open'], statuses_saved: false,
    available_columns: kind === 'sales_orders' ? ['date', 'contact', 'total', 'customer_po_number', 'address', 'ship_date', 'contact_email', 'contact_phone', 'contact_document', 'carrier_name'] : [], column_limit: 8, version: 0, data_mode: 'erp_native', operational_effects: false, ...view };
  srv.controller.documents = async (path, options = {}) => {
    if (!path.endsWith('/preferencias-listagem')) return original(path, options);
    srv.calls.push({ path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined });
    if (options.method === 'POST') { saved.push(structuredClone(options.body)); if (post) post(options.body); current = { ...current, custom_view: options.body.custom_view, columns: options.body.columns, default_statuses: options.body.default_statuses, statuses_saved: true, version: current.version + 1, replayed: false }; }
    return structuredClone(current);
  };
  return { ...srv, saved };
}

test('under the default Em aberto filter the welcome cards show only when the company has no order at all', async () => {
  const empty = viewServer({ rows: [] }), view = await mount(empty);
  try {
    assert.deepEqual(empty.lists(), ['/v1/documentos/sales_orders?limit=100&page=1&status=draft%2Copen', '/v1/documentos/sales_orders?limit=1&page=1'], 'one read without filters (one row) confirms the empty company');
    assert.match(view.text(), /Registre suas vendas facilmente no FAGOO\./);
  } finally { view.unmount(); }
  const some = viewServer({ rows: [] }), original = some.controller.documents;
  some.controller.documents = async (path, options = {}) => { const value = await original(path, options); return path.includes('?limit=1&') ? { ...value, items: [row(9)], total_count: 3, total_amount: '30.00' } : value; };
  const other = await mount(some);
  try {
    assert.match(other.text(), /Nenhum documento encontrado/); assert.doesNotMatch(other.text(), /Registre suas vendas/, 'orders in other situações: only the empty filter message');
  } finally { other.unmount(); }
  const failing = viewServer({ rows: [] }), first = failing.controller.documents;
  failing.controller.documents = async (path, options = {}) => { if (path.includes('?limit=1&')) throw new AccessError(503); return first(path, options); };
  const unknown = await mount(failing);
  try { assert.match(unknown.text(), /Nenhum documento encontrado/, 'without the confirmation the usual empty message stays'); }
  finally { unknown.unmount(); }
});

test('without a saved default the list opens on Origin “Em aberto”; Tornar padrão saves the chosen situações for this user', async () => {
  const srv = viewServer(), view = await mount(srv);
  try {
    assert.deepEqual(srv.lists(), ['/v1/documentos/sales_orders?limit=100&page=1&status=draft%2Copen'], 'only one first read, already filtered (a new order starts Em digitação)');
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Situação: Em digitação, Em aberto']);
    await view.change('documents-status-in_progress', true); await view.change('documents-status-default', true); await view.submit();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1&status=draft%2Copen%2Cin_progress');
    assert.deepEqual(srv.saved.map(body => [body.expected_version, body.default_statuses, body.custom_view]), [[0, ['draft', 'open', 'in_progress'], false]]);
    assert.match(view.text(), /A seleção de status padrão foi atualizada com sucesso/);
    assert.equal(view.input('documents-status-default').props.checked, false);
  } finally { view.unmount(); }
  const proposals = viewServer({ kind: 'sales_proposals', rows: [row(1, { kind: 'sales_proposals' })] }), proposalView = await mount(proposals, 'sales_proposals');
  // The modelos of "Selecione o modelo" are read apart (template=true).
  try { assert.equal(proposals.lists().find(path => !path.includes('template=true')), '/v1/documentos/sales_proposals?limit=100&page=1&status=draft%2Copen%2Cpending%2Cwaiting', 'propostas: Em aberto groups the open ones'); }
  finally { proposalView.unmount(); }
});

test('Visualizar listagem customizada opens Informações visíveis; Aplicar saves the columns and the table shows them in order', async () => {
  const srv = viewServer(), view = await mount(srv, 'sales_orders', ['ViewToggle']);
  try {
    byLabel(view, 'Visualizar listagem customizada').props.onClick(); await view.flush();
    const drawer = component(view, 'DocumentColumnsDrawer');
    assert.deepEqual([drawer.props.selected, drawer.props.limit], [['date', 'contact', 'total'], 8]);
    drawer.props.onApply(['date', 'customer_po_number', 'address', 'total']); await view.flush();
    assert.deepEqual(srv.saved.at(-1), { expected_version: 0, custom_view: true, columns: ['date', 'customer_po_number', 'address', 'total'], default_statuses: ['draft', 'open'], command_id: srv.saved.at(-1).command_id });
    const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
    const headers = view.nodes().filter(n => n.type === 'th').map(textOf);
    assert.deepEqual(headers.slice(1, 7), ['Número', 'Data', 'Número pedido de compra', 'Endereço', 'Total (R$)', 'Situação']);
    assert.match(view.text(), /OC-1.*Rua Sintética, 1 - Centro - Cidade\/SP/s); assert.equal(component(view, 'DocumentColumnsDrawer'), undefined);
    byLabel(view, 'Visualizar listagem padrão').props.onClick(); await view.flush();
    assert.deepEqual(srv.saved.at(-1).custom_view, false); assert.equal(srv.saved.at(-1).expected_version, 1);
    assert.equal(view.nodes().some(n => n.type === 'th' && n.props.children === 'Número pedido de compra'), false);
  } finally { view.unmount(); }
});

test('an unknown outcome while applying the columns keeps the drawer frozen with Conferir resultado and repeats the same command', async () => {
  let fail = true;
  const srv = viewServer({ post: () => { if (fail) { fail = false; throw new AccessError(503); } } }), view = await mount(srv, 'sales_orders', ['ViewToggle']);
  try {
    byLabel(view, 'Visualizar listagem customizada').props.onClick(); await view.flush();
    component(view, 'DocumentColumnsDrawer').props.onApply(['date', 'customer_po_number', 'total']); await view.flush();
    const drawer = component(view, 'DocumentColumnsDrawer');
    assert.ok(drawer, 'the drawer stays open'); assert.equal(drawer.props.uncertain, true); assert.match(drawer.props.error, /Conferir resultado/, 'the message is shown inside the drawer');
    drawer.props.onRetry(); await view.flush();
    assert.equal(srv.saved.length, 2); assert.equal(srv.saved[1].command_id, srv.saved[0].command_id, 'the same command is repeated');
    assert.equal(component(view, 'DocumentColumnsDrawer'), undefined); assert.match(view.text(), /Listagem customizada aplicada\./);
  } finally { view.unmount(); }
  const frozen = await mountComponent('DocumentColumnsDrawer.tsx', { available: ['date', 'contact', 'total'], selected: ['date'], limit: 8, busy: false, uncertain: true, error: 'Resultado não confirmado.', onRetry() {}, onCancel() {}, onApply() { throw new Error('Aplicar must not run'); } });
  try {
    const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
    const modal = frozen.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Modal');
    assert.deepEqual([].concat(modal.props.actions.props.children).filter(Boolean).map(textOf), ['Cancelar', 'Conferir resultado']);
    assert.equal(frozen.input('documents-column-contact').props.disabled, true, 'the choice is frozen until the result is known');
    assert.match(frozen.text(), /Resultado não confirmado\./);
  } finally { frozen.unmount(); }
});

test('a stale version (409) rereads the settings instead of overwriting them', async () => {
  let conflict = true;
  const srv = viewServer({ post: () => { if (conflict) { conflict = false; throw new AccessError(409); } } }), view = await mount(srv);
  try {
    const reads = srv.calls.filter(call => call.path.endsWith('/preferencias-listagem') && call.method === 'GET').length;
    await view.change('documents-status-default', true); await view.submit();
    assert.match(view.text(), /O documento mudou ou a situação atual não permite esta ação/);
    assert.equal(srv.calls.filter(call => call.path.endsWith('/preferencias-listagem') && call.method === 'GET').length, reads + 1, 'the settings are read again');
  } finally { view.unmount(); }
});

test('Informações visíveis keeps the column limit, reorders with the arrows or drag and applies only the active ones', async () => {
  const applied = [];
  const view = await mountComponent('DocumentColumnsDrawer.tsx', { available: ['date', 'contact', 'total', 'customer_po_number', 'address'], selected: ['date', 'contact'], limit: 3, busy: false, onCancel() {}, onApply: columns => applied.push(columns) });
  const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
  try {
    assert.match(view.text(), /Colunas customizadas.*Selecione abaixo quais colunas deseja que estejam visíveis na listagem.*Configurações por usuário/s);
    await view.change('documents-column-total', true);
    await view.change('documents-column-address', true);
    assert.match(view.text(), /Você não pode ativar mais do que 3 colunas/); assert.equal(view.input('documents-column-address').props.checked, false);
    byLabel(view, 'Mover Total (R$) para cima').props.onClick(); await view.flush();
    const lis = view.nodes().filter(n => n.type === 'li');
    lis[1].props.onDragStart(); await view.flush(); view.nodes().filter(n => n.type === 'li')[0].props.onDrop(); await view.flush();
    const modal = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Modal');
    assert.equal(modal.props.title, 'Informações visíveis');
    const apply = [].concat(modal.props.actions.props.children).find(node => node && textOf(node) === 'Aplicar');
    apply.props.onClick(); await view.flush();
    assert.deepEqual(applied, [['total', 'date', 'contact']]);
  } finally { view.unmount(); }
});

test('⋮ Imprimir comprovante / c/ detalhes / carnê open the matching preview; Mais ações export addresses and print labels of the selection', async () => {
  const calls = recorder();
  const fullDoc = () => ({ kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', number: '7', version: 3 } });
  const srv = server({ rows: [row(1, { address: 'Rua 1 - Centro', contact_email: null, contact_phone: null }), row(2, { address: null })], get: fullDoc }), view = await mount(srv, 'sales_orders', ['BatchDialog'], DOWNLOAD);
  try {
    for (const [label, variant, options] of [['Imprimir comprovante', 'receipt', {}], ['Imprimir c/ detalhes', 'normal', { detailed: true }], ['Imprimir carnê', 'carne', {}]]) {
      menuItems(view, id(1)).find(item => item.label === label).onClick(); await view.flush();
      const preview = component(view, 'DocumentPrintPreview');
      // 202610200129: the Preferências print options (defaults when the page is unreadable) go with every print.
      const { prefs, labels, ...rest } = preview.props.options;
      assert.deepEqual([preview.props.variant, rest], [variant, options], label);
      assert.equal(prefs.order, 'insertion'); assert.deepEqual(labels, {});
      preview.props.onClose(); await view.flush();
    }
    assert.equal(view.button('Endereços selecionados').disabled, true, 'needs a selection');
    view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar Pedido 7 · Cliente sintético 1').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Endereços selecionados');
    assert.match(calls.downloads.at(-1)[0], /^enderecos-pedidos-\d{4}-\d{2}-\d{2}\.csv$/); assert.match(calls.downloads.at(-1)[1], /"7";"Cliente sintético 1";"Rua 1 - Centro"/);
    await view.click('Etiquetas selecionadas');
    assert.deepEqual(component(view, 'DocumentLabelsPrint').props.labels, [{ name: 'Cliente sintético 1', address: 'Rua 1 - Centro', reference: 'Pedido 7' }]);
    component(view, 'DocumentLabelsPrint').props.onClose(); await view.flush();
    await view.click('Imprimir selecionados');
    assert.match(view.text(), /Opções de impressão.*Tipo de impressão.*Ordem dos itens.*Desmembrar produtos da estrutura.*Ocultar itens produzidos por terceiros/s);
    await view.change('documents-print-type', 'detailed'); await view.change('documents-print-order', 'alphabetical');
    assert.equal(component(view, 'Modal').props.title, 'Imprimir selecionados');
  } finally { view.unmount(); }
});

test('Origin routes: acao=incluir opens a new document, acao=clonar&origem=<id> the reviewed copy, others explain; Gerar nota fiscal opens a new tab', async () => {
  const opened = [], previous = globalThis.window; globalThis.window = { open: (...args) => opened.push(args) };
  try {
    const srv = server(), add = await mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders&acao=incluir', expandChildren: ['NativeListLayout', 'DocumentList'] });
    try {
      assert.equal(component(add, 'Editor').props.record, null, 'a new pedido opens directly');
      component(add, 'Editor').props.onClose(); await add.flush();
      assert.equal(add.location().search, '?tipo=sales_orders', 'closing removes the route action');
    } finally { add.unmount(); }
    const copySource = { id: id(1), kind: 'sales_orders', number: '7', version: 3, status: 'open', date: '2026-10-16', contact_id: contact, contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético 1' } };
    const cloneSrv = server({ get: () => ({ kind: 'sales_orders', document: copySource }) });
    cloneSrv.controller.documentCopy = async path => { cloneSrv.calls.push({ path, method: 'GET' }); throw new AccessError(409); };
    const clone = await mountComponent('RealDocuments.tsx', { controller: cloneSrv.controller, initialKind: 'sales_orders' }, { location: `/documentos-empresa?tipo=sales_orders&acao=clonar&origem=${id(1)}`, expandChildren: ['NativeListLayout', 'DocumentList'] });
    try { assert.ok(cloneSrv.calls.some(call => call.path === `/v1/duplicacao-documentos/sales_orders/${id(1)}/preview`), 'the clone reads the reviewed copy preview'); }
    finally { clone.unmount(); }
    const other = await mountComponent('RealDocuments.tsx', { controller: server().controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders&acao=venda-fisica', expandChildren: ['NativeListLayout', 'DocumentList'] });
    try { assert.equal(other.location().pathname, '/frente-caixa-empresa', 'Origin #add-fisica opens the Frente de caixa'); } finally { other.unmount(); }
    const list = server(), view = await mount(list);
    try {
      menuItems(view, id(1)).find(item => item.label === 'Gerar nota fiscal').onClick(); await view.flush();
      menuItems(view, id(1)).find(item => item.label === 'Gerar NFC-e').onClick(); await view.flush();
      assert.deepEqual(opened.slice(-2), [[`/historico-fiscal?modelo=55&origem=brufap&nota=nova&pedido=${id(1)}`, '_blank', 'noopener'], [`/historico-fiscal?modelo=65&origem=brufap&nota=nova&pedido=${id(1)}`, '_blank', 'noopener']]);
      view.find(n => n.type === 'button' && String(n.props.className).includes('documents-primary')).props.onClick({ ctrlKey: true }); await view.flush();
      assert.deepEqual(opened.at(-1), ['/documentos-empresa?tipo=sales_orders&acao=incluir', '_blank', 'noopener']);
    } finally { view.unmount(); }
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('OS period button shows only the calendar icon, keeping the period as accessible text', async () => {
  const os = server({ kind: 'service_orders', rows: [row(1, { kind: 'service_orders' })] }), view = await mount(os, 'service_orders');
  try { assert.equal(component(view, 'PeriodPicker').props.iconOnly, true); } finally { view.unmount(); }
  const picker = await mountComponent('OriginList.tsx', { from: '', to: '', today: '2026-10-20', dateType: 'Período', dateTypes: ['Período'], iconOnly: true, onApply() {} }, { componentName: 'PeriodPicker' });
  try {
    const chip = picker.find(n => n.type === 'button' && String(n.props.className).includes('origin-period-chip'));
    assert.equal(chip.props.className, 'origin-period-chip is-icon-only'); assert.equal(chip.props.title, 'Abrir períodos');
    assert.ok(picker.nodes().some(n => n.type === 'span' && n.props.className === 'sr-only' && n.props.children === 'Todo o período'));
  } finally { picker.unmount(); }
});

test('a user without the totals (Exibir totais em listas) sees no Valor total in Informações, the list print or the planilha', async () => {
  const calls = recorder();
  const srv = server({ rows: [row(1), row(2, { total: '0.01' })], amount: null }), view = await mount(srv, 'sales_orders', [], DOWNLOAD);
  try {
    assert.doesNotMatch(view.text(), /Valor total/, 'the server omitted the sum of the list');
    await view.click('Dados para planilha');
    const [, csv] = calls.downloads.at(-1);
    assert.match(csv, /"Quantidade de Vendas";"2"\r\n$/); assert.doesNotMatch(csv, /Valor total/);
    component(view, 'ToolButton').props.onClick(); await view.flush();
    const preview = component(view, 'DocumentListPrint');
    assert.equal(preview.props.snapshot.total_amount, null);
    assert.equal(preview.props.snapshot.rows.length, 2, 'the rows keep their own totals');
  } finally { view.unmount(); }
});

test('202610200289: Lote and Busca customizada filter the pedidos; the chips remove them', async () => {
  const srv = server(), view = await mount(srv, 'sales_orders', ['DocumentListSearch']);
  try {
    await view.change('documents-filter-lots', ' L-1; l-1 ;L-2 ');
    await view.click('Adicionar filtros');
    const select = label => view.find(n => n.type === 'select' && n.props['aria-label'] === label);
    select('Campo do filtro 1').props.onChange({ target: { value: 'total' } }); await view.flush();
    select('Condição do filtro 1').props.onChange({ target: { value: 'ge' } }); await view.flush();
    view.find(n => n.type === 'input' && n.props['aria-label'] === 'Valor do filtro 1').props.onChange({ target: { value: '10,5' } }); await view.flush();
    await view.submit();
    const query = new URLSearchParams(srv.lists().at(-1).split('?')[1]);
    assert.equal(query.get('lote'), 'L-1;L-2');
    assert.deepEqual(JSON.parse(query.get('busca')), [{ field: 'total', op: 'ge', value: '10.5' }], 'the decimal comma becomes a point');
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Lote: L-1; l-1 ;L-2', 'Busca customizada: 1 filtro']);
    // An incomplete condition is refused before the request.
    const reads = srv.lists().length;
    await view.click('Adicionar filtros'); await view.submit();
    assert.equal(srv.lists().length, reads); assert.match(view.text(), /Confira a Busca customizada/);
    component(view, 'AppliedChips').props.chips[1].onRemove(); await view.flush();
    assert.equal(new URLSearchParams(srv.lists().at(-1).split('?')[1]).has('busca'), false);
  } finally { view.unmount(); }
});
