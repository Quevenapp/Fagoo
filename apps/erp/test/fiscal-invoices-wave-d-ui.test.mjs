import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeInvoiceInput, invoiceTotals, DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// Fourth wave of the Origin invoice screens (migration 202610200215 and later): Vendedor of the note, the contact cadastro
// (Contribuinte, natureza padrão, vendedor) when a contact is picked, the transporta group from the pedido carrier, "Considerar a
// data da venda nas parcelas", Destino da Operação manual, the open contas panel and one note per pedido on save.
// Synthetic controller only (no DOM, no network, synthetic data).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = '20000000-0000-4000-8000-000000000001', NATURE = id(900), CONTACT_NATURE = id(901), PRODUCT = id(800), ORDER = id(600), CONTACT = id(500), CARRIER = id(501), SELLER = id(700), OTHER = id(502);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const button = (view, label) => { const found = view.nodes().find(n => n.type === 'button' && textOf(n).trim() === label); if (!found) throw new Error(`Missing button ${label}`); return found; };
const press = async (view, label) => { const node = button(view, label); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
const tab = async (view, label) => { const found = view.nodes().find(n => n.type === 'button' && (n.props.role === 'tab' || String(n.props['aria-controls'] ?? '').startsWith('fiscal-section-')) && textOf(n).trim() === label); if (!found) throw new Error(`Missing tab ${label}`); found.props.onClick(); await view.flush(); };
const modalPress = async (view, label) => { const modal = components(view, 'Modal').at(-1); let found; const walk = value => { if (Array.isArray(value)) { value.forEach(walk); return; } if (!value || typeof value !== 'object') return; if (value.type === 'button' && textOf(value).trim() === label) found = value; walk(value.props?.children); }; walk(modal.props.actions); if (!found) throw new Error('Missing dialog action ' + label); found.props.onClick?.({ preventDefault() {} }); await view.flush(); };
const wait = async view => { await view.flush(); await new Promise(r => setTimeout(r, 300)); await view.flush(); };
const rule = (tax, data) => ({ tax, position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], products: [], data, additional_info: null, fiscal_info: null });
const natureOf = (natureId, description, over = {}) => ({ id: natureId, description, series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
  include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: 'Vendedor: [NOME_VENDEDOR]', fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
  defaults: [], rules: [rule('icms', { situation: '101', cfop: '5102', credit_rate: '1.2500' })], ...over });
const NATURES = { [NATURE]: natureOf(NATURE, 'Venda sintética', { defaults: ['S'] }), [CONTACT_NATURE]: natureOf(CONTACT_NATURE, 'Venda do contato') };
const summary = n => ({ id: n.id, description: n.description, series: n.series, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced, final_consumer: n.final_consumer, return_operation: n.return_operation, active: n.active, version: n.version, defaults: n.defaults, rule_count: n.rules.length, updated_at: n.updated_at });
const contactRow = (over = {}) => ({ contact_id: CONTACT, name: 'Cliente sintético 42', code: 'C-42', active: true, trade_name: null, person_type: 'J', document: '12.345.678/0001-90', ie: '123456789', email: 'cliente@sintetico.test', phone: null,
  mobile: null, postal_code: '30110-000', street: 'Rua Sintética', number: '10', complement: null, district: 'Centro', city: 'Belo Horizonte', state: 'MG', taxpayer: '1', country: null, nfe_email: 'nfe@sintetico.test', ...over });
const carrierRow = { contact_id: CARRIER, name: 'Transportadora sintética', active: true, person_type: 'J', document: '22.333.444/0001-55', ie: '987654321', postal_code: null, street: 'Av. das Cargas', number: '500', complement: null,
  district: 'Distrito', city: 'Campinas', state: 'SP' };
const sourceOf = (over = {}) => ({ document: { id: ORDER, kind: 'sales_orders', number: '42', version: 3, status: 'open', date: '2026-10-10', ship_date: null, customer_po_number: null, notes: null,
  warehouse_id: null, stock_active: false, finance_active: false }, direction: '1', model: '55', eligible: true, reasons: [], contact: contactRow(), nature: null,
  items: [{ position: 1, product_id: PRODUCT, description: 'Peça sintética', code: 'P-1', unit: 'UN', quantity: '2.000000', unit_price: '10.0000000000', gross: '20.00', discount: '0.00', total: '20.00', product: null }],
  totals: { gross: '20.00', line_discount: '0.00', discount: '0.00', freight: '0.00', other_expenses: '0.00', total: '20.00' },
  installments: [{ position: 1, due_date: '2026-11-09', amount: '20.00', method: 'Boleto', note: null }], delivery: null,
  transport: { freight_mode: '0', volume_count: null, gross_weight: null, tracking_code: null, carrier_label: 'Transportadora Origin' }, existing_invoice: null,
  seller: { id: SELLER, name: 'Vendedora sintética' }, carrier: carrierRow, keep_order_dates: false, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native', ...over });
function recordOf(input, over = {}) {
  const normalized = normalizeInvoiceInput(input), totals = invoiceTotals(normalized);
  return { ...normalized, id: id(1), version: 1, status: 1, environment: '2', series: Number(normalized.series), number: null, access_key: null, protocol: null, authorized_at: null, nature_description: normalized.nature_description ?? 'Venda sintética',
    items: normalized.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals, orders: [], seller_name: normalized.seller_id ? 'Vendedora sintética' : null, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, ...over };
}
const envelope = (record, extra = {}) => ({ invoice: record, writable: true, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', ...extra });
function server({ preferences = {}, source = sourceOf(), post, contactSource, context = {}, sellerOptions = [] } = {}) {
  const calls = []; const snapshot = { phase: 'ready', membership: { user_id: admin, role: 'admin' } };
  const prefs = { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [], ...preferences };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') return post(call, calls);
      if (path.startsWith('/v1/notas-fiscais/contexto')) return { company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [{ series: 2, next_number: 42195, enabled: true }],
        defaults: { S: { id: NATURE, description: 'Venda sintética' } }, preferences: structuredClone(prefs), item_discount: false, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native', ...context };
      if (path.startsWith('/v1/notas-fiscais/naturezas?')) return { items: Object.values(NATURES).map(summary), page: 1, limit: 100, total_count: 2, writable: true, review: { confirmed: false, version: 0, confirmed_at: null }, data_mode: 'erp_native' };
      const nature = /^\/v1\/notas-fiscais\/naturezas\/(.+)$/.exec(path); if (nature) return { nature: NATURES[nature[1]], writable: true, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 0, updated_at: null, writable: true, data_mode: 'erp_native' };
      if (path.startsWith(`/v1/notas-fiscais/pedido/${ORDER}?`)) return structuredClone(source);
      const contact = /^\/v1\/notas-fiscais\/contato\/([^?]+)\?direction=([01])$/.exec(path);
      if (contact && contactSource) return contactSource(contact[1], contact[2]);
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog(path) {
      calls.push({ path, method: 'GET' });
      if (path.startsWith('/v1/cadastros/vendedores/opcoes?')) return { scope: 'seller_options', users: [], data_mode: 'erp_native', items: sellerOptions };
      if (path.startsWith('/v1/cadastros/contatos/opcoes?')) return { items: [{ id: CONTACT, name: 'Cliente sintético 42', person_type: 'J', document: '12345678000190', state: 'MG' }, { id: OTHER, name: 'Outro cliente', person_type: 'F', document: '12345678909', state: 'SP' },
        { id: CARRIER, name: 'Transportadora sintética', person_type: 'J', document: '22333444000155', state: 'SP', city: 'Campinas' }], has_more: false };
      return { items: [], has_more: false };
    },
    async finance() { return { entity: 'contact_open_titles', contact_id: CONTACT, kind: 'receivable', total: 0, balance_cents: '0', overdue: 0, overdue_cents: '0', items: [] }; },
  };
  return { calls, controller, snapshot, posts: () => calls.filter(c => c.method !== 'GET') };
}
const mountForm = (srv, props = {}) => mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'order', documentId: ORDER }, today: '2026-10-20', onBack() {}, onSaved() {}, ...props },
  { location: `/historico-fiscal?modelo=55&nota=nova&pedido=${ORDER}` });
const created = (call, over = {}) => envelope(recordOf(call.body.invoice, over), { action: 'create', replayed: false });

test('"Gerar nota fiscal": Vendedor, Transportador of the cadastro and the parcels moved with the note date (Origin default)', async () => {
  const srv = server({ preferences: { autxml_carrier: true }, post: call => created(call) });
  const view = await mountForm(srv);
  try {
    await wait(view);
    await tab(view, 'Destinatário');
    assert.match(view.text(), /Vendedora sintética/, 'the Vendedor of the pedido');
    await tab(view, 'Transportador/Volumes');
    assert.equal(view.input('fiscal-carrier-name').props.value, 'Transportadora sintética', 'the carrier of the cadastro beats the Origin label');
    assert.equal(view.input('fiscal-carrier-document').props.value, '22333444000155'); assert.equal(view.input('fiscal-carrier-ie').props.value, '987654321');
    assert.equal(view.input('fiscal-carrier-state').props.value, 'SP'); assert.equal(view.input('fiscal-carrier-city').props.value, 'Campinas');
    assert.equal(view.input('fiscal-carrier-address').props.value, 'Av. das Cargas, 500, Distrito');
    await press(view, 'Salvar'); await wait(view);
    const body = srv.posts()[0].body.invoice;
    assert.equal(body.seller_id, SELLER); assert.equal(body.operation_destination, null, 'without the preference the destination follows the UFs');
    assert.deepEqual(body.transport.carrier, { contact_id: CARRIER, name: 'Transportadora sintética', document: '22333444000155', ie: '987654321', state: 'SP', city: 'Campinas', address: 'Av. das Cargas, 500, Distrito' });
    assert.deepEqual(body.authorized_xml, [{ contact_id: CARRIER, name: 'Transportadora sintética', document: '22333444000155' }], '"Incluir transportadora como pessoa autorizada"');
    // The pedido of 2026-10-10 is due 30 days later; the note of 2026-10-20 keeps the 30 days.
    assert.deepEqual(body.payment.installments.map(i => [i.days, i.date, i.amount]), [['30', '2026-11-19', '20.00']]);
    assert.equal(body.nature_additional_info, 'Vendedor: Vendedora sintética', 'NOME_VENDEDOR comes from the Vendedor');
  } finally { view.unmount(); }
});

test('"Considerar a data da venda nas parcelas" keeps the pedido due date; a source before 215 behaves like wave C', async () => {
  const srv = server({ source: sourceOf({ keep_order_dates: true }), post: call => created(call) });
  const view = await mountForm(srv);
  try {
    await wait(view); await press(view, 'Salvar'); await wait(view);
    assert.deepEqual(srv.posts()[0].body.invoice.payment.installments.map(i => [i.days, i.date]), [['20', '2026-11-09']]);
  } finally { view.unmount(); }
  const { seller: _s, carrier: _c, keep_order_dates: _k, ...v1 } = sourceOf();
  const old = server({ source: v1, post: call => created(call) }), oldView = await mountForm(old);
  try {
    await wait(oldView); await press(oldView, 'Salvar'); await wait(oldView);
    const body = old.posts()[0].body.invoice;
    assert.deepEqual(body.payment.installments.map(i => i.date), ['2026-11-09']); assert.equal(body.seller_id, null); assert.deepEqual(body.transport.carrier, { name: 'Transportadora Origin' });
  } finally { oldView.unmount(); }
});

test('picking the Destinatário reads the contact cadastro: Contribuinte, e-mail da NF-e, natureza padrão and vendedor; a late answer is ignored', async () => {
  let release; const slow = new Promise(resolve => { release = resolve; });
  const contactSource = contactId => contactId === OTHER ? slow.then(() => ({ contact: contactRow({ contact_id: OTHER, name: 'Outro cliente', taxpayer: '2' }), nature: null, seller: null, writable: true, data_mode: 'erp_native' }))
    : { contact: contactRow(), nature: { id: CONTACT_NATURE, description: 'Venda do contato', crt: '1' }, seller: { id: SELLER, name: 'Vendedora sintética' }, writable: true, data_mode: 'erp_native' };
  const srv = server({ contactSource, post: call => created(call) });
  const view = await mountForm(srv, { opening: { kind: 'new' } });
  try {
    await wait(view); await tab(view, 'Destinatário');
    await view.change('fiscal-recipient-search', 'Outro'); await wait(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).startsWith('Outro cliente')).props.onClick(); await view.flush();
    await view.change('fiscal-recipient-search', 'Cliente'); await wait(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).startsWith('Cliente sintético 42')).props.onClick(); await wait(view);
    release(); await wait(view);
    assert.equal(view.input('fiscal-recipient-name').props.value, 'Cliente sintético 42');
    assert.equal(view.input('fiscal-recipient-ie-indicator').props.value, '1', 'the late answer of the first contact never lands');
    assert.equal(view.input('fiscal-recipient-email').props.value, 'nfe@sintetico.test');
    assert.match(view.text(), /Vendedora sintética/);
    await tab(view, 'Cabeçalho'); assert.match(view.text(), /Venda do contato/, 'the natureza de operação padrão of the contact');
    assert.ok(srv.calls.some(c => c.path === `/v1/notas-fiscais/contato/${CONTACT}?direction=1`));
  } finally { view.unmount(); }
});

test('review: the natureza padrão of the contact brings its presença and série, and the transportadora read never cancels the destinatário read', async () => {
  const saved = NATURES[CONTACT_NATURE];
  NATURES[CONTACT_NATURE] = natureOf(CONTACT_NATURE, 'Venda do contato', { presence: '2', series: 7 });
  let release; const slow = new Promise(resolve => { release = resolve; });
  const contactSource = contactId => contactId === CONTACT
    ? slow.then(() => ({ contact: contactRow(), nature: { id: CONTACT_NATURE, description: 'Venda do contato', crt: '1' }, seller: null, writable: true, data_mode: 'erp_native' }))
    : { contact: { ...contactRow({ contact_id: CARRIER, name: 'Transportadora sintética', taxpayer: null, nfe_email: null }), ...carrierRow, code: null, trade_name: null, email: null, phone: null, mobile: null, taxpayer: null, country: null, nfe_email: null },
      nature: null, seller: null, writable: true, data_mode: 'erp_native' };
  const srv = server({ contactSource, post: call => created(call) });
  const view = await mountForm(srv, { opening: { kind: 'new' } });
  try {
    await wait(view); await tab(view, 'Destinatário');
    await view.change('fiscal-recipient-search', 'Cliente'); await wait(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).startsWith('Cliente sintético 42')).props.onClick(); await view.flush();
    await tab(view, 'Transportador/Volumes');
    await view.change('fiscal-transport-mode', 'manual');
    await view.change('fiscal-carrier-search', 'Transp'); await wait(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).startsWith('Transportadora sintética')).props.onClick(); await wait(view);
    release(); await wait(view);
    assert.equal(view.input('fiscal-carrier-ie').props.value, '987654321', 'the carrier cadastro landed');
    await tab(view, 'Destinatário');
    assert.equal(view.input('fiscal-recipient-ie-indicator').props.value, '1', 'the destinatário read was not cancelled by the carrier read');
    await tab(view, 'Cabeçalho');
    assert.match(view.text(), /Venda do contato/);
    assert.equal(view.input('fiscal-presence').props.value, '2', 'like picking the natureza by hand'); assert.equal(view.input('fiscal-series').props.value, '7');
  } finally { view.unmount(); NATURES[CONTACT_NATURE] = saved; }
});

test('Vendedor: search in the cadastro de vendedores, pick, change and save', async () => {
  const srv = server({ source: sourceOf({ seller: null }), sellerOptions: [{ id: SELLER, name: 'Vendedora sintética', code: 'V-1' }], post: call => created(call) });
  const view = await mountForm(srv);
  try {
    await wait(view); await tab(view, 'Destinatário');
    await view.change('fiscal-recipient-seller', 'Vend'); await wait(view);
    assert.ok(srv.calls.some(c => c.path === '/v1/cadastros/vendedores/opcoes?q=Vend'));
    view.nodes().find(n => n.type === 'button' && textOf(n) === 'Vendedora sintética · V-1').props.onClick(); await view.flush();
    assert.match(view.text(), /Vendedora sintética/);
    await press(view, 'Salvar'); await wait(view);
    assert.equal(srv.posts()[0].body.invoice.seller_id, SELLER);
  } finally { view.unmount(); }
});

test('Destino da Operação appears with its preference, is saved, and the open contas panel follows Vendas › "Permite a visualização…"', async () => {
  const srv = server({ context: { operation_destination_manual: true, open_titles: { receivable: true, payable: false } }, post: call => created(call) });
  const view = await mountForm(srv);
  try {
    await wait(view);
    assert.equal(view.input('fiscal-destination-op').props.value, '');
    await view.change('fiscal-destination-op', '1');
    await tab(view, 'Destinatário');
    const panel = components(view, 'FinanceContactOpenTitles')[0];
    assert.ok(panel, 'the panel of the contact is shown'); assert.equal(panel.props.contactId, CONTACT); assert.equal(panel.props.kind, 'receivable');
    await press(view, 'Salvar'); await wait(view);
    assert.equal(srv.posts()[0].body.invoice.operation_destination, '1');
  } finally { view.unmount(); }
  const off = server({ post: call => created(call) }), offView = await mountForm(off);
  try {
    await wait(offView);
    assert.equal(offView.nodes().some(n => n.props?.id === 'fiscal-destination-op'), false, 'hidden without the preference');
    await tab(offView, 'Destinatário'); assert.equal(components(offView, 'FinanceContactOpenTitles').length, 0);
  } finally { offView.unmount(); }
});

test('one note per pedido: a 409 on "Gerar nota fiscal" says the pedido already has a note and nothing is repeated', async () => {
  const srv = server({ post: () => { throw new AccessError(409); } });
  const view = await mountForm(srv);
  try {
    await wait(view); await press(view, 'Salvar'); await wait(view);
    assert.match(view.text(), /o pedido de origem já tem nota fiscal/);
    assert.equal(srv.posts().length, 1); assert.equal(view.nodes().some(n => n.type === 'button' && textOf(n).trim() === 'Conferir resultado'), false);
  } finally { view.unmount(); }
});

test('Filtrar › Vendedor: picked from the cadastro de vendedores, sent as seller_id, shown as a chip and kept by "Tornar padrão"', async () => {
  const calls = [];
  const emptyPage = query => { const p = new URLSearchParams(query); return { items: [], origin: p.get('origin') ?? 'origin', model: p.get('model'), direction: p.get('direction') ?? '1', page: Number(p.get('page')), limit: 100, order: 'date_desc',
    has_more: false, total_count: 0, total_amount: '0.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: (p.get('origin') ?? 'origin') === 'origin' ? 'origin_mirror_readonly' : 'erp_native_homologation' }; };
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: admin, role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices(path) { calls.push(path); if (path.startsWith('/v1/notas-fiscais?')) return emptyPage(path.split('?')[1]); throw new AccessError(404); },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog(path) { calls.push(path); return path.startsWith('/v1/cadastros/vendedores/opcoes?') ? { scope: 'seller_options', users: [], data_mode: 'erp_native', items: [{ id: SELLER, name: 'Vendedora sintética', code: null }] } : { items: [] }; } };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout', 'AppliedChips', 'ListPreferencesBar'] });
  try {
    await wait(view);
    await view.change('fiscal-seller-search', 'Vend'); await wait(view);
    assert.ok(calls.includes('/v1/cadastros/vendedores/opcoes?q=Vend'));
    await view.change('fiscal-seller', SELLER); await view.submit(); await wait(view);
    assert.ok(calls.some(p => p.startsWith('/v1/notas-fiscais?') && new URLSearchParams(p.split('?')[1]).get('seller_id') === SELLER), JSON.stringify(calls));
    assert.match(view.text(), /Vendedor: Vendedora sintética/);
    assert.match(view.text(), /vendedor do Origin ligado ao contato/, 'the Origin view says how the filter works there');
  } finally { view.unmount(); }
  const entry = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'entrada' }, { location: '/notas-entrada', expandChildren: ['NativeListLayout'] });
  try { await wait(entry); assert.equal(entry.nodes().some(n => n.props?.id === 'fiscal-seller-search'), false, 'only the NF-e de saída list has the Vendedor filter'); } finally { entry.unmount(); }
});

test('Natureza › regra "Quando for: Grupo de Produtos": groups of the product cadastro, chips and the rule saved with group_ids', async () => {
  const GROUP = id(950), calls = [];
  const natureRow = (over = {}) => ({ id: id(1), description: 'Venda por grupo', series: null, direction: '1', crt: '1', presence: '1', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
    include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', defaults: [], rules: [], ...over });
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: admin, role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') return { nature: natureRow({ id: id(2), rules: call.body.nature.rules.map((r, i) => ({ ...r, position: i + 1, products: [], ...(r.product_scope === 'groups' ? { groups: [{ id: GROUP, name: 'Ferramentas' }] } : {}) })) }), action: 'create', replayed: false, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 0, updated_at: null, writable: true, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async catalog(path) { calls.push({ path, method: 'GET' }); if (path === '/v1/cadastros/taxonomias/grupos-produtos') return { kind: 'product_groups', data_mode: 'erp_native', items: [{ id: GROUP, kind: 'product_groups', parent_id: null, name: 'Ferramentas', version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', children: 0, products: 3 }] }; return { items: [] }; } };
  const form = await mountComponent('RealOperationNatures.tsx', { controller }, { location: '/naturezas-operacao?natureza=nova', expandChildren: ['OperationNatureForm', 'NatureRuleDialog'] });
  try {
    await form.change('nature-description', 'Venda por grupo');
    form.nodes().find(n => n.type === 'button' && (n.props.role === 'tab' || String(n.props['aria-controls'] ?? '').startsWith('fiscal-section-')) && textOf(n) === 'IPI').props.onClick(); await form.flush();
    await press(form, 'Adicionar regra');
    await form.change('rule-scope', 'groups'); await wait(form);
    assert.ok(calls.some(c => c.path === '/v1/cadastros/taxonomias/grupos-produtos'), 'the groups come from the product cadastro');
    await form.change('rule-group', GROUP); await form.change('rule-situation', '50'); await form.change('rule-rate', '10');
    assert.match(form.text(), /Ferramentas/);
    const modal = components(form, 'Modal').at(-1); let saveRule; const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
    walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node).trim() === 'Salvar') saveRule = node; }); saveRule.props.onClick(); await form.flush();
    assert.match(form.text(), /Grupo: Ferramentas/, 'the rule list says which groups');
    await press(form, 'Salvar'); await wait(form);
    const saved = calls.filter(c => c.method === 'POST').at(-1);
    assert.deepEqual(saved.body.nature.rules, [{ tax: 'ipi', destinations: [], product_scope: 'groups', ncms: [], product_ids: [], group_ids: [GROUP], data: { situation: '50', rate: '10.0000' }, additional_info: null, fiscal_info: null }]);
  } finally { form.unmount(); }
});

test('Cálculo automático: a "Grupo de Produtos" rule applies to the item of that group (groups read only when a rule asks)', async () => {
  const GROUP = id(950), groupNature = natureOf(NATURE, 'Venda sintética', { defaults: ['S'], rules: [rule('icms', { situation: '101', cfop: '5102' }), { ...rule('ipi', { situation: '50', rate: '10.0000' }), product_scope: 'groups', group_ids: [GROUP], groups: [{ id: GROUP, name: 'Ferramentas' }] }] });
  const saved = NATURES[NATURE]; NATURES[NATURE] = groupNature;
  try {
    const srv = server({ source: sourceOf({ seller: null, carrier: null, transport: null, installments: [] }), post: call => created(call) });
    const original = srv.controller.fiscalInvoices;
    srv.controller.fiscalInvoices = async (path, options) => path.startsWith('/v1/notas-fiscais/grupos-produtos?') ? (srv.calls.push({ path, method: 'GET' }), { items: [{ id: PRODUCT, group_id: GROUP }], data_mode: 'erp_native' }) : original(path, options);
    const view = await mountForm(srv);
    try {
      await wait(view); await wait(view);
      assert.ok(srv.calls.some(c => c.path === `/v1/notas-fiscais/grupos-produtos?ids=${PRODUCT}`));
      await press(view, 'Salvar'); await wait(view);
      const item = srv.posts()[0].body.invoice.items[0];
      assert.equal(item.ipi.value, '2.00', 'IPI 10% of the item of the group'); assert.equal(item.ipi.situation, '50');
    } finally { view.unmount(); }
  } finally { NATURES[NATURE] = saved; }
});

test('Importar XML NF-e de entrada: the dialog says how many products the note created and updated in the cadastro', async () => {
  const entry = { model: '55', direction: '0', issue_type: 'T', series: '1', number: '321', nature_description: 'Compra sintética', issue_date: '2026-10-18', crt: '3', purpose: '1', presence: '9', final_consumer: false,
    recipient: { name: 'Fornecedor sintético S.A.', person_type: 'J', document: '12345678000195' }, items: [{ description: 'Porca sintética', quantity: '2', unit_price: '1.25', product_id: PRODUCT }, { description: 'Arruela', quantity: '1', unit_price: '1' }] };
  const record = recordOf(entry, { issue_type: 'X', status: 8, environment: null, number: 321, protocol: '135260000000777', authorized_at: '2026-10-18T12:00:00Z' });
  let answer = { ...envelope(record, { writable: false, action: 'import', replayed: false }), imported: true, matched_items: 1, contact_matched: true, created_products: 1, updated_products: 2, product_failures: 1 };
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: admin, role: 'admin' } }), subscribe: () => () => {}, async fiscalInvoices() { return structuredClone(answer); } };
  const view = await mountComponent('FiscalImportDialog.tsx', { controller, initial: { name: 'nota.xml', xml: '<nfeProc/>' }, onClose() {}, onOpen() {} }, {});
  try {
    await modalPress(view, 'Importar'); await wait(view);
    assert.match(view.text(), /Sua nota foi importada com sucesso/);
    assert.match(view.text(), /1 produto\(s\) cadastrado\(s\) a partir da nota e 2 atualizado\(s\) com os dados do XML/);
    assert.match(view.text(), /1 produto\(s\) não puderam ser gravados no cadastro/);
  } finally { view.unmount(); }
  answer = { ...answer }; delete answer.created_products; delete answer.updated_products; delete answer.product_failures;
  const old = await mountComponent('FiscalImportDialog.tsx', { controller, initial: { name: 'nota.xml', xml: '<nfeProc/>' }, onClose() {}, onOpen() {} }, {});
  try { await modalPress(old, 'Importar'); await wait(old); assert.match(old.text(), /importada com sucesso/); assert.doesNotMatch(old.text(), /Cadastro de produtos:/, 'an API before 217 says nothing about the cadastro'); } finally { old.unmount(); }
});

const mountIcons = (srv, props = {}) => mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'order', documentId: ORDER }, today: '2026-10-20', onBack() {}, onSaved() {}, ...props },
  { location: `/historico-fiscal?modelo=55&nota=nova&pedido=${ORDER}`, expandChildren: ['FiscalInvoiceItemProduct', 'FiscalInvoiceItemHistory'] });
const iconOf = (view, label) => view.nodes().find(n => (n.type === 'button' || n.type === 'a') && n.props['aria-label'] === label);

test('item icons: "Criar produto a partir da nota" saves the product through the cadastro and links the item; lote stays disabled with the reason', async () => {
  const free = sourceOf({ items: [{ ...sourceOf().items[0], product_id: null, product: null, code: 'NOVO-1', description: 'Peça nova sintética' }] });
  const created = id(810);
  const srv = server({ source: free, post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const catalog = srv.controller.catalog;
  srv.controller.catalog = async (path, options = {}) => {
    if (path === '/v1/cadastros/products/completo') { srv.calls.push({ path, method: options.method, body: structuredClone(options.body) }); return { entity: 'products', record: { id: created, version: 1, name: options.body.data.name, code: options.body.data.code }, replayed: false, data_mode: 'erp_native' }; }
    return catalog(path, options);
  };
  const view = await mountIcons(srv);
  try {
    await wait(view); await tab(view, 'Itens da nota fiscal');
    assert.equal(iconOf(view, 'Informações de lote do item 1').props.disabled, true); assert.match(iconOf(view, 'Informações de lote do item 1').props.title, /Escolha um produto do cadastro no item/, '278: the lots of the note stock need a product and a saved note');
    assert.equal(iconOf(view, 'Depósitos do produto do item 1').props.disabled, true, 'no product, no depósitos');
    iconOf(view, 'Criar produto a partir do item 1').props.onClick(); await view.flush();
    assert.equal(view.input('item-product-name').props.value, 'Peça nova sintética'); assert.equal(view.input('item-product-code').props.value, 'NOVO-1');
    await modalPress(view, 'Salvar produto'); await wait(view);
    const post = srv.calls.find(c => c.path === '/v1/cadastros/products/completo');
    assert.equal(post.method, 'POST'); assert.ok(post.body.command_id); assert.deepEqual(post.body.data, { kind: 'P', format: 'S', name: 'Peça nova sintética', code: 'NOVO-1', unit: 'UN' });
    assert.match(view.text(), /cadastrado e ligado ao item 1/);
    await press(view, 'Salvar'); await wait(view);
    assert.equal(srv.posts().at(-1).body.invoice.items[0].product_id, created, 'the note saves the item linked to the new product');
  } finally { view.unmount(); }
});

test('item icons: "Atualizar produto a partir da nota" patches only the chosen fields with the product version; depósitos and histórico open for the product', async () => {
  const srv = server({ source: sourceOf({ items: [{ ...sourceOf().items[0], product: { kind: 'P', ncm: '84714900', gtin: null, gtin_tax: null, cest: '0100100', origin: '0', gross_weight: null, net_weight: null, volumes: null } }] }),
    post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const catalog = srv.controller.catalog, invoices = srv.controller.fiscalInvoices;
  srv.controller.catalog = async (path, options = {}) => {
    if (path === `/v1/cadastros/products/${PRODUCT}/completo`) { srv.calls.push({ path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined });
      return { entity: 'products', record: { id: PRODUCT, version: 7 + (options.method === 'PATCH' ? 1 : 0), name: 'Peça sintética', ncm: options.method === 'PATCH' ? '84714900' : '84713012', gtin: null, cest: '0100100' }, data_mode: 'erp_native' }; }
    return catalog(path, options);
  };
  srv.controller.fiscalInvoices = async (path, options) => path.startsWith('/v1/notas-fiscais/historico-item?') ? (srv.calls.push({ path, method: 'GET' }),
    { items: [{ origin: 'origin', id: '9801', number: 801, series: 1, issue_date: '2026-10-05', issue_type: null, quantity: '3', unit_price: '10', total: '30.00' }], contact_id: CONTACT, product_id: PRODUCT, direction: '1', data_mode: 'erp_native' }) : invoices(path, options);
  const view = await mountIcons(srv);
  try {
    await wait(view); await tab(view, 'Itens da nota fiscal');
    assert.equal(iconOf(view, 'Depósitos do produto do item 1').props.href, `/estoque-empresa?produto=${PRODUCT}`);
    iconOf(view, 'Atualizar produto a partir do item 1').props.onClick(); await wait(view);
    assert.match(view.text(), /84713012/); assert.equal(view.nodes().find(n => n.props?.['aria-label'] === 'Atualizar NCM').props.checked, true, 'the NCM that changed is chosen');
    assert.equal(view.nodes().find(n => n.props?.['aria-label'] === 'Atualizar CEST').props.disabled, true, 'an equal value cannot be chosen');
    await modalPress(view, 'Atualizar produto'); await wait(view);
    const patch = srv.calls.find(c => c.method === 'PATCH');
    assert.equal(patch.path, `/v1/cadastros/products/${PRODUCT}/completo`); assert.equal(patch.body.expected_version, 7); assert.deepEqual(patch.body.data, { ncm: '84714900' });
    assert.match(view.text(), /Produto atualizado com os dados da nota/);
    await modalPress(view, 'Fechar');
    iconOf(view, 'Histórico do produto do item 1').props.onClick(); await wait(view);
    assert.ok(srv.calls.some(c => c.path === `/v1/notas-fiscais/historico-item?contact_id=${CONTACT}&product_id=${PRODUCT}&direction=1`));
    assert.equal(components(view, 'Modal').at(-1).props.title, 'Histórico do produto para o cliente'); assert.match(view.text(), /000801/); assert.match(view.text(), /Nota do Origin/);
  } finally { view.unmount(); }
});

test('item icons: the fiscal profile does not write the product cadastro, so creating or updating a product stays disabled with the reason', async () => {
  const srv = server({ post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  srv.snapshot.membership.role = 'fiscal';
  const view = await mountIcons(srv);
  try {
    await wait(view); await tab(view, 'Itens da nota fiscal');
    const icon = iconOf(view, 'Atualizar produto a partir do item 1');
    assert.equal(icon.props.disabled, true); assert.match(icon.props.title, /não cadastra produtos/);
  } finally { view.unmount(); }
});

test('"Gerar NF-e dos pedidos selecionados": one homologation note per pedido like Gerar nota fiscal, Número | Motivo, and the same command after an unknown outcome', async () => {
  const ORDER2 = id(601), ORDER3 = id(602), ORDER4 = id(603);
  const refused = sourceOf({ document: { ...sourceOf().document, id: ORDER2, number: '43' }, eligible: false, reasons: [{ code: 'stock_negative', items: [1] }] });
  let attempt = 0;
  const srv = server({ post: call => { if (call.body.orders[0] === ORDER4 && attempt++ === 0) throw new AccessError(503); return envelope(recordOf(call.body.invoice, { orders: call.body.orders.map(o => ({ id: o, kind: 'sales_orders', number: '42', date: '2026-10-10', contact_name: 'Cliente' })) }), { action: 'create', replayed: false }); } });
  const original = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options) => {
    if (path.startsWith(`/v1/notas-fiscais/pedido/${ORDER2}?`)) { srv.calls.push({ path, method: 'GET' }); return structuredClone(refused); }
    if (path.startsWith(`/v1/notas-fiscais/pedido/${ORDER4}?`)) { srv.calls.push({ path, method: 'GET' }); return sourceOf({ document: { ...sourceOf().document, id: ORDER4, number: '45' } }); }
    return original(path, options);
  };
  const rows = [{ id: ORDER, number: '42', status: 'open', contact_name: 'Cliente sintético 42' }, { id: ORDER2, number: '43', status: 'open' }, { id: ORDER3, number: '44', status: 'cancelled' },
    { id: id(604), number: '46', status: 'open', invoice_linked: true }, { id: ORDER4, number: '45', status: 'open' }];
  const closed = [], commands = new Map();
  const view = await mountComponent('FiscalOrderBatch.tsx', { controller: srv.controller, model: '55', rows, today: '2026-10-20', commands, onClose: changed => closed.push(changed) }, { expandChildren: ['BatchDialog'] });
  try {
    assert.match(view.text(), /Deseja realmente gerar nota\(s\) de 3 venda\(s\) selecionada\(s\)\?/);
    assert.match(view.text(), /O pedido está cancelado\./); assert.match(view.text(), /O pedido já tem nota fiscal\./);
    await modalPress(view, 'Gerar'); await wait(view); await wait(view);
    const posts = srv.posts();
    assert.equal(posts.length, 2, 'the refused pedido never reaches the save');
    assert.deepEqual(posts.map(p => p.body.orders), [[ORDER], [ORDER4]]);
    assert.equal(posts[0].body.invoice.items[0].cfop, '5102', 'the taxes come from Cálculo automático like the ⋮ action');
    assert.match(view.text(), /Motivo: O estoque ficaria negativo/); assert.match(view.text(), /Nota salva em homologação/); assert.match(view.text(), /Resultado não confirmado/);
    const uncertainCommand = posts[1].body.command_id;
    await modalPress(view, 'Fechar'); assert.deepEqual(closed, [true]);
    const again = await mountComponent('FiscalOrderBatch.tsx', { controller: srv.controller, model: '55', rows: [rows[4]], today: '2026-10-20', commands, onClose() {} }, { expandChildren: ['BatchDialog'] });
    try { await modalPress(again, 'Gerar'); await wait(again); await wait(again); assert.equal(srv.posts().at(-1).body.command_id, uncertainCommand, 'the same command repeats the unconfirmed save'); assert.match(again.text(), /Nota salva em homologação/); }
    finally { again.unmount(); }
  } finally { view.unmount(); }
});

test('review: "Tentar novamente" reopens the batch with the pedidos that failed or were not confirmed and repeats the same command', async () => {
  const ORDER4 = id(603);
  let attempt = 0;
  const srv = server({ post: call => { if (call.body.orders[0] === ORDER4 && attempt++ === 0) throw new AccessError(503); return envelope(recordOf(call.body.invoice, { orders: call.body.orders.map(o => ({ id: o, kind: 'sales_orders', number: '42', date: '2026-10-10', contact_name: 'Cliente' })) }), { action: 'create', replayed: false }); } });
  const original = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options) => {
    if (path.startsWith(`/v1/notas-fiscais/pedido/${ORDER4}?`)) { srv.calls.push({ path, method: 'GET' }); return sourceOf({ document: { ...sourceOf().document, id: ORDER4, number: '45' } }); }
    return original(path, options);
  };
  const rows = [{ id: ORDER, number: '42', status: 'open' }, { id: ORDER4, number: '45', status: 'open' }];
  const closed = [];
  const view = await mountComponent('FiscalOrderBatch.tsx', { controller: srv.controller, model: '55', rows, today: '2026-10-20', commands: new Map(), onClose: changed => closed.push(changed) }, { expandChildren: ['BatchDialog'] });
  try {
    await modalPress(view, 'Gerar'); await wait(view); await wait(view);
    const first = srv.posts(); assert.equal(first.length, 2); assert.match(view.text(), /Tentar novamente/);
    await modalPress(view, 'Tentar novamente'); await wait(view);
    assert.match(view.text(), /Deseja realmente gerar nota\(s\) de 1 venda\(s\) selecionada\(s\)\?/, 'only the unconfirmed pedido returns');
    await modalPress(view, 'Gerar'); await wait(view); await wait(view);
    const retried = srv.posts().at(-1);
    assert.equal(srv.posts().length, 3); assert.deepEqual(retried.body.orders, [ORDER4]); assert.equal(retried.body.command_id, first[1].body.command_id, 'the same command, never a second note');
    assert.equal(view.nodes().some(n => n.type === 'button' && textOf(n).trim() === 'Tentar novamente'), false, 'nothing left to retry');
    await modalPress(view, 'Fechar'); assert.deepEqual(closed, [true]);
  } finally { view.unmount(); }
});

test('Pedidos de venda › "Gerar NF-e dos pedidos selecionados" and "Mais ações › Gerar: NFC-es selecionadas" open the batch for admin and fiscal only', async () => {
  const contactId = id(530);
  const row = n => ({ id: id(700 + n), kind: 'sales_orders', number: String(n + 6), version: 3, status: 'open', date: '2026-10-16', total: '10.00', contact_id: contactId, contact_name: `Cliente sintético ${n}`, created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z',
    expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null });
  const mountList = async role => {
    const snapshot = { phase: 'ready', membership: { user_id: admin, role } };
    const controller = { getSnapshot: () => snapshot, subscribe: () => () => {},
      async documents(path) { if (path === '/v1/documentos') return { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native' };
        if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'sales_orders', items: [row(1)], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 1, total_amount: '10.00', data_mode: 'erp_native', operational_effects: false }; }
        throw new AccessError(404); },
      async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; }, async documentCopy() { throw new AccessError(404); },
      async fiscalInvoices() { throw new AccessError(404); }, async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; } };
    return mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders', expandChildren: ['NativeListLayout', 'DocumentList'] });
  };
  for (const role of ['fiscal', 'admin']) {
    const view = await mountList(role);
    try {
      await wait(view);
      const nfe = view.nodes().find(n => n.type === 'button' && /Gerar NF-e dos pedidos selecionados/.test(textOf(n)));
      assert.equal(nfe.props.disabled, true, 'nothing selected yet');
      view.nodes().find(n => n.type === 'input' && String(n.props['aria-label']).startsWith('Selecionar Pedido 7')).props.onClick({ shiftKey: false }); await view.flush();
      view.nodes().find(n => n.type === 'button' && /Gerar NF-e dos pedidos selecionados/.test(textOf(n))).props.onClick(); await view.flush();
      const batch = components(view, 'FiscalOrderBatch')[0];
      assert.ok(batch, role); assert.equal(batch.props.model, '55'); assert.deepEqual(batch.props.rows.map(r => r.id), [id(701)]);
      batch.props.onClose(false); await view.flush();
      view.nodes().find(n => n.type === 'button' && textOf(n).includes('NFC-es selecionadas')).props.onClick(); await view.flush();
      assert.equal(components(view, 'FiscalOrderBatch')[0].props.model, '65');
    } finally { view.unmount(); }
  }
  const sales = await mountList('financeiro');
  try {
    await wait(sales);
    const nfe = sales.nodes().find(n => n.type === 'button' && /Gerar NF-e dos pedidos selecionados/.test(textOf(n)));
    assert.equal(nfe.props.disabled, true); assert.match(nfe.props.title, /administrador e pelo fiscal/);
  } finally { sales.unmount(); }
});

test('"Gerar nota fiscal agrupando": the parts of several OS of the same cliente in one note linked to every OS; another cliente is refused', async () => {
  const OS1 = id(620), OS2 = id(621);
  const osSource = (osId, number, over = {}) => sourceOf({ document: { ...sourceOf().document, id: osId, kind: 'service_orders', number }, transport: null, carrier: null, seller: null, installments: [{ position: 1, due_date: '2026-11-09', amount: '20.00', method: null, note: null }],
    items: [{ ...sourceOf().items[0], description: `Peça da OS ${number}` }], totals: { gross: '20.00', line_discount: '0.00', discount: '1.00', freight: '2.00', other_expenses: '0.00', total: '21.00' }, ...over });
  const sources = { [OS1]: osSource(OS1, '50'), [OS2]: osSource(OS2, '51') };
  const srv = server({ post: call => envelope(recordOf(call.body.invoice, { orders: call.body.orders.map(o => ({ id: o, kind: 'service_orders', number: '50', date: '2026-10-10', contact_name: 'Cliente' })) }), { action: 'create', replayed: false }) });
  const original = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options) => { const found = Object.keys(sources).find(k => path.startsWith(`/v1/notas-fiscais/pedido/${k}?`)); if (found) { srv.calls.push({ path, method: 'GET' }); return structuredClone(sources[found]); } return original(path, options); };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: `/historico-fiscal?modelo=55&origem=brufap&nota=nova&pedido=${OS1},${OS2}`, expandChildren: ['FiscalInvoiceForm'] });
  try {
    await wait(view);
    assert.match(view.text(), /Nota agrupada de 2 ordens de serviço \(nº 50, 51\)/);
    await press(view, 'Salvar'); await wait(view);
    const body = srv.posts()[0].body;
    assert.deepEqual(body.orders, [OS1, OS2]);
    assert.deepEqual(body.invoice.items.map(i => i.description), ['Peça da OS 50', 'Peça da OS 51']);
    assert.equal(body.invoice.discount, '2.00'); assert.equal(body.invoice.freight, '4.00'); assert.deepEqual(body.invoice.payment.installments, [], 'the parcels of each OS are not copied');
    assert.match(body.invoice.additional_info, /^Ordens de serviço: 50, 51/);
  } finally { view.unmount(); }
  sources[OS2] = osSource(OS2, '51', { contact: contactRow({ contact_id: OTHER, name: 'Outro cliente' }) });
  const other = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: `/historico-fiscal?modelo=55&origem=brufap&nota=nova&pedido=${OS1},${OS2}`, expandChildren: ['FiscalInvoiceForm'] });
  try { await wait(other); assert.match(other.text(), /precisam ser do mesmo cliente/); } finally { other.unmount(); }
});

test('Ordens de serviço › Mais ações › "Gerar nota fiscal agrupando": admin, two or more OS of the same cliente, opens the grouped note in a new tab', async () => {
  const contactId = id(531), otherContact = id(532);
  const row = (n, over = {}) => ({ id: id(720 + n), kind: 'service_orders', number: String(n + 50), version: 3, status: 'open', date: '2026-10-16', total: '10.00', contact_id: contactId, contact_name: 'Cliente OS', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z',
    expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, ...over });
  const rows = [row(1), row(2), row(3, { contact_id: otherContact })];
  const opened = [], previous = globalThis.window; globalThis.window = { open: (...args) => opened.push(args) };
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: admin, role: 'admin' } }), subscribe: () => () => {},
    async documents(path) { if (path === '/v1/documentos') return { read: ['service_orders'], write: ['service_orders'], data_mode: 'erp_native' };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'service_orders', items: rows, limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 3, total_amount: '30.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404); },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; }, async documentCopy() { throw new AccessError(404); },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; } };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'service_orders' }, { location: '/documentos-empresa?tipo=service_orders', expandChildren: ['NativeListLayout', 'DocumentList'] });
  const grouped = () => view.nodes().find(n => n.type === 'button' && textOf(n).includes('Gerar nota fiscal agrupando'));
  const pick = async number => { view.nodes().find(n => n.type === 'input' && String(n.props['aria-label']).includes(` ${number}`) && String(n.props['aria-label']).startsWith('Selecionar')).props.onClick({ shiftKey: false }); await view.flush(); };
  try {
    await wait(view);
    assert.equal(grouped().props.disabled, true); assert.match(grouped().props.title, /duas ou mais/);
    await pick(51); await pick(53);
    assert.equal(grouped().props.disabled, true); assert.match(grouped().props.title, /mesmo cliente/);
    await pick(53); await pick(52);
    assert.equal(grouped().props.disabled, false);
    grouped().props.onClick(); await view.flush();
    assert.equal(opened.length, 1);
    const url = new URL(opened[0][0], 'https://erp.test'); assert.equal(url.pathname, '/historico-fiscal');
    assert.deepEqual(url.searchParams.get('pedido').split(',').sort(), [id(721), id(722)].sort()); assert.equal(url.searchParams.get('nota'), 'nova');
  } finally { view.unmount(); if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('Parcelas › Forma: the formas of the cadastro set the tPag and the card of the parcel; the referenced key says which note it is', async () => {
  const CARD = id(960), PIX = id(961);
  const srv = server({ post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const original = srv.controller.fiscalInvoices, key = '35261011222333000181550010000009011123456780';
  srv.controller.fiscalInvoices = async (path, options) => {
    if (path === '/v1/notas-fiscais/formas-pagamento?direction=1') { srv.calls.push({ path, method: 'GET' }); return { direction: '1', data_mode: 'erp_native', items: [{ id: CARD, description: 'Cartão Visa loja', payment_type: '03', card_brand: '01', card_integration: '2', card_cnpj: '11222333000181' }, { id: PIX, description: 'Pix crédito em loja', payment_type: '21', card_brand: null, card_integration: null, card_cnpj: null }] }; }
    if (path === `/v1/notas-fiscais/chave/${key}`) { srv.calls.push({ path, method: 'GET' }); return { key, data_mode: 'erp_native', items: [{ origin: 'origin', id: '9901', model: '55', direction: '1', number: 901, series: 1, issue_date: '2026-10-01', name: 'Cliente da chave', total: '55.50' }] }; }
    return original(path, options);
  };
  const view = await mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'order', documentId: ORDER }, today: '2026-10-20', onBack() {}, onSaved() {} },
    { location: `/historico-fiscal?modelo=55&nota=nova&pedido=${ORDER}`, expandChildren: ['FiscalInstallmentDialog'] });
  try {
    await wait(view); await tab(view, 'Pagamento');
    const forma = () => view.nodes().find(n => n.type === 'select' && n.props['aria-label'] === 'Forma da parcela 1');
    assert.ok(forma().props.children[1].some(o => o.props.value === `pm:${CARD}` && textOf(o) === 'Cartão Visa loja'), 'the cadastro forms come first');
    forma().props.onChange({ target: { value: `pm:${CARD}` } }); await view.flush();
    assert.equal(forma().props.value, `pm:${CARD}`);
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Detalhes da parcela 1').props.onClick(); await view.flush();
    assert.equal(view.input('fiscal-installment-method').props.value, `pm:${CARD}`); assert.equal(view.input('fiscal-installment-brand').props.value, '01'); assert.equal(view.input('fiscal-installment-cnpj').props.value, '11222333000181');
    await view.change('fiscal-installment-method', `pm:${PIX}`); await modalPress(view, 'Salvar');
    await tab(view, 'Documento referenciado'); await view.change('fiscal-ref-key', key); await press(view, 'Incluir mais'); await wait(view);
    assert.match(view.text(), /NF-e nº 000901 de 01\/10\/2026 · Cliente da chave · R\$ 55,50 \(nota do Origin\)/);
    await press(view, 'Salvar'); await wait(view);
    const parcel = srv.posts()[0].body.invoice.payment.installments[0];
    assert.equal(parcel.payment_method_id, PIX); assert.equal(parcel.method, '99', 'a tPag the NF-e table does not have becomes 99 - Outros');
    assert.deepEqual(srv.posts()[0].body.invoice.references, [{ type: 'nfe', key }], 'the lookup is conference only');
  } finally { view.unmount(); }
});

test('⋮ Gerar devolução: the "Devolução de produto" modal shows what was already returned, takes the quantities and opens the return note with them', async () => {
  const key = '35261011222333000181550010000009011123456780';
  const native = recordOf({ model: '55', direction: '1', issue_type: 'T', series: '1', number: '901', access_key: key, nature_id: NATURE, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { name: 'Cliente sintético 42', person_type: 'J', document: '12345678000190', state: 'SP' }, items: [{ product_id: PRODUCT, description: 'Peça sintética', quantity: '5', unit_price: '10' }, { description: 'Item livre', code: 'LIVRE', quantity: '2', unit_price: '3' }],
    freight: '7.00' }, { id: id(1), status: 8, environment: null, number: 901, access_key: key });
  const row = { origin: 'brufap', id: id(1), version: 1, number: 901, series: 1, issue_date: '2026-10-20', entry_date: null, name: 'Cliente sintético 42', document: '12345678000190', state: 'SP', nature: 'Venda sintética', status: 8, status_raw: null,
    total: native.totals.total, total_known: true, environment: null, issue_type: 'T', access_key: key, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0, orders: [] };
  const srv = server({ context: { defaults: { S: { id: NATURE, description: 'Venda sintética' }, DE: { id: CONTACT_NATURE, description: 'Devolução sintética' } } }, post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const original = srv.controller.fiscalInvoices;
  srv.controller.fiscalInvoices = async (path, options) => {
    if (path.startsWith('/v1/notas-fiscais?')) { const q = new URLSearchParams(path.split('?')[1]); return { items: q.get('origin') === 'brufap' ? [row] : [], origin: q.get('origin') ?? 'origin', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: q.get('origin') === 'brufap' ? 1 : 0,
      total_amount: q.get('origin') === 'brufap' ? row.total : '0.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: q.get('origin') === 'brufap' ? 'erp_native_homologation' : 'origin_mirror_readonly' }; }
    if (path === `/v1/notas-fiscais/${id(1)}`) return envelope(native, { writable: true, locks: { items: false, installments: false } });
    if (path === `/v1/notas-fiscais/devolucoes/${key}`) { srv.calls.push({ path, method: 'GET' }); return { key, returns: [{ id: id(2), model: '55', direction: '0', number: null, series: 1, issue_date: '2026-10-21', status: 1 }], items: [{ product_id: PRODUCT, code: null, description: 'Peça sintética', quantity: '2.0000' }], data_mode: 'erp_native' }; }
    return original(path, options);
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout', 'FiscalReturnDialog', 'FiscalInvoiceForm'] });
  try {
    await wait(view);
    components(view, 'RowMenu')[0].props.items.find(i => i.label === 'Gerar devolução').onClick(); await wait(view);
    assert.equal(components(view, 'Modal').at(-1).props.title, 'Devolução de produto');
    assert.match(view.text(), /A nota fiscal já possui devolução efetuada/);
    const cell = n => view.nodes().find(x => x.type === 'input' && x.props['aria-label'] === `Devolver do item ${n}`);
    assert.equal(cell(1).props.value, '3', 'total: what is left of the 5'); assert.equal(cell(1).props.disabled, true);
    view.input('fiscal-return-partial').props.onChange(); await view.flush();
    cell(1).props.onChange({ target: { value: '4' } }); await view.flush();
    await modalPress(view, 'Gerar nota de devolução'); assert.match(view.text(), /O item 1 tem 3 para devolver/);
    cell(1).props.onChange({ target: { value: '1,5' } }); cell(2).props.onChange({ target: { value: '0' } }); await view.flush();
    await modalPress(view, 'Gerar nota de devolução'); await wait(view);
    await press(view, 'Salvar'); await wait(view);
    const body = srv.posts().at(-1).body.invoice;
    assert.equal(body.purpose, '4'); assert.equal(body.direction, '0'); assert.deepEqual(body.references, [{ type: 'nfe', key }]);
    assert.deepEqual(body.items.map(i => [i.description, i.quantity]), [['Peça sintética', '1.5000']], 'the item with zero is left out');
    assert.equal(body.freight, '1.87', 'the freight follows the returned value (15.00 of 56.00 of 7.00 = 1.875, truncated to the cent)');
  } finally { view.unmount(); }
});
