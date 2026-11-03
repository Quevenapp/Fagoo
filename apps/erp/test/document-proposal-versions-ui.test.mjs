import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { defaultDocumentPreferences } from '../src/lib/document-preferences.ts';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { documentLabel } from '../src/lib/real-documents-model.ts';

// 202610200269 (synthetic controller, no DOM): the chevron of the Salvar of the proposta (Salvar nova versão, Imprimir, Clonar, Usar
// este como modelo), the previous version read-only and the version label.
const actor = 'a0000000-0000-4000-8000-000000000269', docId = 'b0000000-0000-4000-8000-000000000269', newId = 'b1000000-0000-4000-8000-000000000269', contact = 'c0000000-0000-4000-8000-000000000269';
const base = 'b2000000-0000-4000-8000-000000000269';
const prefs = { ...defaultDocumentPreferences('sales_proposals'), loaded: true };
const body = (extra = {}) => ({ date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item sintético', code: null, unit: 'UN', quantity: '1', unit_price: '10', detailed_description: null }], ...extra });
function record(id = docId, extra = {}, data = body()) {
  const normalized = normalizeDocument('sales_proposals', data);
  return { ...normalized, id, kind: 'sales_proposals', number: '129', version: 3, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map(item => ({ ...item, product_snapshot: null })), ...extra };
}
const version = (seq, superseded, latest = { id: newId, label: '129-2' }) => ({ base_id: base, base_number: '129', seq, label: seq === 1 ? '129' : `129-${seq}`, versions: 2, superseded, latest });
function setup() {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; if (path.startsWith('/v1/cadastros/contacts/')) return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }; return { items: [], has_more: false }; },
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body === undefined ? undefined : structuredClone(options.body) });
      if (path.endsWith('/proximo-numero')) return { kind: 'sales_proposals', next_number: '200', reserved: false, data_mode: 'erp_native', operational_effects: false };
      if (path.endsWith('/nova-versao')) { const { number, ...data } = options.body.data; return { kind: 'sales_proposals', document: record(newId, { number: '140', version: 1 }, data), proposal_version: version(2, false), source: { id: docId, number: '129', version: 3 }, replayed: false, data_mode: 'erp_native', operational_effects: false }; }
      if (path === `/v1/documentos/sales_proposals/${newId}`) return { kind: 'sales_proposals', document: record(newId, { number: '140', version: 1, proposal_version: version(2, false) }, calls.find(call => call.path.endsWith('/nova-versao')).body.data), data_mode: 'erp_native', operational_effects: false };
      throw new Error(`Unexpected ${path}`);
    },
    async documentCopy(path) {
      calls.push({ path, method: 'GET' });
      const { items, ...data } = body();
      return { source: { id: docId, kind: 'sales_proposals', number: '129', version: 3 }, data: { ...data, items: items.map(item => ({ ...item, id: null })), installments: [], template: false },
        reset_fields: ['date', 'expected_date', 'valid_until', 'next_contact', 'installments', 'template', 'equipment', 'serial_number', 'technician', 'defect', 'solution'], persisted: false, data_mode: 'erp_native', operational_effects: false };
    },
    async stockPositions() { return { items: [] }; },
  };
  return { controller, calls };
}
const mount = (s, current, extra = {}) => mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_proposals', record: current, writable: true, onSaved() {}, onClose() {}, onConverted() {}, preferences: prefs, ...extra },
  { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentCommercialFields', 'DocumentOptionalSection'] });
const more = async view => { view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Mais opções de salvar').props.onClick(); await view.flush(); };
const item = (view, label) => view.nodes().find(n => n.type === 'button' && n.props.role === 'menuitem' && n.props.children === label);

test('chevron do Salvar: Salvar nova versão sends the form (never a requested number) and opens the new version 129-2', async () => {
  const s = setup(); let saved = null;
  const view = await mount(s, record(), { onSaved: (doc, message) => { saved = { doc, message }; } });
  try {
    assert.match(view.text(), /Proposta - 129/);
    await more(view);
    for (const label of ['Salvar nova versão', 'Imprimir', 'Clonar', 'Usar este como modelo']) assert.ok(item(view, label), label);
    await view.change('doc-notes', 'Condições revistas');
    assert.equal(item(view, 'Imprimir').props.disabled, true, 'print the saved version only');
    item(view, 'Salvar nova versão').props.onClick(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    const post = s.calls.find(call => call.path === `/v1/documentos/sales_proposals/${docId}/nova-versao`);
    assert.ok(post, JSON.stringify(s.calls.map(call => call.path)));
    assert.equal(post.method, 'POST'); assert.equal(post.body.expected_version, 3); assert.equal(post.body.data.notes, 'Condições revistas'); assert.equal('number' in post.body.data, false);
    assert.ok(saved, 'the editor reports the new version');
    assert.equal(saved.doc.id, newId); assert.match(saved.message, /Nova versão 129-2 da proposta salva\./);
    assert.equal(documentLabel(saved.doc), '129-2');
  } finally { view.unmount(); }
});

test('Usar este como modelo prepares the reviewed copy as a modelo; Clonar as a plain copy', async () => {
  const s = setup(); const drafts = [];
  const view = await mount(s, record(), { onCopyPrepared: draft => drafts.push(draft) });
  try {
    await more(view); item(view, 'Usar este como modelo').props.onClick(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 10)); await view.flush();
    await more(view); item(view, 'Clonar').props.onClick(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 10)); await view.flush();
    assert.deepEqual(drafts.map(draft => [draft.preview.data.template, draft.preview.data.template_name ?? null]), [[true, null], [false, null]]);
  } finally { view.unmount(); }
});

test('a version with a newer one is only consulted: the notice, no Salvar, the form locked, and the label in the title and the print', async () => {
  const s = setup(), old = record(docId, { proposal_version: version(1, true) });
  const view = await mount(s, old);
  try {
    assert.match(view.text(), /Esta é a versão 129 da proposta\. A versão mais nova é a 129-2; as versões anteriores ficam só para consulta\./);
    assert.ok(view.nodes().some(n => n.type === 'button' && n.props.children?.join?.('') === 'Abrir a versão 129-2'));
    assert.equal(view.nodes().some(n => n.type === 'button' && n.props.type === 'submit'), false, 'no Salvar');
    assert.ok(view.nodes().filter(n => n.type === 'fieldset').every(n => n.props.disabled === true), 'every section locked');
    assert.doesNotMatch(view.text(), /A situação atual bloqueia a edição/);
  } finally { view.unmount(); }
  const second = record(newId, { number: '140', proposal_version: version(2, false) });
  assert.equal(documentPrintModel(second).number, '129-2');
});
