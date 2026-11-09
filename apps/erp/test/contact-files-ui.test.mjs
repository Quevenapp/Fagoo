import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { photoFileType, readContactFiles } from '../src/lib/contact-files-model.ts';

// 202610200170 Foto e Anexos of Clientes e fornecedores in the contact form. Synthetic controller and bytes; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000170', contact = 'c0000000-0000-4000-8000-000000000170';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = new TextEncoder().encode('Contrato sintético.\n');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const file = (id, extra = {}) => ({ id, contact_id: contact, purpose: 'attachment', filename: 'anexo-contrato.txt', mime_type: 'text/plain', size_bytes: text.length, sha256: sha(text),
  status: 'ready', created_at: '2026-10-20T13:00:00Z', finished_at: '2026-10-20T13:00:01Z', deleted: false, owner_name: 'Ana Sintética', ...extra });
const id = n => `d0000000-0000-4000-8000-00000000017${n}`;

test('the reader keeps only this contact and refuses a photo that is not ready', () => {
  assert.equal(readContactFiles({ contact_id: contact, items: [file(id(1))], photo: null, pending_photos: [] }, contact).items.length, 1);
  assert.throws(() => readContactFiles({ contact_id: contact, items: [file(id(1), { contact_id: id(9) })], photo: null, pending_photos: [] }, contact));
  assert.throws(() => readContactFiles({ contact_id: contact, items: [], photo: file(id(2), { purpose: 'photo', status: 'reserved' }), pending_photos: [] }, contact));
  assert.equal(photoFileType({ name: 'foto.JPG', size: 10 }), 'image/jpeg');
  assert.throws(() => photoFileType({ name: 'foto.gif', size: 10 }), /PNG ou JPEG/);
  assert.throws(() => photoFileType({ name: 'foto.png', size: 2 * 1024 * 1024 + 1 }), /até 2 MB/);
});

function server({ failFirstDelete = false } = {}) {
  const calls = [], rows = [file(id(1))]; let photo = null, deleteFailures = failFirstDelete ? 1 : 0;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const base = `/v1/anexos-cadastros/contatos/${contact}`;
      if (path === base && (options.method ?? 'GET') === 'GET') return { contact_id: contact, items: rows.filter(row => !row.deleted), photo, pending_photos: [], data_mode: 'erp_native' };
      if (path === base && options.method === 'POST') {
        const created = file(options.body.purpose === 'photo' ? id(5) : id(2), { purpose: options.body.purpose, filename: `anexo-${options.body.filename.replace(/\.[^.]+$/, '')}.${options.body.mime_type === 'image/png' ? 'png' : 'txt'}`,
          mime_type: options.body.mime_type, size_bytes: options.body.size_bytes, sha256: options.body.sha256, status: 'reserved', finished_at: null });
        if (created.purpose === 'photo') photo = null; else rows.push(created);
        return { attachment: created, replayed: false, data_mode: 'erp_native' };
      }
      const upload = /\/([0-9a-f-]{36})\/upload$/.exec(path);
      if (upload) { const row = rows.find(r => r.id === upload[1]); if (row) Object.assign(row, { status: 'ready' }); else photo = file(id(5), { purpose: 'photo', mime_type: 'image/png', size_bytes: png.length, sha256: sha(png), filename: 'anexo-foto.png' }); return { attachment: row ?? photo, replayed: false, data_mode: 'erp_native' }; }
      const removal = /\/([0-9a-f-]{36})\/exclusao$/.exec(path);
      if (removal) { if (deleteFailures-- > 0) throw new AccessError(503); const row = rows.find(r => r.id === removal[1]); if (row) row.deleted = true; else photo = null; return { attachment: { ...(row ?? file(removal[1])), deleted: true }, replayed: false, data_mode: 'erp_native' }; }
      if (/\/download$/.test(path)) return new Blob([path.includes(id(5)) ? png : text], { type: 'application/octet-stream' });
      throw new AccessError(404);
    },
  };
  return { controller, calls, rows };
}

test('Anexos: Anexar arquivo sends the checked bytes; Excluir selecionados keeps its commands until "Conferir resultado" confirms', async () => {
  const s = server({ failFirstDelete: true });
  const view = await mountComponent('ContactFiles.tsx', { controller: s.controller, contactId: contact, writable: true });
  try {
    await view.flush();
    assert.match(view.text(), /anexo-contrato\.txt/); assert.match(view.text(), /Ana Sintética/);
    view.input(`contact-files-${contact}`).props.onChange({ target: { files: [new File([text], 'novo.txt', { type: 'text/plain' })] } });
    await new Promise(resolve => setTimeout(resolve, 50)); await view.flush();
    const reserve = s.calls.find(call => call.method === 'POST' && call.body?.purpose === 'attachment');
    assert.deepEqual([reserve.body.filename, reserve.body.mime_type, reserve.body.size_bytes, reserve.body.sha256], ['novo.txt', 'text/plain', text.length, sha(text)]);
    assert.ok(s.calls.some(call => call.method === 'PUT' && call.path.endsWith(`${id(2)}/upload`)));
    assert.match(view.text(), /Anexo novo\.txt enviado/);
    const box = view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar anexo-contrato.txt');
    box.props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir selecionados'); await view.flush();
    assert.match(view.text(), /precisa ser confirmada/);
    const first = s.calls.filter(call => call.path.endsWith('/exclusao'));
    await view.click('Conferir resultado'); await view.flush();
    const second = s.calls.filter(call => call.path.endsWith('/exclusao'));
    assert.equal(second.length, first.length + 1);
    assert.equal(second.at(-1).body.command_id, first[0].body.command_id, 'the same command is repeated');
    assert.match(view.text(), /Anexos excluídos/);
    assert.equal(view.guard().changed, false);
  } finally { view.unmount(); }
});

test('Foto: preview of the current foto checked by SHA-256, Enviar foto only with PNG/JPEG and Remover foto; read-only profiles only see it', async () => {
  const s = server();
  const view = await mountComponent('ContactFiles.tsx', { controller: s.controller, contactId: contact, writable: true }, { componentName: 'ContactPhoto' });
  try {
    await view.flush();
    assert.match(view.text(), /Sem foto/);
    view.input(`contact-photo-${contact}`).props.onChange({ target: { files: [new File([text], 'foto.txt')] } }); await view.flush();
    assert.match(view.text(), /Use uma imagem PNG ou JPEG/);
    view.input(`contact-photo-${contact}`).props.onChange({ target: { files: [new File([png], 'foto.png', { type: 'image/png' })] } });
    await new Promise(resolve => setTimeout(resolve, 50)); await view.flush(); await new Promise(resolve => setTimeout(resolve, 50)); await view.flush();
    assert.ok(s.calls.some(call => call.method === 'POST' && call.body?.purpose === 'photo' && call.body.mime_type === 'image/png'));
    // Contact files still use checked bytes. External HTTPS media is reserved for administrator-configured campaigns.
    assert.ok(view.nodes().some(n => n.type === 'img' && n.props.alt === 'Foto do contato' && n.props.src === `data:image/png;base64,${Buffer.from(png).toString('base64')}`));
    await view.click('Remover foto'); await view.flush(); await new Promise(resolve => setTimeout(resolve, 50)); await view.flush();
    assert.ok(s.calls.some(call => call.path.endsWith(`${id(5)}/exclusao`) && call.body.command_id));
    assert.match(view.text(), /Sem foto/);
  } finally { view.unmount(); }
  const reader = await mountComponent('ContactFiles.tsx', { controller: server().controller, contactId: contact, writable: false }, { componentName: 'ContactPhoto' });
  try { assert.equal(reader.nodes().some(n => n.type === 'input' && n.props.type === 'file'), false); } finally { reader.unmount(); }
  const fresh = await mountComponent('ContactFiles.tsx', { controller: server().controller, contactId: null, writable: true }, { componentName: 'ContactPhoto' });
  try { assert.match(fresh.text(), /Salve o cadastro para enviar a foto/); } finally { fresh.unmount(); }
});

test('a definitive refusal of Excluir selecionados or Remover foto ends the pending deletion and reads the files again', async () => {
  const s = server();
  const refusing = { ...s.controller, async attachments(path, options = {}) { if (path.endsWith('/exclusao')) { s.calls.push({ path, method: 'POST', body: options.body }); throw new AccessError(409); } return s.controller.attachments(path, options); } };
  const view = await mountComponent('ContactFiles.tsx', { controller: refusing, contactId: contact, writable: true });
  try {
    await view.flush();
    view.nodes().find(n => n.type === 'input' && n.props['aria-label'] === 'Selecionar anexo-contrato.txt').props.onChange({ target: { checked: true } }); await view.flush();
    const reads = s.calls.filter(call => call.method === 'GET').length;
    await view.click('Excluir selecionados'); await view.flush();
    assert.doesNotMatch(view.text(), /precisa ser confirmada/);
    assert.equal(view.guard().changed, false);
    assert.ok(s.calls.filter(call => call.method === 'GET').length > reads, 'the list is read again');
    assert.match(view.text(), /já foi excluído/, 'the refusal stays visible after the files are read again');
  } finally { view.unmount(); }
});

test('image policy permits checked previews and HTTPS campaigns while blocking insecure media', async () => {
  const { readFile } = await import('node:fs/promises');
  const headers = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const img = /img-src ([^;]+);/.exec(headers)?.[1] ?? '';
  assert.ok(img.includes('data:'));
  assert.deepEqual(img.trim().split(/\s+/).sort(), ["'self'",'blob:','data:','https:'].sort());
  assert.equal(img.includes('http:'),false);
});
