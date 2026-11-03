import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { preferencesFixture } from './helpers/preferences-fixture.mjs';
import { fiscalInvoicesRoute, parseFiscalInvoicesRoute, executeFiscalInvoicesRoute, FiscalInvoicesError } from '../src/fiscal-invoices.mjs';
import { COMPANY, SUPPLIER, nfeXml } from './helpers/fiscal-import-xml.mjs';
import { laneUpTo } from './helpers/fiscal-lane.mjs';

// 143 through the real Worker parser and contract on PGlite: "Importar XML NF-e", "Baixar XML" and "Conciliar produtos".
// Synthetic XMLs only (fictitious parties, keys and protocols). Nothing is emitted, transmitted or posted.
const code = expected => error => error.code === expected;
let f, product, ownProduct, supplierContact;
const call = async (path, { method = 'GET', body, user = f.users.fiscal } = {}) => {
  const url = new URL(`https://api.example.test/v1/notas-fiscais${path}`);
  const request = new Request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const parsed = await parseFiscalInvoicesRoute(request, fiscalInvoicesRoute(url.pathname));
  return executeFiscalInvoicesRoute(parsed, { userId: user, rpc: (name, args) => f.rpc(name, args) });
};
const failure = async promise => { try { await promise; return 200; } catch (error) { if (error instanceof FiscalInvoicesError) return error.status; return error.code; } };
const importXml = (xml, options = {}) => call('/importar', { method: 'POST', body: { command_id: options.command ?? randomUUID(), xml }, ...options });
const catalog = async (entity, data) => (await f.rpc('erp_catalog_save', { p_user_id: f.users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record;

before(async () => {
  const base = await preferencesFixture({ lane: laneUpTo('202610200143') });
  f = { ...base, scalar: async (text, args = []) => (await base.db.query(text, args)).rows[0]?.value };
  await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$1::jsonb,$2)", [JSON.stringify({ state: 'SP', cnpj: '11.222.333/0001-81' }), f.users.admin]);
  product = await catalog('products', { name: 'Parafuso do cadastro', code: 'PAR-1', unit: 'UN', kind: 'P', format: 'S', price: '3', gtin: '7891234567895' });
  ownProduct = await catalog('products', { name: 'Produto próprio', code: 'FORN-1', unit: 'UN', kind: 'P', format: 'S', price: '3' });
  supplierContact = await catalog('contacts', { name: 'Fornecedor sintético S.A.', person_type: 'J', document: '12.345.678/0001-95' });
});
after(() => f?.close());

test('143 entry points are SECURITY DEFINER for service_role only and the stored XML is immutable', async () => {
  for (const signature of ['public.erp_fiscal_invoice_import(uuid,uuid,jsonb)', 'public.erp_fiscal_invoice_xml_get(uuid,uuid)', 'public.erp_fiscal_invoice_reconcile(uuid,uuid,jsonb)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') value`, [signature]), false);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    assert.equal(await f.scalar('select prosecdef value from pg_proc where oid=$1::regprocedure', [signature]), true);
  }
  for (const helper of ['erp_fiscal_invoices.company_document()', 'erp_fiscal_invoices.unique_product(text,text)', 'erp_fiscal_invoices.unique_contact(text)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [helper]), false, helper);
  assert.equal(await f.scalar("select has_table_privilege('service_role','erp_fiscal_invoices.invoice_xml','SELECT') value"), false);
});

test('143 a supplier XML becomes a registered entry note (X) with protocol, matched product and contact, and its XML byte for byte', async () => {
  const { xml, key } = nfeXml({ freight: '5.00', items: [{ code: 'FORN-77', name: 'Parafuso sintético', quantity: '10.0000', price: '2.5000', ean: '7891234567895', ipi: '2.50' }, { code: 'FORN-78', name: 'Arruela sintética', quantity: '4.0000', price: '0.7500' }] });
  await assert.rejects(() => importXml(xml, { user: f.users.consulta }), code('42501'));
  const command = randomUUID(), out = await importXml(xml, { command });
  assert.equal(out.imported, true); assert.equal(out.matched_items, 1, 'by GTIN only for supplier notes'); assert.equal(out.contact_matched, true); assert.equal(out.writable, false, 'imported notes are read-only');
  const note = out.invoice;
  assert.deepEqual([note.direction, note.issue_type, note.status, note.environment, note.access_key, note.protocol, note.number, note.series], ['0', 'X', 8, null, key, '135260000000777', 321, 1]);
  assert.equal(note.recipient.name, 'Fornecedor sintético S.A.'); assert.equal(note.recipient.document, SUPPLIER); assert.equal(note.recipient.contact_id, supplierContact.id);
  assert.equal(note.items[0].product_id, product.id); assert.equal(note.items[1].product_id, undefined);
  assert.equal(note.items[0].ipi.situation, '00', 'supplier exit IPI 50 is the entry 00'); assert.equal(note.items[0].others.purchase_order, 'OC-9');
  assert.equal(note.totals.total, '35.50', '25 + 3 + 5 freight + 2.50 IPI'); assert.equal(note.transport.carrier.name, 'Transportadora sintética'); assert.equal(note.payment.installments[0].note, 'Duplicata 001');
  assert.equal((await importXml(xml, { command })).replayed, true, 'same command replays');
  const again = await importXml(xml);
  assert.deepEqual([again.imported, again.refused, again.invoice_id], [false, 'duplicate', note.id]);
  const stored = await call(`/${note.id}/xml`);
  assert.equal(stored.xml, xml); assert.equal(stored.sha256, createHash('sha256').update(xml, 'utf8').digest('hex')); assert.equal(stored.signed, true); assert.equal(stored.protocol_status, '100');
  await assert.rejects(() => f.db.query("update erp_fiscal_invoices.invoice_xml set content='x'"), /erp_fiscal_invoice_history_immutable/);
  const listed = await call('?model=55&direction=0&origin=brufap&status=registered');
  assert.ok(listed.items.some(r => r.id === note.id && r.issue_type === 'X' && r.protocol_present));
  // The form cannot rewrite an imported note: the XML is its source.
  assert.equal(await failure(call(`/${note.id}`, { method: 'PATCH', body: { command_id: randomUUID(), expected_version: 1, invoice: { ...JSON.parse(JSON.stringify(note)), id: undefined } } })), 400);
});

test('143 "Conciliar produtos" links items of an imported note with CAS and audit; other notes are refused', async () => {
  const { xml } = nfeXml({ number: 400, items: [{ code: 'FORN-90', name: 'Peça sem GTIN', quantity: '1.0000', price: '9.0000' }] });
  const note = (await importXml(xml)).invoice;
  assert.equal(note.items[0].product_id, undefined);
  const body = (items, expected = 1) => ({ command_id: randomUUID(), expected_version: expected, items });
  const linked = await call(`/${note.id}/conciliar`, { method: 'POST', body: body([{ position: 1, product_id: product.id }]) });
  assert.equal(linked.invoice.version, 2); assert.equal(linked.invoice.items[0].product_id, product.id); assert.equal(linked.action, 'reconcile');
  assert.equal(await failure(call(`/${note.id}/conciliar`, { method: 'POST', body: body([{ position: 1, product_id: null }]) })), '40001', 'stale version');
  assert.equal(await failure(call(`/${note.id}/conciliar`, { method: 'POST', body: body([{ position: 2, product_id: null }], 2) })), '22023', 'unknown item');
  const unlinked = await call(`/${note.id}/conciliar`, { method: 'POST', body: body([{ position: 1, product_id: null }], 2) });
  assert.equal(unlinked.invoice.items[0].product_id, undefined);
  assert.deepEqual((await f.db.query("select action from erp_fiscal_invoices.audit where entity_id=$1 order by id", [note.id])).rows.map(r => r.action), ['import', 'reconcile', 'reconcile']);
  const nature = (await f.rpc('erp_fiscal_nature_execute', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: 'create', p_data: { nature: { description: 'Compra 143', direction: '0', crt: '1', presence: '9' } } })).nature;
  const typed = (await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'create', p_data: { invoice: { model: '55', direction: '0', issue_type: 'T', series: '1', number: '55', nature_id: nature.id,
    issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '9', recipient: { name: 'Fornecedor', person_type: 'J' }, items: [{ description: 'Item', quantity: '1', unit_price: '1' }] } } })).invoice;
  assert.equal(await failure(call(`/${typed.id}/conciliar`, { method: 'POST', body: body([{ position: 1, product_id: product.id }]) })), '40001', 'only imported notes');
});

test('143 the company as emitter imports an exit note (S) matched by code; other companies and invalid XMLs are refused before any write', async () => {
  const own = nfeXml({ emit: COMPANY, dest: SUPPLIER, number: 900, items: [{ code: 'FORN-1', name: 'Produto próprio', quantity: '2.0000', price: '3.0000' }] });
  const out = await importXml(own.xml);
  assert.deepEqual([out.invoice.direction, out.invoice.issue_type, out.invoice.recipient.name, out.invoice.items[0].product_id, out.invoice.items[0].ipi], ['1', 'S', 'Comprador sintético Ltda', ownProduct.id, undefined]);
  const other = await importXml(nfeXml({ emit: SUPPLIER, dest: '98765432000198', number: 901 }).xml);
  assert.deepEqual([other.imported, other.refused], [false, 'other_company']);
  const before = await f.scalar('select count(*)::integer value from erp_fiscal_invoices.command');
  for (const [options, refused] of [[{ tpAmb: '2' }, 'xml_homologation'], [{ withProtocol: false }, 'xml_not_authorized'], [{ cStat: '110' }, 'xml_not_authorized'], [{ extraTotal: 1 }, 'xml_total_mismatch'],
    [{ version: '3.10' }, 'xml_unsupported'], [{ model: '65', indPres: '9' }, 'xml_unsupported']]) {
    const result = await importXml(nfeXml({ number: 950, ...options }).xml);
    assert.deepEqual([result.imported, result.refused], [false, refused], JSON.stringify(options));
  }
  const mismatch = await importXml(nfeXml({ number: 951, extraTotal: 1 }).xml);
  assert.deepEqual([mismatch.computed_total, mismatch.xml_total], ['27.50', '27.51']);
  for (const xml of ['<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><nfeProc/>', '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe>', 'texto qualquer'])
    assert.equal((await importXml(xml)).refused, 'xml_invalid');
  assert.equal(await f.scalar('select count(*)::integer value from erp_fiscal_invoices.command'), before, 'refusals store no command');
  assert.equal(await failure(call('/importar', { method: 'POST', body: { command_id: randomUUID(), xml: own.xml, extra: 1 } })), 400);
  // The database checks the bytes against the hash the Worker computed.
  const { xml: tampered, key } = nfeXml({ number: 952 });
  await assert.rejects(() => f.rpc('erp_fiscal_invoice_import', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_data: { xml: tampered, sha256: 'a'.repeat(64), size: Buffer.byteLength(tampered), key, signed: true,
    emitter_document: SUPPLIER, recipient_document: COMPANY, protocol: { number: '135260000000777', received_at: '2026-10-18T09:31:05-03:00', status: '100' }, as_emitter: null, as_recipient: null } }), code('22023'));
});

test('143 an imported note is never rewritten by the form, not even as "Emitida por Terceiros" (T)', async () => {
  const { xml } = nfeXml({ number: 960 });
  const note = (await importXml(xml)).invoice;
  const input = JSON.parse(JSON.stringify(note));
  for (const key of ['id', 'version', 'status', 'environment', 'protocol', 'authorized_at', 'created_at', 'updated_at', 'deleted_at', 'delete_reason', 'orders', 'totals']) delete input[key];
  Object.assign(input, { issue_type: 'T', series: String(input.series), number: String(input.number), payment: { condition: null, installments: [] },
    items: input.items.map(({ position, total, allocated, ...item }) => ({ ...item, unit_price: '99' })) });
  assert.equal(await failure(call(`/${note.id}`, { method: 'PATCH', body: { command_id: randomUUID(), expected_version: 1, invoice: input } })), '40001', 'the XML stays the source of the note');
  const stored = (await f.db.query('select issue_type,version,totals->>\'total\' total from erp_fiscal_invoices.invoice where id=$1', [note.id])).rows[0];
  assert.deepEqual([stored.issue_type, stored.version, stored.total], ['X', 1, note.totals.total]);
});
