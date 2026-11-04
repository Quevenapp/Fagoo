import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeInvoiceInput, invoiceTotals, DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// Third wave of the Origin invoice screens (migration 202610200176): "Gerar nota fiscal" from a pedido, the parcel popup
// "Informação", the finance lock that never makes a note unsavable, "Conciliar produtos" on the Itens tab and the IPI / ICMS ST
// estimate of pedidos. Synthetic controller only (no DOM, no network, synthetic data).
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const admin = '20000000-0000-4000-8000-000000000001', NATURE = id(900), PRODUCT = id(800), ORDER = id(600), CONTACT = id(500);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const components = (view, name) => view.nodes().filter(n => typeof n.type === 'function' && n.type.name === name);
const button = (view, label) => { const found = view.nodes().find(n => n.type === 'button' && textOf(n).trim() === label); if (!found) throw new Error(`Missing button ${label}`); return found; };
const press = async (view, label) => { const node = button(view, label); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
const tab = async (view, label) => { const found = view.nodes().find(n => n.type === 'button' && (n.props.role === 'tab' || String(n.props['aria-controls'] ?? '').startsWith('fiscal-section-')) && textOf(n).trim() === label); if (!found) throw new Error(`Missing tab ${label}`); found.props.onClick(); await view.flush(); };
const selectedTab = view => textOf(view.nodes().find(n => n.type === 'button' && (n.props.role === 'tab' || String(n.props['aria-controls'] ?? '').startsWith('fiscal-section-')) && n.props['aria-current'] === 'location')).trim();
const byLabel = (view, label) => view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === label);
const walk = (value, visit) => { if (Array.isArray(value)) { value.forEach(v => walk(v, visit)); return; } if (!value || typeof value !== 'object') return; visit(value); walk(value.props?.children, visit); };
async function modalAction(view, label) {
  const modal = components(view, 'Modal').at(-1); let found;
  walk(modal.props.actions, node => { if (node.type === 'button' && textOf(node).trim() === label) found = node; });
  if (!found) throw new Error(`Missing dialog action ${label}`); if (found.props.disabled) throw new Error(`Disabled dialog action ${label}`);
  found.props.onClick?.({ preventDefault() {} }); await view.flush();
}
const wait = async view => { await view.flush(); await new Promise(r => setTimeout(r, 50)); await view.flush(); };
const rule = (tax, data) => ({ tax, position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], products: [], data, additional_info: null, fiscal_info: null });
const nature = () => ({ id: NATURE, description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '2', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
  include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: 'Pedido [NUMERO_PEDIDO]', fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
  defaults: ['S'], rules: [rule('icms', { situation: '101', cfop: '5102', credit_rate: '1.2500' })] });
const summary = n => ({ id: n.id, description: n.description, series: n.series, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced, final_consumer: n.final_consumer, return_operation: n.return_operation, active: n.active, version: n.version, defaults: n.defaults, rule_count: n.rules.length, updated_at: n.updated_at });
const sourceOf = (over = {}) => ({ document: { id: ORDER, kind: 'sales_orders', number: '42', version: 3, status: 'open', date: '2026-10-20', ship_date: '2026-10-22', customer_po_number: 'PC-7788', notes: 'Entregar pela manhã',
  warehouse_id: null, stock_active: false, finance_active: false }, direction: '1', model: '55', eligible: true, reasons: [],
  contact: { contact_id: CONTACT, name: 'Cliente sintético 42', code: 'C-42', active: true, trade_name: null, person_type: 'J', document: '12.345.678/0001-90', ie: '123456789', email: 'cliente@sintetico.test', phone: '(31) 3333-4444',
    mobile: null, postal_code: '30110-000', street: 'Rua Sintética', number: '10', complement: null, district: 'Centro', city: 'Belo Horizonte', state: 'MG', taxpayer: '1', country: null, nfe_email: 'nfe@sintetico.test' },
  nature: null, items: [{ position: 1, product_id: PRODUCT, description: 'Peça sintética', code: 'P-1', unit: 'UN', quantity: '2.000000', unit_price: '10.0000000000', gross: '20.00', discount: '2.00', total: '18.00',
    product: { kind: 'P', ncm: '84714900', gtin: '7891234567895', gtin_tax: null, cest: '0100100', origin: '0', gross_weight: '1.500000', net_weight: '1.250000', volumes: '1' } }],
  totals: { gross: '20.00', line_discount: '2.00', discount: '1.00', freight: '5.00', other_expenses: '0.00', total: '22.00' },
  installments: [{ position: 1, due_date: '2026-11-19', amount: '22.00', method: 'Boleto', note: null }],
  delivery: { name: 'Filial sintética', postal_code: '30110001', state: 'MG', city: 'Contagem', district: 'Centro', street: 'Av. Sintética', number: '200', complement: null, country: 'Brasil' },
  transport: { freight_mode: '0', volume_count: '2.000000', gross_weight: '3.500000', tracking_code: 'BR123', carrier_label: 'Transportadora sintética' }, existing_invoice: null,
  writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native', ...over });
function recordOf(input, over = {}) {
  const normalized = normalizeInvoiceInput(input), totals = invoiceTotals(normalized);
  return { ...normalized, id: id(1), version: 1, status: 1, environment: '2', series: Number(normalized.series), number: null, access_key: null, protocol: null, authorized_at: null, nature_description: normalized.nature_description ?? 'Venda sintética',
    items: normalized.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals, orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, ...over };
}
const envelope = (record, extra = {}) => ({ invoice: record, writable: true, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', ...extra });
function server({ preferences = {}, source = sourceOf(), post, get, itemDiscount } = {}) {
  const calls = []; const snapshot = { phase: 'ready', membership: { user_id: admin, role: 'admin' } };
  const prefs = { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [], ...preferences };
  const controller = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') return post(call, calls);
      if (get) { const value = get(call); if (value !== undefined) return value; }
      if (path.startsWith('/v1/notas-fiscais/contexto')) return { company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [{ series: 2, next_number: 42195, enabled: true }],
        defaults: { S: { id: NATURE, description: 'Venda sintética' } }, preferences: structuredClone(prefs), ...(itemDiscount === undefined ? {} : { item_discount: itemDiscount }), writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
      if (path.startsWith('/v1/notas-fiscais/naturezas?')) return { items: [summary(nature())], page: 1, limit: 100, total_count: 1, writable: true, review: { confirmed: false, version: 0, confirmed_at: null }, data_mode: 'erp_native' };
      if (path === `/v1/notas-fiscais/naturezas/${NATURE}`) return { nature: nature(), writable: true, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 0, updated_at: null, writable: true, data_mode: 'erp_native' };
      if (path.startsWith(`/v1/notas-fiscais/pedido/${ORDER}?`)) return structuredClone(source);
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  return { calls, controller, snapshot, posts: () => calls.filter(c => c.method !== 'GET') };
}
const mountForm = (srv, props = {}) => mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'order', documentId: ORDER }, today: '2026-10-20', onBack() {}, onSaved() {}, ...props },
  { location: `/historico-fiscal?modelo=55&nota=nova&pedido=${ORDER}`, expandChildren: ['FiscalInvoiceItemDialog', 'FiscalReconcilePanel', 'FiscalInstallmentDialog'] });

test('"Gerar nota fiscal": the note opens filled from the pedido and saves linked to it', async () => {
  const srv = server({ post: call => envelope(recordOf(call.body.invoice, { orders: [{ id: ORDER, kind: 'sales_orders', number: '42', date: '2026-10-20', contact_name: 'Cliente sintético 42' }] }), { action: 'create', replayed: false }) });
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: `/historico-fiscal?modelo=55&origem=brufap&nota=nova&pedido=${ORDER}`, expandChildren: ['FiscalInvoiceForm'] });
  try {
    await wait(view);
    assert.ok(srv.calls.some(c => c.path === `/v1/notas-fiscais/pedido/${ORDER}?model=55`), 'the pedido is read through the note API');
    assert.equal(view.input('fiscal-exit-date').props.value, '2026-10-22', 'Data saída of the pedido');
    assert.equal(view.guard().changed, true, 'the filled note asks before leaving');
    await tab(view, 'Destinatário');
    assert.equal(view.input('fiscal-recipient-name').props.value, 'Cliente sintético 42'); assert.equal(view.input('fiscal-recipient-document').props.value, '12345678000190');
    assert.equal(view.input('fiscal-recipient-ie-indicator').props.value, '1'); assert.equal(view.input('fiscal-recipient-email').props.value, 'nfe@sintetico.test');
    await tab(view, 'Transportador/Volumes');
    assert.equal(view.input('fiscal-transport-mode').props.value, 'manual'); assert.equal(view.input('fiscal-freight-by').props.value, '0'); assert.equal(view.input('fiscal-tracking').props.value, 'BR123');
    assert.equal(view.input('fiscal-carrier-name').props.value, 'Transportadora sintética'); assert.equal(view.input('fiscal-volume-quantity').props.value, '2'); assert.equal(view.input('fiscal-volume-gross').props.value, '3.500');
    assert.equal(view.input('fiscal-delivery-city').props.value, 'Contagem');
    await press(view, 'Salvar'); await wait(view);
    const post = srv.posts()[0];
    assert.equal(post.path, '/v1/notas-fiscais'); assert.deepEqual(post.body.orders, [ORDER]);
    const body = post.body.invoice;
    assert.equal(body.exit_date, '2026-10-22'); assert.equal(body.discount, '3.00'); assert.equal(body.freight, '5.00'); assert.equal(body.presence, '2', 'the natureza fills the presence like a pick');
    assert.deepEqual({ ...body.items[0], icms: undefined }, { icms: undefined, description: 'Peça sintética', quantity: '2.0000', unit_price: '10.0000000000', unit: 'UN', product_id: PRODUCT, code: 'P-1', ncm: '84714900', cest: '0100100', gtin: '7891234567895',
      gross_weight: '1.500', net_weight: '1.250', volumes: '1', others: { purchase_order: 'PC-7788' }, cfop: '5102' });
    assert.equal(body.items[0].icms.origin, '0'); assert.equal(body.items[0].icms.situation, '101');
    // The list opens the note with the real São Paulo date (RealFiscalInvoices), so the Dias of the parcel count from it.
    const spToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const days = Math.round((Date.parse('2026-11-19T00:00:00Z') - Date.parse(`${spToday}T00:00:00Z`)) / 86400000);
    assert.deepEqual(body.payment.installments, [{ ...(days >= 0 ? { days: String(days) } : {}), date: '2026-11-19', amount: '22.00', method: '15', card: null }]);
    assert.equal(body.transport.delivery.postal_code, '30110001'); assert.equal(body.additional_info, 'Entregar pela manhã');
    assert.equal(body.nature_additional_info, 'Pedido 42', 'NUMERO_PEDIDO comes from the pedido before the first save');
  } finally { view.unmount(); }
});

test('"Gerar NFC-e": the NFC-e opens filled from the pedido, as a consumer note, and saves linked to it', async () => {
  const srv = server({ source: sourceOf({ model: '65' }), post: call => envelope(recordOf(call.body.invoice, { orders: [{ id: ORDER, kind: 'sales_orders', number: '42', date: '2026-10-20', contact_name: 'Cliente sintético 42' }] }), { action: 'create', replayed: false }) });
  const view = await mountForm(srv, { config: { screen: 'nfce', model: '65', direction: '1' } });
  try {
    await wait(view);
    assert.ok(srv.calls.some(c => c.path === `/v1/notas-fiscais/pedido/${ORDER}?model=65`), 'the pedido is read for model 65');
    await press(view, 'Salvar'); await wait(view);
    const post = srv.posts()[0];
    assert.ok(post, 'the NFC-e is saved'); assert.deepEqual(post.body.orders, [ORDER]);
    const body = post.body.invoice;
    assert.equal(body.model, '65'); assert.equal(body.issue_type, 'C'); assert.equal(body.presence, '1'); assert.equal(body.final_consumer, true); assert.equal(body.purpose, '1');
    assert.equal(body.transport.mode, 'none', 'the NFC-e takes no transport group'); assert.equal(body.transport.delivery, null);
    assert.equal(body.discount, '3.00'); assert.deepEqual(body.payment.installments.map(i => [i.date, i.amount, i.method]), [['2026-11-19', '22.00', '15']]);
    assert.doesNotThrow(() => normalizeInvoiceInput(body), 'the database contract accepts the generated NFC-e');
  } finally { view.unmount(); }
});

test('"Erro ao gerar a Nota fiscal": a refused pedido shows Origin\'s reasons and nothing is saved', async () => {
  const srv = server({ source: sourceOf({ eligible: false, reasons: [{ code: 'cancelled', items: [] }, { code: 'stock_negative', items: [1] }] }), post: () => { throw new Error('nothing to save'); } });
  const view = await mountForm(srv);
  try {
    await wait(view);
    assert.match(view.text(), /Erro ao gerar a Nota fiscal/); assert.match(view.text(), /O pedido está cancelado/); assert.match(view.text(), /O estoque ficaria negativo.*Itens: 1\./s);
    assert.equal(view.nodes().some(n => n.type === 'button' && textOf(n).trim() === 'Salvar'), false);
  } finally { view.unmount(); }
  const entry = server({ source: sourceOf({ document: { ...sourceOf().document, kind: 'purchase_orders' }, direction: '0' }) });
  const wrong = await mountForm(entry);
  try { await wait(wrong); assert.match(wrong.text(), /O pedido de compra gera a nota em Notas fiscais de entrada/); } finally { wrong.unmount(); }
  const forged = server({ source: { ...sourceOf(), secret: 'x' } });
  const broken = await mountForm(forged);
  try { await wait(broken); assert.match(broken.text(), /Não foi possível carregar ou conferir a nota/); } finally { broken.unmount(); }
});

test('parcel popup "Informação": card data goes with the parcel; the finance lock keeps parcels read-only and never blocks the save', async () => {
  const srv = server({ post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const view = await mountForm(srv);
  try {
    await wait(view); await tab(view, 'Pagamento');
    byLabel(view, 'Detalhes da parcela 1').props.onClick(); await view.flush();
    assert.equal(components(view, 'Modal').at(-1).props.title, 'Informação · parcela 1');
    assert.equal(view.input('fiscal-installment-destination').props.disabled, true, 'Destino/Conta financeira follows the contas the note does not post');
    assert.equal(view.input('fiscal-installment-kind').props.value, 'Boleto Bancário');
    await view.change('fiscal-installment-brand', '02'); await view.change('fiscal-installment-integration', '2'); await view.change('fiscal-installment-cnpj', '11.222.333/0001-81');
    await view.change('fiscal-installment-received', '22,00');
    await modalAction(view, 'Salvar');
    await press(view, 'Salvar'); await wait(view);
    assert.deepEqual(srv.posts()[0].body.invoice.payment.installments[0].card, { brand: '02', integration: '2', cnpj: '11222333000181', received: '22.00' });
  } finally { view.unmount(); }
  // Contas already posted by the pedido + "Bloquear edição da nota quando a conta foi lançada pela venda": parcels follow them.
  const locked = server({ preferences: { block_edit_finance: true }, source: sourceOf({ document: { ...sourceOf().document, finance_active: true }, installments: [{ position: 1, due_date: '2026-11-19', amount: '10.00', method: null, note: 'Parcela do pedido' }] }),
    post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const form = await mountForm(locked);
  try {
    await wait(form); await tab(form, 'Pagamento');
    assert.match(form.text(), /As parcelas seguem as contas já lançadas pelo pedido de venda/);
    assert.equal(form.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Valor da parcela 1').props.disabled, true);
    byLabel(form, 'Detalhes da parcela 1').props.onClick(); await form.flush();
    assert.equal(form.input('fiscal-installment-amount').props.disabled, true); await modalAction(form, 'Fechar');
    await press(form, 'Salvar'); await wait(form);
    assert.equal(locked.posts().length, 1, 'parcels of 10.00 against a 22.00 note still save while they follow posted contas');
    assert.equal(locked.posts()[0].body.invoice.payment.installments[0].note, 'Parcela do pedido');
  } finally { form.unmount(); }
  const strict = server({ source: sourceOf({ installments: [{ position: 1, due_date: '2026-11-19', amount: '10.00', method: null, note: null }] }), post: () => { throw new Error('never sent'); } });
  const blocked = await mountForm(strict);
  try { await wait(blocked); await press(blocked, 'Salvar'); assert.match(blocked.text(), /A soma das parcelas \(R\$ 10,00\) é diferente do total da nota/); assert.equal(strict.posts().length, 0); } finally { blocked.unmount(); }
});

test('"Conciliar produtos" opens the imported note on the Itens tab', async () => {
  const imported = recordOf({ model: '55', direction: '0', issue_type: 'T', series: '1', number: '77', nature_id: null, nature_description: 'Compra', issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', final_consumer: false,
    recipient: { name: 'Fornecedor sintético', person_type: 'J', document: '12345678000195' }, items: [{ description: 'Peça do fornecedor', quantity: '1', unit_price: '20' }] }, { issue_type: 'X', environment: null, status: 8, number: 77 });
  const srv = server({ get: call => call.path === `/v1/notas-fiscais/${id(1)}` ? { ...envelope(imported, { writable: false }), locks: { items: false, installments: false } } : undefined });
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'entrada' }, { location: `/notas-entrada?origem=brufap&nota=${id(1)}&secao=itens`, expandChildren: ['FiscalInvoiceForm'] });
  try {
    await wait(view);
    assert.equal(selectedTab(view), 'Itens da nota fiscal'); assert.ok(components(view, 'FiscalReconcilePanel').length, 'the reconciliation panel is open');
    await tab(view, 'Cabeçalho'); await press(view, 'Conciliar produtos');
    assert.equal(selectedTab(view), 'Itens da nota fiscal', 'the notice button goes back to the panel');
  } finally { view.unmount(); }
});

test('Total do IPI and Total do ICMS ST of a pedido come from the note engine; forged totals and other sessions never show', async () => {
  const calls = []; let answer = null; const snapshot = { phase: 'ready', membership: { user_id: admin, role: 'vendas' } };
  const controller = { getSnapshot: () => snapshot, subscribe: () => () => {}, async fiscalInvoices(path, options) { calls.push({ path, body: options.body }); return answer; } };
  const estimate = (over = {}) => ({ enabled: true, available: true, reason: null, nature: { id: NATURE, description: 'Venda sintética' }, items: [{ product_id: PRODUCT, ipi: '2.00', st: '1.50' }], totals: { ipi: '2.00', st: '1.50', total: '25.50' }, data_mode: 'erp_native', ...over });
  const totals = { items: [], gross: '20.00', line_discount: '2.00', subtotal: '18.00', discount: '1.00', freight: '5.00', other_expenses: '0.00', total: '22.00' };
  const props = { controller, kind: 'sales_orders', contactId: CONTACT, items: [{ product_id: PRODUCT, description: 'Peça', unit: 'UN', quantity: '2', unit_price: '10' }], totals };
  answer = estimate();
  const view = await mountComponent('FiscalOrderTaxEstimate.tsx', props);
  try {
    await new Promise(r => setTimeout(r, 700)); await view.flush();
    assert.deepEqual(calls.at(-1), { path: `/v1/notas-fiscais/estimativa?kind=sales_orders&contact_id=${CONTACT}&items=${encodeURIComponent(`${PRODUCT},2,10`)}&discount=3.00&freight=5.00&other_expenses=0.00`, body: undefined });
    assert.match(view.text(), /Total do IPI.*2,00/s); assert.match(view.text(), /Total ICMS ST.*1,50/s, 'Origin label of the pedido de venda'); assert.match(view.text(), /O total do pedido ainda não soma o IPI e o ICMS ST/);
  } finally { view.unmount(); }
  const proposal = await mountComponent('FiscalOrderTaxEstimate.tsx', { ...props, kind: 'sales_proposals' });
  try { await new Promise(r => setTimeout(r, 700)); await proposal.flush(); assert.match(proposal.text(), /Total do ICMS ST.*1,50/s, 'Origin label of the proposta comercial'); assert.match(proposal.text(), /O total da proposta ainda não soma/); }
  finally { proposal.unmount(); }
  answer = estimate({ enabled: false, items: [{ product_id: PRODUCT, ipi: '0.00', st: '0.00' }], totals: { ipi: '0.00', st: '0.00', total: '22.00' } });
  const hidden = await mountComponent('FiscalOrderTaxEstimate.tsx', props);
  try { await new Promise(r => setTimeout(r, 700)); await hidden.flush(); assert.equal(hidden.text().includes('Total do IPI'), false, 'off and without values: nothing is shown'); } finally { hidden.unmount(); }
  answer = { ...estimate(), totals: { ipi: '9.99', st: '1.50', total: '25.50' } };
  const forged = await mountComponent('FiscalOrderTaxEstimate.tsx', props);
  try { await new Promise(r => setTimeout(r, 700)); await forged.flush(); assert.equal(forged.text().includes('Total do IPI'), false, 'totals that do not add up are refused'); } finally { forged.unmount(); }
  answer = estimate();
  const swapped = await mountComponent('FiscalOrderTaxEstimate.tsx', props);
  try { snapshot.membership = { user_id: id(77), role: 'vendas' }; await new Promise(r => setTimeout(r, 700)); await swapped.flush(); assert.equal(swapped.text().includes('Total do IPI'), false, 'another session never sees it'); }
  finally { swapped.unmount(); snapshot.membership = { user_id: admin, role: 'vendas' }; }
});

test('"Gerar nota fiscal" of an ordem de serviço takes only its parts and the list shows the O letter', async () => {
  const os = sourceOf({ document: { ...sourceOf().document, kind: 'service_orders', number: '9', ship_date: null, customer_po_number: null, notes: null },
    items: [sourceOf().items[0], { position: 2, product_id: id(801), description: 'Mão de obra', code: 'S-1', unit: 'H', quantity: '1.000000', unit_price: '50', gross: '50.00', discount: '0.00', total: '50.00',
      product: { kind: 'S', ncm: null, gtin: null, gtin_tax: null, cest: null, origin: null, gross_weight: null, net_weight: null, volumes: null } }],
    totals: { gross: '70.00', line_discount: '2.00', discount: '5.00', freight: '5.00', other_expenses: '0.00', total: '68.00' }, installments: [{ position: 1, due_date: '2026-11-19', amount: '68.00', method: null, note: null }], transport: null, delivery: null });
  const srv = server({ source: os, post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const view = await mountForm(srv);
  try {
    await wait(view);
    assert.match(view.text(), /A nota leva só os produtos da ordem de serviço nº 9: 1 serviço\(s\)/);
    await press(view, 'Salvar'); await wait(view);
    const body = srv.posts()[0].body.invoice;
    assert.deepEqual(body.items.map(i => i.description), ['Peça sintética']); assert.equal(body.discount, '2.00', 'only the line discount of the part');
    assert.equal(body.freight, '0.00'); assert.deepEqual(body.payment.installments, []); assert.deepEqual(srv.posts()[0].body.orders, [ORDER]);
  } finally { view.unmount(); }
  const { orderIndicators } = await import('../src/lib/fiscal-invoice-list-model.ts');
  assert.deepEqual(orderIndicators({ orders: [{ id: ORDER, kind: 'sales_orders', number: '42', date: '2026-10-20', contact_name: 'Cliente' }, { id: id(2), kind: 'service_orders', number: '9', date: '2026-10-19', contact_name: 'Cliente' }] }),
    [{ text: 'V', color: 'orange', title: 'Número pedido: 42 - Data: 20/10/2026 - Cliente: Cliente' }, { text: 'O', color: 'green', title: 'Número ordem de serviço: 9 - Data: 19/10/2026 - Cliente: Cliente' }]);
});

test('pedidos de compra: "Gerar nota fiscal" opens the entry note and the Vinculação column shows the linked entry notes', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const po = n => ({ id: id(n), kind: 'purchase_orders', number: String(n + 40), version: 2, status: 'open', date: today, total: '10.00', contact_id: CONTACT, contact_name: `Fornecedor sintético ${n}`, created_at: '2026-10-20T12:00:00Z',
    updated_at: '2026-10-20T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false,
    receipt_active: false, reservation_active: null, fiscal_draft: null, internal_notes: null });
  const rows = [po(1), po(2), po(3)], calls = [], opened = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: admin, role: 'fiscal' } }), subscribe: () => () => {},
    async documents(path) {
      if (path === '/v1/documentos') return { read: ['purchase_orders'], write: [], data_mode: 'erp_native' };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'purchase_orders', items: rows, limit: Number(q.get('limit')), page: Number(q.get('page')), order: q.get('order') ?? 'date_desc', has_more: false, next_cursor: null, total_count: rows.length, total_amount: '30.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async fiscalInvoices(path, options = {}) { calls.push({ path, body: structuredClone(options.body) }); return { items: [{ document_id: id(1), state: 'none' }, { document_id: id(2), state: 'linked' }, { document_id: id(3), state: 'partial' }], data_mode: 'erp_native' }; },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
  };
  const previous = globalThis.window; globalThis.window = { ...(previous ?? {}), open: (...args) => { opened.push(args); return null; } };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'purchase_orders' }, { location: '/documentos-empresa?tipo=purchase_orders', expandChildren: ['NativeListLayout', 'DocumentList'] });
  try {
    await wait(view);
    assert.deepEqual(calls.at(-1), { path: '/v1/notas-fiscais/vinculos', body: { document_ids: [id(1), id(2), id(3)] } });
    assert.ok(view.nodes().some(n => n.type === 'th' && textOf(n) === 'Vinculação'));
    const badges = view.nodes().filter(n => n.type === 'span' && String(n.props.className).startsWith('status-badge status-')).map(n => [textOf(n), n.props.className]);
    assert.deepEqual(badges.filter(([text]) => ['Não vinculado', 'Vinculado', 'Parcial'].includes(text)), [['Não vinculado', 'status-badge status-waiting'], ['Vinculado', 'status-badge status-success'], ['Parcial', 'status-badge status-warning']]);
    const menu = components(view, 'RowMenu')[0];
    const item = menu.props.items.find(i => i.label === 'Gerar nota fiscal');
    assert.equal(Boolean(item.disabled), false); item.onClick(); await view.flush();
    assert.deepEqual(opened.at(-1), [`/notas-entrada?origem=brufap&nota=nova&pedido=${id(1)}`, '_blank', 'noopener']);
  } finally { view.unmount(); if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('Mais ações › Imprimir › "Etiquetas selecionadas" prints the address labels of the selected notes', async () => {
  const originRow = n => ({ origin: 'origin', id: String(9000 + n), version: null, number: 120 + n, series: 3, issue_date: '2026-10-15', entry_date: '2026-10-16', name: `Cliente Origin ${n}`, document: '12345678000190', state: 'MG',
    nature: 'Venda de mercadoria', status: 6, status_raw: '5', total: '100.10', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [] });
  const detail = n => ({ origin: 'origin', entity: 'nfe', source_id: String(9000 + n), model: '55', direction: '1', number: 120 + n, series: 3, issue_date: '2026-10-15', operation_date: null, status: 6, status_raw: '5', access_key: null,
    total: '100.10', total_known: true, freight: null, contact: { name: `Cliente Origin ${n}`, document: null, ie: null, email: null, phone: null, street: 'Rua das Flores', number: String(n), complement: null, district: 'Centro',
      postal_code: '30110000', city: 'Belo Horizonte', state: 'MG', country: null }, items: [], installments: [], transport: { freight_by: null, carrier: null }, additional_info: null, xml: null, events: [],
    observed_at: '2026-10-16T12:00:00Z', data_mode: 'origin_mirror_readonly', writable: false });
  const srv = server({ get: call => {
    if (call.path.startsWith('/v1/notas-fiscais?')) { const q = new URLSearchParams(call.path.split('?')[1]); return { items: [originRow(1), originRow(2)], origin: 'origin', model: '55', direction: '1', page: Number(q.get('page')), limit: 100,
      order: q.get('order') ?? 'date_desc', has_more: false, total_count: 2, total_amount: '200.20', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: 'origin_mirror_readonly' }; }
    const match = /^\/v1\/notas-fiscais\/origin\/nfe\/(900[12])$/.exec(call.path); if (match) return detail(Number(match[1]) - 9000);
    return undefined;
  } });
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller: srv.controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55', expandChildren: ['NativeListLayout'] });
  try {
    await wait(view);
    assert.equal(button(view, 'Etiquetas selecionadas').props.disabled, true, 'enabled only with a selection');
    assert.equal(button(view, 'Etiquetas de transporte').props.disabled, true);
    view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar nota 000122').props.onClick({ shiftKey: false }); await view.flush();
    await press(view, 'Etiquetas selecionadas'); await wait(view);
    assert.ok(srv.calls.some(c => c.path === '/v1/notas-fiscais/origin/nfe/9002'));
    assert.deepEqual(components(view, 'DocumentLabelsPrint')[0].props.labels, [{ name: 'Cliente Origin 2', address: 'Rua das Flores, 2 · Centro · Belo Horizonte - MG · CEP 30110-000', reference: 'NF 000122' }]);
  } finally { view.unmount(); }
  const { noteLabel } = await import('../src/lib/fiscal-invoice-list-model.ts');
  assert.deepEqual(noteLabel({ number: 7 }, { name: 'Cliente', street: 'Rua A', number: '1', city: 'Campinas', state: 'SP' }, { name: 'Filial', street: 'Av. B', number: '2', city: 'Sumaré', state: 'SP', postal_code: '13170000' }),
    { name: 'Filial', address: 'Av. B, 2 · Sumaré - SP · CEP 13170-000', reference: 'NF 000007' }, 'the delivery address comes first');
});

test('the emitter opened by an old "Gerar nota fiscal" link preselects the pedido (and explains a cancelled one)', async () => {
  const doc = (status = 'open') => ({ document: { id: ORDER, kind: 'sales_orders', number: '42', version: 3, status, date: '2026-10-20', totals: { total: '22.00' }, contact_id: CONTACT, contact_snapshot: { id: CONTACT, name: 'Cliente sintético 42' },
    created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' } });
  const mountDrafts = status => {
    const calls = [];
    const controller = {
      async fiscalDraft(path) { calls.push(path); return { items: [], has_more: false, next_cursor: null, data_mode: 'erp_native' }; },
      async documents(path) { calls.push(path); if (path === `/v1/documentos/sales_orders/${ORDER}`) return doc(status); return { kind: 'sales_orders', items: [], has_more: false, next_cursor: null, data_mode: 'erp_native' }; },
    };
    return mountComponent('RealFiscalDrafts.tsx', { controller, initialModel: '55' }, { location: `/emissor-fiscal?modelo=55&pedido=${ORDER}`, expandChildren: ['CreateDraft'] }).then(view => ({ view, calls }));
  };
  const { view, calls } = await mountDrafts('open');
  try {
    await wait(view);
    assert.ok(calls.includes(`/v1/documentos/sales_orders/${ORDER}`));
    assert.match(view.text(), /Conferi o pedido nº 42, versão 3, e o modelo 55/);
    assert.equal(view.guard().changed, false, 'the preselection alone is not a change');
  } finally { view.unmount(); }
  const cancelled = await mountDrafts('cancelled');
  try { await wait(cancelled.view); assert.match(cancelled.view.text(), /Pedido nº 42 cancelado: não pode gerar rascunho fiscal/); assert.equal(cancelled.view.text().includes('Conferi o pedido nº 42'), false); }
  finally { cancelled.view.unmount(); }
});

test('"Informar desconto individualmente nos itens": the item keeps its discount, the note discount is the sum, and saved notes keep their totals', async () => {
  const srv = server({ itemDiscount: true, source: sourceOf({ installments: [] }), post: call => envelope(recordOf(call.body.invoice), { action: 'create', replayed: false }) });
  const view = await mountForm(srv);
  try {
    await wait(view); await tab(view, 'Cálculo de imposto');
    assert.equal(view.input('fiscal-discount').props.readOnly, true); assert.equal(view.input('fiscal-discount').props.value, '3.00', 'line discount 2.00 + the pedido discount 1.00');
    await tab(view, 'Itens da nota fiscal');
    byLabel(view, 'Editar item 1').props.onClick(); await view.flush();
    await view.change('fiscal-item-discount', '2,50'); await modalAction(view, 'Salvar item');
    await tab(view, 'Cálculo de imposto'); assert.equal(view.input('fiscal-discount').props.value, '2.50');
    await press(view, 'Salvar'); await wait(view);
    const body = srv.posts()[0].body.invoice;
    assert.equal(body.items[0].discount, '2.50'); assert.equal(body.discount, '2.50');
  } finally { view.unmount(); }
  // A note saved with the discount spread opens with each item's share: same totals, nothing to save.
  const saved = recordOf({ model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: NATURE, nature_description: 'Venda sintética', issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { name: 'Cliente', person_type: 'J', document: '12345678000190', state: 'SP' }, discount: '1.00', items: [{ description: 'A', quantity: '1', unit_price: '10' }, { description: 'B', quantity: '1', unit_price: '20' }] });
  const old = server({ itemDiscount: true, get: call => call.path === `/v1/notas-fiscais/${id(1)}` ? { ...envelope(saved), locks: { items: false, installments: false } } : undefined, post: call => envelope(recordOf(call.body.invoice, { version: 2 }), { action: 'update', replayed: false }) });
  const form = await mountForm(old, { id: id(1), opening: null });
  try {
    await wait(form);
    assert.equal(form.guard().changed, false, 'converting the discount mode is not a change');
    await tab(form, 'Itens da nota fiscal'); form.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Editar item 2').props.onClick(); await form.flush();
    assert.equal(form.input('fiscal-item-discount').props.value, '0.67');
  } finally { form.unmount(); }
  const off = server({ itemDiscount: false });
  const plain = await mountForm(off);
  try { await wait(plain); await tab(plain, 'Cálculo de imposto'); assert.equal(Boolean(plain.input('fiscal-discount').props.readOnly), false); assert.equal(plain.input('fiscal-discount').props.value, '3.00'); }
  finally { plain.unmount(); }
});

test('the pedido discount is shared by the net value of each line, so an item never passes its own value', async () => {
  const { orderDraft } = await import('../src/lib/fiscal-invoice-form-model.ts');
  const line = (position, gross, discount) => ({ position, product_id: null, description: `Item ${position}`, code: null, unit: 'UN', quantity: '1', unit_price: gross, gross, discount, total: (Number(gross) - Number(discount)).toFixed(2), product: null });
  const source = { ...sourceOf(), items: [line(1, '100.00', '90.00'), line(2, '100.00', '0.00')], installments: [], transport: null, delivery: null,
    totals: { gross: '200.00', line_discount: '90.00', discount: '100.00', freight: '0.00', other_expenses: '0.00', total: '10.00' } };
  const context = { company: { crt: '1', state: 'SP' }, series: [], defaults: {}, preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] }, item_discount: true };
  const draft = orderDraft(source, { model: '55', direction: '1' }, context, '2026-10-20');
  assert.deepEqual(draft.items.map(i => i.discount), ['99.09', '90.91'], '90.00 + 9.09, then the remainder 90.91');
  assert.equal(draft.discount, '190.00');
  const { normalizeInvoiceInput: normalize, invoiceTotals: totalsOf } = await import('../../../packages/erp-domain/src/fiscal-invoice-contract.mjs');
  const { draftToInput } = await import('../src/lib/fiscal-invoice-form-model.ts');
  assert.equal(totalsOf(normalize(draftToInput({ ...draft, nature_description: 'Venda', recipient: { name: 'Cliente', person_type: 'J' } }))).totals.total, '10.00');
});
