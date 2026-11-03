import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { defaultDocumentPreferences } from '../src/lib/document-preferences.ts';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { documentListQuery, EMPTY_LIST_FILTERS } from '../src/lib/document-list-model.ts';
import { groupTotals, groupedItems, itemGroup } from '../src/lib/service-order-items.ts';
import { documentInput, explicitDocumentInput } from '../src/lib/real-documents-model.ts';

// 202610200268 (synthetic controller, no DOM): the OS editor with the Origin grids Peças and Serviços executados, the print and the
// Peça / Serviço filters of the listagem.
const actor = 'a0000000-0000-4000-8000-000000000268', docId = 'b0000000-0000-4000-8000-000000000268', contact = 'c0000000-0000-4000-8000-000000000268';
const part = 'd0000000-0000-4000-8000-000000000268', labour = 'd1000000-0000-4000-8000-000000000268';
const node = (view, name, predicate = () => true) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name && predicate(n));
const picker = (view, label) => node(view, 'CatalogPicker', n => n.props.label === label);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const prefs = (extra = {}) => ({ ...defaultDocumentPreferences('service_orders'), loaded: true, ...extra });
const partRow = { id: part, entity: 'products', version: 1, active: true, name: 'Tela sintética', code: 'TL-1', gtin: null, unit: 'UN', kind: 'P', price: '50.0000', gross_weight: null, source: null };
const labourRow = { id: labour, entity: 'products', version: 1, active: true, name: 'Troca de tela', code: 'SV-1', gtin: null, unit: '', kind: 'S', price: '80.0000', gross_weight: null, source: null };
function record(items, extra = {}) {
  const normalized = normalizeDocument('service_orders', { date: '2026-10-20', contact_id: contact, items, equipment: 'Celular sintético' });
  return { ...normalized, id: docId, kind: 'service_orders', number: '268', version: 1, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, ...extra,
    items: normalized.items.map((item, index) => ({ ...item, id: item.id, product_snapshot: extra.snapshots?.[index] ?? null })) };
}
function setup() {
  const posts = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; if (path.startsWith('/v1/cadastros/contacts/')) return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }; return { entity: 'products', items: [], has_more: false }; },
    async documents(path, options = {}) {
      if (path.endsWith('/proximo-numero')) return { kind: 'service_orders', next_number: '268', reserved: false, data_mode: 'erp_native', operational_effects: false };
      if (options.method) posts.push(structuredClone(options.body));
      const data = posts.at(-1)?.data ?? { date: '2026-10-20', contact_id: contact, items: [] };
      const { number, ...rest } = data;
      return { kind: 'service_orders', document: record(rest.items.map((item, index) => ({ ...item, id: item.id ?? `e000000${index}-0000-4000-8000-000000000268` }))), data_mode: 'erp_native', operational_effects: false };
    },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new Error('copy'); },
  };
  return { controller, posts };
}
const mount = (s, current, preferences = prefs()) => mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'service_orders', record: current, writable: true, onSaved() {}, onClose() {}, onConverted() {}, preferences },
  { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentCommercialFields', 'DocumentOptionalSection', 'ServiceOrderItems'] });

test('model: the group of an item, the saved group first; Total peças and Total serviços exact; legacy items by the type of the product', () => {
  assert.equal(itemGroup({ group: 'service' }, 'P'), 'service'); assert.equal(itemGroup({}, 'S'), 'service'); assert.equal(itemGroup({}, null), 'part');
  const items = groupedItems('service_orders', [{ description: 'a', unit: 'UN', quantity: '1', unit_price: '1', group: 'part', quote: true }, { description: 'b', unit: 'H', quantity: '1', unit_price: '1', quote: true }], () => 'S');
  assert.deepEqual(items.map(item => [item.group, item.quote, item.done]), [['part', false, false], ['service', true, false]]);
  assert.deepEqual(groupedItems('sales_orders', [{ description: 'a' }]), [{ description: 'a' }], 'other kinds are untouched');
  assert.deepEqual(groupTotals(items, { items: [{ total: '0.10' }, { total: '0.20' }] }), { part: '0.10', service: '0.20' });
  // A record saved before 268 (no group): the snapshot type decides; the save body always carries group, Orçar and OK.
  const legacy = record([{ id: 'e0000000-0000-4000-8000-000000000001', product_id: labour, description: 'Troca', code: 'SV-1', unit: 'H', quantity: '1', unit_price: '80' }], { snapshots: [{ kind: 'S' }] });
  const input = explicitDocumentInput(documentInput(legacy), 'service_orders');
  assert.deepEqual(input.items.map(item => [item.group, item.quote, item.done]), [['service', false, false]]);
  assert.equal(normalizeDocument('service_orders', input).items[0].group, 'service');
});

test('Peças e Serviços executados: two grids with their own search and free line, Orçar/OK, Total peças / Total serviços; the save sends the groups', async () => {
  const s = setup(), view = await mount(s, null, prefs({ labels: { servico_quantidade: 'Qtd. horas', servico_orcar: 'Orçar?' } }));
  try {
    assert.ok(picker(view, 'Adicionar peça do cadastro')); assert.ok(picker(view, 'Adicionar serviço do cadastro'));
    assert.equal(picker(view, 'Adicionar peça do cadastro').props.productKind, 'P'); assert.equal(picker(view, 'Adicionar serviço do cadastro').props.productKind, 'S');
    assert.equal(picker(view, 'Adicionar serviço do cadastro').props.placeholder, 'Digite parte do nome ou código do serviço');
    node(view, 'CatalogPicker', n => n.props.entity === 'contacts').props.onSelect({ id: contact, name: 'Cliente sintético' }); await view.flush();
    assert.match(picker(view, 'Adicionar peça do cadastro').props.onSelect(partRow), /incluído/); await view.flush();
    assert.match(picker(view, 'Adicionar serviço do cadastro').props.onSelect(labourRow), /incluído/); await view.flush();
    await view.click('+ Adicionar serviço');
    await view.change('doc-item-description-2', 'Limpeza interna');
    await view.change('doc-item-qty-1', '1,5');
    const shown = view.text();
    assert.match(shown, /Peças/); assert.match(shown, /Serviços executados/); assert.match(shown, /Qtd\. horas/); assert.match(shown, /Orçar\?/);
    assert.match(shown, /Total peçasR\$ 50,00/); assert.match(shown, /Total serviçosR\$ 120,00/);
    const quote = view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Orçar? o serviço 1'); quote.props.onChange({ target: { checked: true } }); await view.flush();
    const ok = view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Serviço 2 OK'); ok.props.onChange({ target: { checked: true } }); await view.flush();
    await view.submit();
    assert.equal(s.posts.length, 1, JSON.stringify(view.text()).slice(0, 400));
    const items = s.posts[0].data.items;
    assert.deepEqual(items.map(item => [item.description, item.group, item.quote, item.done, item.unit]), [['Tela sintética', 'part', false, false, 'UN'], ['Troca de tela', 'service', true, false, 'UN'], ['Limpeza interna', 'service', false, true, 'UN']]);
    assert.doesNotThrow(() => normalizeDocument('service_orders', s.posts[0].data));
  } finally { view.unmount(); }
});

test('a saved OS: legacy items go to the grid of their product type; moving and removing stay inside the grid', async () => {
  const saved = record([
    { id: 'e0000000-0000-4000-8000-000000000001', product_id: part, description: 'Tela', code: 'TL-1', unit: 'UN', quantity: '1', unit_price: '50' },
    { id: 'e0000000-0000-4000-8000-000000000002', product_id: labour, description: 'Troca', code: 'SV-1', unit: 'H', quantity: '1', unit_price: '80' },
    { id: 'e0000000-0000-4000-8000-000000000003', product_id: null, description: 'Bateria', code: null, unit: 'UN', quantity: '1', unit_price: '30' }], { snapshots: [{ kind: 'P' }, { kind: 'S' }, null] });
  const s = setup(), view = await mount(s, saved);
  try {
    assert.equal(view.guard().changed, false, 'deriving the groups is not an unsaved change');
    const peças = view.nodes().find(n => n.type === 'section' && n.props['aria-label'] === 'Peças'), serviços = view.nodes().find(n => n.type === 'section' && n.props['aria-label'] === 'Serviços executados');
    assert.match(text(peças), /Peças/); assert.ok(serviços);
    assert.ok(view.nodes().some(n => n.props?.['aria-label'] === 'Descrição da peça 2'), 'Bateria is the second peça');
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Mover peça 2 para cima').props.onClick(); await view.flush();
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Remover serviço 1').props.onClick(); await view.flush();
    await view.submit();
    assert.deepEqual(s.posts[0].data.items.map(item => [item.description, item.group]), [['Bateria', 'part'], ['Tela', 'part']]);
  } finally { view.unmount(); }
});

test('print: Peças and Serviços apart with the labels and the group totals; listagem: Peça is product_id, Serviço is service_id', async () => {
  const saved = record([
    { id: 'e0000000-0000-4000-8000-000000000001', product_id: part, description: 'Tela', code: 'TL-1', unit: 'UN', quantity: '1', unit_price: '50', group: 'part', quote: false, done: false },
    { id: 'e0000000-0000-4000-8000-000000000002', product_id: labour, description: 'Troca', code: 'SV-1', unit: 'H', quantity: '2', unit_price: '40', group: 'service', quote: true, done: false }]);
  const model = documentPrintModel(saved, null, { labels: { servico_quantidade: 'Horas trabalhadas', servico_valor: 'Valor hora' } });
  assert.equal(model.serviceGroups, true);
  assert.deepEqual(model.items.map(item => item.group), ['part', 'service']);
  assert.deepEqual(model.totals.slice(0, 2), [{ label: 'Total peças', value: 'R$ 50,00' }, { label: 'Total serviços', value: 'R$ 80,00' }]);
  const view = await mountComponent('DocumentPrintPreview.tsx', { model }, { componentName: 'DocumentPrintSheet' });
  try {
    const shown = view.text();
    assert.match(shown, /PeçasItemDescrição \/ código|PeçasItemDescrição/); assert.match(shown, /ServiçosItemDescrição/); assert.match(shown, /Horas trabalhadas/); assert.match(shown, /Valor hora/);
    assert.match(shown, /Observações do Serviço|Total serviços/);
  } finally { view.unmount(); }
  const params = documentListQuery('service_orders', { ...EMPTY_LIST_FILTERS, product: { id: part, name: 'Tela' }, service: { id: labour, name: 'Troca' } });
  assert.deepEqual([params.get('product_id'), params.get('service_id')], [part, labour]);
  assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, service: { id: labour, name: 'Troca' } }), /serviço do filtro/);
});
