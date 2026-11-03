import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Wave F (documentos lane): the Descrição of each free line searches the cadastro ("Pesquise por código, descrição ou GTIN") and the
// product chosen replaces that line. The real Editor of RealDocuments.tsx with a synthetic controller (no DOM, no network).
const actor = 'a0000000-0000-4000-8000-000000000301', docId = 'b0000000-0000-4000-8000-000000000301', contact = 'c0000000-0000-4000-8000-000000000301';
const product = 'd0000000-0000-4000-8000-000000000301', other = 'd0000000-0000-4000-8000-000000000302';
const productRow = (extra = {}) => ({ id: product, entity: 'products', version: 1, active: true, name: 'Parafuso sintético', code: 'PAR-1', gtin: null, unit: 'CX', kind: 'P', price: '12.5000', source: null, ...extra });
const body = () => ({ date: '2026-10-16', contact_id: contact, items: [
  { id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item livre', code: null, unit: 'UN', quantity: '3', unit_price: '1', detailed_description: null },
  { id: 'e0000000-0000-4000-8000-000000000002', product_id: other, description: 'Produto do cadastro', code: 'PC-2', unit: 'UN', quantity: '1', unit_price: '4', detailed_description: null }] });
function record() {
  const normalized = normalizeDocument('sales_orders', body());
  return { ...normalized, id: docId, kind: 'sales_orders', number: '301', version: 1, status: 'draft', created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false },
    items: normalized.items.map((item, index) => ({ ...item, id: body().items[index].id, product_snapshot: item.product_id ? { id: item.product_id, name: item.description } : null, total: '0.00' })) };
}
function setup() {
  const searches = []; let snapshot = { phase: 'ready', membership: { role: 'vendas', user_id: actor } }, hold = null;
  const controller = {
    getSnapshot: () => snapshot,
    async catalog(path) {
      if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/contacts/')) return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } };
      return { entity: 'products', items: [], has_more: false };
    },
    async documents(path) {
      // 202610200288 (onda G): the free line searches the products that are sold (GET /v1/documentos/{tipo}/produtos), no longer the cadastro.
      if (path.startsWith('/v1/documentos/sales_orders/produtos?')) {
        searches.push(path);
        const answer = { kind: 'sales_orders', entity: 'products', items: [productRow(), productRow({ id: 'd0000000-0000-4000-8000-000000000303', name: 'Parafuso longo', code: 'PAR-2' })], has_more: false, limit: 8, data_mode: 'erp_native', operational_effects: false };
        if (hold) return new Promise(resolve => { hold.release = () => resolve(answer); });
        return answer;
      }
      return { kind: 'sales_orders', document: record(), data_mode: 'erp_native', operational_effects: false };
    },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { controller, searches, become: value => { snapshot = value; }, holdNext: () => { hold = {}; return hold; } };
}
const wait = async (view, ms = 300) => { await new Promise(resolve => setTimeout(resolve, ms)); await view.flush(); await view.flush(); };
async function mount(s) {
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_orders', record: record(), writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentLineSuggestions'] });
  const reservations = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'SalesOrderReservations');
  if (reservations) { reservations.props.onActive(false); await view.flush(); }
  return view;
}
const keys = (input, key) => input.props.onKeyDown({ key, preventDefault() {} });

test('a free line searches after typing and the chosen product replaces it, keeping the quantity', async () => {
  const s = setup(), view = await mount(s);
  try {
    const free = view.input('doc-item-description-0');
    assert.equal(free.props.placeholder, 'Pesquise por código, descrição ou GTIN');
    assert.equal(view.input('doc-item-description-1').props.placeholder, undefined, 'a line of the cadastro does not search');
    free.props.onFocus(); await view.flush(); await wait(view);
    assert.equal(s.searches.length, 0, 'focusing a filled line does not search');
    await view.change('doc-item-description-0', 'Para'); await wait(view);
    assert.deepEqual(s.searches.map(path => Object.fromEntries(new URLSearchParams(path.split('?')[1]))), [{ q: 'Para', limit: '8' }]);
    assert.ok(view.nodes().some(n => n.type === 'li' && n.props.role === 'option' && /Parafuso sintético/.test(JSON.stringify(n.props.children))));
    keys(view.input('doc-item-description-0'), 'ArrowDown'); await view.flush();
    keys(view.input('doc-item-description-0'), 'Enter'); await view.flush();
    const line = view.input('doc-item-description-0');
    assert.equal(line.props.value, 'Parafuso sintético');
    assert.equal(view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Código do item 1').props.value, 'PAR-1');
    assert.equal(view.input('doc-item-unit-0').props.value, 'CX');
    assert.equal(view.input('doc-item-qty-0').props.value, '3', 'the quantity typed in the free line stays');
    assert.equal(view.input('doc-item-price-0').props.value, '12,5');
    assert.equal(view.input('doc-item-description-1').props.value, 'Produto do cadastro', 'the other lines do not change');
    assert.equal(view.nodes().some(n => n.type === 'li' && n.props.role === 'option'), false, 'the list closes');
    assert.equal(line.props.placeholder, undefined, 'the line is now of the cadastro');
  } finally { view.unmount(); }
});

test('Esc closes the list, a mouse choice works, and a late answer for another user is dropped', async () => {
  const s = setup(), view = await mount(s);
  try {
    view.input('doc-item-description-0').props.onFocus(); await view.change('doc-item-description-0', 'Para'); await wait(view);
    keys(view.input('doc-item-description-0'), 'Escape'); await view.flush();
    assert.equal(view.nodes().some(n => n.type === 'li' && n.props.role === 'option'), false);
    await view.change('doc-item-description-0', 'Paraf'); await wait(view);
    view.nodes().find(n => n.type === 'li' && n.props.role === 'option' && /Parafuso longo/.test(JSON.stringify(n.props.children))).props.onMouseDown({ preventDefault() {} }); await view.flush();
    assert.equal(view.input('doc-item-description-0').props.value, 'Parafuso longo');
  } finally { view.unmount(); }
  const late = setup(), other = await mount(late);
  try {
    const hold = late.holdNext();
    other.input('doc-item-description-0').props.onFocus(); await other.change('doc-item-description-0', 'Para'); await wait(other);
    late.become({ phase: 'ready', membership: { role: 'vendas', user_id: 'a0000000-0000-4000-8000-000000000999' } });
    hold.release(); await wait(other, 20);
    assert.equal(other.nodes().some(n => n.type === 'li' && n.props.role === 'option'), false);
    assert.equal(other.input('doc-item-description-0').props.value, 'Para', 'the typed text stays a free item');
  } finally { other.unmount(); }
});
