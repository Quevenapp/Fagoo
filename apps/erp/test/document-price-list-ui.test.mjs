import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { priceListApplies, productListPrice, readPriceLists, saoPauloNow } from '../src/lib/document-price-list-model.ts';

// Cadastros › Listas de preços applied in the pedido de venda (PRD-149). Synthetic controller; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000149', customer = 'c0000000-0000-4000-8000-000000000149', other = 'c1000000-0000-4000-8000-000000000149';
const product = 'f0000000-0000-4000-8000-000000000149', second = 'f1000000-0000-4000-8000-000000000149';
const wholesale = 'e0000000-0000-4000-8000-000000000149', vip = 'e1000000-0000-4000-8000-000000000149', south = 'e2000000-0000-4000-8000-000000000149';
const header = (id, name, category, extra = {}) => ({ id, name, category, list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false,
  starts_on: null, ends_on: null, start_time: null, end_time: null, version: 1, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', rule: 'Customizada', products: 2, ...extra });

test('which lists apply to the cliente now and the list price of a product', () => {
  const now = { day: '2026-10-20', time: '10:30' };
  const contactList = { ...readPriceLists({ items: [header(vip, 'VIP', 'contact')] })[0], contacts: [customer], regions: [] };
  assert.equal(priceListApplies(contactList, { id: customer, state: 'SP' }, now), true);
  assert.equal(priceListApplies(contactList, { id: other, state: 'SP' }, now), false);
  const regionList = { ...readPriceLists({ items: [header(south, 'Sul', 'region')] })[0], contacts: [], regions: ['RS', 'SC'] };
  assert.equal(priceListApplies(regionList, { id: customer, state: 'sc' }, now), true);
  assert.equal(priceListApplies(regionList, { id: customer, state: 'SP' }, now), false);
  const period = readPriceLists({ items: [header(wholesale, 'Outubro', 'other', { list_type: 'period', starts_on: '2026-10-01', ends_on: '2026-10-19' })] })[0];
  assert.equal(priceListApplies(period, null, now), false, 'expired yesterday');
  const hours = readPriceLists({ items: [header(wholesale, 'Happy hour', 'other', { considers_datetime: true, start_time: '17:00', end_time: '19:00' })] })[0];
  assert.equal(priceListApplies(hours, null, now), false); assert.equal(priceListApplies(hours, null, { ...now, time: '18:00' }), true);
  assert.equal(productListPrice({ product_id: product, items: [{ id: wholesale, name: 'Atacado', list_type: 'custom', rule: 'Customizada', list_price: '8.50' }] }, product, wholesale), '8.50');
  assert.equal(productListPrice({ product_id: product, items: [] }, product, wholesale), null);
  assert.match(saoPauloNow(new Date('2026-10-20T02:30:00Z')).day, /^2026-10-19$/, 'the day is the day in São Paulo');
});

test('pedido de venda: Lista de preço offers only the lists of the cliente and prices the products; Aplicar a lista aos itens reprices the lines', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) {
      calls.push(path);
      if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/listas-precos') return { items: [header(wholesale, 'Atacado', 'other'), header(vip, 'VIP', 'contact')], data_mode: 'erp_native' };
      // 202610200282: the server answers the lists that apply now (VIP is of another cliente).
      if (path.startsWith('/v1/cadastros/listas-precos/aplicaveis')) return { contact_id: customer, seller_id: null, payment_method_id: null, state: 'SP', items: [header(wholesale, 'Atacado', 'other')], data_mode: 'erp_native' };
      if (path.startsWith(`/v1/cadastros/listas-precos/${vip}?`)) return { list: { ...header(vip, 'VIP', 'contact'), contacts: [{ id: other, name: 'Outro' }], regions: [] }, items: [], total: 0, offset: 0, limit: 1, data_mode: 'erp_native' };
      // 202610200196: the batch lookup of the produtos lane (listas-precos/{id}/precos?produtos=).
      if (path.startsWith(`/v1/cadastros/listas-precos/${wholesale}/precos?`)) { const ids = new URLSearchParams(path.split('?')[1]).get('produtos').split(',');
        const prices = { [product]: '8.50', [second]: '3.00' };
        return { list: { id: wholesale, name: 'Atacado', list_type: 'custom', rule: 'Customizada', valid_now: true, version: 1 }, items: ids.map(id => ({ product_id: id, in_list: Boolean(prices[id]), list_price: prices[id] ?? null })), data_mode: 'erp_native' }; }
      return { items: [], has_more: false };
    },
    async documents() { throw new AccessError(404); }, async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentPriceList'] });
  const picker = entity => view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === entity && n.props.label !== 'Transportador');
  const settle = async () => { for (let i = 0; i < 3; i += 1) { await new Promise(resolve => setTimeout(resolve, 20)); await view.flush(); } };
  try {
    picker('contacts').props.onSelect({ id: customer, name: 'Cliente sintético', state: 'SP' }); await settle();
    const options = view.input('doc-price-list').props.children[2].map(option => option.props.children.join(''));
    assert.deepEqual(options, ['Atacado · Customizada'], 'VIP belongs to another cliente');
    await view.change('doc-price-list', wholesale);
    picker('products').props.onSelect({ id: product, name: 'Produto A', code: 'A', unit: 'UN', price: '10', kind: 'P' }); await settle();
    assert.equal(view.input('doc-item-price-0').props.value, '8,5');
    assert.match(view.text(), /Preço da lista Atacado aplicado ao item 1/);
    await view.change('doc-price-list', '');
    picker('products').props.onSelect({ id: second, name: 'Produto B', code: 'B', unit: 'UN', price: '4', kind: 'P' }); await settle();
    assert.equal(view.input('doc-item-price-1').props.value, '4', 'without a list the product price stays');
    await view.change('doc-price-list', wholesale);
    await view.click('Aplicar a lista aos itens'); await settle();
    assert.deepEqual([view.input('doc-item-price-0').props.value, view.input('doc-item-price-1').props.value], ['8,5', '3']);
    assert.match(view.text(), /Lista Atacado: 2 item\(ns\) com o preço da lista/);
  } finally { view.unmount(); }
});
