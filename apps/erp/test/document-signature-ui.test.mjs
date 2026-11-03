import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// 202610200199 Proposta › Assinatura: Saudação e Departamento "Definido por usuário", saved by its own command and printed at the
// end of the proposta. Synthetic controller; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000199';
function controller({ fail = null } = {}) {
  const posts = [];let signature = { greeting: null, department: null, version: 0, name: 'Vendedor sintético', data_mode: 'erp_native', operational_effects: false };
  return { posts, api: { getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }), async documents(path, options = {}) {
    assert.equal(path, '/v1/documentos/sales_proposals/assinatura');
    if (options.method === 'POST') { posts.push(structuredClone(options.body)); const failure = fail?.(posts.length); if (failure) throw failure;
      signature = { ...signature, greeting: options.body.greeting, department: options.body.department, version: signature.version + 1, replayed: posts.length > 1 }; return signature; }
    return signature;
  } } };
}
const settle = async view => { for (let i = 0; i < 3; i += 1) { await new Promise(resolve => setTimeout(resolve, 10)); await view.flush(); } };

test('the user saves the Saudação and the Departamento with one command; a lost answer keeps it for Conferir resultado', async () => {
  const c = controller({ fail: n => n === 1 ? new AccessError(503) : null });
  let loaded = null;
  const view = await mountComponent('DocumentSignature.tsx', { controller: c.api, writable: true, onLoaded: value => { loaded = value; } });
  try {
    await settle(view);
    assert.match(view.text(), /AssinaturaSaudaçãoDefinido por usuárioDepartamentoDefinido por usuário/);
    assert.equal(view.button('Salvar assinatura').disabled, true, 'nothing changed');
    await view.change('doc-signature-greeting', 'Atenciosamente,'); await view.change('doc-signature-department', 'Comercial');
    await view.click('Salvar assinatura'); await settle(view);
    assert.match(view.text(), /Conferir resultado/);
    await view.click('Conferir resultado'); await settle(view);
    assert.equal(c.posts.length, 2); assert.deepEqual(c.posts[0], c.posts[1]);
    assert.deepEqual([c.posts[0].expected_version, c.posts[0].greeting, c.posts[0].department], [0, 'Atenciosamente,', 'Comercial']);
    assert.deepEqual([loaded.greeting, loaded.department, loaded.version], ['Atenciosamente,', 'Comercial', 1]);
    assert.match(view.text(), /Assinatura salva\./);
  } finally { view.unmount(); }
});

test('the print of the proposta ends with the signature of the user', () => {
  const record = { ...normalizeDocument('sales_proposals', { date: '2026-10-20', contact_id: 'c0000000-0000-4000-8000-000000000199', items: [{ description: 'Item', unit: 'UN', quantity: '1', unit_price: '10' }] }),
    id: 'b0000000-0000-4000-8000-000000000199', kind: 'sales_proposals', number: '9', version: 1, status: 'open', contact_snapshot: { id: 'c0000000-0000-4000-8000-000000000199', name: 'Cliente' }, source_proposal_id: null,
    effect_flags: { finance_active: false, stock_active: false }, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
  record.items = record.items.map(item => ({ ...item, id: 'd0000000-0000-4000-8000-000000000199', product_snapshot: null }));
  const model = documentPrintModel(record, null, { userSignature: { greeting: 'Atenciosamente,', department: 'Comercial', name: 'Vendedor sintético' } });
  assert.deepEqual(model.userSignature, { greeting: 'Atenciosamente,', name: 'Vendedor sintético', department: 'Comercial' });
  assert.equal(documentPrintModel(record, null, { userSignature: { greeting: null, department: null, name: 'X' } }).userSignature, null, 'without Saudação nor Departamento nothing is printed');
  assert.equal(documentPrintModel({ ...record, kind: 'sales_orders', status: 'open' }, null, { userSignature: { greeting: 'A', department: null, name: 'X' } }).userSignature, null, 'only the proposta');
});
