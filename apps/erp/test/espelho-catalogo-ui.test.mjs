import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { mirrorRows, readOriginMirror, syncSummary, mirrorValueText } from '../src/lib/origin-mirror-model.ts';

// Leva H, lane espelho (350-352): Dados do Origin, categorias e exclusões do Origin. Synthetic controller; no DOM, no network.
const contact = 'c0000000-0000-4000-8000-000000000350', product = 'p0000000-0000-4000-8000-000000000352'.replace('p', 'a');
const mirror = (over = {}) => ({ scope: 'origin_mirror', entity: 'contacts', id: contact, data_mode: 'erp_native', system: 'origin', linked: true, source_id: '501', state: 'synced',
  synced_at: '2026-10-21T15:00:00Z', source_updated_at: null, source_seen_at: '2026-10-21T15:30:00Z', pending: false,
  fields: { name: 'Transportes Sintéticos', nfe_email: 'nf@sintetico.test', billing_address: { city: 'Campinas', state: 'SP' }, contact_types: ['Cliente', 'Transportador'], source_roles: ['carrier', 'customer'], zz_new: 'x' },
  local_complements: [], ...over });

test('the mirror rows follow the Origin order, flatten addresses and lists and hide internal keys', () => {
  const rows = mirrorRows(readOriginMirror(mirror(), 'contacts', contact));
  assert.deepEqual(rows.map(row => row.label), ['Nome', 'E-mail para envio da NF-e', 'Endereço de cobrança', 'Tipos de contato', 'zz_new']);
  assert.equal(rows.find(row => row.key === 'billing_address').value, 'Campinas, SP');
  assert.equal(mirrorValueText('<p>Rica <b>descrição</b></p>'), 'Rica descrição');
  assert.throws(() => readOriginMirror(mirror({ id: product }), 'contacts', contact));
  assert.equal(syncSummary({ created: 2, unchanged: 1, invalid: 0 }), 'Categorias do Origin: 2 criadas, 1 sem alteração.');
  assert.equal(syncSummary({}), 'Nenhuma categoria do Origin para sincronizar.');
});

test('Dados do Origin: read only fields, and the Transportador complement repeats its command until confirmed', async () => {
  const calls = []; let complement = false, failNext = true;
  const controller = { async originMirror(path, options = {}) {
    calls.push({ path, method: options.method ?? 'GET', body: options.body });
    if (path.startsWith('/v1/espelho-origin/transportadores/')) { if (failNext) { failNext = false; throw new AccessError(503); } complement = options.body.carrier; return { scope: 'contact_carrier_complement' }; }
    return mirror({ local_complements: complement ? ['carrier_complement'] : [] });
  } };
  const view = await mountComponent('OriginMirrorPanel.tsx', { controller, entity: 'contacts', id: contact, writable: true });
  try {
    await view.flush();
    assert.doesNotMatch(view.text(), /Transportes Sintéticos/, 'collapsed until opened');
    await view.click('Dados do Origin'); await view.flush();
    assert.match(view.text(), /Origem: Origin, id 501/); assert.match(view.text(), /nf@sintetico\.test/); assert.match(view.text(), /altere-os no Origin/);
    const box = () => view.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
    box().props.onChange(); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.match(view.text(), /Conferir resultado/);
    await view.click('Conferir resultado'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    const sent = calls.filter(call => call.method === 'POST');
    assert.equal(sent.length, 2); assert.equal(sent[0].body.command_id, sent[1].body.command_id); assert.equal(sent[1].body.carrier, true);
    assert.match(view.text(), /marcado como transportador/); assert.equal(box().props.checked, true);
  } finally { view.unmount?.(); }
});

test('a cadastro without Origin link says so; the product panel never offers the complement', async () => {
  const controller = { async originMirror() { return { ...mirror({ entity: 'products', id: product, linked: false, source_id: null, state: null, synced_at: null, fields: {} }) }; } };
  const view = await mountComponent('OriginMirrorPanel.tsx', { controller, entity: 'products', id: product, writable: true });
  try {
    await view.click('Dados do Origin'); await view.flush();
    assert.match(view.text(), /sem vínculo com o Origin/); assert.doesNotMatch(view.text(), /Transportador/);
  } finally { view.unmount?.(); }
});

test('Categorias do Origin: the administrador synchronizes and sees the pendências', async () => {
  const calls = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { role: 'admin' } }), async originMirror(path, options = {}) {
    calls.push({ path, method: options.method ?? 'GET', body: options.body });
    if (options.method === 'POST') return { scope: 'origin_categories_sync', counts: { created: 2, adopted: 1 }, issues: [] };
    return { scope: 'origin_categories', source_count: 3, source_seen_at: null, pending: 1, items: [
      { source_id: '11', taxonomy_id: product, name: 'Ferramentas', source_name: 'Ferramentas', source_parent_id: null, parent_id: null, inactive: true, issue: null, synced_at: '2026-10-21T15:00:00Z', removed_locally: false }] };
  } };
  let synced = 0;
  const view = await mountComponent('OriginCatalogSync.tsx', { controller, onSynced: () => { synced++; } }, { componentName: 'OriginCategorySync' });
  try {
    await view.flush();
    assert.match(view.text(), /Categorias no Origin: 3/); assert.match(view.text(), /1 para sincronizar/);
    await view.click('Sincronizar categorias do Origin'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.match(view.text(), /2 criadas, 1 vinculadas a categorias existentes/); assert.equal(synced, 1);
    await view.click('Ver pendências (1)'); await view.flush();
    assert.match(view.text(), /Inativa no Origin/);
    assert.match(calls.find(call => call.method === 'POST').body.command_id, /^[0-9a-f-]{36}$/);
  } finally { view.unmount?.(); }
});

test('Exclusões do Origin: listed for review and applied with the expected version', async () => {
  const calls = []; let done = false;
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { role: 'admin' } }), async originMirror(path, options = {}) {
    calls.push({ path, method: options.method ?? 'GET', body: options.body });
    if (options.method === 'POST') { done = true; return { scope: 'origin_deletion_apply' }; }
    return { scope: 'origin_deletions', has_more: false, writable: true, source_seen_at: null, items: done ? [] : [{ id: product, version: 4, name: 'Produto Sintético', code: 'P1', source_id: '801', source_status: 'E', action: 'delete', deleted_at: null }] };
  } };
  const view = await mountComponent('OriginCatalogSync.tsx', { controller, onChanged: () => {} }, { componentName: 'OriginProductDeletions' });
  try {
    await view.flush();
    assert.match(view.text(), /1 excluído\(s\) no Origin/);
    await view.click('Revisar'); await view.flush();
    await view.click('Mover para Excluídos'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    const sent = calls.find(call => call.method === 'POST');
    assert.equal(sent.path, `/v1/espelho-origin/exclusoes/${product}`); assert.deepEqual([sent.body.expected_version, sent.body.action], [4, 'delete']);
  } finally { view.unmount?.(); }
});
