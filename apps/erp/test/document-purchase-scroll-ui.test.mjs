import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// EST-029 (documentos lane, wave F), synthetic controller, no DOM: Origin pedidos de compra list every record of the period in one
// scroll with a fixed header; reaching the end of the scroll reads the next page and appends it; a reload starts from the first page.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000029', contact = '30000000-0000-4000-8000-000000000029';
const row = n => ({ id: id(n), kind: 'purchase_orders', number: String(n), version: 1, status: 'open', date: '2026-10-01', total: '1.00', contact_id: contact, contact_name: `Fornecedor sintético ${n}`,
  created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null,
  source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: null, fiscal_draft: null, internal_notes: null });
const TOTAL = 150, settle = async view => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
function server(kind = 'purchase_orders') {
  const lists = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => {},
    async documents(path) {
      if (path === '/v1/documentos') return { read: [kind], write: [kind], data_mode: 'erp_native' };
      if (path.startsWith(`/v1/documentos/${kind}?`)) {
        const q = new URLSearchParams(path.split('?')[1]), page = Number(q.get('page')), limit = Number(q.get('limit')); if (limit > 1) lists.push(page);
        const items = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - (page - 1) * limit)) }, (_, i) => ({ ...row((page - 1) * limit + i + 1), kind }));
        return { kind, items, limit, page, order: q.get('order') ?? 'date_desc', has_more: page * limit < TOTAL, next_cursor: null, total_count: TOTAL, total_amount: '150.00', data_mode: 'erp_native', operational_effects: false };
      }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
  };
  return { controller, lists };
}
const mount = (srv, kind = 'purchase_orders') => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: kind }, { location: `/documentos-empresa?tipo=${kind}`, expandChildren: ['NativeListLayout', 'DocumentList'] });
const scroller = view => view.nodes().find(n => n.type === 'div' && String(n.props.className ?? '').includes('documents-single-scroll'));
const rowCount = view => view.nodes().filter(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('Selecionar Pedido de compra ')).length;

test('pedidos de compra: one scroll, the next page appended at the end of the scroll, no pagination; a reload goes back to the first page', async () => {
  const srv = server(), view = await mount(srv);
  try {
    await settle(view);
    assert.ok(scroller(view), 'the single scroll with the fixed header');
    assert.equal(view.nodes().some(n => n.props?.pages !== undefined && n.props?.size === 100), false, 'no visible pagination');
    assert.equal(rowCount(view), 100); assert.match(view.text(), /100 de 150 registro\(s\) · role a listagem para ver os próximos/);
    // Scrolling before the end reads nothing; at the end the second page is appended.
    scroller(view).props.onScroll({ currentTarget: { scrollTop: 100, clientHeight: 400, scrollHeight: 4000 } }); await settle(view);
    assert.deepEqual(srv.lists, [1]);
    scroller(view).props.onScroll({ currentTarget: { scrollTop: 3550, clientHeight: 400, scrollHeight: 4000 } }); await settle(view);
    assert.deepEqual(srv.lists, [1, 2]); assert.equal(rowCount(view), 150); assert.match(view.text(), /150 de 150 registro\(s\)/);
    // Everything shown: no further read.
    scroller(view).props.onScroll({ currentTarget: { scrollTop: 5600, clientHeight: 400, scrollHeight: 6000 } }); await settle(view);
    assert.deepEqual(srv.lists, [1, 2]);
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Recarregar').props.onClick(); await settle(view);
    assert.deepEqual(srv.lists, [1, 2, 1]); assert.equal(rowCount(view), 100, 'the reload starts again from the first page');
  } finally { view.unmount(); }
});

test('the other lists keep the Origin pagination', async () => {
  const srv = server('sales_orders'), view = await mount(srv, 'sales_orders');
  try {
    await settle(view);
    assert.equal(scroller(view), undefined);
    assert.ok(view.nodes().some(n => n.props?.pages === 2 && n.props?.size === 100), 'OriginPagination');
  } finally { view.unmount(); }
});
