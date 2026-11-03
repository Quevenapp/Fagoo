import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeInvoiceInput, invoiceTotals, DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// Origin-style invoice list and "Nota fiscal" form with a synthetic controller (no DOM, no network, synthetic data).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = '20000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002', NATURE = id(900), PRODUCT = id(800);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const component = (view, name, index = 0) => components(view, name)[index];
const button = (view, label) => { const found = view.nodes().find(n => n.type === 'button' && textOf(n).trim() === label); if (!found) throw new Error(`Missing button ${label}`); return found; };
const press = async (view, label) => { const node = button(view, label); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
async function modalAction(view, label) {
  const modal = components(view, 'Modal').at(-1); let found;
  walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node).trim() === label) found = node; });
  if (!found) throw new Error(`Missing dialog action ${label}`); if (found.props.disabled) throw new Error(`Disabled dialog action ${label}`);
  found.props.onClick?.({ preventDefault() {} }); await view.flush();
}
const originRow = (n, over = {}) => ({ origin: 'origin', id: String(9000 + n), version: null, number: 120 + n, series: 1, issue_date: '2026-10-15', entry_date: null, name: `Cliente Origin ${n}`, document: '12345678000190', state: 'SP',
  nature: null, status: 6, status_raw: '5', total: '100.10', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [], ...over });
const nativeRow = (n, over = {}) => ({ ...originRow(n), origin: 'brufap', id: id(n), version: 2, number: null, status: 1, status_raw: null, environment: '2', issue_type: 'N', protocol_present: false, ...over });
const listResponse = (path, rows, total) => { const q = new URLSearchParams(path.split('?')[1]), page = Number(q.get('page'));
  if (total !== undefined) rows = Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => originRow(i + 1 + (page - 1) * 100));
  return { items: rows, origin: q.get('origin') ?? 'origin', model: q.get('model'), direction: q.get('direction') ?? '1', page: Number(q.get('page')), limit: 100,
  order: q.get('order') ?? 'date_desc', has_more: (total ?? rows.length) > Number(q.get('page')) * 100, total_count: total ?? rows.length, total_amount: '200.20', amount_unknown: 0, brufap_visible: true, show_totals: true,
  data_mode: q.get('origin') === 'brufap' ? 'erp_native_homologation' : 'origin_mirror_readonly' }; };
const baseInput = (over = {}) => ({ model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: NATURE, nature_description: 'Venda sintética', issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1',
  final_consumer: false, recipient: { name: 'Cliente sintético', person_type: 'J', document: '12345678000190', state: 'SP' }, items: [{ description: 'Peça sintética', quantity: '2', unit_price: '50' }], ...over });
function recordOf(input, over = {}) {
  const normalized = normalizeInvoiceInput(input), totals = invoiceTotals(normalized);
  return { ...normalized, id: id(1), version: 1, status: 1, environment: '2', series: Number(normalized.series), number: null, access_key: null, protocol: null, authorized_at: null, nature_description: 'Venda sintética',
    items: normalized.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals, orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, ...over };
}
const envelope = (record, extra = {}) => ({ invoice: record, writable: record.deleted_at === null && [1, 5, 8, 12].includes(record.status), emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', ...extra });
const nature = (over = {}) => ({ id: NATURE, description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
  include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', defaults: ['S'],
  rules: [{ tax: 'icms', position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], products: [], data: { situation: '101', cfop: '5102', credit_rate: '1.2500' }, additional_info: null, fiscal_info: null }], ...over });
const summary = n => ({ id: n.id, description: n.description, series: n.series, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced, final_consumer: n.final_consumer, return_operation: n.return_operation, active: n.active, version: n.version, defaults: n.defaults, rule_count: n.rules.length });

function server({ role = 'admin', rows = [originRow(1), originRow(2)], natives = [nativeRow(1)], total, post, get, preferences = {} } = {}) {
  const prefsFor = () => ({ ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [], ...preferences });
  const calls = []; let snapshot = { phase: 'ready', membership: { user_id: admin, role } };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') return post(call, calls);
      if (get) { const value = await get(call, calls); if (value !== undefined) return value; }
      if (path.startsWith('/v1/notas-fiscais?')) return listResponse(path, path.includes('origin=brufap') ? natives : rows, total);
      if (path.startsWith('/v1/notas-fiscais/contexto')) return { company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [{ series: 2, next_number: 42195, enabled: true }], defaults: { S: { id: NATURE, description: 'Venda sintética' } }, preferences: structuredClone(prefsFor(call)), writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
      if (path.startsWith('/v1/notas-fiscais/naturezas?')) return { items: [summary(nature())], page: 1, limit: 100, total_count: 1, writable: true, data_mode: 'erp_native' };
      if (path === `/v1/notas-fiscais/naturezas/${NATURE}`) return { nature: nature(), writable: true, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 0, updated_at: null, writable: true, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async listPreferences(path) { calls.push({ path, method: 'GET' }); return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog(path) { calls.push({ path, method: 'GET' }); if (path.startsWith('/v1/cadastros/products')) return { items: [{ id: PRODUCT, entity: 'products', name: 'Peça catálogo', code: 'P-1', unit: 'UN', ncm: '84713012', price: '12.5000' }], has_more: false }; return { items: [], has_more: false }; },
  };
  return { calls, controller, lists: () => calls.filter(c => c.path.startsWith('/v1/notas-fiscais?')).map(c => c.path), posts: () => calls.filter(c => c.method !== 'GET'), become: value => { snapshot = value; } };
}
const mountList = (srv, location = '/historico-fiscal?modelo=55', screen = 'nfe') => mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen }, { location, expandChildren: ['NativeListLayout'] });

test('Notas fiscais de saída: Origin mirror by default, 100 per page, Origin labels, six-digit numbers and filtered totals', async () => {
  const srv = server({ total: 250 }), view = await mountList(srv);
  try {
    assert.deepEqual(srv.lists(), ['/v1/notas-fiscais?model=55&page=1']);
    const text = view.text();
    assert.equal(component(view, 'OriginListHeader').props.title, 'Notas Fiscais de Saída'); assert.equal(component(view, 'OriginListHeader').props.selector.props.value, 'Notas do Origin');
    for (const expected of ['000121', '000122', 'Autorizada', 'Quantidade de notas', '250', 'Informações baseadas nos filtros aplicados.']) assert.ok(text.includes(expected), expected);
    assert.equal(view.input('fiscal-search').props.placeholder, 'Pesquisar por nome, CPF/CNPJ ou n° da nota');
    const pagination = component(view, 'OriginPagination').props; assert.deepEqual([pagination.page, pagination.pages, pagination.size, pagination.total], [1, 3, 100, 250]);
    pagination.onPage(3); await view.flush(); assert.equal(srv.lists().at(-1), '/v1/notas-fiscais?model=55&page=3');
    await view.change('fiscal-status', 'cancelled'); await view.change('fiscal-state', 'MG'); await view.change('fiscal-search', ' 12.345.678/0001 '); await view.submit();
    assert.equal(srv.lists().at(-1), '/v1/notas-fiscais?model=55&page=1&q=12.345.678%2F0001&status=cancelled&state=MG');
    assert.deepEqual(component(view, 'AppliedChips').props.chips.map(c => c.label), ['Pesquisa: 12.345.678/0001', 'Situação: Canceladas', 'UF: MG']);
    component(view, 'PeriodPicker').props.onApply({ from: '2026-10-01', to: '2026-10-31' }); await view.flush();
    assert.match(srv.lists().at(-1), /&date_from=2026-10-01&date_to=2026-10-31&status=cancelled&state=MG$/);
    component(view, 'AppliedChips').props.onClear(); await view.flush();
    assert.equal(srv.lists().at(-1), '/v1/notas-fiscais?model=55&page=1&date_from=2026-10-01&date_to=2026-10-31', 'Limpar keeps the period');
    const before = srv.lists().length; await view.change('fiscal-search', 'linha\nquebrada'); await view.submit();
    assert.equal(srv.lists().length, before, 'invalid search never reaches the server'); assert.match(view.text(), /A pesquisa deve ter até 120 caracteres/);
  } finally { view.unmount(); }
});

test('the ⋮ menu keeps Origin notes read-only during coexistence and lists unavailable actions disabled with the reason', async () => {
  const srv = server(), view = await mountList(srv);
  try {
    const items = component(view, 'RowMenu').props.items, find = label => items.find(i => i.label === label);
    assert.equal(find('Visualizar').disabled, false);
    for (const label of ['Cancelar NF-e', 'Carta de correção', 'Lançar contas', 'Lançar estoque', 'Imprimir DANFE']) { assert.equal(find(label).disabled, true, label); assert.ok(find(label).title, label); }
    assert.match(find('Cancelar NF-e').title, /convivência/);
    assert.equal(find('Clonar nota').disabled, true); assert.equal(find('Clonar para entrada').disabled, true);
    assert.equal(items.some(i => i.label === 'Enviar nota fiscal'), false, 'Origin hides Enviar for authorized notes');
    const pending = component(view, 'RowMenu', 1).props.items; void pending;
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta' }), consult = await mountList(reader, '/historico-fiscal?modelo=55&origem=brufap');
  try {
    assert.deepEqual(reader.lists(), ['/v1/notas-fiscais?model=55&page=1'], 'consulta cannot open the homologation view');
    assert.equal(component(consult, 'OriginSelector'), undefined); assert.equal(component(consult, 'RowMenu').props.items.find(i => i.label === 'Clonar nota').disabled, true);
    assert.equal(consult.nodes().some(n => n.type === 'button' && textOf(n).trim() === 'Incluir nota fiscal'), false);
  } finally { consult.unmount(); }
});

test('Testes de homologação do FAGOO: native rows are marked and deleted one by one with reason, command id and recovery', async () => {
  let attempts = 0;
  const srv = server({ natives: [nativeRow(1), nativeRow(2, { version: 3 })], post: call => {
    const target = call.path.includes(id(2)) ? 2 : 1;
    if (target === 2 && attempts++ === 0) throw new AccessError(503);
    return envelope(recordOf(baseInput(), { id: id(target), version: call.body.expected_version + 1, deleted_at: '2026-10-20T13:00:00Z', delete_reason: call.body.reason }), { action: 'delete', replayed: attempts > 1 });
  } }), view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout', 'BatchDialog'] });
  try {
    assert.deepEqual(srv.lists(), ['/v1/notas-fiscais?model=55&origin=brufap&page=1']);
    assert.match(view.text(), /Homologação/); assert.match(view.text(), /sem valor fiscal/);
    const boxes = () => view.nodes().filter(n => n.type === 'input' && String(n.props['aria-label']).startsWith('Selecionar nota'));
    boxes()[0].props.onClick({ shiftKey: false }); await view.flush(); boxes()[1].props.onClick({ shiftKey: true }); await view.flush();
    assert.match(view.text(), /2 selecionados/);
    component(view, 'ToolButton', 1).props.onClick(); await view.flush();
    assert.equal(component(view, 'Modal').props.title, 'Excluir notas selecionadas');
    await assert.rejects(() => modalAction(view, 'Excluir'), /Disabled/, 'a reason is required');
    await view.change('fiscal-delete-reason', 'Teste sintético'); await modalAction(view, 'Excluir');
    const posts = srv.posts();
    assert.deepEqual(posts.map(p => [p.path, p.body.expected_version, p.body.reason]), [[`/v1/notas-fiscais/${id(1)}/excluir`, 2, 'Teste sintético'], [`/v1/notas-fiscais/${id(2)}/excluir`, 3, 'Teste sintético'], [`/v1/notas-fiscais/${id(2)}/excluir`, 3, 'Teste sintético']]);
    assert.equal(posts[1].body.command_id, posts[2].body.command_id, 'the unknown outcome is repeated with the same command');
    assert.notEqual(posts[0].body.command_id, posts[1].body.command_id);
  } finally { view.unmount(); }
});

test('a late list response never replaces a newer filter', async () => {
  let release; const slow = new Promise(resolve => { release = resolve; });
  const srv = server({ get: call => call.path === '/v1/notas-fiscais?model=55&page=1' ? slow.then(() => listResponse(call.path, [originRow(7)])) : undefined }), view = await mountList(srv);
  try {
    await view.change('fiscal-search', 'Cliente Origin 2'); await view.submit();
    release(); await view.flush();
    assert.ok(view.text().includes('000122')); assert.equal(view.text().includes('000127'), false);
  } finally { view.unmount(); }
});

const mountForm = (srv, props = {}) => mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'new' }, today: '2026-10-20', onBack() {}, onSaved() {}, ...props }, { location: '/historico-fiscal?modelo=55&nota=nova' });
const tab = async (view, label) => { const found = view.nodes().find(n => n.type === 'button' && n.props.role === 'tab' && textOf(n).trim() === label); found.props.onClick(); await view.flush(); };

test('new note: Origin defaults, one Salvar with command id, automatic Simples credit and recovery of an unknown outcome', async () => {
  let attempt = 0; const saved = [];
  // 'Mensagem de aproveitamento de crédito do Simples Nacional' is on in this company's preferences.
  const srv = server({ preferences: { simples_credit_message: true }, post: call => { if (attempt++ === 0) throw new AccessError(503); const record = recordOf(call.body.invoice); return envelope(record, { action: 'create', replayed: attempt > 2 }); } });
  const view = await mountForm(srv, { onSaved: record => saved.push(record) });
  try {
    assert.match(view.text(), /Nota fiscal - nova/); assert.match(view.text(), /Homologação · sem valor fiscal/);
    assert.equal(view.input('fiscal-series').props.value, '2'); assert.equal(view.input('fiscal-number').props.placeholder, '42195'); assert.equal(view.input('fiscal-number').props.disabled, true);
    assert.match(view.text(), /Venda sintética/, 'default nature "Padrão venda"');
    await press(view, 'Salvar'); assert.match(view.text(), /Inclua pelo menos um item na nota\./); assert.equal(srv.posts().length, 0);
    await tab(view, 'Destinatário'); await view.change('fiscal-recipient-name', 'Cliente sintético'); await view.change('fiscal-recipient-type', 'J'); await view.change('fiscal-recipient-document', '12.345.678/0001-90'); await view.change('fiscal-recipient-state', 'SP');
    await tab(view, 'Itens da nota fiscal'); await press(view, 'Adicionar outro item');
    const field = label => view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === label);
    field('Produto ou serviço do item 1').props.onChange({ target: { value: 'Peça' } }); await view.flush(); await new Promise(r => setTimeout(r, 300)); await view.flush();
    const pick = view.nodes().find(n => n.type === 'button' && textOf(n).includes('Peça catálogo')); pick.props.onClick(); await view.flush();
    field('Quantidade do item 1').props.onChange({ target: { value: '3' } }); field('Preço unitário do item 1').props.onChange({ target: { value: '10,5' } }); await view.flush();
    assert.ok(view.text().includes('31,50'), 'line total in R$');
    await tab(view, 'Cálculo de imposto'); assert.match(view.text(), /Cálculo automático ligado/);
    await press(view, 'Salvar');
    assert.match(view.text(), /Não foi possível confirmar se a nota foi salva/);
    const first = srv.posts()[0];
    assert.equal(first.path, '/v1/notas-fiscais'); assert.equal(first.method, 'POST');
    assert.deepEqual(first.body.invoice.items[0], { product_id: PRODUCT, description: 'Peça catálogo', code: 'P-1', unit: 'UN', quantity: '3.0000', unit_price: '10.5000000000', ncm: '84713012', cfop: '5102', icms: { situation: '101', credit_rate: '1.2500', credit_value: '0.39' } });
    assert.equal(first.body.invoice.recipient.document, '12345678000190'); assert.equal(first.body.invoice.environment, undefined);
    assert.match(first.body.invoice.nature_additional_info, /APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R\$ 0,39/);
    await press(view, 'Conferir resultado');
    assert.equal(srv.posts()[1].body.command_id, first.body.command_id, 'same command id after an unknown outcome');
    assert.equal(saved.length, 1); assert.equal(saved[0].version, 1);
  } finally { view.unmount(); }
});

test('editing keeps the expected version, refuses a session change and becomes read-only for consulta', async () => {
  const record = recordOf(baseInput(), { version: 4 });
  const srv = server({ get: call => call.path === `/v1/notas-fiscais/${id(1)}` ? envelope(record) : undefined, post: () => { throw new AccessError(503); } });
  const view = await mountForm(srv, { id: id(1), opening: null });
  try {
    assert.match(view.text(), /Nota fiscal - sem número/); assert.match(view.text(), /Pendente/);
    await tab(view, 'Informações adicionais'); await view.change('fiscal-additional', 'Pedido 42');
    await press(view, 'Salvar');
    assert.equal(srv.posts()[0].method, 'PATCH'); assert.equal(srv.posts()[0].body.expected_version, 4); assert.equal(srv.posts()[0].body.invoice.additional_info, 'Pedido 42');
    srv.become({ phase: 'ready', membership: { user_id: other, role: 'admin' } });
    await press(view, 'Conferir resultado');
    assert.equal(srv.posts().length, 1, 'not resent for another user'); assert.match(view.text(), /A sessão ou o perfil mudou/);
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta', get: call => call.path === `/v1/notas-fiscais/${id(1)}` ? envelope(record) : undefined }), readOnly = await mountForm(reader, { id: id(1), opening: null });
  try { assert.equal(button(readOnly, 'Salvar').disabled, true); assert.match(readOnly.text(), /Seu perfil atual não permite alterar notas fiscais/); } finally { readOnly.unmount(); }
});

test('Documento referenciado validates keys like Origin and the item modal shows calculated values read-only', async () => {
  const srv = server(), view = await mountForm(srv);
  try {
    await tab(view, 'Documento referenciado');
    await press(view, 'Incluir mais'); assert.match(view.text(), /Informe uma chave de acesso/);
    await view.change('fiscal-ref-key', '123'); await press(view, 'Incluir mais'); assert.match(view.text(), /A chave deve ter 44 dígitos/);
    const key = '35261011222333000181550010000001231123456781';
    await view.change('fiscal-ref-key', key); await press(view, 'Incluir mais');
    await view.change('fiscal-ref-key', key); await press(view, 'Incluir mais'); assert.match(view.text(), /Esta chave já foi adicionada/);
    await tab(view, 'Itens da nota fiscal'); await press(view, 'Adicionar outro item');
    const editButton = view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Editar item 1'); editButton.props.onClick(); await view.flush();
    const dialog = component(view, 'FiscalInvoiceItemDialog');
    assert.equal(dialog.props.auto, true); assert.equal(dialog.props.crt, '1');
  } finally { view.unmount(); }
});

test('Gerar NF-e from a Origin NFC-e opens an NF-e draft that references the NFC-e and nothing is saved before Salvar', async () => {
  const key = '35261011222333000181650010000000071123456785';
  const detail = { origin: 'origin', entity: 'nfce', source_id: '9101', model: '65', direction: '1', number: 7, series: 1, issue_date: '2026-10-10', operation_date: null, status: 6, status_raw: '5', access_key: key,
    total: '12.50', total_known: true, freight: null, contact: { name: 'Consumidor sintético', document: null, ie: null, email: null, phone: null, street: null, number: null, complement: null, district: null, postal_code: null, city: null, state: null, country: null },
    items: [{ code: 'P-1', description: 'Peça sintética', unit: 'UN', quantity: '1', unit_price: '12.5', total: '12.50', cfop: '5102', ncm: '84713012', gtin: null }], installments: [], transport: { freight_by: null, carrier: null },
    additional_info: null, xml: null, events: [], observed_at: '2026-10-20T12:00:00Z', data_mode: 'origin_mirror_readonly', writable: false };
  const srv = server();
  const view = await mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfce', model: '65', direction: '1' }, id: null, opening: { kind: 'nfe_from_nfce', origin: detail }, today: '2026-10-20', onBack() {}, onSaved() {} });
  try {
    assert.ok(srv.calls.some(c => c.path === '/v1/notas-fiscais/contexto?model=55'));
    assert.match(view.text(), /Nota fiscal - nova/);
    await tab(view, 'Documento referenciado'); assert.ok(view.text().includes(key));
    await tab(view, 'Itens da nota fiscal');
    assert.equal(view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Produto ou serviço do item 1').props.value, 'Peça sintética');
    assert.equal(srv.posts().length, 0);
  } finally { view.unmount(); }
});

test('a same-actor role loss hides the open FAGOO note but keeps it mounted; consulta never opens one directly', async () => {
  const srv = server(), view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: `/historico-fiscal?modelo=55&origem=brufap&nota=${id(1)}` });
  try {
    const form = () => component(view, 'FiscalInvoiceForm');
    assert.ok(form()); assert.equal(form().props.id, id(1));
    srv.become({ phase: 'ready', membership: { user_id: admin, role: 'consulta' } }); await view.updateProps({});
    assert.ok(form(), 'still mounted'); assert.match(view.text(), /Uma confirmação pendente fica preservada/);
    assert.equal(view.nodes().find(n => n.type === 'div' && n.props.hidden === true && n.props.inert === true) !== undefined, true);
    srv.become({ phase: 'ready', membership: { user_id: admin, role: 'fiscal' } }); await view.updateProps({});
    assert.equal(view.text().includes('Nota do FAGOO não liberada'), false); assert.ok(form());
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta' }), direct = await mountComponent('RealFiscalInvoices.tsx', { controller: reader.controller, screen: 'nfe' }, { location: `/historico-fiscal?modelo=55&nota=${id(1)}` });
  try { assert.equal(component(direct, 'FiscalInvoiceForm'), undefined); assert.match(direct.text(), /Nota do FAGOO não liberada/); } finally { direct.unmount(); }
});

// ---- Review fixes (synthetic data only) ----
const KEY55 = '35261011222333000181550010000001231123456783';
const originNote = (over = {}) => ({ origin: 'origin', entity: 'nfe', source_id: '9001', model: '55', direction: '1', number: 123, series: 1, issue_date: '2026-10-15', operation_date: null, status: 6, status_raw: '5', access_key: KEY55,
  total: '100.00', total_known: true, freight: null, contact: { name: 'Cliente Origin sintético', document: '12345678000190', ie: null, email: null, phone: null, street: null, number: null, complement: null, district: null, postal_code: null, city: null, state: 'SP', country: null },
  items: [{ code: 'P-1', description: 'Peça sintética', unit: 'UN', quantity: '2', unit_price: '50', total: '100.00', cfop: '5102', ncm: '84713012', gtin: null }], installments: [], transport: { freight_by: null, carrier: null },
  additional_info: null, xml: null, events: [], observed_at: '2026-10-20T12:00:00Z', data_mode: 'origin_mirror_readonly', writable: false, ...over });
const guardPorts = () => {
  const flags = { changed: false, busy: false, bypass: 0 };
  return { flags, blocked: () => flags.bypass === 0 && (flags.changed || flags.busy), ports: { useUnsavedChanges(changed, busy) { flags.changed = changed; flags.busy = busy;
    return { confirmLeave: action => action(), store: { runConfirmed(action) { flags.bypass++; try { action(); } finally { flags.bypass--; } } } }; } } };
};

test('the first save opens the saved note through the confirmed navigation, never through a guard that still sees the save', async () => {
  const guard = guardPorts(), saved = [];
  const srv = server({ post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const view = await mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'new' }, today: '2026-10-20', onBack() {},
    onSaved: record => saved.push({ id: record.id, blocked: guard.blocked() }) }, { location: '/historico-fiscal?modelo=55&nota=nova', ports: guard.ports });
  try {
    await tab(view, 'Destinatário'); await view.change('fiscal-recipient-name', 'Cliente sintético'); await view.change('fiscal-recipient-type', 'J'); await view.change('fiscal-recipient-document', '12345678000190');
    await tab(view, 'Itens da nota fiscal'); await press(view, 'Adicionar outro item');
    const field = label => view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === label);
    field('Produto ou serviço do item 1').props.onChange({ target: { value: 'Peça sintética' } }); field('Preço unitário do item 1').props.onChange({ target: { value: '10' } }); await view.flush();
    await press(view, 'Salvar');
    assert.deepEqual(saved, [{ id: id(1), blocked: false }], 'without runConfirmed the router blocker cancels the navigation and the form reopens blank');
  } finally { view.unmount(); }
});

test('a note saved from another list opens in the list where Origin shows it', async () => {
  for (const [location, screen, record, expected] of [
    ['/historico-fiscal?modelo=55&nota=nova', 'nfe', { id: id(5), model: '55', direction: '0' }, ['/notas-entrada', `?origem=brufap&nota=${id(5)}`]],
    ['/historico-fiscal?modelo=65&nota=nova', 'nfce', { id: id(6), model: '55', direction: '1' }, ['/historico-fiscal', `?modelo=55&origem=brufap&nota=${id(6)}`]],
    ['/historico-fiscal?modelo=55&nota=nova', 'nfe', { id: id(7), model: '55', direction: '1' }, ['/historico-fiscal', `?modelo=55&nota=${id(7)}&origem=brufap`]],
  ]) {
    const srv = server(), view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen }, { location });
    try {
      component(view, 'FiscalInvoiceForm').props.onSaved(record); await view.flush();
      assert.deepEqual([view.location().pathname, view.location().search], expected); assert.equal(view.navigations().at(-1).replace, true);
    } finally { view.unmount(); }
  }
});

test('Origin complementary, return and clone actions cannot open a native draft during coexistence', async () => {
  const srv = server({ rows: [originRow(1, { access_key: KEY55 })], get: call => call.path === '/v1/notas-fiscais/origin/nfe/9001' ? originNote() : undefined }), view = await mountList(srv);
  try {
    for (const label of ['NFe complementar', 'Clonar nota', 'Clonar para entrada']) {
      const item = component(view, 'RowMenu').props.items.find(i => i.label === label);
      assert.equal(item.disabled, true); assert.match(item.title, /convivência/); item.onClick(); await view.flush();
    }
    assert.equal(component(view, 'FiscalInvoiceForm'), undefined);
    assert.equal(srv.posts().length, 0); assert.equal(srv.calls.some(c => c.path === '/v1/notas-fiscais/origin/nfe/9001'), false);
  } finally { view.unmount(); }
  const form = await mountForm(server(), { opening: { kind: 'complementary', origin: originNote() } });
  try {
    assert.equal(form.input('fiscal-purpose').props.value, '2', 'Finalidade: NF-e complementar');
    await tab(form, 'Documento referenciado'); assert.ok(form.text().includes(KEY55));
  } finally { form.unmount(); }
});

test('an inverted clone shows the entry labels of its own direction', async () => {
  const view = await mountForm(server(), { opening: { kind: 'clone_invert', origin: originNote() } });
  try {
    assert.match(view.text(), /Tipo de Entrada\*/); assert.match(view.text(), /Data entrada/); assert.equal(view.text().includes('Tipo de saída*'), false);
    assert.ok(view.nodes().some(n => n.type === 'button' && n.props.role === 'tab' && textOf(n).trim() === 'Remetente'));
  } finally { view.unmount(); }
});

test('Contato rápido always fills the recipient, even after a carrier search', async () => {
  const view = await mountForm(server());
  try {
    await tab(view, 'Transportador/Volumes'); await view.change('fiscal-transport-mode', 'manual'); await view.change('fiscal-carrier-search', 'T');
    await tab(view, 'Destinatário');
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Adicionar novo').props.onClick(); await view.flush();
    component(view, 'DocumentQuickContact').props.onCreated({ id: id(30), entity: 'contacts', name: 'Contato rápido sintético', person_type: 'F', document: '98765432100' }); await view.flush();
    assert.equal(view.input('fiscal-recipient-name').props.value, 'Contato rápido sintético');
    await tab(view, 'Transportador/Volumes'); assert.equal(view.input('fiscal-carrier-name').props.value, '');
  } finally { view.unmount(); }
});

test('another row action during Imprimir listagem never leaves the list busy', async () => {
  let hold = false, release; const pending = new Promise(resolve => { release = resolve; });
  const srv = server({ get: call => hold && call.path.startsWith('/v1/notas-fiscais?') ? pending.then(() => listResponse(call.path, [nativeRow(1), nativeRow(2)])) : undefined }), view = await mountList(srv, '/historico-fiscal?modelo=55&origem=brufap');
  try {
    hold = true;
    const print = () => components(view, 'ToolButton').find(b => b.props.title === 'Imprimir listagem de notas');
    print().props.onClick(); await view.flush();
    assert.equal(view.guard().busy, true); assert.equal(print().props.disabled, true);
    component(view, 'RowMenu').props.items.find(i => i.label === 'Clonar nota').onClick(); await view.flush();
    release(); await view.flush();
    assert.equal(view.guard().busy, false, 'printing ends with its own request'); assert.equal(components(view, 'FiscalListPrint').length, 0, 'the cancelled gathering prints nothing');
  } finally { view.unmount(); }
});

const mirrorCoverage = { scope: 'model_direction', source_count: 10, visible_count: 7, xml_count: 5, missing_xml_count: 2, homologation_count: 2, duplicate_count: 1, incomplete_count: 1,
  oldest_observed_at: '2026-10-20T12:00:00Z', latest_observed_at: '2026-10-22T15:30:00Z', partial: true };
test('NF-e, NFC-e and entry lists expose Origin origin, observation and scoped collection coverage', async () => {
  for (const [screen, location, expected] of [['nfe', '/historico-fiscal?modelo=55', '/v1/notas-fiscais?model=55&page=1'],
    ['nfce', '/historico-fiscal?modelo=65', '/v1/notas-fiscais?model=65&page=1'], ['entrada', '/notas-entrada', '/v1/notas-fiscais?model=55&direction=0&page=1']]) {
    const srv = server({ get: call => call.path.startsWith('/v1/notas-fiscais?') ? { ...listResponse(call.path, [originRow(1, { observed_at: '2026-10-22T15:30:00Z' })]), coverage: mirrorCoverage } : undefined });
    const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen }, { location, expandChildren: ['NativeListLayout', 'FiscalMirrorCoverage'] });
    try {
      assert.deepEqual(srv.lists(), [expected]);
      for (const text of ['Origin · somente leitura', 'ID Origin 9001', '22/10/2026, 12:30', 'Cobertura parcial do espelho', 'XML pendente', 'dentro do seu acesso', '2 registro(s) de homologação', '1 duplicata(s)', 'não comprovam que o Origin esteja integralmente atualizado']) assert.ok(view.text().includes(text), `${screen}: ${text}`);
      const menu = component(view, 'RowMenu').props.items;
      for (const label of ['Clonar nota', 'Gerar devolução', 'Imprimir DANFE', ...(screen === 'nfce' ? ['Gerar NF-e'] : ['NFe complementar'])]) {
        const item = menu.find(i => i.label === label); assert.equal(item.disabled, true, `${screen}: ${label}`); assert.ok(item.title);
      }
      assert.equal(srv.posts().length, 0);
    } finally { view.unmount(); }
  }
});

test('the FAGOO source keeps imported production XML distinct from marked homologation tests', async () => {
  const srv = server({ natives: [nativeRow(1), nativeRow(2, { issue_type: 'S', environment: null, status: 8, source_environment: '1', source_origin: 'xml_import', fiscal_status: 8, danfe_emitted: false })] });
  const view = await mountList(srv);
  try {
    const selector = component(view, 'OriginListHeader').props.selector;
    assert.deepEqual(selector.props.options, ['Notas do Origin', 'Registros do FAGOO']); selector.props.onChange('Registros do FAGOO'); await view.flush();
    assert.equal(srv.lists().at(-1), '/v1/notas-fiscais?model=55&origin=brufap&page=1');
    for (const text of ['Homologação · sem valor fiscal', 'Origem FAGOO', 'XML importado', 'produção']) assert.ok(view.text().includes(text), text);
    assert.equal(component(view, 'FiscalMirrorCoverage'), undefined);
  } finally { view.unmount(); }
});

test('missing optional fiscal coverage is explicit and never invents a synchronization time', async () => {
  const view = await mountComponent('FiscalMirrorCoverage.tsx', {});
  try { assert.match(view.text(), /cobertura da sincronização ainda não foi informada/); assert.equal(view.nodes().some(n => n.type === 'time'), false); } finally { view.unmount(); }
});

test('Origin detail exposes observation and read-only actions while preserving collected XML access', async () => {
  const note = originNote({ xml: { id: id(50), hash: 'a'.repeat(64), size: 123, protocol: '135260000000123' } });
  const srv = server({ get: call => call.path === '/v1/notas-fiscais/origin/nfe/9001' ? note : undefined });
  const view = await mountComponent('FiscalOriginInvoiceView.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, sourceId: '9001', writable: true, onBack() {} });
  try {
    for (const label of ['Clonar nota', 'Clonar para entrada', 'Imprimir DANFE']) { const item = button(view, label); assert.equal(item.props.disabled, true); assert.ok(item.props.title); assert.equal(item.props.onClick, undefined); }
    for (const label of ['Ver o XML da nota', 'Baixar XML']) assert.equal(button(view, label).props.disabled, false);
    assert.match(view.text(), /Observada no Origin em/); assert.equal(srv.posts().length, 0);
  } finally { view.unmount(); }
});
