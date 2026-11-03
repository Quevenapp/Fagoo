import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

// Origin waiting texts while a reviewed stock or finance posting is being confirmed (synthetic data, no network).
const id = '10000000-0000-4000-8000-000000000001', warehouse = '20000000-0000-4000-8000-000000000001';
const original = { id, kind: 'service_orders', number: '1', version: 3, status: 'approved', date: '2026-10-16', warehouse_id: warehouse, totals: { total: '3.02' }, installments: [{ amount: '3.02', due_date: '2026-11-01' }] };
for (const kind of ['finance', 'stock']) test(`${kind}: “${kind === 'finance' ? 'Lançando contas, aguarde...' : 'Lançando estoque...'}” while the confirmation is pending`, async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const page = { document: { ...original, eligible: true, active_posting_id: null }, document_id: id, document_version: 3, active_posting: null, items: [], postings: [], has_more: false, next_cursor: null };
  const preview = { document: page.document, document_id: id, document_version: 3, kind: 'service_orders', number: '1', contact_name: 'Contato sintético', direction: 'receivable', total_cents: '302', category_name: null, plan_source: 'document', preview_hash: 'a'.repeat(64), installments: [{ position: 1, amount_cents: '302', due_on: '2026-11-01', method: null }], action: 'post', occurred_on: '2026-10-16', reason: 'Saída sintética', warehouse: { id: warehouse, name: 'Depósito sintético' }, positions: [], ignored: [] };
  const controller = { getSnapshot: () => ({ membership: { role: 'admin' } }), finance: async () => ({ items: [], has_more: false, next_cursor: null }), async documents() { return { document: original }; } };
  controller[kind === 'finance' ? 'documentFinance' : 'documentStock'] = async path => { if (path.endsWith('/preview')) return { preview }; if (path.endsWith('/post')) { await pending; throw new Error('synthetic stop'); } return page; };
  const view = await mountComponent(kind === 'finance' ? 'DocumentFinance.tsx' : 'DocumentStock.tsx', { controller, record: original, writable: true, blocked: false, onChanged() {}, onActive() {}, onBusy() {}, onDraft() {} });
  try {
    if (kind === 'stock') await view.change(view.find(n => n.type === 'input' && n.props.maxLength === 500).props.id, 'Saída sintética');
    await view.click(kind === 'finance' ? 'Conferir lançamento financeiro' : 'Conferir lançamento de estoque');
    view.find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await view.flush();
    assert.doesNotMatch(view.text(), /Lançando/);
    await view.click(kind === 'finance' ? 'Lançar contas confirmadas' : 'Lançar estoque confirmado');
    assert.match(view.text(), kind === 'finance' ? /Lançando contas, aguarde\.\.\./ : /Lançando estoque\.\.\./);
    release(); await view.flush();
  } finally { release(); view.unmount(); }
});
