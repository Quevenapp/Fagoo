import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { importDraft, readXmlImport } from '../src/lib/document-xml-import-model.ts';

// 202610200167 "Importar › Pedido XML": the answer of the API becomes a new pedido to review. No DOM, no network.
const actor = '20000000-0000-4000-8000-000000000167', contact = '30000000-0000-4000-8000-000000000167', product = '40000000-0000-4000-8000-000000000167';
const answer = (extra = {}) => ({ key: '35261011222333000181550010000003211123456780', number: '321', series: '1', issue_date: '2026-10-18', xml_total: '27.38', contact: null,
  party: { name: 'Cliente do XML', person_type: 'J', document: '12345678000195', ie: '110042490114', email: null, phone: null, postal_code: '13400000', street: 'Rua Sintética', number: '100', complement: null, district: 'Centro', city: 'Piracicaba', state: 'SP' },
  items: [{ code: 'X-9', gtin: '7891234567895', description: 'Produto com GTIN', unit: 'UN', quantity: '2.0000', unit_price: '10.0000', ncm: '73181500', product: { id: product, name: 'Produto com GTIN', code: 'PG-1', unit: 'PC', by: 'gtin' } },
    { code: 'LIVRE', gtin: null, description: 'Item livre', unit: 'UN', quantity: '1.0000', unit_price: '5.0000', ncm: null, product: null }],
  freight: '3.00', discount: '0.00', other_expenses: '0.00', freight_mode: '0', installments: [{ due_date: '2026-11-18', amount: '28.00' }], notes: 'Pedido do cliente OC-9.', data_mode: 'erp_native', operational_effects: false, ...extra });

test('the draft links matched products, keeps the others free and explains what the pedido does not take', () => {
  const draft = importDraft('sales_orders', readXmlImport(answer()), '2026-10-20');
  assert.deepEqual(draft.data.items.map(item => [item.product_id, item.code, item.unit, item.quantity]), [[product, 'PG-1', 'PC', '2.0000'], [null, 'LIVRE', 'UN', '1.0000']]);
  assert.deepEqual([draft.data.date, draft.data.freight, draft.data.contact_id, draft.data.commercial.transport.freight_mode], ['2026-10-18', '3.00', '', '0']);
  assert.deepEqual(draft.data.installments.map(row => row.amount), ['28.00'], 'the duplicata equals the total of the pedido (25.00 + 3.00)');
  assert.match(draft.notices.join(' '), /1 item sem produto cadastrado ficou como item livre/);
  assert.match(draft.notices.join(' '), /O total da NF-e \(R\$ 27,38\) é diferente do total do pedido \(R\$ 28,00\)/);
  assert.match(draft.notices.join(' '), /Cliente do XML não cadastrado: Cliente do XML \(12345678000195\)/);
  assert.deepEqual([draft.quick.document, draft.quick.city, draft.quick.roles], ['12345678000195', 'Piracicaba', ['customer']]);
  const known = importDraft('purchase_orders', readXmlImport(answer({ contact: { id: contact, name: 'Fornecedor' }, installments: [{ due_date: '2026-11-18', amount: '1.00' }] })), '2026-10-20');
  assert.equal(known.quick, null); assert.equal(known.data.contact_id, contact); assert.deepEqual(known.data.installments, []);
  assert.match(known.notices.join(' '), /As duplicatas do XML não somam o total do pedido/);
});

test('Importar › Pedido XML: upload, Processar and the pedido opens to review; a refused XML explains why', async () => {
  const calls = [], imported = [];
  let reply = () => answer();
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }),
    async documents(path, options = {}) { calls.push({ path, method: options.method, body: options.body }); return reply(); } };
  const view = await mountComponent('DocumentXmlImport.tsx', { controller, kind: 'sales_orders', today: '2026-10-20', onClose() {}, onImported: draft => imported.push(draft) },
    { expandChildren: ['Modal'], modules: { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' } });
  try {
    assert.equal(view.button('Processar').disabled, true);
    view.input('document-xml-file').props.onChange({ target: { files: [new File(['<nfeProc/>'], 'nota.xml', { type: 'text/xml' })] } }); await view.flush();
    await view.click('Processar');
    assert.deepEqual([calls[0].path, calls[0].method, calls[0].body.xml], ['/v1/documentos/sales_orders/importar-xml', 'POST', '<nfeProc/>']);
    assert.equal(imported.length, 1); assert.equal(imported[0].data.items.length, 2);
    reply = () => { throw new AccessError(422); };
    await view.click('Processar');
    assert.match(view.text(), /Use o XML autorizado de uma NF-e modelo 55 emitida em produção/);
    assert.equal(imported.length, 1);
  } finally { view.unmount(); }
});

test('the editor opens the imported pedido unsaved, with the notices and "Cadastrar cliente do XML"', async () => {
  const draft = importDraft('sales_orders', readXmlImport(answer()), '2026-10-20');
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: ['contacts'], data_mode: 'erp_native' }; if (path === '/v1/cadastros/tipos-contato') return { items: [], can_create: false, can_delete: false }; return { items: [], has_more: false }; },
    async documents() { throw new AccessError(404); }, async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); } };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {}, importDraft: draft },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentQuickContact', 'ContactQuickDrawer'] });
  try {
    assert.match(view.text(), /Pedido montado a partir da NF-e nº 321 série 1/);
    assert.equal(view.input('doc-item-description-1').props.value, 'Item livre');
    assert.equal(view.guard().changed, true, 'an unsaved import is guarded like a draft');
    await view.click('Cadastrar cliente do XML');
    assert.equal(view.input('quick-contact-document').props.value, '12345678000195');
    assert.equal(view.input('quick-contact-city').props.value, 'Piracicaba');
  } finally { view.unmount(); }
});

test('acao=xml opens the upload once over the list and the list does not reopen it after the editor closes', async () => {
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }), subscribe: () => () => {},
    async documents(path) {
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native' };
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'sales_orders', items: [], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; }, async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const modal = { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders&acao=xml', expandChildren: ['NativeListLayout', 'DocumentList', 'DocumentXmlImport', 'Modal'], modules: modal });
  const uploads = () => view.nodes().filter(node => node.type === 'section' && node.props['aria-label'] === 'Importar pedido (XML da NF-e)').length;
  try {
    await view.flush();
    assert.equal(uploads(), 1, 'acao=xml opens Importar pedido');
    assert.equal(new URLSearchParams(view.location().search).has('acao'), false, 'the action leaves the address');
    await view.click('Cancelar'); assert.equal(uploads(), 0);
    await view.click('Incluir pedido'); await view.flush();
    const editor = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'Editor');
    assert.ok(editor, 'Incluir pedido opens the editor'); assert.equal(uploads(), 0);
    editor.props.onClose(); await view.flush();
    assert.equal(uploads(), 0, 'the list mounted again does not reopen the upload');
    await view.click('Pedido XML'); assert.equal(uploads(), 1, 'Mais ações › Importar › Pedido XML opens it');
  } finally { view.unmount(); }
});

test('the notas lists open "Importar Pedido XML" in the pedido of venda (saída) or compra (entrada) for the profiles that include them', async () => {
  const controller = role => ({ getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {},
    async fiscalInvoices() { throw new AccessError(404); }, async listPreferences() { throw new AccessError(404); } });
  const pressed = async (screen, role, location) => {
    const view = await mountComponent('RealFiscalInvoices.tsx', { controller: controller(role), screen }, { location, expandChildren: ['NativeListLayout'] });
    try { const node = view.button('Importar Pedido XML'); if (node.disabled) return { disabled: true, title: node.props.title };
      node.props.onClick(); await view.flush(); return { disabled: false, to: `${view.location().pathname}${view.location().search}` };
    } finally { view.unmount(); }
  };
  assert.deepEqual(await pressed('nfe', 'vendas', '/historico-fiscal?modelo=55'), { disabled: false, to: '/documentos-empresa?tipo=sales_orders&acao=xml' });
  assert.deepEqual(await pressed('entrada', 'estoque', '/notas-entrada'), { disabled: false, to: '/documentos-empresa?tipo=purchase_orders&acao=xml' });
  assert.deepEqual(await pressed('nfe', 'fiscal', '/historico-fiscal?modelo=55'), { disabled: true, title: 'Somente administrador e vendas incluem pedidos de venda.' });
  assert.deepEqual(await pressed('entrada', 'vendas', '/notas-entrada'), { disabled: true, title: 'Somente administrador e estoque incluem pedidos de compra.' });
});
