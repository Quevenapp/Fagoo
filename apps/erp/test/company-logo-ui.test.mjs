import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { logoFileType, readCompanyLogoPage, companyLogoPath } from '../src/lib/company-logo-model.ts';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { defaultTitlePeriod } from '../src/lib/finance-list-route.ts';

// 202610200262 Empresa › Dados da empresa › Sua marca and the logo in the recibo header. Synthetic controller and bytes; no DOM, no network.
globalThis.document = { activeElement: null };
const admin = 'a0000000-0000-4000-8000-000000000262', other = 'b0000000-0000-4000-8000-000000000262';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=', 'base64'));
const id = n => `d0000000-0000-4000-8000-00000000026${n}`;
const logo = (n, extra = {}) => ({ id: id(n), mime_type: 'image/png', size_bytes: png.length, sha256: sha(png), status: 'ready', created_at: '2026-10-20T13:00:00Z', finished_at: '2026-10-20T13:00:01Z',
  deleted: false, owner_name: 'Ana Sintética', ...extra });
const page = (current, extra = {}) => ({ scope: 'company_logo', can_manage: true, logo: current, pending: [], data_mode: 'erp_native', ...extra });

test('the reader refuses a logo that is not ready, pending rows for a reader and other formats; PNG or JPEG up to 2 MB', () => {
  assert.equal(readCompanyLogoPage(page(logo(1))).logo.id, id(1));
  assert.throws(() => readCompanyLogoPage(page(logo(1, { status: 'reserved' }))));
  assert.throws(() => readCompanyLogoPage(page(logo(1, { mime_type: 'image/gif' }))));
  assert.throws(() => readCompanyLogoPage(page(null, { can_manage: false, pending: [logo(2, { status: 'reserved' })] })));
  assert.throws(() => readCompanyLogoPage({ ...page(null), scope: 'other' }));
  assert.equal(logoFileType({ name: 'marca.JPEG', size: 10 }), 'image/jpeg');
  assert.throws(() => logoFileType({ name: 'marca.svg', size: 10 }), /PNG ou JPEG/);
  assert.throws(() => logoFileType({ name: 'marca.png', size: 2 * 1024 * 1024 + 1 }), /até 2 MB/);
  assert.equal(companyLogoPath(id(1), 'exclusao'), `/v1/anexos-empresa/logo/${id(1)}/exclusao`);
});

function server({ current = logo(1), role = 'admin', failUploadOnce = false, failRemoveOnce = false, corrupt = false } = {}) {
  const calls = []; let state = current, uploadFailures = failUploadOnce ? 1 : 0, removeFailures = failRemoveOnce ? 1 : 0, snapshot = { phase: 'ready', membership: { user_id: admin, role } };
  const controller = {
    getSnapshot: () => snapshot, setSnapshot: value => { snapshot = value; },
    async attachments(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/v1/anexos-empresa/logo' && (options.method ?? 'GET') === 'GET') return page(state, { can_manage: role === 'admin' });
      if (path === '/v1/anexos-empresa/logo' && options.method === 'POST') return { logo: logo(5, { mime_type: options.body.mime_type, size_bytes: options.body.size_bytes, sha256: options.body.sha256, status: 'reserved', finished_at: null }), replayed: false, data_mode: 'erp_native' };
      if (/\/upload$/.test(path)) { if (uploadFailures-- > 0) throw new AccessError(503); state = logo(5); return { logo: state, replayed: false, data_mode: 'erp_native' }; }
      if (/\/exclusao$/.test(path)) { if (removeFailures-- > 0) throw new AccessError(503); const removed = { ...state, deleted: true }; state = null; return { logo: removed, replayed: false, data_mode: 'erp_native' }; }
      if (/\/download$/.test(path)) return new Blob([corrupt ? new Uint8Array([1, 2, 3]) : png], { type: 'application/octet-stream' });
      throw new AccessError(404);
    },
  };
  return { controller, calls };
}
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 20)); await view.flush(); } };
const image = view => view.nodes().find(n => n.type === 'img');

test('Sua marca: the current logo is shown only after its SHA-256 matches; Trocar logo keeps the command until "Conferir resultado"', async () => {
  const s = server({ failUploadOnce: true });
  const view = await mountComponent('CompanyLogo.tsx', { controller: s.controller });
  try {
    await settle(view);
    assert.match(image(view).props.src, /^data:image\/png;base64,/); assert.match(view.text(), /enviado por Ana Sintética/);
    view.input('company-logo-file').props.onChange({ target: { files: [new File([png], 'marca.png', { type: 'image/png' })] } });
    await settle(view);
    const reserve = s.calls.find(call => call.method === 'POST' && call.path === '/v1/anexos-empresa/logo');
    assert.deepEqual([reserve.body.mime_type, reserve.body.size_bytes, reserve.body.sha256], ['image/png', png.length, sha(png)]);
    assert.match(view.text(), /O envio do logo precisa ser confirmado/); assert.equal(view.guard().changed, true, 'leaving warns while the upload is pending');
    await view.click('Conferir resultado'); await settle(view);
    assert.equal(s.calls.filter(call => call.method === 'POST' && call.path === '/v1/anexos-empresa/logo').length, 1, 'the reservation is never repeated');
    assert.equal(s.calls.filter(call => call.method === 'PUT').length, 2);
    assert.match(view.text(), /Logo enviado/); assert.equal(view.guard().changed, false);
  } finally { view.unmount(); }
});

test('Sua marca: Remover logo repeats the same command; Gerar nova logo stays disabled; a reader only sees the logo; a corrupt download is never shown', async () => {
  const s = server({ failRemoveOnce: true });
  const view = await mountComponent('CompanyLogo.tsx', { controller: s.controller });
  try {
    await settle(view);
    assert.equal(view.button('Gerar nova logo').disabled, true);
    await view.click('Remover logo'); await settle(view);
    assert.match(view.text(), /A remoção do logo precisa ser confirmada/);
    await view.click('Conferir resultado'); await settle(view);
    const removals = s.calls.filter(call => call.path.endsWith('/exclusao'));
    assert.equal(removals.length, 2); assert.equal(removals[0].body.command_id, removals[1].body.command_id);
    assert.match(view.text(), /Logo removido/); assert.match(view.text(), /Nenhum logo enviado/);
  } finally { view.unmount(); }
  const reader = server({ role: 'financeiro' });
  const read = await mountComponent('CompanyLogo.tsx', { controller: reader.controller });
  try {
    await settle(read);
    assert.ok(image(read)); assert.throws(() => read.button('Remover logo')); assert.throws(() => read.input('company-logo-file'));
    assert.match(read.text(), /Somente administradores enviam ou removem o logo/);
  } finally { read.unmount(); }
  const bad = server({ corrupt: true });
  const broken = await mountComponent('CompanyLogo.tsx', { controller: bad.controller });
  try { await settle(broken); assert.equal(image(broken), undefined); assert.match(broken.text(), /Não foi possível carregar o logo/); } finally { broken.unmount(); }
});

test('Sua marca: a response that arrives after the user changed is discarded', async () => {
  const s = server();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const original = s.controller.attachments;
  s.controller.attachments = async (path, options) => { if (path === '/v1/anexos-empresa/logo') await gate; return original(path, options); };
  const view = await mountComponent('CompanyLogo.tsx', { controller: s.controller });
  try {
    s.controller.setSnapshot({ phase: 'ready', membership: { user_id: other, role: 'admin' } }); release(); await settle(view);
    assert.equal(image(view), undefined, 'the logo read for the previous user is not shown');
  } finally { view.unmount(); }
});

test('Sua marca (review): a role change while the screen is open drops the pending upload and reads can_manage again', async () => {
  const s = server({ failUploadOnce: true }); const listeners = new Set();
  s.controller.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const original = s.controller.attachments;
  s.controller.attachments = async (path, options = {}) => { const value = await original(path, options);
    return path === '/v1/anexos-empresa/logo' && (options.method ?? 'GET') === 'GET' ? { ...value, can_manage: s.controller.getSnapshot().membership.role === 'admin' } : value; };
  const view = await mountComponent('CompanyLogo.tsx', { controller: s.controller });
  try {
    await settle(view);
    view.input('company-logo-file').props.onChange({ target: { files: [new File([png], 'marca.png', { type: 'image/png' })] } });
    await settle(view);
    assert.match(view.text(), /O envio do logo precisa ser confirmado/); assert.equal(view.guard().changed, true);
    s.controller.setSnapshot({ phase: 'ready', membership: { user_id: admin, role: 'financeiro' } }); for (const listener of listeners) listener();
    await settle(view);
    assert.doesNotMatch(view.text(), /O envio do logo precisa ser confirmado/, 'the upload of the administrador is not offered to the new role');
    assert.throws(() => view.input('company-logo-file')); assert.throws(() => view.button('Remover logo'));
    assert.match(view.text(), /Somente administradores enviam ou removem o logo/); assert.ok(image(view), 'the logo is read again for the new role');
    assert.equal(view.guard().changed, false);
    assert.equal(s.calls.filter(call => call.method === 'PUT').length, 1, 'nothing is sent for the previous role');
  } finally { view.unmount(); }
});

// The recibo of contas a receber with "Exibir cabeçalho com logo e informações da empresa ao imprimir recibo".
const TODAY = todaySP(), PERIOD = defaultTitlePeriod(TODAY), row = n => ({ id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind: 'receivable', version: 1, group_id: '10000000-0000-4000-8000-000000000900', installment: 1, installments: 1,
  contact_id: '10000000-0000-4000-8000-000000000800', contact_name: 'Alfa Sintética', category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null, issued_on: PERIOD.from, due_on: TODAY, competence_on: PERIOD.from,
  account_id: null, account_name: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: TODAY, deleted_at: null, remittance: null, imported: false, amount_cents: '12345', settled_cents: '0', balance_cents: '12345', status: 'open',
  payments: { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false } });
const company = { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 2, data: { legal_name: 'FAGOO Sintética Ltda', trade_name: 'FAGOO', cnpj: '00.000.000/0001-91', street: 'Rua Sintética', number: '1', complement: null, district: 'Centro', city: 'Cidade Sintética', state: 'SP' } } };
function printController({ failLogo = false } = {}) {
  const calls = [];
  return { calls, controller: { async company() { return structuredClone(company); }, async finance() { throw new Error('not used'); },
    async attachments(path, options = {}) { calls.push(path); if (failLogo) throw new AccessError(503); return path === '/v1/anexos-empresa/logo' ? page(logo(1), { can_manage: false }) : new Blob([png]); } } };
}
const printButton = view => view.nodes().find(n => n.type === 'button' && view.nodes() && JSON.stringify(n.props.children) === '"Imprimir"');

test('recibo: the logo of Sua marca joins the company header when the preference is on; a failed logo blocks Imprimir with Tentar novamente', async () => {
  const ok = printController();
  const view = await mountComponent('FinancePrintPreview.tsx', { controller: ok.controller, kind: 'receivable', onClose() {}, receiptHeader: true, print: { mode: 'receipts', source: { kind: 'rows', rows: [row(2)] } } }, { expandChildren: true });
  try {
    await settle(view);
    const img = view.nodes().find(n => n.type === 'img' && n.props.className === 'finance-print-logo');
    assert.match(img.props.src, /^data:image\/png;base64,/); assert.match(view.text(), /FAGOO Sintética Ltda/);
    assert.equal(printButton(view).disabled, false);
  } finally { view.unmount(); }
  const off = printController();
  const plain = await mountComponent('FinancePrintPreview.tsx', { controller: off.controller, kind: 'receivable', onClose() {}, receiptHeader: false, print: { mode: 'receipts', source: { kind: 'rows', rows: [row(2)] } } });
  try { await settle(plain); assert.deepEqual(off.calls, [], 'without the header the logo is not read'); assert.equal(plain.nodes().find(n => n.type === 'img'), undefined); } finally { plain.unmount(); }
  const failing = printController({ failLogo: true });
  const blocked = await mountComponent('FinancePrintPreview.tsx', { controller: failing.controller, kind: 'receivable', onClose() {}, receiptHeader: true, print: { mode: 'receipts', source: { kind: 'rows', rows: [row(2)] } } });
  try {
    await settle(blocked);
    assert.match(blocked.text(), /Não foi possível carregar o logo da empresa/); assert.equal(printButton(blocked).disabled, true);
    await blocked.click('Tentar novamente'); await settle(blocked); assert.equal(failing.calls.length, 2);
    // A logo that keeps failing never blocks the recibo: "Imprimir sem o logo" keeps the company header without the image.
    await blocked.click('Imprimir sem o logo'); await settle(blocked); assert.equal(printButton(blocked).disabled, false);
    assert.equal(blocked.nodes().find(n => n.type === 'img'), undefined); assert.doesNotMatch(blocked.text(), /Não foi possível carregar o logo/);
  } finally { blocked.unmount(); }
});
