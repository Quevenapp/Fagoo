import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { createDocumentFinanceLinkFixture } from '../src/qa/document-finance-link-fixture.ts';

// 202610200129: pedido de compra in the Origin layout (synthetic controller, no DOM) and the Origin refused-estorno message.
const actor = 'a0000000-0000-4000-8000-000000000135', contact = 'c0000000-0000-4000-8000-000000000135', docId = 'b0000000-0000-4000-8000-000000000135';
const node = (view, name) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name);
const body = extra => ({ date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item', code: null, unit: 'UN', quantity: '1', unit_price: '10', detailed_description: null }], ...extra });
function record(extra = {}) { const normalized = normalizeDocument('purchase_orders', body(extra)); return { ...normalized, id: docId, kind: 'purchase_orders', number: '45', version: 1, status: 'open', created_at: '2026-10-20T13:14:15Z', updated_at: '2026-10-20T13:14:15Z', source_proposal_id: null, contact_snapshot: { id: contact, version: 1, name: 'Fornecedor' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map(item => ({ ...item, product_snapshot: null })) }; }
const controller = { getSnapshot: () => ({ phase: 'ready', membership: { role: 'estoque', user_id: actor } }), async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [] }; return { entity: 'contacts', record: { id: contact, name: 'Fornecedor', active: true } }; }, async documents() { throw new AccessError(404); }, async documentCopy() { throw new AccessError(404); } };
async function mount(current) {
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'purchase_orders', record: current, writable: true, onSaved() {}, onClose() {}, onConverted() {} }, { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentCommercialFields'] });
  for (const name of ['PurchaseReceipts', 'DocumentStock']) { const child = node(view, name); if (child) { child.props.onActive?.(false); await view.flush(); } }
  return view;
}

test('pedido de compra: no line discount nor Outras despesas, Total dos produtos, Cadastrado em, trash and Alt+Z, whole volumes', async () => {
  const view = await mount(record());
  try {
    assert.equal(view.nodes().some(n => n.type === 'th' && n.props.children === 'Desc (%)'), false);
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-other_expenses'), false);
    assert.match(view.text(), /Total dos produtos/); assert.doesNotMatch(view.text(), /Desconto total dos itens/);
    assert.match(view.text(), /Cadastrado em: 20\/10\/2026 10:14:15/);
    assert.equal(view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Remover item 1').props.title, 'Remover item do pedido');
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-introduction'), false, 'no sales fields in the pedido de compra');
    view.find(n => n.type === 'form').props.onKeyDown({ altKey: true, key: 'z', preventDefault() {} }); await view.flush();
    assert.ok(view.nodes().some(n => n.props?.id === 'doc-item-description-1'), 'Alt+Z adds another item');
    await view.change('doc-volume_count', '3,5 cx');
    assert.equal(view.input('doc-volume_count').props.value, '35', 'volumes are whole numbers');
  } finally { view.unmount(); }
  const old = await mount(record({ other_expenses: '2', items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item', code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '5', detailed_description: null }], commercial: { introduction: 'Antiga', attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null, transport: null } }));
  try {
    assert.ok(old.nodes().some(n => n.type === 'th' && n.props.children === 'Desc (%)'), 'an older pedido with discount keeps the column');
    assert.ok(old.nodes().some(n => n.props?.id === 'doc-other_expenses')); assert.ok(old.nodes().some(n => n.props?.id === 'doc-introduction'));
  } finally { old.unmount(); }
});

test('a refused estorno shows the Origin “Não foi possível estornar contas. Motivo: …”', async () => {
  const f = createDocumentFinanceLinkFixture(), read = f.controller.documentFinance;
  f.detail.titles[0].settled_cents = '0'; f.detail.titles[0].balance_cents = '12550';
  f.controller.documentFinance = async (path, options = {}) => { if (path.endsWith('/reverse-preview')) return { preview: { ...structuredClone(f.detail), preview_hash: 'a'.repeat(64) } }; if (path.endsWith('/reverse')) throw new AccessError(409); return read(path, options); };
  const view = await mountComponent('DocumentFinance.tsx', { controller: f.controller, record: f.record, writable: true, blocked: false, onChanged() {}, onActive() {}, onBusy() {}, onDraft() {}, onOpenTitle() {} });
  try {
    await view.click('Conferir estorno integral');
    view.nodes().find(n => n.type === 'input' && n.props.maxLength === 1000).props.onChange({ target: { value: 'Conferência sintética' } });
    view.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await view.flush();
    view.nodes().find(n => n.type === 'button' && String(n.props.children).includes('Confirmar estorno')).props.onClick(); await view.flush();
    assert.match(view.text(), /Não foi possível estornar contas\. Motivo: /);
  } finally { view.unmount(); }
});
