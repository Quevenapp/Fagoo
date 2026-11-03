import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { nfeXml } from '../../../workers/erp-api/test/helpers/fiscal-import-xml.mjs';
import { DELETE_FINANCE_GROUPED, DELETE_FINANCE_POSTED, DELETE_STOCK_POSTED, SCREENS, deleteBlockedReason, deletePlan, deleteRefusalText } from '../src/lib/fiscal-invoice-list-model.ts';
import { danfeData } from '../src/lib/danfe.ts';
import { danfeJobFile, danfeJobText, newDanfeJob } from '../src/lib/danfe-pdf-job.ts';

// Notas fiscais lane, wave F (synthetic data only, no network): the reason a note with lançamentos is not deleted and the background
// "Gerar PDF DANFE" task of the list.
const port = { saved: [] };
globalThis.document ??= {};
Object.assign(globalThis.document, { activeElement: null, getElementById: () => null, addEventListener: globalThis.document.addEventListener ?? (() => undefined), removeEventListener: globalThis.document.removeEventListener ?? (() => undefined),
  createElement: () => ({ className: '', remove() {}, append() {}, click() {} }), body: { append() {}, appendChild() {}, classList: { add() {}, remove() {} } } });
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const settle = async view => { for (let i = 0; i < 8; i++) { await view.flush(); await new Promise(r => setTimeout(r, 5)); } };
// The buttons of a Modal live in its `actions` prop, outside the children walked by the harness.
const walk = (value, out = []) => { if (Array.isArray(value)) value.forEach(v => walk(v, out)); else if (value && typeof value === 'object' && value.props) { out.push(value); walk(value.props.children, out); } return out; };
const modalButton = (view, title, label) => walk(view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Modal' && n.props.title === title).props.actions).find(n => n.type === 'button' && textOf(n) === label);
// Each click re-reads the tree: a handler of an older render would see the selection of that render.
const selectAll = async view => {
  const count = view.nodes().filter(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('Selecionar nota')).length;
  for (let i = 0; i < count; i++) { view.nodes().filter(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('Selecionar nota'))[i].props.onClick({ shiftKey: false }); await settle(view); }
  return count;
};
const id = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nativeRow = (n, over = {}) => ({ origin: 'brufap', id: id(n), version: 2, number: null, series: 2, issue_date: '2026-10-20', entry_date: null, name: `Cliente ${n}`, document: null, state: 'SP', nature: 'Venda',
  status: 1, status_raw: null, total: '10.00', total_known: true, environment: '2', issue_type: 'N', access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0, orders: [], ...over });
const page = (items, over = {}) => ({ items, origin: items[0]?.origin ?? 'brufap', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: items.length, total_amount: '0.00', amount_unknown: 0,
  brufap_visible: true, show_totals: true, data_mode: items[0]?.origin === 'origin' ? 'origin_mirror_readonly' : 'erp_native_homologation', ...over });

test('a note with contas or stock posted by it is listed with the specific reason, before asking and after the server refuses', () => {
  const posted = { finance: { writable: true, posted: true, grouped: false }, stock: null };
  assert.equal(deleteBlockedReason(posted), DELETE_FINANCE_POSTED);
  assert.equal(deleteBlockedReason({ finance: { writable: false, posted: true, grouped: true }, stock: null }), DELETE_FINANCE_GROUPED);
  assert.equal(deleteBlockedReason({ finance: null, stock: { flag: 'S', reference: null, manage: false } }), DELETE_STOCK_POSTED);
  assert.equal(deleteBlockedReason({ finance: { writable: true, posted: true, grouped: false }, stock: { flag: 'S', reference: null, manage: true } }), `${DELETE_FINANCE_POSTED} ${DELETE_STOCK_POSTED}`);
  // Stock posted by the pedido (R) and unknown lançamentos never block here: the database still decides.
  assert.equal(deleteBlockedReason({ finance: null, stock: { flag: 'R', reference: '7', manage: true } }), null);
  assert.equal(deleteBlockedReason(null), null);
  const rows = [nativeRow(1), nativeRow(2), { ...nativeRow(3), origin: 'origin', id: '9003', version: null }];
  const plan = deletePlan(rows, row => row.id === id(2) ? posted : null);
  assert.deepEqual(plan.eligible.map(item => item.row.id), [id(1)]);
  assert.deepEqual(plan.skipped.map(s => s.message), [DELETE_FINANCE_POSTED, 'Nota do Origin: a exclusão continua no Origin.']);
  assert.equal(deleteRefusalText('finance_posted', null), DELETE_FINANCE_POSTED);
  assert.equal(deleteRefusalText('finance_posted', { finance: { writable: true, posted: false, grouped: true }, stock: null }), DELETE_FINANCE_GROUPED);
  assert.equal(deleteRefusalText('stock_posted', null), DELETE_STOCK_POSTED);
  assert.equal(deleteRefusalText(undefined, null), null); assert.equal(deleteRefusalText('other', null), null);
});

const nativeController = ({ rows, role = 'fiscal', remove }) => ({
  getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(900), role } }), subscribe: () => () => {},
  async fiscalInvoices(path, options = {}) {
    if (path.startsWith('/v1/notas-fiscais?')) return page(rows);
    if (path.endsWith('/excluir')) return remove(path, options);
    throw new AccessError(404);
  },
  async preferences() { return { items: [] }; },
  async listPreferences(path) { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
  async catalog() { return { items: [], has_more: false }; },
});

test('Excluir notas selecionadas: the refusal of the database for posted stock or contas becomes the reason of that note', async () => {
  const rows = [nativeRow(1), nativeRow(2)], sent = [];
  const controller = nativeController({ rows, remove: path => { sent.push(path); throw Object.assign(new AccessError(409), { field: path.includes(id(1)) ? 'stock_posted' : 'finance_posted' }); } });
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout'] });
  try {
    await settle(view);
    assert.equal(await selectAll(view), 2);
    view.nodes().find(n => n.props?.title === 'Excluir notas selecionadas' || (n.type === 'button' && textOf(n).includes('Excluir notas selecionadas'))).props.onClick(); await settle(view);
    const dialog = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'BatchDialog');
    assert.equal(dialog.props.plan.eligible.length, 2, 'without known lançamentos both notes go to the server');
    await assert.rejects(dialog.props.run(dialog.props.plan.eligible[0]), new RegExp(DELETE_STOCK_POSTED.slice(0, 40).replace(/[()⋮]/g, '.')));
    await assert.rejects(dialog.props.run(dialog.props.plan.eligible[1]), new RegExp(DELETE_FINANCE_POSTED.slice(0, 40).replace(/[()⋮]/g, '.')));
    assert.equal(sent.length, 2, 'a definitive refusal is never repeated');
  } finally { view.unmount(); }
});

test('Gerar PDF DANFE builds one PDF with every DANFE or a ZIP with one PDF per note, and says what stayed out', () => {
  const docs = [1, 2].map(n => ({ data: danfeData(nfeXml({ number: 700 + n }).xml), status: null }));
  const single = danfeJobFile(docs, { firstPage: 0, otherPages: 0 }, 'single');
  assert.equal(single.type, 'application/pdf'); assert.equal(single.name, 'DANFE-2-notas.pdf'); assert.ok(Buffer.from(single.bytes).toString('latin1').startsWith('%PDF-1.4'));
  const zip = danfeJobFile(docs, { firstPage: 0, otherPages: 0 }, 'zip');
  assert.equal(zip.type, 'application/zip'); assert.equal(zip.documents, 2); assert.equal(Buffer.from(zip.bytes).readUInt32LE(0), 0x04034b50);
  const text = Buffer.from(zip.bytes).toString('latin1');
  for (const doc of docs) assert.ok(text.includes(`DANFE-${doc.data.key}.pdf`), 'each PDF is named by its access key');
  const one = danfeJobFile(docs.slice(0, 1), { firstPage: 0, otherPages: 0 }, 'zip');
  assert.equal(one.type, 'application/pdf', 'one note is always a PDF'); assert.equal(one.name, `DANFE-${docs[0].data.key}.pdf`);
  assert.throws(() => danfeJobFile([], { firstPage: 0, otherPages: 0 }, 'single'), /DANFE_JOB_EMPTY/);
  assert.match(danfeJobText({ ...newDanfeJob('single'), total: 4, done: 1 }), /1 de 4 notas lidas/);
  assert.match(danfeJobText({ ...newDanfeJob('zip'), running: false, file: zip }), /ZIP pronto com 2 PDF/);
  assert.match(danfeJobText({ ...newDanfeJob('single'), running: false, cancelled: true, total: 4, done: 2 }), /cancelada.*Nenhum arquivo/);
});

test('Gerar PDF DANFE of imported FAGOO records runs in the background and keeps the list usable', async () => {
  const xmls = [801, 802].map(number => nfeXml({ number }));
  const files = xmls.map(({ xml }) => { const bytes = Buffer.from(xml, 'utf8'); return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }; });
  const rows = [nativeRow(1, { number: 801, issue_type: 'S', status: 8, environment: null, access_key: xmls[0].key }),
    nativeRow(2, { number: 802, issue_type: 'S', status: 8, environment: null, access_key: xmls[1].key }), nativeRow(3, { number: 803 })];
  const calls = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(901), role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices(path) { calls.push(path); if (path.startsWith('/v1/notas-fiscais?')) return page(rows, { total_count: 3, total_amount: '75.00' });
      if (path.endsWith('/xml')) { await gate; const index = path.includes(id(1)) ? 0 : 1; return { invoice_id: rows[index].id, access_key: xmls[index].key, xml: xmls[index].xml, sha256: files[index].hash, size: files[index].bytes.length }; } throw new AccessError(404); },
    async preferences() { return { items: [] }; },
    async listPreferences(path) { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout'] });
  try {
    await settle(view);
    await selectAll(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).includes('Gerar PDF DANFE')).props.onClick(); await settle(view);
    view.nodes().find(n => n.type === 'input' && n.props.name === 'fiscal-pdf-format' && !n.props.checked).props.onChange(); await settle(view);
    modalButton(view, 'Gerar PDF DANFE', 'Gerar').props.onClick(); await settle(view);
    let job = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'FiscalDanfePdfJob');
    assert.equal(job.props.state.running, true, 'the task is running while the XMLs are read');
    assert.equal(view.guard().busy, true, 'leaving the screen asks first');
    assert.equal(view.nodes().some(n => typeof n.type === 'function' && n.type.name === 'Modal' && n.props.title === 'Gerar PDF DANFE'), false, 'no modal blocks the list');
    // Another action of the list (Recarregar) does not cancel the task.
    view.nodes().find(n => n.props?.title === 'Recarregar' || (n.type === 'button' && textOf(n) === 'Recarregar'))?.props.onClick?.();
    release(); await settle(view);
    job = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'FiscalDanfePdfJob');
    assert.equal(job.props.state.running, false); assert.equal(job.props.state.file.type, 'application/zip'); assert.equal(job.props.state.file.documents, 2);
    assert.deepEqual(job.props.state.problems, ['Nota 000803: sem XML autorizado para o DANFE.']);
    assert.equal(view.guard().busy, false);
  } finally { view.unmount(); }
});

test('the PDF task stops when the user changes and when Cancelar is pressed, without a file', async () => {
  const { xml, key } = nfeXml({ number: 901 }); const bytes = Buffer.from(xml, 'utf8'), hash = createHash('sha256').update(bytes).digest('hex');
  const rows = [0, 1, 2].map(n => nativeRow(10 + n, { number: 901, status: 8, environment: null, issue_type: 'S', access_key: key }));
  let user = id(902), downloads = 0, gate = null;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: user, role: 'fiscal' } }), subscribe: () => () => {},
    async fiscalInvoices(path) { if (path.startsWith('/v1/notas-fiscais?')) return page(rows);
      if (path.endsWith('/xml')) { downloads++; if (downloads === 1) user = id(903); if (gate) await gate; return { invoice_id: path.split('/').at(-2), access_key: key, xml, sha256: hash, size: bytes.length }; } throw new AccessError(404); },
    async preferences() { return { items: [] }; },
    async listPreferences(path) { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: path.split('/').at(-1), version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog() { return { items: [], has_more: false }; },
  };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout'] });
  try {
    await settle(view);
    await selectAll(view);
    view.nodes().find(n => n.type === 'button' && textOf(n).includes('Gerar PDF DANFE')).props.onClick(); await settle(view);
    modalButton(view, 'Gerar PDF DANFE', 'Gerar').props.onClick(); await settle(view);
    const job = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'FiscalDanfePdfJob');
    assert.equal(job.props.state.running, false); assert.equal(job.props.state.file, null); assert.match(job.props.state.error, /sessão ou o perfil mudou/);
    assert.ok(downloads < rows.length, 'no XML is read for another user');
    // Cancelar stops the task between two notes and no file is offered.
    job.props.onClose(); await settle(view);
    let release; gate = new Promise(resolve => { release = resolve; }); downloads = 1; user = id(902);
    view.nodes().find(n => n.type === 'button' && textOf(n).includes('Gerar PDF DANFE')).props.onClick(); await settle(view);
    modalButton(view, 'Gerar PDF DANFE', 'Gerar').props.onClick(); await settle(view);
    const running = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'FiscalDanfePdfJob');
    assert.equal(running.props.state.running, true);
    running.props.onCancel(); release(); await settle(view);
    const cancelled = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'FiscalDanfePdfJob').props.state;
    assert.deepEqual([cancelled.running, cancelled.cancelled, cancelled.file], [false, true, null]);
    assert.equal(downloads, 2, 'no other XML is read after Cancelar');
  } finally { view.unmount(); }
});

// ---- "Validar" (Outras opções de NF-e) and "Gerar XML (suporte)" (⋮ da NFC-e): native XML of a note of the Brufap (273) ----
const { validateNativeInvoice } = await import('../../../packages/fiscal-xml/src/native-invoice.mjs');
const fixtures = await import('../../../packages/fiscal-xml/test/native-invoice-fixtures.mjs');
const { nativeXmlBlock, nativeXmlResult } = await import('../src/lib/fiscal-native-xml.ts');
const { rowActions } = await import('../src/lib/fiscal-invoice-list-model.ts');
const nativeAnswer = (invoice, over = {}) => {
  const r = validateNativeInvoice(fixtures.source(invoice, over));
  return { invoice_id: invoice.id, invoice_version: invoice.version, model: invoice.model, series: invoice.series, number: r.number, number_provisional: true, access_key: r.access_key, issued_at: r.issued_at, xml: r.xml,
    xml_bytes: Buffer.byteLength(r.xml), xml_sha256: createHash('sha256').update(r.xml).digest('hex'), schema: r.schema, rules: r.rules, valid: r.valid, signed: false, transmitted: false, numbering_reserved: false, environment: '2', data_mode: 'erp_native_homologation' };
};

test('the answer of the native XML is checked before it is shown: size, SHA-256, key, homologation and the valid flag', async () => {
  const invoice = fixtures.record(), answer = nativeAnswer(invoice);
  const result = await nativeXmlResult(answer, invoice.id);
  assert.equal(result.valid, true); assert.equal(result.number, 41);
  for (const change of [a => { a.xml = a.xml.replace('<tpAmb>2</tpAmb>', '<tpAmb>1</tpAmb>'); }, a => { a.xml_sha256 = '0'.repeat(64); }, a => { a.signed = true; }, a => { a.numbering_reserved = true; },
    a => { a.valid = false; }, a => { a.invoice_id = id(77); }, a => { a.rules = [{ severity: 'error', message: 'x', field: null }]; }, a => { a.schema.errors = 'x'; }])
    await assert.rejects(nativeXmlResult((c => { change(c); return c; })(structuredClone(answer)), invoice.id), /NATIVE_XML_RESPONSE_INVALID/);
  assert.equal(nativeXmlBlock({ origin: 'origin', issue_type: null }, true).startsWith('Nota do Origin'), true);
  assert.match(nativeXmlBlock({ origin: 'brufap', issue_type: 'X' }, true), /registrada/); assert.match(nativeXmlBlock({ origin: 'brufap', issue_type: 'T' }, true), /registrada/);
  assert.match(nativeXmlBlock({ origin: 'brufap', issue_type: 'N' }, false), /administrador e fiscal/); assert.equal(nativeXmlBlock({ origin: 'brufap', issue_type: 'C' }, true), null);
  const nfceRow = nativeRow(5, { issue_type: 'C' });
  const actions = rowActions(SCREENS.nfce, nfceRow, { writable: true });
  const labels = actions.map(a => a.label);
  assert.ok(labels.indexOf('Gerar XML (suporte)') === labels.indexOf('Exportar XML') + 1, 'Origin order: Exportar XML · Gerar XML (suporte)');
  assert.equal(actions.find(a => a.id === 'support_xml').enabled, true);
  assert.equal(rowActions(SCREENS.nfce, { ...nfceRow, origin: 'origin', id: '9', version: null }, { writable: true }).find(a => a.id === 'support_xml').enabled, false);
  assert.equal(rowActions(SCREENS.nfe, nativeRow(6), { writable: true }).some(a => a.id === 'support_xml'), false, 'the NF-e menu of Origin has no Gerar XML (suporte)');
});

test('Validar shows the errors of the layout and of the rules; Gerar XML (suporte) shows and downloads the XML; a late answer is dropped', async () => {
  const invoice = fixtures.record({ items: [fixtures.item({ ncm: null })] });
  const nfceInvoice = fixtures.record({ model: '65', issue_type: 'C', presence: '1', final_consumer: true, recipient: {}, payment: { installments: [{ date: '2026-10-20', amount: '25.00', method: '01' }] } });
  const answers = { [invoice.id]: nativeAnswer(invoice) };
  const row = nativeRow(1, { id: invoice.id }), calls = [];
  let hold = null;
  const controller = { ...nativeController({ rows: [row], remove: () => { throw new AccessError(500); } }) };
  const list = controller.fiscalInvoices;
  controller.fiscalInvoices = async (path, options) => { calls.push(path); if (path.endsWith('/xml-nativo')) { if (hold) await hold; return answers[path.split('/').at(-2)]; } return list(path, options); };
  const view = await mountComponent('RealFiscalInvoices.tsx', { controller, screen: 'nfe' }, { location: '/historico-fiscal?modelo=55&origem=brufap', expandChildren: ['NativeListLayout'] });
  try {
    await settle(view);
    const menu = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'RowMenu');
    menu.props.items.find(i => i.label === 'Outras opções de NF-e').onClick(); await settle(view);
    const validar = view.nodes().find(n => n.type === 'button' && textOf(n) === 'Validar');
    assert.equal(validar.disabled, false);
    validar.props.onClick(); await settle(view);
    assert.ok(calls.includes(`/v1/notas-fiscais/${invoice.id}/xml-nativo`));
    const dialog = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'FiscalNativeXmlDialog');
    assert.equal(dialog.props.mode, 'validate'); assert.equal(dialog.props.result.valid, false);
    assert.deepEqual(dialog.props.result.schema.errors.map(e => e.message), ['Falta o campo NCM em /NFe/infNFe/det/prod (antes de CFOP).']);
    assert.ok(dialog.props.result.rules.some(r => r.message === 'Item 1: informe o NCM (8 dígitos).'));
    dialog.props.onClose(); await settle(view);
    // A late answer after another row action (Clonar nota reads the note) never opens the dialog.
    let release; hold = new Promise(resolve => { release = resolve; });
    view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'RowMenu').props.items.find(i => i.label === 'Outras opções de NF-e').onClick(); await settle(view);
    view.nodes().find(n => n.type === 'button' && textOf(n) === 'Validar').props.onClick(); await settle(view);
    view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'RowMenu').props.items.find(i => i.label === 'Clonar nota').onClick(); await settle(view);
    release(); await settle(view);
    assert.equal(view.nodes().some(n => typeof n.type === 'function' && n.type.name === 'FiscalNativeXmlDialog'), false, 'the late answer is dropped');
    hold = null;
  } finally { view.unmount(); }
  const dialogView = await mountComponent('FiscalNativeXmlDialog.tsx', { mode: 'support', result: await nativeXmlResult(nativeAnswer(nfceInvoice), nfceInvoice.id), onClose() {} });
  try {
    const text = dialogView.text();
    assert.match(text, /número previsto 41 da série 2 \(não reservado\)/); assert.match(text, /homologação, sem valor fiscal/);
    assert.ok(dialogView.nodes().some(n => n.type === 'pre' && textOf(n).includes('<infNFeSupl>')), 'the XML of the NFC-e with its QR Code supplement is shown');
  } finally { dialogView.unmount(); }
});

// ---- "Importar XML" (NFC-e) and "Lançar Contas / Lançar Estoque" of the import (274) ----
const importXmlHelper = await import('../../../workers/erp-api/test/helpers/fiscal-import-xml.mjs');
const importedRecord = (invoiceOver = {}) => {
  const base = fixtures.record({ model: '65', issue_type: 'C', presence: '1', final_consumer: true, recipient: {}, payment: { installments: [{ date: '2026-10-20', amount: '25.00', method: '01' }] } });
  const { accessKey } = importXmlHelper;
  return { ...base, issue_type: 'S', environment: null, status: 8, number: 77, access_key: accessKey({ cnpj: '11222333000181', series: 2, number: 77, model: '65' }), ...invoiceOver };
};
test('Importar XML of the NFC-e: Lançar Contas and Lançar Estoque go on with the flows of the note for the profiles that post them', async () => {
  const { importRefusalText, IMPORT_REFUSALS } = await import('../src/lib/fiscal-invoice-list-model.ts');
  for (const code of ['xml_signature_missing', 'xml_signature_invalid', 'nfce_recipient']) assert.ok(IMPORT_REFUSALS.includes(code), code);
  assert.match(importRefusalText({ refused: 'xml_signature_invalid', field: 'DigestValue' }), /assinatura digital do XML não confere \(DigestValue\)/);
  assert.match(importRefusalText({ refused: 'nfce_recipient' }), /empresa é a emitente/);
  const record = importedRecord();
  const snapshot = { role: 'admin' };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(950), role: snapshot.role } }), subscribe: () => () => {},
    async fiscalInvoices(path, options) { if (path.endsWith('/importar')) return { imported: true, matched_items: 1, contact_matched: false, action: 'import', replayed: false, invoice: record, writable: false,
      emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native' }; void options; throw new AccessError(404); },
    async finance() { throw new AccessError(404); }, async stock() { throw new AccessError(404); },
  };
  const fiscalView = await mountComponent('FiscalImportDialog.tsx', { controller: { ...controller, getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(951), role: 'fiscal' } }) }, model: '65', initial: { name: 'nfce.xml', xml: '<x/>' }, onClose() {}, onOpen() {} });
  try {
    const modal = fiscalView.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Modal');
    assert.equal(modal.props.title, 'Importar XML NFC-e');
    assert.equal(fiscalView.input('fiscal-import-finance').disabled, true); assert.match(fiscalView.input('fiscal-import-finance').props.title, /administrador e financeiro/);
    assert.equal(fiscalView.input('fiscal-import-stock').disabled, true); assert.match(fiscalView.input('fiscal-import-stock').props.title, /administrador e estoque/);
  } finally { fiscalView.unmount(); }
  const view = await mountComponent('FiscalImportDialog.tsx', { controller, model: '65', initial: { name: 'nfce.xml', xml: '<x/>' }, onClose() {}, onOpen() {} });
  try {
    assert.equal(view.input('fiscal-import-finance').disabled, false); assert.equal(view.input('fiscal-import-stock').disabled, false);
    await view.change('fiscal-import-finance', true); await view.change('fiscal-import-stock', true);
    const modal = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'Modal');
    walk(modal.props.actions).find(n => n.type === 'button' && textOf(n) === 'Importar').props.onClick(); await settle(view);
    let root = view.nodes()[0];
    assert.equal(root.type.name, 'FiscalInvoiceFinance', 'Lançar contas of the imported note opens first'); assert.equal(root.props.invoiceId, record.id);
    root.props.onChanged(); root.props.onClose(); await settle(view);
    root = view.nodes()[0];
    assert.equal(root.type.name, 'InvoiceStockDialog'); assert.deepEqual([root.props.invoiceId, root.props.mode], [record.id, 'post']);
    root.props.onDone('Estoque lançado no depósito Geral.'); await settle(view);
    const text = view.text();
    assert.match(text, /Sua nota foi importada com sucesso/); assert.match(text, /Contas lançadas pela nota\. Estoque lançado no depósito Geral\./);
  } finally { view.unmount(); }
});

test('an imported NFC-e exports its stored XML from the ⋮, shows its type and is cloned as an NFC-e of the FAGOO', async () => {
  const { cloneDraft, issueOptions } = await import('../src/lib/fiscal-invoice-form-model.ts');
  const record = importedRecord();
  const row = nativeRow(8, { id: record.id, issue_type: 'S', status: 8, environment: null, number: 77, access_key: record.access_key });
  const actions = rowActions(SCREENS.nfce, row, { writable: true });
  assert.deepEqual([actions.find(a => a.id === 'xml').enabled, actions.find(a => a.id === 'support_xml').enabled], [true, false], 'the stored XML exists; the native XML does not');
  assert.equal(rowActions(SCREENS.nfce, nativeRow(9, { issue_type: 'C' }), { writable: true }).find(a => a.id === 'xml').enabled, false, 'an NFC-e of the FAGOO has no authorized XML');
  assert.deepEqual(issueOptions('1', '65').find(([v]) => v === 'S'), ['S', 'Importação de XML de saída']);
  const clone = cloneDraft(record);
  assert.deepEqual([clone.model, clone.issue_type, clone.number, clone.access_key], ['65', 'C', '', ''], 'model 65 is only C for an own note');
  assert.deepEqual([cloneDraft(record, { toNfe: true }).model, cloneDraft(record, { toNfe: true }).issue_type], ['55', 'N']);
});

// ---- "Vincular à pedido de compra" item a item (275) ----
test('item links: the proposal by product, the limits of the pedido and of the note item, and the summary', async () => {
  const { defaultLinkLines, linkLineItems, linkLineProblems, linkSummary, orderItemsState, qty } = await import('../src/lib/fiscal-order-item-links.ts');
  const P = id(300), Q = id(301), I1 = id(310), I2 = id(311), I3 = id(312);
  const note = [{ position: 1, product_id: P, description: 'Peça P', quantity: '6.0000' }, { position: 2, product_id: P, description: 'Peça P', quantity: '4.0000' }, { position: 3, product_id: Q, description: 'Peça Q', quantity: '1.0000' }];
  const order = [{ id: I1, product_id: P, description: 'Peça P', quantity: '8.000000' }, { id: I2, product_id: P, description: 'Peça P outra', quantity: '5' }, { id: I3, product_id: null, description: 'Serviço', quantity: '1' }, { id: null, description: 'Sem id', quantity: '1' }];
  const lines = defaultLinkLines(note, order, [{ document_item_id: I2, quantity: '1.0000' }]);
  assert.deepEqual(lines.map(l => [l.document_item_id, l.position, l.quantity]), [[I1, 1, '6'], [I2, 2, '4'], [I3, null, '']], 'what is left of each note item is used once');
  assert.deepEqual(linkLineProblems(lines, note), []);
  assert.deepEqual(linkLineItems(lines), [{ position: 1, document_item_id: I1, quantity: '6.0000' }, { position: 2, document_item_id: I2, quantity: '4.0000' }]);
  assert.deepEqual(linkSummary(lines), { linked: 1, open: 2, total: 3 }, 'I2 is complete with the 1 of the other notes');
  const wrong = lines.map((l, i) => i === 0 ? { ...l, position: 3 } : i === 1 ? { ...l, quantity: '4,5' } : { ...l, position: 1, quantity: '1' });
  const problems = linkLineProblems(wrong, note);
  assert.ok(problems.some(p => /Peça P: o item 3 da nota é de outro produto/.test(p)));
  assert.ok(problems.some(p => /Peça P outra: a quantidade passa do que falta vincular no pedido \(4\)/.test(p)));
  assert.ok(problems.some(p => /Item 2 da nota: as quantidades passam da quantidade da nota \(4\)/.test(p)), '4,5 of an item of 4');
  assert.ok(linkLineProblems([{ ...lines[0], quantity: '7' }], note).some(p => /Item 1 da nota: as quantidades passam da quantidade da nota \(6\)/.test(p)));
  assert.ok(linkLineProblems([{ ...lines[0], quantity: '0' }], note).some(p => /maior que zero/.test(p)));
  assert.equal(qty('1,23456'), -1n); assert.equal(qty('2,5'), 25000n);
  assert.throws(() => orderItemsState({ invoice_id: id(1), document_id: id(2), linked: true, items: [{ invoice_position: 1, document_item_id: 'x', quantity: '1.0000', counted: '1.0000', valid: true }], others: [], state: 'linked', data_mode: 'erp_native' }, id(1), id(2)));
  assert.equal(orderItemsState({ invoice_id: id(1), document_id: id(2), linked: false, items: [], others: [], state: 'none', data_mode: 'erp_native' }, id(1), id(2)).state, 'none');
});

// ---- "Editar NF-e" of Notas recebidas (the received NF-e as an entry note to complete and save) ----
test('Editar NF-e opens the note of the key when the FAGOO has it, and otherwise the entry note read from the checked XML', async () => {
  const { xmlDraft } = await import('../src/lib/fiscal-invoice-form-model.ts');
  const { normalizeInvoiceInput } = await import('../../../packages/erp-domain/src/fiscal-invoice-contract.mjs');
  const { xml, key } = importXmlHelper.nfeXml({ number: 777 });
  const entry = normalizeInvoiceInput({ model: '55', direction: '0', issue_type: 'T', series: '1', number: '777', access_key: key, nature_description: 'Venda de mercadoria sintética', issue_date: '2026-10-18', crt: '3', purpose: '1', presence: '9', final_consumer: false,
    recipient: { name: 'Fornecedor sintético S.A.', person_type: 'J', document: '12345678000195', state: 'SP' }, items: [{ description: 'Parafuso sintético', code: 'FORN-1', quantity: '10', unit_price: '2.5', icms: { origin: '0', situation: '00' } }] });
  const draft = xmlDraft(entry, { company: { crt: '3', state: 'SP' }, series: [], defaults: { CJ: { id: id(70), description: 'Compra de PJ' } }, preferences: null });
  assert.deepEqual([draft.issue_type, draft.direction, draft.number, draft.access_key, draft.nature_id, draft.nature_description, draft.items.length], ['T', '0', '777', key, id(70), 'Compra de PJ', 1]);
  const bytes = new TextEncoder().encode(xml), channel = id(31), hash = createHash('sha256').update(bytes).digest('hex');
  const FLAGS = { data_mode: 'received_dfe', model: '55', transport_enabled: false, can_query: false, can_manifest: false, can_emit: false, origin_authenticated: false, signature_verified: false, xsd_validated: false, sefaz_authorized: false, financial_mutation_performed: false, stock_mutation_performed: false };
  const current = { id: channel, environment: '1', identity_version: 1, version: 1, coordinator: 'external', other_consumers_reviewed: false, checkpoint: null, checkpoint_confirmed: false, collection_requested: false, paused: false, has_active_attempt: false, not_before: null, updated_at: '2026-10-16T12:00:00.123456Z', company_changed: false };
  const row = { id: id(32), channel_id: channel, nsu: '000000000000009', kind: 'invoice', schema: 'procNFe_v4.00.xsd', model: '55', access_key: key, recipient_match: true, quarantined: false, xml_hash: hash, size_bytes: bytes.byteLength, collected_at: '2026-10-16T12:00:00Z', is_complete_invoice: true };
  let existing = [];
  const posts = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: id(990), role: 'fiscal' } }), subscribe: () => () => {},
    async dfeDistribution(path) { return path.includes('/documents') ? { ...FLAGS, channel_id: channel, items: [row], limit: 25, has_more: false, next_cursor: null } : { ...FLAGS, current }; },
    async dfeDistributionDownload() { return new Blob([bytes]); },
    async fiscalInvoices(path, options = {}) {
      if (path === `/v1/notas-fiscais/chave/${key}`) return { key, items: existing, data_mode: 'erp_native' };
      if (path === '/v1/notas-fiscais/importar/previa') { posts.push(options.body); return { previewed: true, key, recipient_document: '11222333000181', emitter_document: '12345678000195', total: '27.50', invoice: entry, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('RealReceivedDfe.tsx', { controller, initialEnvironment: '1' }, { location: '/notas-recebidas' });
  try {
    await settle(view);
    view.nodes().find(n => n.type === 'button' && textOf(n) === 'Editar NF-e').props.onClick(); await settle(view);
    const form = view.nodes()[0];
    assert.equal(form.type.name, 'FiscalInvoiceForm'); assert.equal(form.props.opening.kind, 'xml'); assert.equal(form.props.opening.input.access_key, key); assert.equal(form.props.id, null);
    assert.equal(form.props.config.screen, 'entrada');
    assert.equal(posts[0].xml, xml, 'the checked bytes go to the preview as they are');
    form.props.onBack(); await settle(view);
    // A note of the Brufap with the key already: it opens instead.
    existing = [{ origin: 'brufap', id: id(55), model: '55', direction: '0', number: 777, series: 1, issue_date: '2026-10-18', name: 'Fornecedor', total: '27.50' }];
    view.nodes().find(n => n.type === 'button' && textOf(n) === 'Editar NF-e').props.onClick(); await settle(view);
    assert.equal(view.location().pathname, '/notas-entrada'); assert.equal(new URLSearchParams(view.location().search).get('nota'), id(55));
    assert.equal(posts.length, 1, 'no preview for a note that exists');
  } finally { view.unmount(); }
});
