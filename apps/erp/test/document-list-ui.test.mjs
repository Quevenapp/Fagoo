import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { decimalMoney } from '../src/lib/real-access.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { documentInput } from '../src/lib/real-documents-model.ts';
import { COPY_RESET_FIELDS } from '../src/lib/document-copy-model.ts';

// Origin list behavior of RealDocuments/DocumentList with a synthetic controller (no DOM, no network).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002', contact = '30000000-0000-4000-8000-000000000001';
const row = (n, over = {}) => ({ id: id(n), kind: 'sales_orders', number: String(n + 6), version: 3, status: 'open', date: '2026-10-16', total: '10.00', contact_id: contact, contact_name: 'Cliente sintético', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, ...over });
const component = (view, name, index = 0) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name)[index];
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
async function modalAction(view, label) {
  const modal = components(view, 'Modal').at(-1); let found;
  walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node) === label) found = node; });
  if (!found) throw new Error(`Missing dialog action ${label}`); if (found.props.disabled) throw new Error(`Disabled dialog action ${label}`);
  found.props.onClick?.({ preventDefault() {} }); await view.flush();
}
const menuItems = (view, rowId) => components(view, 'RowMenu')[view.nodes().filter(tr => tr.type === 'tr' && String(tr.props.className).startsWith('documents-row')).findIndex(tr => tr.key === rowId)].props.items;

function server({ kind = 'sales_orders', rows = [row(1), row(2)], total, role = 'admin', write = true, post, get, copy } = {}) {
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  const page = path => { const q = new URLSearchParams(path.split('?')[1]); return { kind, items: rows, limit: Number(q.get('limit')), page: Number(q.get('page')), order: q.get('order') ?? 'date_desc', has_more: false, next_cursor: null, total_count: total ?? rows.length, total_amount: '1234.56', data_mode: 'erp_native', operational_effects: false }; };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async documents(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined, signal: options.signal }; calls.push(call);
      if (path === '/v1/documentos') return { read: [kind], write: write ? [kind] : [], data_mode: 'erp_native' };
      if (path.includes('?')) return page(path);
      if (call.method === 'POST') { if (post) return post(call, calls); const target = rows.find(item => path.includes(item.id)); return { kind, document: { id: target.id, kind, status: call.body.status, version: target.version + 1 }, replayed: false, data_mode: 'erp_native', operational_effects: false }; }
      if (get) return get(call, calls);
      const target = rows.find(item => path.endsWith(item.id)); return { kind, document: { id: target.id, kind, version: target.version, number: target.number } };
    },
    async catalog(path) { calls.push({ path, method: 'GET' }); if (path === '/v1/cadastros') return { read: ['warehouses', 'products'], write: [] }; if (path.startsWith('/v1/cadastros/warehouses')) return { entity: 'warehouses', items: [{ id: id(90), name: 'Depósito Norte', active: true }], has_more: false }; return { items: [], has_more: false }; },
    async documentCopy(path, options = {}) { calls.push({ path, method: options.method ?? 'GET' }); return copy(path); },
  };
  return { calls, controller, lists: () => calls.filter(call => call.path.startsWith('/v1/documentos/') && call.path.includes('?')).map(call => call.path), posts: () => calls.filter(call => call.method === 'POST'), become: value => { snapshot = value; } };
}
const mount = (srv, kind = 'sales_orders', expand = []) => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: kind }, { location: `/documentos-empresa?tipo=${kind}`, expandChildren: ['NativeListLayout', 'DocumentList', ...expand] });

test('Origin list asks for 100 per page newest first, shows filtered totals, numbered pages, sortable columns and row indicators', async () => {
  const first = row(1, { source_proposal_id: id(70), source_proposal_number: '15', finance_active: true, stock_active: true, warehouse_name: 'Depósito Norte', fiscal_draft: true, internal_notes: 'Ligar antes da entrega', expected_date: '2026-10-20' });
  const srv = server({ rows: [first, row(2, { date: '2026-10-15' })], total: 250 }), view = await mount(srv);
  try {
    assert.deepEqual(srv.lists(), ['/v1/documentos/sales_orders?limit=100&page=1']);
    assert.deepEqual(view.nodes().filter(n => n.type === 'tr' && String(n.props.className).startsWith('documents-row')).map(n => n.key), [id(1), id(2)], 'rows keep the server order');
    const text = view.text();
    for (const expected of ['Quantidade de Vendas', '250', decimalMoney('1234.56'), 'Informações baseadas nos filtros aplicados.', '250 documentos encontrados', '(prevista até: 20/10/2026)']) assert.ok(text.includes(expected), expected);
    assert.equal(view.input('documents-search').props.placeholder, 'Pesquisar por nome, e-mail, CPF/CNPJ ou n° do pedido');
    assert.deepEqual(components(view, 'IndicatorLetter').map(n => [n.props.text, n.props.title]), [['P', 'Proposta comercial 15'], ['C', 'Contas lançadas'], ['E', 'Estoque lançado - Depósito: Depósito Norte'], ['N', 'Nota fiscal vinculada (rascunho no emissor)']]);
    assert.ok(view.nodes().some(n => n.props['aria-label'] === 'Observação interna: Ligar antes da entrega'));
    const pagination = component(view, 'OriginPagination').props;
    assert.deepEqual([pagination.page, pagination.pages, pagination.size, pagination.total], [1, 3, 100, 250]);
    pagination.onPage(3); await view.flush();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=3');
    assert.equal(view.nodes().find(n => n.type === 'th' && n.props['aria-sort'] === 'descending') && textOf(view.nodes().find(n => n.type === 'th' && n.props['aria-sort'] === 'descending')), 'Data');
    await view.click('Número'); assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1&order=number_desc', 'a new order restarts at page 1');
    await view.click('Número'); assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1&order=number_asc');
    await view.click('Data'); assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1');
  } finally { view.unmount(); }
});

test('Filtrar panel sends multi situação, depósito, cidade/UF and tipo de data; chips remove one filter and Limpar keeps the period', async () => {
  const srv = server(), view = await mount(srv);
  try {
    await view.change('documents-status-open', true); await view.change('documents-status-verified', true);
    await view.change('documents-warehouse', id(90)); await view.change('documents-filter-city', ' Piracicaba '); await view.change('documents-state', 'SP');
    await view.change('documents-search', ' 12.345.678/0001-90 '); await view.submit();
    assert.equal(srv.lists().at(-1), `/v1/documentos/sales_orders?limit=100&page=1&status=open%2Cverified&q=12.345.678%2F0001-90&warehouse_id=${id(90)}&city=Piracicaba&state=SP`);
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Situação: Em aberto, Verificado', 'Pesquisa: 12.345.678/0001-90', 'Depósito: Depósito Norte', 'Cidade: Piracicaba', 'UF: SP']);
    component(view, 'PeriodPicker').props.onApply({ from: '2026-10-01', to: '2026-10-31', dateType: 'Data prevista' }); await view.flush();
    assert.match(srv.lists().at(-1), /&date_type=expected_date&date_from=2026-10-01&date_to=2026-10-31&warehouse_id=/);
    assert.equal(component(view, 'PeriodPicker').props.dateType, 'Data prevista'); assert.equal(component(view, 'PeriodPicker').props.prefixLabel, true);
    component(view, 'AppliedChips').props.chips[2].onRemove(); await view.flush();
    assert.doesNotMatch(srv.lists().at(-1), /warehouse_id/); assert.equal(view.input('documents-warehouse').props.value, '');
    component(view, 'AppliedChips').props.onClear(); await view.flush();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1&date_type=expected_date&date_from=2026-10-01&date_to=2026-10-31');
    const before = srv.lists().length;
    await view.change('documents-filter-city', 'linha\nquebrada'); await view.submit();
    assert.equal(srv.lists().length, before, 'an invalid filter never reaches the server'); assert.match(view.text(), /Confira o filtro Cidade/);
  } finally { view.unmount(); }
});

// ⋮ situação (202610200103): Origin "Alterando situação para …" with Data, Hora and the occurrence text, sent as an occurrence.
const occurrenceResult = (call, target) => ({ kind: 'sales_orders', document: { id: target.id, kind: 'sales_orders', status: call.body.status, version: target.version + 1 }, replayed: false,
  occurrence: { id: id(99), sequence: 1, occurred_on: call.body.occurred_on, occurred_time: call.body.occurred_time, text: call.body.text, status_before: target.status, status_after: call.body.status, next_contact: null, actor_id: actor, actor_role: 'admin', document_version: target.version + 1, recorded_at: '2026-10-20T12:00:00Z' },
  data_mode: 'erp_native', operational_effects: false });
test('⋮ opens “Alterando situação para …”, records Data, Hora and the description as an occurrence and recovers an uncertain outcome with the same command', async () => {
  let fail = 0;
  const srv = server({ rows: [row(1), row(2, { status: 'verified', version: 4 })], post: call => {
    if (call.body.status === 'in_progress' && fail++ === 0) throw new AccessError(503);
    return occurrenceResult(call, call.path.includes(id(2)) ? row(2, { status: 'verified', version: 4 }) : row(1));
  } }), view = await mount(srv);
  try {
    assert.deepEqual(menuItems(view, id(1)).filter(item => item.icon === 'arrow-right').map(item => item.label), ['Em digitação', 'Verificado', 'Em andamento', 'Venda Agenciada', 'Atendido', 'Cancelado']);
    const lists = srv.lists().length;
    menuItems(view, id(1)).find(item => item.label === 'Verificado').onClick(); await view.flush();
    assert.equal(component(view, 'Modal').props.title, 'Alterando situação para Verificado'); assert.equal(srv.posts().length, 0, 'nothing is sent before Alterar situação');
    assert.match(view.input('documents-situation-date').props.value, /^\d{4}-\d{2}-\d{2}$/); assert.match(view.input('documents-situation-time').props.value, /^\d{2}:\d{2}$/);
    await view.change('documents-situation-date', '2026-10-19'); await view.change('documents-situation-time', '17:45'); await view.change('documents-situation-text', 'Conferido com o cliente');
    await modalAction(view, 'Alterar situação');
    assert.deepEqual(srv.posts().map(call => [call.path, call.body.expected_version, call.body.status, call.body.text, call.body.occurred_on, call.body.occurred_time]), [[`/v1/documentos/sales_orders/${id(1)}/ocorrencias`, 3, 'verified', 'Conferido com o cliente', '2026-10-19', '17:45']]);
    assert.match(view.text(), /Pedido 7 · Cliente sintético: situação alterada para Verificado\./); assert.equal(srv.lists().length, lists + 1, 'the list is reread after the change');
    menuItems(view, id(1)).find(item => item.label === 'Cancelado').onClick(); await view.flush();
    await modalAction(view, 'Alterar situação');
    assert.match(view.text(), /pelo menos três caracteres/); assert.equal(srv.posts().length, 1, 'the description is the cancel reason');
    await view.change('documents-situation-text', 'Cliente desistiu'); await modalAction(view, 'Alterar situação');
    assert.deepEqual([srv.posts().at(-1).body.status, srv.posts().at(-1).body.text], ['cancelled', 'Cliente desistiu']); assert.equal(component(view, 'Modal'), undefined);
    menuItems(view, id(2)).find(item => item.label === 'Em andamento').onClick(); await view.flush(); await modalAction(view, 'Alterar situação');
    assert.match(view.text(), /Não foi possível confirmar o resultado/);
    assert.ok(menuItems(view, id(1)).filter(item => item.icon === 'arrow-right').every(item => item.disabled), 'no other change while the outcome is unknown');
    const pending = srv.posts().at(-1).body.command_id;
    await modalAction(view, 'Conferir resultado');
    assert.equal(srv.posts().at(-1).body.command_id, pending, 'recovery repeats the same command'); assert.match(view.text(), /situação alterada para Em andamento/);
  } finally { view.unmount(); }
});

test('an uncertain command is not resent after the session changes to another user', async () => {
  const srv = server({ post: () => { throw new AccessError(503); } }), view = await mount(srv);
  try {
    menuItems(view, id(1)).find(item => item.label === 'Verificado').onClick(); await view.flush(); await modalAction(view, 'Alterar situação');
    const posts = srv.posts().length; srv.become({ phase: 'ready', membership: { user_id: other, role: 'admin' } });
    await modalAction(view, 'Conferir resultado');
    assert.equal(srv.posts().length, posts); assert.match(view.text(), /A sessão mudou/);
  } finally { view.unmount(); }
});

test('Mudar situação dos selecionados previews skipped rows and reports each result; failures do not stop the others', async () => {
  const rows = [row(1), row(2, { status: 'verified', version: 4 }), row(3, { status: 'cancelled' }), row(4, { version: 5 })];
  const srv = server({ rows, post: call => {
    if (call.path.includes(id(2))) throw new AccessError(409);
    if (call.path.includes(id(4))) throw new AccessError(503);
    return { kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', status: call.body.status, version: 4 }, replayed: false, data_mode: 'erp_native', operational_effects: false };
  } }), view = await mount(srv, 'sales_orders', ['BatchDialog']);
  try {
    assert.equal(view.button('Mudar situação dos pedidos selecionados').disabled, true);
    const box = n => view.nodes().find(node => node.type === 'input' && node.props['aria-label'] === `Selecionar Pedido ${n + 6} · Cliente sintético`);
    box(1).props.onClick({ shiftKey: false }); await view.flush(); box(4).props.onClick({ shiftKey: true }); await view.flush();
    assert.match(view.text(), /4 selecionados/);
    await view.click('Mudar situação dos pedidos selecionados');
    assert.equal(component(view, 'Modal').props.title, 'Alteração de situação das vendas');
    await view.change('documents-batch-status', 'in_progress');
    assert.match(view.text(), /Informe um motivo com pelo menos três caracteres\./, 'leaving Cancelado needs the description as reason');
    await modalAction(view, 'Ok');
    const posts = srv.posts();
    assert.deepEqual(posts.map(call => [call.path.split('/')[4], call.body.expected_version, call.body.status]), [[id(1), 3, 'in_progress'], [id(2), 4, 'in_progress'], [id(4), 5, 'in_progress'], [id(4), 5, 'in_progress']]);
    assert.equal(new Set(posts.map(call => call.body.command_id)).size, 3, 'each document has its own command; only the uncertain one is repeated');
    const text = view.text();
    for (const expected of ['1 concluído', '1 com falha', '1 a conferir', '1 ignorado', 'Situação alterada para Em andamento.', 'O documento mudou ou a situação atual não permite esta ação.', 'Resultado não confirmado. Confira Pedido 10 · Cliente sintético antes de repetir.']) assert.ok(text.includes(expected), expected);
    const lists = srv.lists().length;
    await modalAction(view, 'Fechar');
    assert.equal(component(view, 'Modal'), undefined); assert.equal(srv.lists().length, lists + 1); assert.doesNotMatch(view.text(), /selecionados?$/m);
  } finally { view.unmount(); }
});

test('Imprimir selecionados reads every saved version and opens one preview with the documents that were read', async () => {
  const srv = server({ get: call => { if (call.path.endsWith(id(2))) throw new AccessError(404); return { kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', version: 3, number: '7' } }; } }), view = await mount(srv, 'sales_orders', ['BatchDialog']);
  try {
    await view.change('documents-select-all', true); assert.match(view.text(), /2 selecionados/);
    await view.click('Imprimir selecionados'); await modalAction(view, 'Preparar impressão');
    assert.match(view.text(), /1 concluído · 1 com falha/); assert.match(view.text(), /Documento não encontrado/);
    await modalAction(view, 'Fechar');
    assert.deepEqual(component(view, 'DocumentBatchPrint').props.records.map(record => record.id), [id(1)]);
    assert.equal(srv.posts().length, 0, 'printing never writes');
  } finally { view.unmount(); }
});

test('⋮ Lançar estoque opens the reviewed stock component for the saved version and rereads it after a change', async () => {
  let version = 3;
  const srv = server({ role: 'estoque', rows: [row(1)], get: () => ({ kind: 'sales_orders', document: { id: id(1), kind: 'sales_orders', version, number: '7' } }) }), view = await mount(srv, 'sales_orders', ['DocumentEffectDialog']);
  try {
    const items = menuItems(view, id(1));
    assert.equal(items.find(item => item.label === 'Lançar contas').disabled, true); assert.match(items.find(item => item.label === 'Lançar contas').title, /financeiro/);
    items.find(item => item.label === 'Lançar estoque').onClick(); await view.flush();
    assert.equal(component(view, 'Modal').props.title, 'Estoque · Pedido 7 · Cliente sintético');
    assert.equal(component(view, 'DocumentStock').props.record.version, 3);
    version = 4; await component(view, 'DocumentStock').props.onChanged(4); await view.flush();
    assert.equal(component(view, 'DocumentStock').props.record.version, 4);
    await assert.rejects(async () => { version = 2; await component(view, 'DocumentStock').props.onChanged(4); }, error => error.status === 502, 'an older version is never accepted');
    const lists = srv.lists().length;
    await modalAction(view, 'Fechar');
    assert.equal(component(view, 'DocumentEffectDialog'), undefined); assert.equal(srv.lists().length, lists + 1, 'the list is reread after an effect changed');
  } finally { view.unmount(); }
});

test('⋮ Gerar venda opens the pedido prefilled from the proposta, creating nothing (202610200196)', async () => {
  const proposal = row(1, { kind: 'sales_proposals', status: 'approved', version: 5 });
  const srv = server({ kind: 'sales_proposals', rows: [proposal, row(2, { kind: 'sales_proposals', status: 'cancelled' })] }), view = await mount(srv, 'sales_proposals');
  try {
    assert.equal(menuItems(view, id(2)).find(item => item.label === 'Gerar venda').disabled, true);
    menuItems(view, id(1)).find(item => item.label === 'Gerar venda').onClick(); await view.flush();
    assert.equal(srv.posts().length, 0, 'nothing is created by the menu');
    const params = new URLSearchParams(view.location().search);
    assert.deepEqual([params.get('tipo'), params.get('acao'), params.get('origem')], ['sales_orders', 'proposta', proposal.id]);
  } finally { view.unmount(); }
});

test('⋮ Clonar prepares the reviewed copy and opens it in the editor without saving', async () => {
  const source = { ...normalizeDocument('sales_orders', { date: '2026-10-16', contact_id: contact, items: [{ id: '40000000-0000-4000-8000-000000000001', description: 'Item sintético', unit: 'UN', quantity: '1', unit_price: '10' }] }), id: id(1), kind: 'sales_orders', number: '7', version: 3, status: 'open', contact_snapshot: { id: contact, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, source_proposal_id: null, created_at: '2026-10-16T07:00:00Z', updated_at: '2026-10-16T07:00:00Z' };
  const preview = () => { const data = documentInput(source); for (const key of COPY_RESET_FIELDS) if (!['date', 'installments', 'template'].includes(key)) data[key] = null; data.date = '2026-10-17'; data.items = data.items.map(item => ({ ...item, id: null })); data.installments = []; data.template = false; return { source: { id: source.id, kind: 'sales_orders', number: '7', version: 3 }, data, reset_fields: [...COPY_RESET_FIELDS], persisted: false, data_mode: 'erp_native', operational_effects: false }; };
  const srv = server({ get: () => ({ kind: 'sales_orders', document: structuredClone(source) }), copy: () => preview() }), view = await mount(srv);
  try {
    menuItems(view, id(1)).find(item => item.label === 'Clonar venda').onClick(); await view.flush();
    assert.deepEqual(srv.calls.slice(-2).map(call => call.path), [`/v1/documentos/sales_orders/${id(1)}`, `/v1/duplicacao-documentos/sales_orders/${id(1)}/preview`]);
    const editor = component(view, 'Editor');
    assert.equal(editor.props.record, null); assert.equal(editor.props.copyDraft.preview.source.id, id(1)); assert.equal(srv.posts().length, 0);
  } finally { view.unmount(); }
});

test('read-only profiles see the list and print, without situação or batch changes', async () => {
  const srv = server({ role: 'consulta', write: false }), view = await mount(srv);
  try {
    const items = menuItems(view, id(1));
    assert.equal(items.some(item => item.icon === 'arrow-right'), false); assert.equal(items[0].label, 'Visualizar');
    assert.equal(items.find(item => item.label === 'Imprimir').disabled, false); assert.equal(items.find(item => item.label === 'Clonar venda').disabled, true);
    await view.change('documents-select-all', true);
    assert.equal(view.button('Mudar situação dos pedidos selecionados').disabled, true); assert.equal(view.button('Imprimir selecionados').disabled, false);
  } finally { view.unmount(); }
});

test('a page left past the end after the filtered set shrinks moves to the last page instead of an empty list', async () => {
  let total = 250;
  const srv = server({ rows: [row(1), row(2)], total }), base = srv.controller.documents.bind(srv.controller);
  srv.controller.documents = async (path, options) => {
    const value = await base(path, options);
    if (!path.includes('?')) return value;
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
    return { ...value, total_count: total, items: page > Math.ceil(total / 100) ? [] : value.items };
  };
  const view = await mount(srv);
  const reload = async () => { view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Recarregar').props.onClick(); await view.flush(); };
  try {
    component(view, 'OriginPagination').props.onPage(3); await view.flush();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=3');
    total = 150; await reload();
    assert.deepEqual(srv.lists().slice(-2), ['/v1/documentos/sales_orders?limit=100&page=3', '/v1/documentos/sales_orders?limit=100&page=2']);
    assert.deepEqual([component(view, 'OriginPagination').props.page, component(view, 'OriginPagination').props.pages], [2, 2]);
    assert.equal(view.nodes().filter(n => n.type === 'tr' && String(n.props.className).startsWith('documents-row')).length, 2);
    assert.doesNotMatch(view.text(), /Nenhum documento encontrado/);
    total = 0; await reload();
    assert.equal(srv.lists().at(-1), '/v1/documentos/sales_orders?limit=100&page=1', 'an emptied set returns to the first page');
  } finally { view.unmount(); }
});
