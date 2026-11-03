import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// 202610200170 Anexos dos documentos: Dono, Data and "Excluir selecionados" (VND-205, EST-060). Synthetic controller; no DOM.
const doc = 'd0000000-0000-4000-8000-000000000205', file = 'f0000000-0000-4000-8000-000000000205';
const row = (extra = {}) => ({ id: file, document_id: doc, filename: 'anexo-pedido.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: 'a'.repeat(64), status: 'ready',
  created_at: '2026-10-20T12:00:00Z', finished_at: '2026-10-20T12:00:05Z', deleted: false, owner_name: 'Bruno Sintético', ...extra });

test('Excluir selecionados keeps its commands until "Conferir resultado" confirms; the table shows Dono and Data', async () => {
  const calls = []; let deleted = false, failures = 1;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: 'a0000000-0000-4000-8000-000000000205', role: 'admin' } }),
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === `/v1/documentos/purchase_orders/${doc}/anexos`) return { items: deleted ? [] : [row()], document_id: doc, data_mode: 'erp_native' };
      if (path.endsWith('/exclusao')) { if (failures-- > 0) throw new AccessError(503); deleted = true; return { attachment: row({ deleted: true }), replayed: false, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('DocumentAttachments.tsx', { controller, kind: 'purchase_orders', documentId: doc, writable: true });
  try {
    await view.flush();
    assert.match(view.text(), /Bruno Sintético/); assert.match(view.text(), /20\/10\/2026/);
    assert.equal(view.button('Excluir selecionados').disabled, true, 'nothing selected');
    view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar anexo-pedido.pdf').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir selecionados');
    assert.match(view.text(), /precisa ser confirmada/);
    assert.equal(view.guard().changed, true);
    const first = calls.filter(call => call.path.endsWith('/exclusao'));
    await view.click('Conferir resultado');
    const all = calls.filter(call => call.path.endsWith('/exclusao'));
    assert.equal(all.length, 2); assert.equal(all[1].body.command_id, first[0].body.command_id, 'the same command is repeated');
    assert.match(view.text(), /Anexos excluídos/); assert.match(view.text(), /Nenhum anexo neste documento/);
    assert.equal(view.guard().changed, false);
  } finally { view.unmount(); }
  const reader = await mountComponent('DocumentAttachments.tsx', { controller: { ...controller, async attachments() { return { items: [row()], document_id: doc, data_mode: 'erp_native' }; } }, kind: 'purchase_orders', documentId: doc, writable: false });
  try { await reader.flush(); assert.equal(reader.nodes().some(n => n.type === 'button' && n.props.children === 'Excluir selecionados'), false); assert.equal(reader.nodes().some(n => n.type === 'input' && n.props.type === 'checkbox'), false); }
  finally { reader.unmount(); }
});

test('"Digite o nome do arquivo" filters the list and a file dropped on the area is chosen like the file input', async () => {
  const rows = [row(), row({ id: 'f1000000-0000-4000-8000-000000000205', filename: 'anexo-contrato.pdf' })];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: 'a0000000-0000-4000-8000-000000000205', role: 'admin' } }),
    async attachments() { return { items: rows, document_id: doc, data_mode: 'erp_native' }; } };
  const view = await mountComponent('DocumentAttachments.tsx', { controller, kind: 'purchase_orders', documentId: doc, writable: true });
  try {
    await view.flush();
    await view.change(`attachment-search-${doc}`, 'contrato');
    assert.doesNotMatch(view.text(), /anexo-pedido\.pdf/); assert.match(view.text(), /anexo-contrato\.pdf/);
    const form = view.nodes().find(n => n.type === 'form');
    form.props.onDrop({ preventDefault() {}, dataTransfer: { files: [new File(['%PDF-1.7\n%%EOF'], 'novo.pdf', { type: 'application/pdf' })] } }); await view.flush();
    assert.match(view.text(), /novo\.pdf/);
  } finally { view.unmount(); }
});

test('a definitive refusal of Excluir selecionados (already deleted elsewhere) does not stay pending forever', async () => {
  const calls = []; let reads = 0;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: 'a0000000-0000-4000-8000-000000000205', role: 'admin' } }),
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path === `/v1/documentos/purchase_orders/${doc}/anexos`) { reads += 1; return { items: reads > 1 ? [] : [row()], document_id: doc, data_mode: 'erp_native' }; }
      if (path.endsWith('/exclusao')) throw new AccessError(409);
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('DocumentAttachments.tsx', { controller, kind: 'purchase_orders', documentId: doc, writable: true });
  try {
    await view.flush();
    view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar anexo-pedido.pdf').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir selecionados'); await view.flush();
    assert.doesNotMatch(view.text(), /precisa ser confirmada/);
    assert.match(view.text(), /não fica pendente/);
    assert.equal(view.guard().changed, false, 'nothing is left to confirm');
    assert.ok(reads >= 2, 'the list is read again');
    assert.equal(calls.filter(call => call.path.endsWith('/exclusao')).length, 1);
  } finally { view.unmount(); }
});

test('Miniatura (202610200240): small PNG/JPEG show a checked data: preview, other files their format; a wrong hash shows none', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const image = row({ id: 'f1000000-0000-4000-8000-000000000205', filename: 'foto.png', mime_type: 'image/png', size_bytes: bytes.length, sha256: digest });
  const forged = row({ id: 'f2000000-0000-4000-8000-000000000205', filename: 'outra.png', mime_type: 'image/png', size_bytes: bytes.length, sha256: 'b'.repeat(64) });
  const big = row({ id: 'f3000000-0000-4000-8000-000000000205', filename: 'grande.jpg', mime_type: 'image/jpeg', size_bytes: 3 * 1024 * 1024 });
  const downloads = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: 'a0000000-0000-4000-8000-000000000205', role: 'admin' } }),
    async attachments(path, options = {}) {
      if (path === `/v1/documentos/sales_orders/${doc}/anexos`) return { items: [row(), image, forged, big], document_id: doc, data_mode: 'erp_native' };
      if (path.endsWith('/download')) { assert.equal(options.download, true); downloads.push(path.split('/').at(-2)); return new Blob([bytes]); }
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('DocumentAttachments.tsx', { controller, kind: 'sales_orders', documentId: doc, writable: true });
  try {
    await view.flush(); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.deepEqual(downloads, [image.id, forged.id], 'only small images are read');
    const images = view.nodes().filter(n => n.type === 'img');
    assert.deepEqual(images.map(n => n.props.alt), ['Miniatura de foto.png']);
    assert.equal(images[0].props.src, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    assert.match(view.text(), /Miniatura.*Nome.*Tamanho.*Data.*Dono/s); assert.match(view.text(), /PDF/); assert.match(view.text(), /JPEG/);
    assert.match(view.text(), /Arraste e solte o arquivo aqui para upload/); assert.match(view.text(), /Procurar arquivo/);
  } finally { view.unmount(); }
});
