import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Origin lupa "Pesquisar" (busca avançada) of the Cliente field (VND-098). Synthetic controller; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000098', contact = 'c0000000-0000-4000-8000-000000000098';
const MODAL = { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' };
function controllerWith(calls) {
  return {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) {
      calls.push(path);
      if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/tipos-contato') return { items: [{ id: 't1', slug: 'cliente', label: 'Cliente', system: true, deletable: false, position: 1, contacts: 3 }], can_create: false, can_delete: false };
      if (path.startsWith('/v1/cadastros/contatos?')) return { entity: 'contacts', items: [{ id: contact, name: 'Cliente da busca', trade_name: 'Fantasia', code: '7', document: '12345678000195', city: 'Piracicaba', state: 'SP', situation: 'A' }], page: 1, size: 10, total: 1, sort: 'name_asc', situation: 'A', scoped: false };
      return { items: [], has_more: false };
    },
    async documents() { throw new AccessError(404); }, async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
}

test('the busca avançada filters by name, city, UF, tipo and pessoa, only active or sem movimento, and returns the chosen cadastro', async () => {
  const calls = [], chosen = [];
  const view = await mountComponent('DocumentContactSearch.tsx', { controller: controllerWith(calls), label: 'Cliente', initialQuery: 'cli', onClose() {}, onSelect: row => chosen.push(row) }, { modules: MODAL });
  try {
    await view.flush();
    assert.ok(calls.some(path => path.startsWith('/v1/cadastros/contatos?') && new URLSearchParams(path.split('?')[1]).get('q') === 'cli'));
    await view.change('contact-search-city', 'Piracicaba'); await view.change('contact-search-state', 'SP'); await view.change('contact-search-type', 'cliente'); await view.change('contact-search-situation', 'S');
    view.nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} }); await view.flush();
    const params = new URLSearchParams(calls.filter(path => path.startsWith('/v1/cadastros/contatos?')).at(-1).split('?')[1]);
    assert.deepEqual(['q', 'city', 'state', 'type', 'situation', 'page', 'size'].map(key => params.get(key)), ['cli', 'Piracicaba', 'SP', 'cliente', 'S', '1', '10']);
    assert.match(view.text(), /Cliente da busca · 7/); assert.match(view.text(), /Piracicaba \/ SP/);
    await view.click('Selecionar');
    // 202610200238 (wave E): the whole row goes to the caller (the PDV client panel shows Tipo, CNPJ/CPF, Código and Fantasia).
    assert.deepEqual(chosen, [{ id: contact, name: 'Cliente da busca', trade_name: 'Fantasia', code: '7', document: '12345678000195', person_type: null, city: 'Piracicaba', state: 'SP', situation: 'A' }]);
  } finally { view.unmount(); }
});

test('the pedido opens the busca avançada and the chosen cadastro becomes the cliente', async () => {
  const calls = [];
  const view = await mountComponent('RealDocuments.tsx', { controller: controllerWith(calls), kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentContactSearch', 'Modal'], modules: MODAL });
  try {
    await view.click('Busca avançada'); await view.flush();
    assert.ok(view.nodes().some(n => n.type === 'section' && n.props['aria-label'] === 'Pesquisar cliente'));
    await view.click('Selecionar');
    const picker = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === 'contacts' && n.props.label !== 'Transportador');
    assert.deepEqual(picker.props.selected, { id: contact, name: 'Cliente da busca' });
    assert.equal(view.nodes().some(n => n.type === 'section' && n.props['aria-label'] === 'Pesquisar cliente'), false, 'the search closes');
  } finally { view.unmount(); }
});

test('lápis "Editar Contato": the contact form opens over the document and the next save takes the new data of the contact', async () => {
  const { normalizeDocument } = await import('../../../packages/erp-domain/src/index.mjs');
  const calls = [], document = { ...normalizeDocument('sales_proposals', { date: '2026-10-20', contact_id: contact, items: [{ description: 'Item', unit: 'UN', quantity: '1', unit_price: '1' }] }),
    id: 'd0000000-0000-4000-8000-000000000100', kind: 'sales_proposals', number: '7', version: 2, status: 'draft', contact_snapshot: { id: contact, name: 'Nome antigo' },
    effect_flags: { finance_active: false, stock_active: false }, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null };
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { role: 'admin', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: ['contacts'] }; return { items: [], has_more: false }; },
    async documents(path, options = {}) { calls.push({ path, method: options.method, body: options.body }); if (options.method) return { kind: 'sales_proposals', document: { ...document, version: 3 }, data_mode: 'erp_native', operational_effects: false }; throw new AccessError(404); },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); } };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'sales_proposals', record: document, writable: true, onSaved() {}, onClose() {}, onConverted() {} }, { componentName: 'Editor', location: '/documentos-empresa' });
  try {
    const link = view.nodes().find(n => n.type === 'a' && n.props.title === 'Editar Contato');
    link.props.onClick({ preventDefault() {} }); await view.flush();
    const form = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'ContactEditor');
    assert.equal(form.props.record.id, contact);
    form.props.onSaved({ id: contact, name: 'Nome novo', state: 'SP' }); await view.flush();
    const picker = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === 'contacts' && n.props.label !== 'Transportador');
    assert.match(picker.props.status, /Salve o documento para levar os dados novos do contato/);
    assert.deepEqual(picker.props.selected, { id: contact, name: 'Nome novo' });
    assert.equal(view.guard().changed, true, 'the document asks to be saved');
    await view.submit();
    const patch = calls.find(call => call.method === 'PATCH');
    assert.equal(patch.body.data.refresh_contact, true);
  } finally { view.unmount(); }
});

test('pedido de compra: missing required fields open the modal "Atenção" over the highlighted fields', async () => {
  const calls = [];
  const view = await mountComponent('RealDocuments.tsx', { controller: controllerWith(calls), kind: 'purchase_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['Modal'], modules: MODAL });
  try {
    await view.submit();
    assert.ok(view.nodes().some(n => n.type === 'section' && n.props['aria-label'] === 'Atenção'));
    assert.match(view.text(), /Não foi possível salvar o pedido de compra\. Verifique os campos destacados\./);
    await view.click('OK');
    assert.equal(view.nodes().some(n => n.type === 'section' && n.props['aria-label'] === 'Atenção'), false);
    assert.equal(calls.some(path => typeof path === 'string' && path.startsWith('/v1/documentos/purchase_orders') ), false, 'nothing is sent');
  } finally { view.unmount(); }
});
