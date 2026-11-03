import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// "Gerar nota fiscal" with the pedido source v3 (202610200254): Detalhes de pagamento, the card group of the parcel and the
// compositions split by "Desmembrar produtos ... em uma estrutura na nota fiscal". Synthetic controller only.
const id = n => `31000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '31000000-0000-4000-8000-0000000000aa', ORDER = id(600), CONTACT = id(500), NATURE = id(900), KIT = id(810), COMPONENT = id(811);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const press = async (view, label) => { const node = view.nodes().find(n => n.type === 'button' && textOf(n).trim() === label); if (!node) throw new Error(`Missing button ${label}`); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
const settle = async view => { for (let i = 0; i < 4; i++) { await view.flush(); await new Promise(r => setTimeout(r, 10)); } };
const natureOf = () => ({ id: NATURE, description: 'Venda sintética', series: null, direction: '1', crt: '1', presence: '2', invoiced: true, final_consumer: false, return_operation: false, update_last_purchase_price: false,
  include_freight_ipi_base: false, others: {}, retentions: {}, additional_info: null, fiscal_info: null, active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
  defaults: ['S'], rules: [{ tax: 'icms', position: 1, destinations: [], product_scope: 'any', ncms: [], product_ids: [], products: [], data: { situation: '102', cfop: '5102' }, additional_info: null, fiscal_info: null }] });
const productOf = ncm => ({ kind: 'P', ncm, gtin: null, gtin_tax: null, cest: null, origin: '0', gross_weight: null, net_weight: null, volumes: null });
const v3Source = composition => ({ document: { id: ORDER, kind: 'sales_orders', number: '42', version: 3, status: 'open', date: '2026-10-20', ship_date: null, customer_po_number: null, notes: null, warehouse_id: null, stock_active: false, finance_active: false },
  direction: '1', model: '55', eligible: true, reasons: [],
  contact: { contact_id: CONTACT, name: 'Cliente sintético 42', code: null, active: true, trade_name: null, person_type: 'J', document: '12345678000190', ie: null, email: null, phone: null, mobile: null, postal_code: null, street: null,
    number: null, complement: null, district: null, city: null, state: 'SP', taxpayer: '9', country: null, nfe_email: null },
  nature: null, items: [{ position: 1, product_id: KIT, description: 'Kit sintético', code: 'KIT', unit: 'KT', quantity: '2.000000', unit_price: '25.0000000000', gross: '50.00', discount: '0.00', total: '50.00', product: productOf('84714900'), composition }],
  totals: { gross: '50.00', line_discount: '0.00', discount: '0.00', freight: '0.00', other_expenses: '0.00', total: '50.00' },
  installments: [{ position: 1, due_date: '2026-10-20', amount: '50.00', method: null, note: null, payment_method: null,
    details: { payment_type: '03', card_brand: '02', integration_type: '2', acquirer_cnpj: '11222333000181', authorization_code: 'AUT-42', received_amount: '48.50', fee_amount: '1.50', commission_fee_amount: null } }],
  delivery: null, transport: null, existing_invoice: null, seller: null, carrier: null, keep_order_dates: true, payment: { means: '17', indicator: '0' },
  writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' });
function formServer(source) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      const call = { path, method: options.method ?? 'GET', body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (call.method !== 'GET') throw new AccessError(409);
      if (path.startsWith('/v1/notas-fiscais/contexto')) return { company: { crt: '1', regime_confirmed: true, state: 'SP', cnpj_present: true }, series: [{ series: 2, next_number: 42195, enabled: true }],
        defaults: { S: { id: NATURE, description: 'Venda sintética' } }, preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [] }, item_discount: true, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
      if (path.startsWith('/v1/notas-fiscais/naturezas?')) { const n = natureOf(); return { items: [{ id: n.id, description: n.description, series: n.series, direction: n.direction, crt: n.crt, presence: n.presence, invoiced: n.invoiced, final_consumer: n.final_consumer,
        return_operation: n.return_operation, active: n.active, version: n.version, defaults: n.defaults, rule_count: 1 }], page: 1, limit: 100, total_count: 1, writable: true, review: { confirmed: false, version: 0, confirmed_at: null }, data_mode: 'erp_native' }; }
      if (path === `/v1/notas-fiscais/naturezas/${NATURE}`) return { nature: natureOf(), writable: true, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/impostos') return { settings: { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false }, difal_by_state: {}, version: 0, updated_at: null, writable: true, data_mode: 'erp_native' };
      if (path.startsWith(`/v1/notas-fiscais/pedido/${ORDER}?`)) return structuredClone(source);
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  return { calls, controller };
}
const formTab = async (view, label) => { const found = view.nodes().find(n => n.type === 'button' && n.props.role === 'tab' && textOf(n).trim() === label); found.props.onClick(); await view.flush(); };
const mountOrderForm = srv => mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'order', documentId: ORDER }, today: '2026-10-20', onBack() {}, onSaved() {} },
  { location: `/historico-fiscal?modelo=55&nota=nova&pedido=${ORDER}` });

test('"Gerar nota fiscal" (v3): components in place of the composition, the parcel card group and the Forma de pagamento of the pedido', async () => {
  const composition = { stock_type: 'physical', problem: null, components: [{ position: 1, product_id: COMPONENT, description: 'Componente sintético', code: 'C-1', unit: 'UN', quantity: '5.000000', price: '5.0000', product: productOf('73181500') }] };
  const srv = formServer(v3Source(composition));
  const view = await mountOrderForm(srv);
  try {
    await settle(view);
    await formTab(view, 'Pagamento');
    assert.match(view.text(), /Forma de pagamento do pedido: Pagamento à vista/);
    const before = srv.calls.length;
    await press(view, 'Salvar'); await settle(view);
    const post = srv.calls.slice(before).find(c => c.method === 'POST');
    assert.equal(post?.path, '/v1/notas-fiscais', view.text());
    const body = post.body.invoice;
    assert.equal(body.payment.indicator, '0');
    assert.deepEqual(body.payment.installments[0].card, { brand: '02', integration: '2', cnpj: '11222333000181', authorization: 'AUT-42', received: '48.50', fee: '1.50' });
    assert.equal(body.payment.installments[0].method, '03', 'the Tipo de pagamento of the parcel details wins over the Método de pagamento');
    assert.deepEqual(body.items.map(i => [i.product_id, i.quantity, i.unit_price, i.ncm]), [[COMPONENT, '10.0000', '5.0000000000', '73181500']]);
  } finally { view.unmount(); }
});

test('"Gerar nota fiscal" (v3): a composition that cannot be split stays whole and the form says why', async () => {
  const srv = formServer(v3Source({ stock_type: 'virtual', problem: 'component_unavailable', components: [] }));
  const view = await mountOrderForm(srv);
  try {
    await settle(view);
    assert.match(view.text(), /Kit sintético: não foi desmembrada porque um componente está inativo, excluído ou não é um produto simples\. O item ficou com a composição\./);
  } finally { view.unmount(); }
});

test('Transportador/Volumes: the transportadora search looks first for contacts of the Tipo de contato Transportador', async () => {
  const srv = formServer(v3Source(null)); const searches = [];
  const empty = { items: [], has_more: false }, options = { scope: 'contact_options', items: [], has_more: false };
  srv.controller.catalog = async path => { searches.push(path); return path.startsWith('/v1/cadastros/contatos/opcoes') ? options : empty; };
  const view = await mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'new' }, today: '2026-10-20', onBack() {}, onSaved() {} },
    { location: '/historico-fiscal?modelo=55&nota=nova' });
  try {
    await settle(view);
    await formTab(view, 'Destinatário'); await view.change('fiscal-recipient-search', 'Cli'); await new Promise(r => setTimeout(r, 300)); await settle(view);
    assert.ok(searches.some(p => p.startsWith('/v1/cadastros/contatos/opcoes?') && p.includes('q=Cli') && !p.includes('papel=')), 'the destinatário searches every contact');
    await formTab(view, 'Transportador/Volumes'); await view.change('fiscal-transport-mode', 'manual');
    await view.change('fiscal-carrier-search', 'Tra'); await new Promise(r => setTimeout(r, 300)); await settle(view);
    assert.ok(searches.some(p => p.includes('q=Tra') && p.includes('papel=transportador')), 'the transportadora searches the Transportador type');
  } finally { view.unmount(); }
});

test('Transportador/Volumes: contacts mirrored from the Origin (no Tipo de contato) are still found when no Transportador matches', async () => {
  const srv = formServer(v3Source(null)); const searches = [];
  const carrier = { id: id(700), name: 'Transportes Sintéticos', code: null, document: '22333444000155', trade_name: null, city: 'São Paulo', state: 'SP', has_notes: false, persons: 0 };
  srv.controller.catalog = async path => {
    searches.push(path);
    if (!path.startsWith('/v1/cadastros/contatos/opcoes')) return { items: [], has_more: false };
    return { scope: 'contact_options', items: path.includes('papel=transportador') ? [] : [carrier], has_more: false };
  };
  const view = await mountComponent('FiscalInvoiceForm.tsx', { controller: srv.controller, config: { screen: 'nfe', model: '55', direction: '1' }, id: null, opening: { kind: 'new' }, today: '2026-10-20', onBack() {}, onSaved() {} },
    { location: '/historico-fiscal?modelo=55&nota=nova' });
  try {
    await settle(view);
    await formTab(view, 'Transportador/Volumes'); await view.change('fiscal-transport-mode', 'manual');
    await view.change('fiscal-carrier-search', 'Tra'); await new Promise(r => setTimeout(r, 300)); await settle(view);
    const carrierSearches = searches.filter(p => p.includes('q=Tra'));
    assert.deepEqual(carrierSearches.map(p => p.includes('papel=transportador')), [true, false], 'the Transportador type first, then every contact');
    assert.match(view.text(), /Nenhum contato com o Tipo de contato Transportador: a busca mostra todos os contatos/);
    assert.ok(view.nodes().some(n => n.type === 'button' && textOf(n).includes('Transportes Sintéticos')), 'the mirrored contact can be picked');
  } finally { view.unmount(); }
});
