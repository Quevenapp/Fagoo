import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { permittedTargets, situationPermissionNote } from '../src/lib/document-situations-model.ts';
import { documentRowActions } from '../src/lib/document-list-model.ts';
import { readHistory } from '../src/lib/document-history-model.ts';
import { readDiscountApproval } from '../src/lib/document-approval-model.ts';

// Documentos lane, wave E (migration 239): Sistema › Usuários › Serviços › Ordem de Serviço in the screens, the approval of the
// discount (configuration and situação menus) and the hidden Financeiro tab. Synthetic data only.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const APPROVAL = id(1), OTHER = id(2), actor = id(9);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const permissions = (os = {}, so = {}) => ({ service_orders: { situations: true, stock: true, finance: true, finance_history: true, payment_method: true, ...os }, sales_orders: { discount_approver: false, approval_situations: [APPROVAL], ...so } });
const row = (kind, extra = {}) => ({ id: id(50), kind, number: '7', version: 1, status: 'open', date: '2026-10-21', total: '10.00', contact_id: id(60), contact_name: 'Cliente', created_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:00:00Z',
  expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false,
  reservation_active: false, fiscal_draft: null, internal_notes: null, ...extra });

test('permitted targets: an OS without Gerenciar situações offers none; a pedido in approval moves only between approval situações', () => {
  assert.deepEqual(permittedTargets('service_orders', 'open', ['quoted', 'approved'], permissions({ situations: false })), []);
  assert.deepEqual(permittedTargets('service_orders', 'open', ['quoted'], permissions()), ['quoted']);
  assert.deepEqual(permittedTargets('sales_orders', APPROVAL, ['open', OTHER, APPROVAL], permissions()), [APPROVAL]);
  assert.deepEqual(permittedTargets('sales_orders', APPROVAL, ['open'], permissions({}, { discount_approver: true })), ['open']);
  assert.deepEqual(permittedTargets('sales_orders', 'open', ['draft'], null), ['draft'], 'before 239 nothing changes');
  assert.match(situationPermissionNote('sales_orders', APPROVAL, permissions()), /aguarda a aprovação do desconto/);
  assert.match(situationPermissionNote('service_orders', 'open', permissions({ situations: false })), /Gerenciar situações/);
  assert.equal(situationPermissionNote('sales_orders', 'open', permissions()), null);
});

test('⋮ of an OS: Lançar estoque / contas disabled without the permission, and no situação without Gerenciar situações', () => {
  const actions = documentRowActions('service_orders', row('service_orders'), { role: 'admin', writable: true, permissions: permissions({ stock: false, finance: false, situations: false }) });
  const stock = actions.find(a => a.action === 'stock'), finance = actions.find(a => a.action === 'finance');
  assert.deepEqual([stock.enabled, finance.enabled], [false, false]);
  assert.match(stock.title, /Lançar estoque/); assert.match(finance.title, /Lançar contas/);
  assert.equal(actions.some(a => a.action === 'status'), false);
  const free = documentRowActions('service_orders', row('service_orders'), { role: 'admin', writable: true, permissions: permissions() });
  assert.deepEqual([free.find(a => a.action === 'stock').enabled, free.find(a => a.action === 'finance').enabled], [true, true]);
  assert.ok(free.some(a => a.action === 'status'));
});

test('the Financeiro tab of the history comes hidden for an OS without Histórico financeiro', () => {
  const page = readHistory({ items: [], has_more: false, invoices_included: false, finance: null, finance_hidden: true }, { mode: 'client' });
  assert.deepEqual([page.finance, page.finance_hidden], [null, true]);
  assert.throws(() => readHistory({ items: [], has_more: false, invoices_included: false, finance: null }, { mode: 'client' }), 'without the flag the finance block is required');
  assert.throws(() => readDiscountApproval({ kind: 'sales_orders', version: 1, can_write: true, situations: [] }, true), 'a save answer says whether it was replayed');
});

function approvalServer({ post } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: 'admin' } } };
  let current = { kind: 'sales_orders', version: 0, can_write: true, situations: [], data_mode: 'erp_native', operational_effects: false };
  const situations = { kind: 'sales_orders', adopted: true, occurrence_date_editable: false, transitions: [], situations: [
    { key: 'draft', base_status: 'draft', name: 'Em digitação', color: '#9e9e9e', default: true, active: true },
    { key: APPROVAL, base_status: 'draft', name: 'Aguardando aprovação', color: '#123456', default: false, active: true },
    { key: OTHER, base_status: 'open', name: 'Aberta especial', color: '#654321', default: false, active: true }] };
  const controller = {
    getSnapshot: () => state.session,
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/v1/documentos/sales_orders/situacoes') return situations;
      if (options.method === 'POST') { const answer = post(options.body, calls.filter(c => c.method === 'POST').length); current = answer; return answer; }
      return current;
    },
  };
  return { controller, calls, posts: () => calls.filter(c => c.method === 'POST') };
}

test('Situação para aprovação de descontos: only custom situações of Em digitação; an uncertain save repeats the same command', async () => {
  const source = approvalServer({ post: (body, count) => { if (count === 1) throw new AccessError(503); return { kind: 'sales_orders', version: 1, can_write: true, replayed: count > 2,
    situations: body.situations.map(key => ({ id: key, name: 'Aguardando aprovação', color: '#123456', active: true })) }; } });
  const view = await mountComponent('DocumentDiscountApproval.tsx', { controller: source.controller, onClose() {} });
  try {
    await view.flush();
    assert.match(view.text(), /Aguardando aprovação/); assert.doesNotMatch(view.text(), /Aberta especial/, 'only the situações of Em digitação');
    assert.equal(view.button('Salvar').disabled, true, 'nothing to save yet');
    await view.change(`approval-${APPROVAL}`, true);
    assert.equal(view.guard().changed, true);
    await view.click('Salvar');
    assert.match(view.text(), /Conferir resultado/);
    const first = source.posts()[0].body;
    await view.click('Conferir resultado');
    const second = source.posts()[1].body;
    assert.equal(second.command_id, first.command_id, 'the same command'); assert.deepEqual(second.situations, [APPROVAL]); assert.equal(second.expected_version, 0);
    assert.match(view.text(), /Situação para aprovação de descontos: Aguardando aprovação/);
  } finally { view.unmount(); }
});

test('Situação para aprovação de descontos: a conflict rereads the configuration; a reader without the administrador profile only sees it', async () => {
  const source = approvalServer({ post: () => { throw new AccessError(409); } });
  const view = await mountComponent('DocumentDiscountApproval.tsx', { controller: source.controller, onClose() {} });
  try {
    await view.flush(); await view.change(`approval-${APPROVAL}`, true); await view.click('Salvar');
    assert.match(view.text(), /A configuração mudou/);
    assert.equal(source.calls.filter(c => c.path === '/v1/documentos/sales_orders/aprovacao-descontos' && c.method === 'GET').length, 2, 'reread after the conflict');
  } finally { view.unmount(); }
  const reader = approvalServer({ post: () => { throw new Error('no post'); } });
  const inner = reader.controller.documents;
  reader.controller.documents = async (path, options = {}) => { const value = await inner(path, options); return path.endsWith('aprovacao-descontos') ? { ...value, can_write: false } : value; };
  const readOnly = await mountComponent('DocumentDiscountApproval.tsx', { controller: reader.controller, onClose() {} });
  try { await readOnly.flush(); assert.match(readOnly.text(), /Somente o administrador altera esta configuração/); assert.equal(readOnly.input(`approval-${APPROVAL}`).disabled, true); } finally { readOnly.unmount(); }
});
