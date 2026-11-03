import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeInvoiceInput, invoiceTotals, DEFAULT_INVOICE_PREFERENCES } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// Wave E of the notas fiscais screens (synthetic controller only: no DOM, no network, synthetic data).
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '30000000-0000-4000-8000-0000000000aa', SUPPLIER = id(700), PRODUCT = id(800), NOTE = id(1);
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const buttons = (view, label) => view.nodes().filter(n => n.type === 'button' && textOf(n).trim() === label);
const press = async (view, label, index = -1) => { const node = buttons(view, label).at(index); if (!node) throw new Error(`Missing button ${label}`); if (node.disabled) throw new Error(`Disabled button: ${label}`); node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); await view.flush(); };
const settle = async view => { for (let i = 0; i < 4; i++) { await view.flush(); await new Promise(r => setTimeout(r, 5)); } };
function entryRecord() {
  const normalized = normalizeInvoiceInput({ model: '55', direction: '0', issue_type: 'T', number: '77', series: '1', nature_id: id(900), issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', final_consumer: false,
    recipient: { contact_id: SUPPLIER, name: 'Fornecedor sintético', person_type: 'J', document: '22333444000155', state: 'SP' }, items: [{ product_id: PRODUCT, description: 'Peça sintética', quantity: '2', unit_price: '10' }] });
  const totals = invoiceTotals(normalized);
  return { ...normalized, id: NOTE, version: 1, status: 8, environment: null, series: 1, number: 77, access_key: null, protocol: null, authorized_at: null, nature_description: 'Compra sintética',
    items: normalized.items.map((item, i) => ({ ...item, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals, orders: [], created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null };
}
const row = { origin: 'brufap', id: NOTE, version: 1, number: 77, series: 1, issue_date: '2026-10-20', entry_date: null, name: 'Fornecedor sintético', document: '22333444000155', state: 'SP', nature: 'Compra sintética', status: 8, status_raw: null,
  total: '20.00', total_known: true, environment: null, issue_type: 'T', access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0, orders: [] };

function pricingServer({ priceFailures = 0, markFailures = 0 } = {}) {
  const calls = []; let prices = 0, marks = 0;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body && structuredClone(options.body) });
      if (path === `/v1/notas-fiscais/${NOTE}`) return { invoice: entryRecord(), writable: false, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native', locks: { items: false, installments: false } };
      if (path.startsWith('/v1/notas-fiscais/contexto')) return { preferences: { ...DEFAULT_INVOICE_PREFERENCES, autxml_people: [], markup: '30' } };
      if (path === `/v1/notas-fiscais/${NOTE}/precos`) { if (++marks <= markFailures) throw new TypeError('rede sintética'); return { invoice_id: NOTE, catalog_command_id: options.body.catalog_command_id, products: 1, recorded_at: '2026-10-20T13:00:00Z', replayed: marks > 1, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products'], write: ['products'], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products/compras?')) return { entity: 'products', supplier_id: SUPPLIER, mode: 'last_purchase', items: [{ product_id: PRODUCT, version: 4, name: 'Peça sintética', code: null, price: '10.0000', deleted: false, default_supplier: null, supplier: null, last_purchase_price: null, suggested_price: null }], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/precos') { if (++prices <= priceFailures) throw new TypeError('rede sintética'); return { entity: 'products', supplier_id: SUPPLIER, items: [{ product_id: PRODUCT, version: 5, price: '13.0000', cost_price: '10.0000' }], replayed: prices > 1, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
  };
  return { calls, controller };
}

test('Formação de preços stays open while "Atualizar preços" waits on "Conferir resultado", then records the P mark of the note', async () => {
  const srv = pricingServer({ priceFailures: 1 }); let closed = 0; const priced = [];
  const view = await mountComponent('FiscalPricingDialog.tsx', { controller: srv.controller, row, onClose: () => { closed++; }, onPriced: mark => priced.push(mark) }, { expandChildren: ['Modal', 'UpdatePricesButton'] });
  try {
    await settle(view);
    assert.match(view.text(), /Custo unitário/);
    await press(view, 'Atualizar preços', 0); // opens the confirmation of the products lane button
    await press(view, 'Atualizar preços');    // confirms it
    await settle(view);
    assert.match(view.text(), /Use “Conferir resultado” para repetir a mesma operação sem duplicar/);
    // Fechar, the X and Esc (Modal onClose) keep the dialog open while the result is not confirmed.
    assert.equal(buttons(view, 'Fechar').at(-1).disabled, true);
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Fechar').props.onClick(); await view.flush();
    assert.equal(closed, 0);
    assert.match(view.text(), /Use “Conferir resultado” antes de fechar/);
    const first = srv.calls.filter(c => c.path === '/v1/cadastros/products/precos');
    await press(view, 'Conferir resultado'); await settle(view);
    const sent = srv.calls.filter(c => c.path === '/v1/cadastros/products/precos');
    assert.equal(sent.length, 2); assert.equal(sent[1].body.command_id, first[0].body.command_id, 'same command, never a second update');
    // The confirmed command is recorded on the note (P), then the dialog closes normally.
    const mark = srv.calls.find(c => c.path === `/v1/notas-fiscais/${NOTE}/precos`);
    assert.deepEqual(mark.body, { catalog_command_id: first[0].body.command_id });
    assert.equal(priced.length, 1); assert.match(view.text(), /letra P na listagem/);
    assert.equal(buttons(view, 'Fechar').at(-1).disabled, false);
    await press(view, 'Fechar'); assert.equal(closed, 1);
  } finally { view.unmount(); }
});

test('Formação de preços: an unconfirmed P mark offers its own "Conferir resultado" with the same catalog command', async () => {
  const srv = pricingServer({ markFailures: 1 }); let closed = 0; const priced = [];
  const view = await mountComponent('FiscalPricingDialog.tsx', { controller: srv.controller, row, onClose: () => { closed++; }, onPriced: mark => priced.push(mark) }, { expandChildren: ['Modal', 'UpdatePricesButton'] });
  try {
    await settle(view);
    await press(view, 'Atualizar preços', 0); await press(view, 'Atualizar preços'); await settle(view);
    assert.match(view.text(), /Não foi possível confirmar a marca P da nota/);
    assert.equal(buttons(view, 'Fechar').at(-1).disabled, true);
    await press(view, 'Conferir resultado'); await settle(view);
    const marks = srv.calls.filter(c => c.path === `/v1/notas-fiscais/${NOTE}/precos`);
    assert.equal(marks.length, 2); assert.equal(marks[0].body.catalog_command_id, marks[1].body.catalog_command_id);
    assert.equal(priced.length, 1); assert.equal(priced[0].replayed, true);
    await press(view, 'Fechar'); assert.equal(closed, 1);
  } finally { view.unmount(); }
});

test('Notas de entrada: the P letter "Preços atualizados" comes from the marks of the FAGOO notes of the page', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body && structuredClone(options.body) });
      if (path.startsWith('/v1/notas-fiscais?')) return { items: [row, { ...row, id: id(2), number: 78 }], origin: 'brufap', model: '55', direction: '0', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: 2, total_amount: '40.00', amount_unknown: 0,
        brufap_visible: true, show_totals: true, data_mode: 'erp_native_homologation' };
      if (path.startsWith('/v1/notas-fiscais/precos?')) return { items: [{ invoice_id: NOTE, recorded_at: '2026-10-20T13:00:00Z', products: 1, count: 2 }], data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async listPreferences(path) { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'entrada' }, { location: '/notas-entrada?origem=brufap', expandChildren: ['NativeListLayout'] });
  try {
    await settle(view);
    const marks = calls.filter(c => c.path.startsWith('/v1/notas-fiscais/precos?'));
    assert.equal(marks.length, 1); assert.equal(marks[0].path, `/v1/notas-fiscais/precos?ids=${encodeURIComponent([NOTE, id(2)].join(','))}`); assert.equal(marks[0].method, 'GET');
    const letters = view.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'IndicatorLetter');
    assert.deepEqual(letters.map(l => [l.props.text, l.props.color]), [['P', 'red']]);
    assert.match(letters[0].props.title, /^Preços atualizados em 20\/10\/2026 \(1 produto, 2 formações\)$/);
  } finally { view.unmount(); }
});
