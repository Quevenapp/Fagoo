import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeInvoiceInput, invoiceTotals, DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// Second wave of the Origin invoice screens: Preferências › Notas Fiscais applied to the form and lists, "Listagem customizada",
// natures deletion and review. Synthetic controller only (no DOM, no network, synthetic data).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = '20000000-0000-4000-8000-000000000001', NATURE = id(900), PRODUCT = id(800), CARRIER = id(700);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const component = (view, name, index = 0) => components(view, name)[index];
const button = (view, label) => { const found = view.nodes().find(n => n.type === 'button' && textOf(n).trim() === label); if (!found) throw new Error(`Missing button ${label}`); return found; };
const press = async (view, label) => { const node = button(view, label); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
const tab = async (view, label) => { const found = view.nodes().find(n => n.type === 'button' && (n.props.role === 'tab' || String(n.props['aria-controls'] ?? '').startsWith('fiscal-section-')) && textOf(n).trim() === label); if (!found) throw new Error(`Missing tab ${label}`); found.props.onClick(); await view.flush(); };
const tabs = view => view.nodes().filter(n => n.type === 'button' && (n.props.role === 'tab' || String(n.props['aria-controls'] ?? '').startsWith('fiscal-section-'))).map(n => textOf(n).trim());
const field = (view, label) => view.nodes().find(n => ['input', 'select'].includes(n.type) && n.props['aria-label'] === label);
const wait = async view => { await view.flush(); await new Promise(r => setTimeout(r, 300)); await view.flush(); };
const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
async function modalAction(view, label) {
  const modal = components(view, 'Modal').at(-1); let found;
  walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node).trim() === label) found = node; });
  if (!found) throw new Error(`Missing dialog action ${label}`); if (found.props.disabled) throw new Error(`Disabled dialog action ${label}`);
  found.props.onClick?.({ preventDefault() {} }); await view.flush();
}
const rule = (tax, data) => ({ tax, position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], products: [], data, additional_info: null, fiscal_info: null });
const nature = (rules = [rule('icms', { situation: '101', cfop: '5102', credit_rate: '1.2500' })]) => ({ id: NATURE, description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '1', invoiced: true,
  final_consumer: false, return_operation: false, update_last_purchase_price: false, include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1,
  created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', defaults: ['S'], rules });
const summary = n => ({ id: n.id, description: n.description, series: n.series, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced, final_consumer: n.final_consumer, return_operation: n.return_operation, active: n.active, version: n.version, defaults: n.defaults, rule_count: n.rules.length });
function recordOf(input, over = {}) {
  const normalized = normalizeInvoiceInput(input), totals = invoiceTotals(normalized);
  return { ...normalized, id: id(1), version: 1, status: 1, environment: '2', series: Number(normalized.series), number: null, access_key: null, protocol: null, authorized_at: null, nature_description: 'Venda sintética',
    items: normalized.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals, orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, ...over };
}
const envelope = (record, extra = {}) => ({ invoice: record, writable: true, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', ...extra });
const originRow = (n, over = {}) => ({ origin: 'origin', id: String(9000 + n), version: null, number: 120 + n, series: 3, issue_date: '2026-10-15', entry_date: '2026-10-16', name: `Cliente Origin ${n}`, document: '12345678000190', state: 'MG',
  nature: 'Venda de mercadoria', status: 6, status_raw: '5', total: '100.10', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [], ...over });

function server({ role = 'admin', preferences = {}, natureRules, listPrefs = null, showTotals = true, post } = {}) {
  const calls = []; const snapshot = { phase: 'ready', membership: { user_id: admin, role } };
  const prefs = { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [], ...preferences };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') return post(call, calls);
      if (path.startsWith('/v1/notas-fiscais?')) { const q = new URLSearchParams(path.split('?')[1]); return { items: [originRow(1), originRow(2)], origin: 'origin', model: q.get('model'), direction: q.get('direction') ?? '1', page: Number(q.get('page')),
        limit: 100, order: q.get('order') ?? 'date_desc', has_more: false, total_count: 2, total_amount: '200.20', amount_unknown: 0, brufap_visible: true, show_totals: showTotals, data_mode: 'origin_mirror_readonly' }; }
      if (path.startsWith('/v1/notas-fiscais/contexto')) return { company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [{ series: 2, next_number: 42195, enabled: true }],
        defaults: { S: { id: NATURE, description: 'Venda sintética' } }, preferences: structuredClone(prefs), writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
      if (path.startsWith('/v1/notas-fiscais/naturezas?')) return { items: [summary(nature(natureRules))], page: 1, limit: 100, total_count: 1, writable: true, review: { confirmed: false, version: 0, confirmed_at: null }, data_mode: 'erp_native' };
      if (path === `/v1/notas-fiscais/naturezas/${NATURE}`) return { nature: nature(natureRules), writable: true, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 0, updated_at: null, writable: true, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async listPreferences(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined });
      const listId = path.split('/').at(-1);
      if ((options.method ?? 'GET') === 'POST') return { scope: 'list_preferences_command', data_mode: 'erp_native', replayed: false, receipt: { command_id: options.body.command_id, list_id: listId, from_version: options.body.expected_version, to_version: options.body.expected_version + 1, changed_at: '2026-10-20T13:00:00Z' },
        preference: { scope: 'list_preferences', data_mode: 'erp_native', list_id: listId, version: options.body.expected_version + 1, columns: options.body.columns, filters: options.body.filters, updated_at: '2026-10-20T13:00:00Z' } };
      return { scope: 'list_preferences', data_mode: 'erp_native', list_id: listId, ...(listPrefs ? { version: 1, updated_at: '2026-10-20T12:00:00Z', columns: null, filters: null, ...listPrefs } : { version: 0, columns: null, filters: null, updated_at: null }) };
    },
    async catalog(path) {
      calls.push({ path, method: 'GET' });
      if (path.startsWith('/v1/cadastros/products')) return { items: [{ id: PRODUCT, entity: 'products', name: 'Peça catálogo', code: 'P-1', unit: 'UN', ncm: '84713012', price: '10.0000', gross_weight: '1.250000', net_weight: '1.000005', volumes: '2' }], has_more: false };
      if (path.startsWith('/v1/cadastros/contatos/opcoes')) return { scope: 'contact_options', items: [{ id: CARRIER, entity: 'contacts', name: 'Transportadora sintética', code: null, document: '11.222.333/0001-81', state: 'SP', city: 'Campinas' }], has_more: false };
      return { items: [], has_more: false };
    },
  };
  return { calls, controller, lists: () => calls.filter(c => c.path.startsWith('/v1/notas-fiscais?')).map(c => c.path), posts: () => calls.filter(c => c.method !== 'GET') };
}
const mountForm = (srv, props = {}) => mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'new' }, today: '2026-10-20', onBack() {}, onSaved() {}, ...props }, { location: '/historico-fiscal?modelo=55&nota=nova', expandChildren: ['FiscalInvoiceItemDialog', 'FiscalReconcilePanel'] });
async function fillNote(view, quantity = '3') {
  await tab(view, 'Destinatário'); await view.change('fiscal-recipient-name', 'Cliente sintético'); await view.change('fiscal-recipient-type', 'J'); await view.change('fiscal-recipient-document', '12345678000190'); await view.change('fiscal-recipient-state', 'SP');
  await tab(view, 'Itens da nota fiscal'); await press(view, 'Adicionar outro item');
  field(view, 'Produto ou serviço do item 1').props.onChange({ target: { value: 'Peça' } }); await wait(view);
  view.nodes().find(n => n.type === 'button' && textOf(n).includes('Peça catálogo')).props.onClick(); await view.flush();
  field(view, 'Quantidade do item 1').props.onChange({ target: { value: quantity } }); await view.flush();
}

test('a new note follows Preferências › Configurações de NF-e: frete, espécie, volumes, pessoas autorizadas and visible groups', async () => {
  const plain = server(), first = await mountForm(plain);
  try {
    assert.equal(tabs(first).includes('Retenções'), false, 'Retenções only with "Exibir grupo e configurações de retenção"');
    await tab(first, 'Transportador/Volumes');
    assert.equal(first.input('fiscal-freight-by').props.value, '9'); assert.equal(first.input('fiscal-volume-species').props.value, 'volumes'); assert.equal(first.input('fiscal-volume-quantity').props.value, '');
    await fillNote(first);
    first.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Editar item 1').props.onClick(); await first.flush();
    const itemTabs = tabs(first);
    for (const hidden of ['Combustível', 'Armamento', 'Veículo', 'Retenções']) assert.equal(itemTabs.includes(hidden), false, hidden);
  } finally { first.unmount(); }
  const srv = server({ preferences: { freight_by: '1', species: 'caixas', volume_quantity: 3, retention_group: true, fuel_group: true, weapon_group: true, vehicle_group: true,
    autxml_people: [{ document: '11222333000181', name: 'Contabilidade sintética' }] } });
  const view = await mountForm(srv);
  try {
    assert.ok(tabs(view).includes('Retenções'));
    await tab(view, 'Transportador/Volumes');
    assert.equal(view.input('fiscal-freight-by').props.value, '1'); assert.equal(view.input('fiscal-volume-species').props.value, 'caixas'); assert.equal(view.input('fiscal-volume-quantity').props.value, '3');
    await tab(view, 'Pessoas autorizadas a acessar o XML da nota'); assert.match(view.text(), /Contabilidade sintética/); assert.match(view.text(), /11222333000181/);
    await fillNote(view);
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Editar item 1').props.onClick(); await view.flush();
    for (const shown of ['Combustível', 'Armamento', 'Veículo', 'Retenções']) assert.ok(tabs(view).includes(shown), shown);
    await tab(view, 'Armamento'); await view.change('fiscal-item-weapon-type', '1'); await view.change('fiscal-item-weapon-serial', 'SERIE-1');
    await modalAction(view, 'Salvar item');
    await press(view, 'Salvar');
    const body = srv.posts()[0].body.invoice;
    assert.equal(body.transport.freight_by, '1'); assert.deepEqual(body.transport.volumes, { species: 'caixas', quantity: '3' });
    assert.deepEqual(body.authorized_xml, [{ document: '11222333000181', name: 'Contabilidade sintética' }]);
    assert.deepEqual(body.items[0].weapon, { type: '1', serial: 'SERIE-1' });
  } finally { view.unmount(); }
});

test('Somar peso, Calcular volume, transportadora autorizada and the Simples message stay off unless the preferences ask', async () => {
  const srv = server({ preferences: { sum_weight: true, compute_volume: true, autxml_carrier: true }, post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const view = await mountForm(srv);
  try {
    await fillNote(view, '3');
    await tab(view, 'Transportador/Volumes');
    assert.equal(view.input('fiscal-volume-gross').props.value, '3.750'); assert.equal(view.input('fiscal-volume-net').props.value, '3.000', '1.000005 kg rounds to 1.000');
    assert.equal(view.input('fiscal-volume-quantity').props.value, '6'); assert.equal(view.input('fiscal-volume-gross').props.disabled, true);
    assert.match(view.text(), /Os pesos somam o peso de cada produto vezes a quantidade/);
    await view.change('fiscal-transport-mode', 'manual');
    view.input('fiscal-carrier-search').props.onChange({ target: { value: 'Trans' } }); await wait(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).includes('Transportadora sintética')).props.onClick(); await view.flush();
    await press(view, 'Salvar');
    const body = srv.posts()[0].body.invoice;
    assert.deepEqual(body.items[0].gross_weight, '1.250'); assert.deepEqual(body.transport.volumes, { gross_weight: '3.750', net_weight: '3.000', quantity: '6', species: 'volumes' });
    assert.deepEqual(body.authorized_xml, [{ contact_id: CARRIER, name: 'Transportadora sintética', document: '11222333000181' }]);
    assert.equal(body.nature_additional_info, null, '"Mensagem de aproveitamento de crédito" is off by default');
  } finally { view.unmount(); }
});

test('parcelas must add up to the total unless "Campos com validação opcional: Parcelas"; IPI goes into the first parcel when asked', async () => {
  const strict = server({ post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) }), view = await mountForm(strict);
  try {
    await fillNote(view, '3');
    await tab(view, 'Pagamento'); await press(view, 'Adicionar parcela');
    field(view, 'Valor da parcela 1').props.onChange({ target: { value: '10' } }); await view.flush();
    await press(view, 'Salvar');
    assert.equal(strict.posts().length, 0); assert.match(view.text(), /A soma das parcelas \(R\$ 10,00\) é diferente do total da nota \(R\$ 30,00\)/);
    field(view, 'Valor da parcela 1').props.onChange({ target: { value: '30' } }); await view.flush();
    await press(view, 'Salvar'); assert.equal(strict.posts().length, 1);
  } finally { view.unmount(); }
  const optional = server({ preferences: { optional_installments: true }, post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) }), loose = await mountForm(optional);
  try {
    await fillNote(loose, '3'); await tab(loose, 'Pagamento'); await press(loose, 'Adicionar parcela');
    field(loose, 'Valor da parcela 1').props.onChange({ target: { value: '10' } }); await loose.flush();
    await press(loose, 'Salvar'); assert.equal(optional.posts().length, 1, 'optional validation lets it through');
  } finally { loose.unmount(); }
  const ipi = server({ preferences: { ipi_first_installment: true }, natureRules: [rule('icms', { situation: '102', cfop: '5102' }), rule('ipi', { situation: '50', rate: '10.0000' })] });
  const first = await mountForm(ipi);
  try {
    await fillNote(first, '3');
    await tab(first, 'Pagamento'); await first.change('fiscal-condition', '2x'); await press(first, 'Gerar parcelas');
    // total 30.00 + IPI 3.00 = 33.00: 15.00 + 3.00 in the first parcel, 15.00 in the second.
    assert.equal(field(first, 'Valor da parcela 1').props.value, '18.00'); assert.equal(field(first, 'Valor da parcela 2').props.value, '15.00');
  } finally { first.unmount(); }
});

const mountList = (srv, location = '/historico-fiscal?modelo=55', screen = 'nfe') => mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen }, { location, expandChildren: ['NativeListLayout', 'ListPreferencesBar'] });
const headers = view => view.nodes().filter(n => n.type === 'th').map(n => textOf(n).trim()).filter(Boolean);

test('lists: "Exibir totais" hides the totals, "Listagem customizada" orders the columns and "Tornar padrão" filters apply once', async () => {
  const hidden = server({ showTotals: false }), view = await mountList(hidden);
  try {
    assert.equal(view.text().includes('Quantidade de notas'), false); assert.equal(view.text().includes('Valor total'), false);
    assert.deepEqual(headers(view), ['Seleção', 'Número', 'Data emissão', 'Nome', 'Situação', 'Valor (R$)', 'Marcadores', 'Ações'], 'standard Origin columns');
    await press(view, 'Listagem customizada');
    assert.match(view.text(), /Escolha as colunas e a ordem/);
    view.input('list-column-series').props.onChange({ target: { checked: true } }); view.input('list-column-state').props.onChange({ target: { checked: true } }); await view.flush();
    view.nodes().find(n => n.type === 'button' && textOf(n).trim() === 'Salvar').props.onClick(); await view.flush();
    const saved = hidden.posts().find(c => c.path === '/v1/preferencias-listas/fiscal.nfe');
    assert.deepEqual(saved.body.columns, ['date', 'name', 'total', 'series', 'state']); assert.equal(saved.body.filters, null);
    assert.deepEqual(headers(view), ['Seleção', 'Número', 'Data emissão', 'Nome', 'Situação', 'Valor (R$)', 'Série', 'UF', 'Marcadores', 'Ações'], 'Situação stays right before Valor');
    assert.ok(view.text().includes('MG'));
  } finally { view.unmount(); }
  const custom = server({ listPrefs: { columns: ['document', 'nature', 'order_numbers', 'exit_date'], filters: { status: 'cancelled', f_nature: 'Venda' } } }), list = await mountList(custom);
  try {
    assert.deepEqual(custom.lists(), ['/v1/notas-fiscais?model=55&page=1', '/v1/notas-fiscais?model=55&page=1&status=cancelled&nature=Venda'], 'saved filters apply once, after the first load');
    assert.deepEqual(headers(list), ['Seleção', 'Número', 'CPF/CNPJ', 'Natureza de operação', 'Número da venda', 'Data de saída', 'Situação', 'Marcadores', 'Ações']);
    assert.ok(list.text().includes('12.345.678/0001-90')); assert.ok(list.text().includes('16/10/2026'));
    assert.deepEqual(component(list, 'AppliedChips').props.chips.map(c => c.label), ['Situação: Canceladas', 'Natureza: Venda']);
    component(list, 'AppliedChips').props.onClear(); await list.flush();
    await press(list, 'Remover filtro padrão');
    const cleared = custom.posts().at(-1); assert.equal(cleared.body.filters, null); assert.deepEqual(cleared.body.columns, ['document', 'nature', 'order_numbers', 'exit_date']);
  } finally { list.unmount(); }
});

const mountNatures = srv => mountComponent('RealOperationNatures.tsx', { controller: srv.controller }, { location: '/naturezas-operacao', expandChildren: ['BatchDialog'] });
test('natures: "Excluir as operações selecionadas" runs one command per nature and the review is confirmed with recovery', async () => {
  let reviewAttempt = 0;
  const srv = server({ post: call => {
    if (call.path === '/v1/notas-fiscais/naturezas/revisao') { if (reviewAttempt++ === 0) throw new AccessError(503); return { review: { confirmed: true, version: 1, confirmed_at: '2026-10-20T13:00:00Z' }, action: 'confirm_review', replayed: true, data_mode: 'erp_native' }; }
    return { nature: { ...nature(), version: 2, active: false, defaults: [] }, action: 'delete', replayed: false, data_mode: 'erp_native' };
  } });
  const view = await mountNatures(srv);
  try {
    const trash = component(view, 'ToolButton'); assert.equal(trash.props.title, 'Excluir as operações selecionadas'); assert.equal(trash.props.disabled, true);
    view.input('natures-review').props.onChange(); await view.flush();
    assert.match(view.text(), /Não foi possível confirmar o registro da revisão/);
    await press(view, 'Conferir resultado');
    const reviews = srv.posts().filter(c => c.path.endsWith('/revisao'));
    assert.equal(reviews.length, 2); assert.equal(reviews[1].body.command_id, reviews[0].body.command_id); assert.equal(reviews[0].body.expected_version, 0);
    assert.match(view.text(), /Revisão confirmada em 20\/10\/2026 às 10:00/);
    view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar natureza Venda sintética').props.onChange({ target: { checked: true } }); await view.flush();
    component(view, 'ToolButton').props.onClick(); await view.flush();
    assert.equal(component(view, 'Modal').props.title, 'Excluir as operações selecionadas');
    await modalAction(view, 'Excluir'); await view.flush();
    const deleted = srv.posts().find(c => c.body?.action === 'delete');
    assert.deepEqual({ ...deleted.body, command_id: undefined }, { command_id: undefined, action: 'delete', id: NATURE, expected_version: 1 });
    assert.match(view.text(), /Natureza excluída/);
  } finally { view.unmount(); }
});

const ORDER = id(600), ORDER_ITEM = id(601), ORDER_ITEM_FREE = id(602);
const entryInput = { model: '55', direction: '0', issue_type: 'T', series: '1', number: '77', nature_description: 'Compra sintética', issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', final_consumer: false,
  recipient: { name: 'Fornecedor sintético', person_type: 'J', document: '12345678000190', state: 'SP' }, items: [{ product_id: PRODUCT, description: 'Peça sintética', quantity: '2', unit_price: '10' }] };
function linkServer({ fail = 0, locks } = {}) {
  const srv = server({ post: call => {
    if (srv.failures++ < fail) throw new AccessError(503);
    const linked = call.body.action === 'link';
    return envelope(recordOf(entryInput, { version: call.body.expected_version + 1, status: 8, environment: null, number: 77, orders: linked ? [{ id: ORDER, kind: 'purchase_orders', number: '15', date: '2026-10-15', contact_name: 'Fornecedor sintético' }] : [] }),
      { action: `${call.body.action}_order`, replayed: srv.failures > 1, document_id: call.body.document_id,
        // Wave F (202610200275): the item links of the pedido after the command.
        items: (call.body.items ?? []).map(i => ({ invoice_position: i.position, document_item_id: i.document_item_id, quantity: i.quantity, counted: i.quantity, valid: true })), removed_items: 0 });
  } });
  srv.failures = 0;
  const base = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options = {}) => {
    if ((options.method ?? 'GET') === 'GET' && path === `/v1/notas-fiscais/${id(1)}`) { srv.calls.push({ path, method: 'GET' }); return { ...envelope(recordOf(entryInput, { version: 4, status: 8, environment: null, number: 77 })), locks: locks ?? { items: false, installments: false } }; }
    // Wave F (202610200275): what the other notes already link of each item of the pedido.
    if ((options.method ?? 'GET') === 'GET' && path === `/v1/notas-fiscais/${id(1)}/pedidos/${ORDER}`) { srv.calls.push({ path, method: 'GET' });
      return { invoice_id: id(1), document_id: ORDER, linked: false, items: [], others: [{ document_item_id: ORDER_ITEM_FREE, quantity: '0.5000' }], state: 'partial', data_mode: 'erp_native' }; }
    if ((options.method ?? 'GET') === 'GET' && path.startsWith('/v1/notas-fiscais?') && path.includes('origin=brufap')) {
      srv.calls.push({ path, method: 'GET' }); const q = new URLSearchParams(path.split('?')[1]);
      return { items: [{ ...originRow(1), origin: 'brufap', id: id(1), version: 4, number: 77, status: 8, status_raw: null, environment: null, issue_type: 'T', protocol_present: false, orders: [] }], origin: 'brufap', model: '55', direction: q.get('direction'), page: 1,
        limit: 100, order: 'date_desc', has_more: false, total_count: 1, total_amount: '20.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: 'erp_native_homologation' };
    }
    return base(path, options);
  };
  srv.controller.documents = async (path, options = {}) => {
    srv.calls.push({ path, method: options.method ?? 'GET' });
    if (path.startsWith('/v1/documentos/purchase_orders?')) return { kind: 'purchase_orders', items: [{ id: ORDER, kind: 'purchase_orders', number: '15', version: 2, status: 'in_progress', date: '2026-10-15', total: '30.00', contact_id: id(500), contact_name: 'Fornecedor sintético', created_at: '2026-10-15T12:00:00Z', updated_at: '2026-10-15T12:00:00Z' }],
      limit: 100, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 1, total_amount: '30.00', data_mode: 'erp_native', operational_effects: false };
    if (path === `/v1/documentos/purchase_orders/${ORDER}`) return { kind: 'purchase_orders', document: { id: ORDER, kind: 'purchase_orders', number: '15', items: [{ id: ORDER_ITEM, product_id: PRODUCT, description: 'Peça sintética', quantity: '3' }, { id: ORDER_ITEM_FREE, product_id: null, description: 'Frete do fornecedor', quantity: '1' }] }, data_mode: 'erp_native', operational_effects: false };
    throw new AccessError(404);
  };
  return srv;
}

test('Vincular à pedido de compra: one FAGOO note, item a item with the summary, and the same command after an unknown outcome', async () => {
  const srv = linkServer({ fail: 1 });
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'entrada' }, { location: '/notas-entrada?origem=brufap', expandChildren: ['NativeListLayout', 'FiscalOrderLinkDialog'] });
  try {
    assert.deepEqual(headers(view).slice(-4), ['Valor (R$)', 'Marcadores', 'Vinculação', 'Ações'], 'Origin: the Vinculação badge comes after the Marcadores');
    assert.equal(button(view, 'Vincular à pedido de compra').disabled, true, 'select one note first');
    view.nodes().find(n => n.type === 'input' && String(n.props['aria-label']).startsWith('Selecionar nota')).props.onClick({ shiftKey: false }); await view.flush();
    assert.equal(button(view, 'Desvincular pedido compra').disabled, true, 'not linked yet');
    await press(view, 'Vincular à pedido de compra');
    assert.match(view.text(), /Não vinculado/);
    await view.change('fiscal-link-search', '15'); view.nodes().filter(n => n.type === 'form').at(-1).props.onSubmit({ preventDefault() {} }); await view.flush();
    assert.ok(srv.calls.some(c => c.path.startsWith('/v1/documentos/purchase_orders?') && c.path.includes('q=15')));
    view.nodes().find(n => n.type === 'button' && textOf(n).startsWith('Pedido 15')).props.onClick(); await view.flush();
    // Wave F: each item of the pedido proposes the note item of the same product with what is left to link.
    assert.match(view.text(), /Itens vinculados: 0 de 2 · a vincular: 2/);
    const select = label => view.nodes().find(n => n.type === 'select' && n.props['aria-label'] === `Item da nota para ${label}`);
    const amount = label => view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === `Quantidade a vincular de ${label}`);
    assert.deepEqual([select('Peça sintética').props.value, amount('Peça sintética').props.value], ['1', '2']);
    assert.deepEqual([select('Frete do fornecedor').props.value, amount('Frete do fornecedor').props.value], ['', '']);
    assert.ok(view.nodes().filter(n => n.type === 'tr').map(textOf).some(r => r.startsWith('Frete do fornecedor10,5')), 'the quantity linked by other notes');
    // More than what is left of the pedido is refused before the server.
    amount('Peça sintética').props.onChange({ target: { value: '4' } }); await view.flush();
    assert.match(view.text(), /a quantidade passa do que falta vincular no pedido \(3\)/);
    assert.equal(view.guard().changed, true, 'changed quantities ask before leaving');
    amount('Peça sintética').props.onChange({ target: { value: '2' } }); await view.flush();
    await modalAction(view, 'Vincular');
    assert.match(view.text(), /Não foi possível confirmar o resultado/); assert.equal(view.guard().changed, true, 'the unknown link asks before leaving');
    await modalAction(view, 'Conferir resultado');
    const posts = srv.posts().filter(c => c.path === `/v1/notas-fiscais/${id(1)}/pedidos`);
    assert.equal(posts.length, 2); assert.equal(posts[1].body.command_id, posts[0].body.command_id);
    assert.deepEqual({ ...posts[0].body, command_id: null }, { command_id: null, expected_version: 4, action: 'link', document_id: ORDER, items: [{ position: 1, document_item_id: ORDER_ITEM, quantity: '2.0000' }] });
    assert.match(view.text(), /Nota vinculada ao pedido de compra, 1 item\(ns\) vinculado\(s\)/); assert.equal(view.guard().changed, false); assert.match(view.text(), /Pedido 15 · Fornecedor sintético/);
  } finally { view.unmount(); }
});

test('a note locked by the sales order keeps items and parcels read-only, with the reason', async () => {
  const srv = linkServer({ locks: { items: true, installments: true } });
  const view = await mountForm(srv, { id: id(1), opening: null, config: { screen: 'entrada', model: '55', direction: '0' } });
  try {
    assert.match(view.text(), /Estoque e contas já foram lançados pelo pedido de venda: itens, quantidades e parcelas ficam bloqueados/);
    await tab(view, 'Itens da nota fiscal');
    assert.equal(field(view, 'Quantidade do item 1').props.disabled, true); assert.equal(button(view, 'Adicionar outro item').disabled, true);
    await tab(view, 'Pagamento'); assert.equal(button(view, 'Adicionar parcela').disabled, true);
    await tab(view, 'Informações adicionais'); assert.equal(view.input('fiscal-additional').props.disabled, false, 'the rest stays editable');
  } finally { view.unmount(); }
});

const importedRecord = (over = {}) => recordOf(entryInput, { id: id(1), version: 1, status: 8, environment: null, number: 77, issue_type: 'X', protocol: '135260000000777', authorized_at: '2026-10-18T12:31:05Z', ...over });
const SAMPLE_XML = '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35261012345678000195550010000000771123456780"/></NFe></nfeProc>';
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');

test('Importar XML NF-e: one command per file, "Conferir resultado" after an unknown outcome, success and refusals in Origin words', async () => {
  let attempt = 0;
  const srv = server({ post: call => {
    if (call.path !== '/v1/notas-fiscais/importar') throw new AccessError(404);
    if (call.body.xml.includes('outra empresa')) return { imported: false, refused: 'other_company', invoice_id: null, data_mode: 'erp_native' };
    if (attempt++ === 0) throw new AccessError(503);
    return { ...envelope(importedRecord(), { writable: false }), action: 'import', replayed: true, imported: true, matched_items: 0, contact_matched: true };
  } });
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout', 'FiscalImportDialog'] });
  try {
    await press(view, 'Importar XML NF-e');
    assert.equal(component(view, 'Modal').props.title, 'Importar XML NF-e');
    assert.equal(view.input('fiscal-import-finance').props.disabled, true); assert.equal(view.input('fiscal-import-stock').props.disabled, true);
    view.input('fiscal-import-file').props.onChange({ target: { files: [{ name: 'nota.pdf', size: 10, text: async () => '' }] } }); await view.flush();
    assert.match(view.text(), /Escolha um arquivo \.xml/);
    view.input('fiscal-import-file').props.onChange({ target: { files: [{ name: 'nota.xml', size: SAMPLE_XML.length, text: async () => SAMPLE_XML }] } }); await view.flush();
    assert.match(view.text(), /Arquivo escolhido: nota\.xml/);
    assert.equal(view.guard().changed, true, 'a chosen file asks before leaving');
    await modalAction(view, 'Importar');
    assert.match(view.text(), /Não foi possível confirmar a importação/);
    assert.equal(view.guard().changed, true, 'an unknown outcome keeps Conferir resultado');
    await modalAction(view, 'Conferir resultado');
    const posts = srv.posts();
    assert.equal(posts.length, 2); assert.equal(posts[1].body.command_id, posts[0].body.command_id); assert.equal(posts[0].body.xml, SAMPLE_XML);
    assert.match(view.text(), /Sua nota foi importada com sucesso/); assert.equal(view.guard().changed, false); assert.match(view.text(), /Importação de XML de entrada · nota 000077/); assert.match(view.text(), /0 de 1 item\(ns\) ligado\(s\)/);
    await press(view, 'Conciliar produtos');
    assert.equal(view.location().pathname, '/notas-entrada'); assert.equal(new URLSearchParams(view.location().search).get('nota'), id(1), 'an entry note opens in Notas de entrada');
  } finally { view.unmount(); }
  const other = server({ post: () => ({ imported: false, refused: 'other_company', invoice_id: null, data_mode: 'erp_native' }) });
  const refused = await mountComponent('RealFiscalInvoices.tsx', { controller: other.controller, screen: 'entrada' }, { location: '/notas-entrada', expandChildren: ['NativeListLayout', 'FiscalImportDialog'] });
  try {
    await press(refused, 'Importar XML NF-e');
    refused.input('fiscal-import-file').props.onChange({ target: { files: [{ name: 'nota.xml', size: 20, text: async () => '<x>outra empresa</x>' }] } }); await refused.flush();
    await modalAction(refused, 'Importar');
    assert.match(refused.text(), /A empresa não é a emitente nem a destinatária deste XML/);
  } finally { refused.unmount(); }
});

test('an imported note opens read-only with "Conciliar produtos" and its XML is shown only after the browser checks it', async () => {
  const srv = server({ post: call => ({ ...envelope(importedRecord({ version: 2, items: importedRecord().items.map(i => ({ ...i, product_id: PRODUCT })) }), { writable: false }), action: 'reconcile', replayed: false }) });
  const base = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options = {}) => {
    if ((options.method ?? 'GET') === 'GET' && path === `/v1/notas-fiscais/${id(1)}`) { srv.calls.push({ path, method: 'GET' }); return { ...envelope(importedRecord({ items: importedRecord().items.map(({ product_id, ...i }) => i) }), { writable: false }), locks: { items: false, installments: false } }; }
    if (path === `/v1/notas-fiscais/${id(1)}/xml`) { srv.calls.push({ path, method: 'GET' }); return { invoice_id: id(1), access_key: '35261012345678000195550010000000771123456780', sha256: await sha(SAMPLE_XML), size: SAMPLE_XML.length, signed: true, protocol_status: '100', imported_at: '2026-10-20T12:00:00Z', xml: SAMPLE_XML, data_mode: 'erp_native' }; }
    return base(path, options);
  };
  const form = await mountForm(srv, { id: id(1), opening: null, config: { screen: 'entrada', model: '55', direction: '0' } });
  try {
    assert.match(form.text(), /Nota importada do XML \(chave/); assert.equal(button(form, 'Salvar').disabled, true);
    await tab(form, 'Itens da nota fiscal');
    assert.match(form.text(), /Conciliar produtos/); assert.equal(button(form, 'Salvar conciliação').disabled, true);
    await press(form, 'Escolher produto'); await wait(form);
    form.nodes().find(n => n.type === 'button' && textOf(n).includes('Peça catálogo')).props.onClick(); await form.flush();
    assert.equal(form.guard().changed, true, 'a chosen product asks before leaving the note');
    await press(form, 'Salvar conciliação');
    const sent = srv.posts().find(c => c.path === `/v1/notas-fiscais/${id(1)}/conciliar`);
    assert.deepEqual({ ...sent.body, command_id: null }, { command_id: null, expected_version: 1, items: [{ position: 1, product_id: PRODUCT }] });
    assert.match(form.text(), /Produtos conciliados/); assert.equal(form.guard().changed, false);
  } finally { form.unmount(); }
  const list = server(); const listBase = list.controller.fiscalInvoices;
  list.controller.fiscalInvoices = async (path, options = {}) => {
    if (path.startsWith('/v1/notas-fiscais?') && path.includes('origin=brufap')) { list.calls.push({ path, method: 'GET' }); return { items: [{ ...originRow(1), origin: 'brufap', id: id(1), version: 1, number: 77, status: 8, status_raw: null, environment: null, issue_type: 'X', protocol_present: true }],
      origin: 'brufap', model: '55', direction: '0', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: 1, total_amount: '20.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: 'erp_native_homologation' }; }
    if (path === `/v1/notas-fiscais/${id(1)}/xml`) { list.calls.push({ path, method: 'GET' }); return { invoice_id: id(1), access_key: '35261012345678000195550010000000771123456780', sha256: '0'.repeat(64), size: SAMPLE_XML.length, signed: true, protocol_status: '100', imported_at: '2026-10-20T12:00:00Z', xml: SAMPLE_XML, data_mode: 'erp_native' }; }
    return listBase(path, options);
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: list.controller, screen: 'entrada' }, { location: '/notas-entrada?origem=brufap', expandChildren: ['NativeListLayout'] });
  try {
    const items = component(view, 'RowMenu').props.items;
    assert.equal(items.find(i => i.label === 'Visualizar').disabled, false, 'imported notes are viewed, not edited');
    items.find(i => i.label === 'Outras opções de NF-e').onClick(); await view.flush();
    await press(view, 'Ver o XML da nota'); await view.flush();
    assert.match(view.text(), /Não foi possível conferir o XML\. Nenhum arquivo foi entregue/, 'a hash that does not match is never shown');
  } finally { view.unmount(); }
});

test('Exportação de XML NFe: selected notes go into one ZIP after each XML is checked; unverifiable or missing XMLs are listed', async () => {
  const good = '<nfeProc>nota sintética 121</nfeProc>', goodHash = await sha(good);
  const srv = server(); const base = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options = {}) => {
    if (path.startsWith('/v1/notas-fiscais?')) { const page = await base(path, options); page.items = [originRow(1, { xml_id: id(11), xml_hash: goodHash, xml_size: new TextEncoder().encode(good).byteLength, access_key: '35261012345678000195550010000001211123456781' }),
      originRow(2, { xml_id: id(12), xml_hash: 'f'.repeat(64), xml_size: 5 }), originRow(3)]; page.total_count = 3; return page; }
    return base(path, options);
  };
  srv.controller.syncedXmlDownload = async path => new Blob([path.includes(id(11)) ? good : 'falso']);
  const saved = []; const previous = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
  URL.createObjectURL = blob => { saved.push(blob); return 'blob:sintetico'; }; URL.revokeObjectURL = () => {};
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout', 'FiscalXmlExportDialog'] });
  try {
    component(view, 'ListControls').props.onToggleAll(); await view.flush();
    await press(view, 'Exportar XML');
    assert.equal(component(view, 'Modal').props.title, 'Exportação de XML NFe'); assert.equal(view.input('fiscal-export-selected').props.checked, true);
    await modalAction(view, 'Exportar'); await new Promise(r => setTimeout(r, 50)); await view.flush();
    assert.match(view.text(), /3 de 3 notas exportadas · 1 arquivo\(s\)/); assert.match(view.text(), /2 nota\(s\) não exportada\(s\)/);
    assert.match(view.text(), /Nota 000122: o XML não pôde ser conferido/); assert.match(view.text(), /Nota 000123: sem XML coletado do Origin/);
    assert.equal(saved.length, 1); const zip = new Uint8Array(await saved[0].arrayBuffer());
    assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]); assert.ok(new TextDecoder().decode(zip).includes('NFe35261012345678000195550010000001211123456781.xml'));
    assert.ok(new TextDecoder().decode(zip).includes(good));
  } finally { view.unmount(); Object.assign(globalThis, { document: previous.document }); URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; }
});

test('Exportação de XML NFe by period says how many notes stay out beyond the 1.000 of one ZIP', async () => {
  const { SCREENS, emptyFilters } = await import('../src/lib/fiscal-invoice-list-model.ts');
  const total = 1205, srv = server(); const base = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options = {}) => {
    if (path.startsWith('/v1/notas-fiscais?')) { const page = await base(path, options), n = page.page; page.total_count = total; page.has_more = total > n * 100;
      page.items = Array.from({ length: Math.min(100, total - (n - 1) * 100) }, (_, i) => originRow((n - 1) * 100 + i + 1, { id: String(100000 + (n - 1) * 100 + i) })); return page; }
    return base(path, options);
  };
  const config = SCREENS.nfe, filters = { ...emptyFilters(config), from: '2026-10-01', to: '2026-10-20' };
  const view = await mountComponent('FiscalXmlExportDialog.tsx', { controller: srv.controller, config, origin: 'origin', filters, order: 'date_desc', selected: [], onClose() {} });
  try {
    assert.equal(view.input('fiscal-export-period').props.checked, true);
    await modalAction(view, 'Exportar'); await new Promise(r => setTimeout(r, 50)); await view.flush();
    assert.equal(srv.calls.filter(c => c.path.startsWith('/v1/notas-fiscais?')).length, 10, 'ten pages of 100, never more');
    assert.match(view.text(), /1000 de 1000 notas exportadas/);
    assert.match(view.text(), /O filtro tem 1\.205 notas: este ZIP leva as 1\.000 primeiras na ordem da lista e 205 ficam de fora/);
  } finally { view.unmount(); }
});

test('Incluir NFC-e without an active A1 asks "deseja prosseguir mesmo assim?" and links to the certificate', async () => {
  for (const [state, prompt] of [[{ state: 'unconfigured', time_valid_now: false }, true], [{ state: 'configured_offline', time_valid_now: true }, false]]) {
    const srv = server(); srv.controller.a1 = async () => state;
    const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfce' }, { location: '/historico-fiscal?modelo=65', expandChildren: ['NativeListLayout'] });
    try {
      component(view, 'OriginListHeader').props.primary.props.onClick(); await view.flush(); await view.flush();
      if (prompt) {
        assert.match(view.text(), /Sem a configuração do certificado não é possível emitir a NFC-e, deseja prosseguir mesmo assim\?/);
        await modalAction(view, 'Configurar certificado digital'); assert.equal(view.location().pathname, '/certificado-a1');
      } else assert.equal(new URLSearchParams(view.location().search).get('nota'), 'nova');
    } finally { view.unmount(); }
  }
});

test('Notas recebidas: number, series and issuer read from the key, "Copiar chave" and "Importar NF-e para notas de compra" with the checked file', async () => {
  const xml = '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">recebida sintética</nfeProc>', key = '35261012345678000195550010000003211123456780';
  const bytes = new TextEncoder().encode(xml), channel = id(31);
  const FLAGS = { data_mode: 'received_dfe', model: '55', transport_enabled: false, can_query: false, can_manifest: false, can_emit: false, origin_authenticated: false, signature_verified: false, xsd_validated: false, sefaz_authorized: false, financial_mutation_performed: false, stock_mutation_performed: false };
  const current = { id: channel, environment: '1', identity_version: 1, version: 1, coordinator: 'external', other_consumers_reviewed: false, checkpoint: null, checkpoint_confirmed: false, collection_requested: false, paused: false, has_active_attempt: false, not_before: null, updated_at: '2026-10-16T12:00:00.123456Z', company_changed: false };
  const row = { id: id(32), channel_id: channel, nsu: '000000000000009', kind: 'invoice', schema: 'procNFe_v4.00.xsd', model: '55', access_key: key, recipient_match: true, quarantined: false, xml_hash: await sha(xml), size_bytes: bytes.byteLength, collected_at: '2026-10-16T12:00:00Z', is_complete_invoice: true };
  const srv = server({ post: call => ({ ...envelope(importedRecord(), { writable: false }), action: 'import', replayed: false, imported: true, matched_items: 1, contact_matched: false }) });
  Object.assign(srv.controller, {
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 1, data: { legal_name: 'EMPRESA FICTICIA', cnpj: '11222333000181' } } }; },
    async dfeDistribution(path) { srv.calls.push({ path, method: 'GET' }); return path.includes('/documents') ? { ...FLAGS, channel_id: channel, items: [row], limit: 25, has_more: false, next_cursor: null } : { ...FLAGS, current }; },
    async dfeDistributionDownload() { return new Blob([bytes]); },
  });
  const copied = []; const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied.push(text); } } }, configurable: true });
  const view = await mountComponent('RealReceivedDfe.tsx', { controller: srv.controller, initialEnvironment: '1' }, { location: '/notas-recebidas', expandChildren: ['FiscalImportDialog'] });
  try {
    await view.flush();
    assert.ok(headers(view).includes('Número') && headers(view).includes('Série') && headers(view).includes('CNPJ/CPF'));
    assert.ok(view.text().includes('000321')); assert.ok(view.text().includes('12.345.678/0001-95'));
    await press(view, 'Copiar chave'); assert.deepEqual(copied, [key]); assert.match(view.text(), /Chave copiada/);
    await press(view, 'Importar NF-e para notas de compra'); await view.flush();
    assert.equal(component(view, 'Modal').props.title, 'Importar XML NF-e'); assert.match(view.text(), /Arquivo escolhido: NFE_/);
    await modalAction(view, 'Importar');
    assert.equal(srv.posts()[0].body.xml, xml, 'the checked bytes are imported as they are');
    assert.match(view.text(), /Sua nota foi importada com sucesso/);
  } finally { view.unmount(); Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true }); }
});

test('Preferências › Configurações de NF-e › Controle de numeração shows CNPJ | Série | Próximo número of the homologation series', async () => {
  const { createPreferencesFixture } = await import('../src/qa/preferences-fixture.ts');
  const { preferencePage } = await import('../../../packages/erp-domain/src/preferences/catalog.mjs');
  const previous = globalThis.document; globalThis.document = { activeElement: null, documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} };
  const NUMBERING = { data_mode: 'fiscal_numbering', policy: 'brufap-homologation-exclusive-v1', environment: '2', can_emit: false, can_transmit: false, authorized: false, financial_mutation_performed: false, stock_mutation_performed: false };
  const series = { id: id(41), issuer_cnpj: '11222333000181', cuf: '35', model: '55', environment: '2', series: '2', first_number: '1', next_number: '42195', exhausted: false, version: 42195, identity_version: 1, enabled: true,
    exclusive_use_confirmed: true, reference: 'Série sintética', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', company_changed: false };
  const f = createPreferencesFixture({ role: 'fiscal' }), paths = [];
  const controller = { ...f.controller, fiscalNumbering: async path => { paths.push(path); return { ...NUMBERING, read_only: true, items: [series], limit: 25, has_more: false, next_cursor: null }; } };
  const view = await mountComponent('PreferenceSettingsPage.tsx', { controller, page: preferencePage('notas-nfe'), section: 'numeracao', categoryLabel: 'Notas Fiscais', categoryTo: '/preferencias/notas-fiscais' }, { expandChildren: true, location: '/preferencias/notas-fiscais/nfe/numeracao' });
  try {
    await view.flush();
    assert.ok(paths[0].startsWith('/v1/numeracao-fiscal/series?') && paths[0].includes('model=55'), paths[0]);
    assert.deepEqual(headers(view).slice(0, 4), ['CNPJ', 'Série', 'Próximo número', 'Ambiente']);
    assert.match(view.text(), /11\.222\.333\/0001-81/); assert.match(view.text(), /42195/); assert.match(view.text(), /As séries de produção ficam travadas/);
  } finally { view.unmount(); globalThis.document = previous; }
});

test('Formação de preços: unit cost from the entry note and the sale price of the markup preference, exact to four decimals', async () => {
  const { pricingLines } = await import('../src/lib/fiscal-invoice-pricing.ts');
  const record = { items: [{ position: 1, description: 'Peça sintética', product_id: PRODUCT, quantity: '3.0000', unit_price: '10.0000000000', total: '30.00', ipi: { value: '3.00' }, icms: { st_value: '1.50' },
    allocated: { freight: '2.00', insurance: '0.10', other_expenses: '0.40', discount: '1.00' } }] };
  assert.deepEqual(pricingLines(record, {}, '35.5')[0], { position: 1, description: 'Peça sintética', product_id: PRODUCT, quantity: '3.0000', purchase: '10.0000', ipi: '1.0000', st: '0.5000', freight: '0.7000',
    other: '0.1333', discount: '0.3333', cost: '12.0000', sale: '16.2600' });
  assert.equal(pricingLines(record, { 1: '10,5' }, '35.5')[0].sale, '13.2600'); assert.equal(pricingLines(record, { 1: 'abc' }, '35.5')[0].sale, null);
  const srv = linkServer(); const base = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options = {}) => path.startsWith('/v1/notas-fiscais/contexto') ? { ...(await base(path, options)), preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [], markup: '35.5' } } : base(path, options);
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'entrada' }, { location: '/notas-entrada?origem=brufap', expandChildren: ['NativeListLayout', 'FiscalPricingDialog'] });
  try {
    component(view, 'RowMenu').props.items.find(i => i.label === 'Formação de preços').onClick(); await view.flush(); await view.flush();
    assert.equal(component(view, 'Modal').props.title, 'Formação de preços'); assert.match(view.text(), /markup padrão 35,5%/);
    // entryInput: 2 × 10.00, no taxes: cost 10.0000, sale 13.5500.
    assert.ok(view.text().includes('10,0000')); assert.ok(view.text().includes('13,5500'));
    field(view, 'Markup do item 1').props.onChange({ target: { value: '50' } }); await view.flush();
    assert.ok(view.text().includes('15,0000'));
    // "Atualizar preços" is the products lane button (ProductPriceUpdate.tsx, migration 155): it receives the lines of this dialog.
    let update; walk(component(view, 'Modal').props.actions, n => { if (n.type?.name === 'UpdatePricesButton') update = n; });
    assert.equal(update.props.lines[0].sale, '15.0000'); assert.equal(update.props.lines[0].cost, '10.0000');
  } finally { view.unmount(); }
});

test('Outras opções › Baixar XML carta de correção hands over the CC-e collected with a Origin note after checking it', async () => {
  const letter = '<procEventoNFe>carta sintética</procEventoNFe>', letterHash = await sha(letter), size = new TextEncoder().encode(letter).byteLength;
  const srv = server(); const base = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options = {}) => {
    if (path.startsWith('/v1/notas-fiscais?')) { const page = await base(path, options); page.items = [originRow(1, { event_count: 1, access_key: '35261012345678000195550010000001211123456781' }), originRow(2)]; return page; }
    if (path === '/v1/notas-fiscais/origin/nfe/9001') { srv.calls.push({ path, method: 'GET' }); return { origin: 'origin', entity: 'nfe', source_id: '9001', model: '55', direction: '1', number: 121, series: 1, issue_date: '2026-10-15', operation_date: null,
      status: 6, status_raw: '5', access_key: '35261012345678000195550010000001211123456781', total: '100.10', total_known: true, freight: null,
      contact: { name: 'Cliente Origin 1', document: null, ie: null, email: null, phone: null, street: null, number: null, complement: null, district: null, postal_code: null, city: null, state: null, country: null },
      items: [], installments: [], transport: { freight_by: null, carrier: null }, additional_info: null, xml: null, events: [{ id: id(51), type: '110110', sequence: '1', hash: letterHash, size }],
      observed_at: '2026-10-16T12:00:00Z', data_mode: 'origin_mirror_readonly', writable: false }; }
    return base(path, options);
  };
  srv.controller.syncedXmlDownload = async () => new Blob([letter]);
  const saved = []; const previous = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
  URL.createObjectURL = blob => { saved.push(blob); return 'blob:sintetico'; }; URL.revokeObjectURL = () => {};
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout'] });
  try {
    component(view, 'RowMenu', 1).props.items.find(i => i.label === 'Outras opções de NF-e').onClick(); await view.flush();
    assert.equal(button(view, 'Baixar XML carta de correção').disabled, true, 'no event collected for this note');
    await modalAction(view, 'Fechar');
    component(view, 'RowMenu').props.items.find(i => i.label === 'Outras opções de NF-e').onClick(); await view.flush();
    await press(view, 'Baixar XML carta de correção'); await new Promise(r => setTimeout(r, 20)); await view.flush();
    assert.equal(saved.length, 1); assert.equal(await saved[0].text(), letter); assert.match(view.text(), /XML da carta de correção conferido e baixado/);
  } finally { view.unmount(); globalThis.document = previous.document; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; }
});

test('Gerar devolução opens a finalidade 4 draft in the other direction, referencing the key, with the Padrão devolução nature', async () => {
  const { returnDraft, cloneDraft } = await import('../src/lib/fiscal-invoice-form-model.ts');
  const DE = id(910), record = recordOf({ model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: NATURE, nature_description: 'Venda sintética', issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { name: 'Cliente sintético', person_type: 'J', document: '12345678000190', state: 'SP' }, items: [{ description: 'Peça sintética', quantity: '2', unit_price: '50' }] }, { access_key: null });
  const key = '35261011222333000181550020000001231123456781';
  const context = { company: { crt: '1', state: 'SP' }, series: [], defaults: { DE: { id: DE, description: 'Devolução de venda' }, E: { id: id(911), description: 'Compra' } }, preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] } };
  const draft = returnDraft(cloneDraft(record, { invert: true, context }), key, context);
  assert.deepEqual([draft.model, draft.direction, draft.issue_type, draft.purpose, draft.nature_id, draft.nature_description, draft.presence], ['55', '0', 'N', '4', DE, 'Devolução de venda', '9']);
  assert.deepEqual(draft.references, [{ type: 'nfe', key }]); assert.equal(draft.items[0].quantity, '2.0000'); assert.equal(draft.items[0].cfop, undefined);
  assert.equal(draft.series, '1', 'an own NF-e: never the series of the returned note');
  const withSeries = { ...context, series: [{ series: 4, next_number: 10, enabled: false }, { series: 7, next_number: 20, enabled: true }] };
  assert.equal(returnDraft(cloneDraft(record, { invert: true, context: withSeries }), key, withSeries).series, '7', 'the enabled NF-e series of the context');
  // From an NFC-e screen the return is an NF-e: the form reads the NF-e context (series, defaults and preferences).
  const nfce = server(), returned = await mountForm(nfce, { config: { screen: 'nfce', model: '65', direction: '1' }, opening: { kind: 'return', record: { ...record, model: '65', issue_type: 'C', access_key: key } } });
  try {
    assert.ok(nfce.calls.some(c => c.path === '/v1/notas-fiscais/contexto?model=55'));
    assert.equal(nfce.calls.some(c => c.path === '/v1/notas-fiscais/contexto?model=65'), false);
  } finally { returned.unmount(); }
  const srv = server(), view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout'] });
  try {
    const action = component(view, 'RowMenu').props.items.find(i => i.label === 'Gerar devolução');
    assert.equal(action.disabled, true, 'Origin returns remain in Origin during coexistence'); assert.match(action.title, /convivência.*devolução/);
  } finally { view.unmount(); }
});
