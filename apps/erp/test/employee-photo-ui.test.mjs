import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { ownerFilesPath, readContactFiles } from '../src/lib/contact-files-model.ts';

// 202610200272 Foto of the Funcionário (Cadastros › Funcionários) with the ContactPhoto of 170 and owner "employee".
// Synthetic controller and bytes; no DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000272', employee = 'e0000000-0000-4000-8000-000000000272', photoId = 'f0000000-0000-4000-8000-000000000272';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const row = (extra = {}) => ({ id: photoId, employee_id: employee, purpose: 'photo', filename: 'anexo-foto.png', mime_type: 'image/png', size_bytes: png.length, sha256: sha(png),
  status: 'ready', created_at: '2026-10-21T13:00:00Z', finished_at: '2026-10-21T13:00:01Z', deleted: false, owner_name: null, ...extra });

test('the reader keeps only the foto of this funcionário', () => {
  assert.equal(ownerFilesPath('employee', employee), `/v1/anexos-cadastros/funcionarios/${employee}`);
  assert.equal(ownerFilesPath('employee', employee, photoId, 'download'), `/v1/anexos-cadastros/funcionarios/${employee}/${photoId}/download`);
  assert.equal(readContactFiles({ employee_id: employee, items: [], photo: row(), pending_photos: [] }, employee, 'employee').photo.id, photoId);
  assert.throws(() => readContactFiles({ employee_id: employee, items: [], photo: row({ employee_id: photoId }), pending_photos: [] }, employee, 'employee'));
  assert.throws(() => readContactFiles({ employee_id: employee, items: [row()], photo: null, pending_photos: [] }, employee, 'employee'), 'a funcionário has no Anexos');
  assert.throws(() => readContactFiles({ contact_id: employee, items: [], photo: null, pending_photos: [] }, employee, 'employee'));
});

test('Foto do funcionário: Enviar foto, preview checked by SHA-256 and Remover foto on the funcionário route', async () => {
  const calls = []; let photo = null;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const base = `/v1/anexos-cadastros/funcionarios/${employee}`;
      if (path === base && (options.method ?? 'GET') === 'GET') return { employee_id: employee, items: [], photo, pending_photos: [], data_mode: 'erp_native' };
      if (path === base && options.method === 'POST') return { attachment: row({ status: 'reserved', finished_at: null, size_bytes: options.body.size_bytes, sha256: options.body.sha256 }), replayed: false, data_mode: 'erp_native' };
      if (path === `${base}/${photoId}/upload`) { photo = row(); return { attachment: photo, replayed: false, data_mode: 'erp_native' }; }
      if (path === `${base}/${photoId}/download`) return new Blob([png], { type: 'application/octet-stream' });
      if (path === `${base}/${photoId}/exclusao`) { photo = null; return { attachment: row({ deleted: true }), replayed: false, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('ContactFiles.tsx', { controller, contactId: employee, writable: true, owner: 'employee' }, { componentName: 'ContactPhoto' });
  try {
    await view.flush();
    assert.match(view.text(), /Sem foto/);
    view.input(`employee-photo-${employee}`).props.onChange({ target: { files: [new File([png], 'retrato.png', { type: 'image/png' })] } });
    await new Promise(resolve => setTimeout(resolve, 50)); await view.flush(); await new Promise(resolve => setTimeout(resolve, 50)); await view.flush();
    assert.ok(calls.every(call => call.path.startsWith(`/v1/anexos-cadastros/funcionarios/${employee}`)), 'never the contato route');
    assert.ok(calls.some(call => call.method === 'POST' && call.body?.purpose === 'photo' && call.body.mime_type === 'image/png'));
    assert.ok(view.nodes().some(n => n.type === 'img' && n.props.alt === 'Foto do funcionário' && n.props.src === `data:image/png;base64,${Buffer.from(png).toString('base64')}`));
    await view.click('Remover foto'); await view.flush(); await new Promise(resolve => setTimeout(resolve, 50)); await view.flush();
    assert.ok(calls.some(call => call.path.endsWith(`${photoId}/exclusao`) && call.body.command_id));
    assert.match(view.text(), /Sem foto/);
  } finally { view.unmount(); }
});

test('the funcionário form shows the Foto (enviar after the first save)', async () => {
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => {},
    async catalog(path) { if (path.startsWith('/v1/cadastros/funcionarios?')) return { items: [], page: 1, size: 100, total: 0 }; throw new AccessError(404); },
    async attachments() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealEmployees.tsx', { controller }, { expandChildren: ['NativeListLayout', 'EmployeeEditor', 'EmployeeForm', 'ContactPhoto'] });
  try {
    await view.flush();
    await view.click('Incluir cadastro'); await view.flush();
    assert.match(view.text(), /Salve o cadastro para enviar a foto/);
    assert.doesNotMatch(view.text(), /ainda não existe/);
  } finally { view.unmount(); }
});
