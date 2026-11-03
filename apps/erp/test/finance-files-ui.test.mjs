import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { financeFiles, financeFilesPath } from '../src/lib/finance-files-model.ts';

// Synthetic data only. 211: aba Anexos of a conta (and of a lançamento de caixa): reserve, upload, uncertain answers, exclusão.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1), clicks = [];
globalThis.document = { activeElement: null, createElement: () => ({ click() { clicks.push(this.download); }, remove() {} }), body: { append() {} } };
globalThis.URL.createObjectURL ??= () => 'blob:synthetic'; globalThis.URL.revokeObjectURL ??= () => {};
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const bytes = new TextEncoder().encode('Comprovante sintético.\n'), sha = createHash('sha256').update(bytes).digest('hex');
const row = (n, extra = {}) => ({ id: id(n), owner_kind: 'title', owner_id: OWNER, filename: `anexo-arquivo-${n}.txt`, mime_type: 'text/plain', size_bytes: bytes.length, sha256: sha, status: 'ready', created_at: '2026-10-20T12:00:00Z', finished_at: '2026-10-20T12:00:01Z', deleted: false, owner_name: 'Financeiro sintético', ...extra });
function server({ fail } = {}) {
  const calls = [], state = { rows: [row(10)] };
  const controller = {
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      const failure = fail?.(path, options, calls.length); if (failure) throw failure;
      if (path === `/v1/anexos-financeiro/contas/${OWNER}` && (options.method ?? 'GET') === 'GET') return { owner_kind: 'title', owner_id: OWNER, items: structuredClone(state.rows), data_mode: 'erp_native' };
      if (path === `/v1/anexos-financeiro/contas/${OWNER}` && options.method === 'POST') { const created = row(20, { status: 'reserved', filename: 'anexo-recibo.txt', finished_at: null }); state.rows.push(created); return { attachment: structuredClone(created), replayed: false, data_mode: 'erp_native' }; }
      const match = /\/([0-9a-f-]{36})\/(upload|download|abort|exclusao)$/.exec(path);
      const target = state.rows.find(item => item.id === match?.[1]);
      if (match?.[2] === 'upload') { target.status = 'ready'; return { attachment: structuredClone(target), replayed: false, data_mode: 'erp_native' }; }
      if (match?.[2] === 'download') return new Blob([bytes]);
      if (match?.[2] === 'exclusao') { state.rows = state.rows.filter(item => item.id !== target.id); return { attachment: { ...structuredClone(target), deleted: true }, replayed: false, data_mode: 'erp_native' }; }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, state };
}
const mount = (source, props = {}) => mountComponent('FinanceAttachments.tsx', { controller: source.controller, owner: 'contas', ownerId: OWNER, writable: true, ...props });

test('211 model binds the list to its owner and builds only proxy paths', () => {
  assert.equal(financeFilesPath('contas', OWNER), `/v1/anexos-financeiro/contas/${OWNER}`);
  assert.equal(financeFilesPath('lancamentos', OWNER, id(2), 'download'), `/v1/anexos-financeiro/lancamentos/${OWNER}/${id(2)}/download`);
  assert.throws(() => financeFilesPath('contas', '../x'));
  assert.deepEqual(financeFiles({ owner_kind: 'title', owner_id: OWNER, items: [row(1)], data_mode: 'erp_native' }, 'contas', OWNER).map(item => item.id), [id(1)]);
  for (const bad of [{ owner_kind: 'cash_entry', owner_id: OWNER, items: [], data_mode: 'erp_native' }, { owner_kind: 'title', owner_id: OWNER, items: [row(1, { owner_id: id(9) })], data_mode: 'erp_native' },
    { owner_kind: 'title', owner_id: OWNER, items: [row(1, { deleted: true })], data_mode: 'erp_native' }, { owner_kind: 'title', owner_id: OWNER, items: Array.from({ length: 101 }, (_, n) => row(n)), data_mode: 'erp_native' }])
    assert.throws(() => financeFiles(bad, 'contas', OWNER));
});

test('211 Anexos lists, uploads by reserve + upload + read back, downloads checked by SHA-256 and excludes the selected files', async () => {
  const source = server(), view = await mount(source);
  try {
    assert.match(view.text(), /anexo-arquivo-10\.txt/); assert.match(view.text(), /1 registro\(s\) de anexo/);
    await view.change(`finance-file-contas-${OWNER}`, null);
    view.input(`finance-file-contas-${OWNER}`).props.onChange({ target: { files: [new File([bytes], 'recibo.txt', { type: 'text/plain' })] } }); await view.flush();
    await view.click('Enviar arquivo'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    const reserve = source.calls.find(call => call.method === 'POST' && call.path.endsWith(OWNER));
    assert.deepEqual(reserve.body, { command_id: reserve.body.command_id, filename: 'recibo.txt', mime_type: 'text/plain', size_bytes: bytes.length, sha256: sha });
    assert.ok(source.calls.some(call => call.method === 'PUT' && call.path.endsWith(`${id(20)}/upload`)));
    assert.match(view.text(), /Anexo anexo-recibo\.txt disponível/);
    await view.click('Baixar'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.deepEqual(clicks, ['anexo-arquivo-10.txt']); assert.match(view.text(), /Download preparado/);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar anexo-arquivo-10.txt').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir selecionados');
    const removal = source.calls.find(call => call.path.endsWith(`${id(10)}/exclusao`));
    assert.match(removal.body.command_id, /^[0-9a-f-]{36}$/); assert.match(view.text(), /Anexos excluídos/); assert.doesNotMatch(view.text(), /anexo-arquivo-10/);
  } finally { view.unmount(); }
});

test('211 an unconfirmed upload keeps the same command and file; consulta only reads', async () => {
  let lost = true;
  const source = server({ fail: (path, options) => { if (options.method === 'PUT' && lost) { lost = false; return new AccessError(503); } return null; } }), view = await mount(source);
  try {
    view.input(`finance-file-contas-${OWNER}`).props.onChange({ target: { files: [new File([bytes], 'recibo.txt', { type: 'text/plain' })] } }); await view.flush();
    await view.click('Enviar arquivo'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.match(view.text(), /O resultado precisa ser confirmado/);
    await view.click('Confirmar a mesma operação'); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    assert.equal(source.calls.filter(call => call.method === 'POST' && call.path.endsWith(OWNER)).length, 1, 'the reservation is never repeated');
    assert.equal(source.calls.filter(call => call.method === 'PUT').length, 2); assert.match(view.text(), /disponível/);
  } finally { view.unmount(); }
  const reader = server(), readonly = await mount(reader, { writable: false });
  try { assert.throws(() => readonly.input(`finance-file-contas-${OWNER}`)); assert.throws(() => readonly.button('Excluir selecionados')); assert.ok(readonly.button('Baixar')); }
  finally { readonly.unmount(); }
});
