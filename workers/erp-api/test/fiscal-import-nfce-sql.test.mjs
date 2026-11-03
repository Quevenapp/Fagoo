import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveFFixture, migrationText } from './helpers/fiscal-wave-f-fixture.mjs';
import { COMPANY, SUPPLIER, nfeXml } from './helpers/fiscal-import-xml.mjs';

// 202610200274 on PGlite over every migration applied in production, through the real Worker handler (synthetic XMLs signed with a
// synthetic certificate in memory): "Importar XML" of the NFC-e, the signature check of every imported XML and what the import keeps.
let f;
before(async () => {
  f = await fiscalWaveFFixture({ upto: '202610200274' });
  await f.company();
});
after(() => f?.close());
const nfce = (over = {}) => nfeXml({ model: '65', emit: COMPANY, dest_block: false, crt: '1', transport: false, dup: false, items: [{ code: 'P-65', name: 'Produto de balcão', quantity: '2.0000', price: '10.0000' }],
  pay: [{ tPag: '01', vPag: '25.00' }], change: '5.00', ...over });
const importXml = (xml, user = f.users.fiscal) => f.call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml }, user);

test('274: the import keeps its rules (SECURITY DEFINER, service_role only), the replaced body was hash-checked and the table accepts model 65 with S', async () => {
  const sig = 'public.erp_fiscal_invoice_import(uuid,uuid,jsonb)';
  assert.deepEqual((await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role, sig]), false);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  const text = await migrationText('202610200274_fiscal_import_nfce_signature.sql');
  assert.match(text, /fiscal_import_274_previous_definition_changed/); assert.match(text, /^-- 274[\s\S]*\nbegin;[\s\S]*\ncommit;\n$/);
  const checks = (await f.db.query("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='erp_fiscal_invoices.invoice'::regclass and contype='c'")).rows.map(r => r.d);
  assert.ok(checks.some(d => /WHEN \(model = '65'::text\) THEN \(issue_type = ANY \(ARRAY\['C'::text, 'S'::text\]\)\)/.test(d)));
  assert.equal(checks.some(d => d === "CHECK (((model = '65'::text) = (issue_type = 'C'::text)))"), false);
});

test('274: an NFC-e of the company is imported as an exit note (S, model 65), with the change of the cash payment and the verified signature', async () => {
  const { xml, key } = nfce();
  const { status, value } = await importXml(xml);
  assert.equal(status, 200, JSON.stringify(value));
  assert.equal(value.imported, true);
  const invoice = value.invoice;
  assert.deepEqual([invoice.model, invoice.issue_type, invoice.direction, invoice.status, invoice.access_key, invoice.environment, invoice.final_consumer], ['65', 'S', '1', 8, key, null, true]);
  assert.deepEqual(invoice.payment.installments.map(p => [p.amount, p.method]), [['20.00', '01']], 'the troco stays out of the parcels');
  assert.equal(invoice.totals.total, '20.00');
  assert.deepEqual((await f.db.query('select signature_verified,signed from erp_fiscal_invoices.invoice_xml where invoice_id=$1', [invoice.id])).rows[0], { signature_verified: true, signed: true });
  // It is listed in the NFC-e of the Brufap and its XML is handed back checked.
  const list = await f.call('/v1/notas-fiscais?model=65&origin=brufap');
  assert.equal(list.status, 200); assert.ok(list.value.items.some(row => row.id === invoice.id && row.issue_type === 'S'));
  const stored = await f.call(`/v1/notas-fiscais/${invoice.id}/xml`);
  assert.equal(stored.status, 200); assert.equal(stored.value.xml, xml);
  // The same key again is a duplicate.
  const again = await importXml(xml);
  assert.deepEqual([again.value.imported, again.value.refused, again.value.invoice_id], [false, 'duplicate', invoice.id]);
});

test('274: an imported NFC-e or NF-e posts its stock and contas by the flows of the note (what Lançar Contas / Lançar Estoque of the import open)', async () => {
  const product = await f.catalog('products', { name: 'Produto de balcão', code: 'P-65-B', unit: 'UN', kind: 'P', format: 'S', price: '10' });
  const depot = await f.warehouse('Depósito NFC-e');
  await f.rpc('erp_stock_launch', { p_user_id: f.users.estoque, p_command_id: randomUUID(), p_kind: 'receipt', p_product_id: product.id, p_warehouse_id: depot.id, p_quantity: '10',
    p_expected_version: 0, p_unit_price: null, p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null });
  const { xml } = nfce({ number: 655, items: [{ code: 'P-65-B', name: 'Produto de balcão', quantity: '2.0000', price: '10.0000' }] });
  const imported = (await importXml(xml, f.users.admin)).value;
  assert.equal(imported.matched_items, 1, 'the item of the NFC-e is linked by the code of the product');
  const invoice = imported.invoice;
  const stock = await f.rpc('erp_stock_invoice_get', { p_user_id: f.users.admin, p_invoice_id: invoice.id });
  assert.equal(stock.invoice.screen, 'nfce');
  const preview = await f.rpc('erp_stock_invoice_preview', { p_user_id: f.users.admin, p_invoice_id: invoice.id, p_expected_version: invoice.version, p_warehouse_id: depot.id });
  const posted = await f.rpc('erp_stock_invoice_post', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_invoice_id: invoice.id, p_expected_version: invoice.version, p_warehouse_id: depot.id, p_preview_hash: preview.preview.preview_hash });
  assert.equal(posted.flag.flag, 'S');
  // A consumer NFC-e without destinatário has no contact for the conta: Lançar contas shows why (the import never posts silently).
  const finance = await f.rpc('erp_finance_invoice_finance_get', { p_user_id: f.users.admin, p_invoice_id: invoice.id });
  assert.equal(finance.blocked_reason, 'erp_finance_invalid_contact');
});

test('274: refusals: an NFC-e with the company as consumer, a changed XML, an unsigned XML and a certificate of another company never write', async () => {
  const before = await f.scalar('select count(*)::integer v from erp_fiscal_invoices.invoice');
  const consumer = nfeXml({ model: '65', emit: SUPPLIER, dest: COMPANY, crt: '1', transport: false, dup: false, items: [{ code: 'X', name: 'Compra no balcão', quantity: '1.0000', price: '5.0000' }], number: 660 });
  assert.equal((await importXml(consumer.xml)).value.refused, 'nfce_recipient');
  const { xml } = nfce({ number: 661 });
  const changed = await importXml(xml.replace('Produto de balcão', 'Produto alterado'));
  assert.deepEqual([changed.value.imported, changed.value.refused, changed.value.field], [false, 'xml_signature_invalid', 'DigestValue']);
  assert.equal((await importXml(nfce({ number: 662, signature: 'none' }).xml)).value.refused, 'xml_signature_missing');
  assert.equal((await importXml(nfce({ number: 663, signer: SUPPLIER }).xml)).value.refused, 'xml_signature_invalid');
  assert.equal((await importXml(nfeXml({ number: 664, signature: 'fake' }).xml)).value.refused, 'xml_signature_invalid');
  assert.equal(await f.scalar('select count(*)::integer v from erp_fiscal_invoices.invoice'), before, 'nothing was written');
  // An NF-e of a supplier keeps importing as before (X), now with the verified signature.
  const entry = await importXml(nfeXml({ number: 665 }).xml);
  assert.deepEqual([entry.value.imported, entry.value.invoice.issue_type], [true, 'X']);
  assert.equal(await f.scalar('select signature_verified v from erp_fiscal_invoices.invoice_xml where invoice_id=$1', [entry.value.invoice.id]), true);
});

test('274: before the migration, the new Worker keeps importing NF-e and the NFC-e is refused by the database (database first)', async () => {
  const old = await fiscalWaveFFixture({ upto: '0' });
  try {
    await old.company();
    const entry = await old.call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: nfeXml({ number: 670 }).xml }, old.users.fiscal);
    assert.deepEqual([entry.status, entry.value.imported], [200, true]);
    const nfceAnswer = await old.call('/v1/notas-fiscais/importar', 'POST', { command_id: randomUUID(), xml: nfce({ number: 671 }).xml }, old.users.fiscal);
    assert.equal(nfceAnswer.status, 400);
    assert.equal(await old.scalar("select count(*)::integer v from erp_fiscal_invoices.invoice where model='65'"), 0);
  } finally { await old.close(); }
});

test('Editar NF-e (Notas recebidas): the received NF-e of a supplier is answered as an entry note for the form, checked like the import, and nothing is stored', async () => {
  const before = await f.scalar('select count(*)::integer v from erp_fiscal_invoices.invoice');
  const { xml, key } = nfeXml({ number: 690 });
  const { status, value } = await f.call('/v1/notas-fiscais/importar/previa', 'POST', { xml }, f.users.fiscal);
  assert.equal(status, 200, JSON.stringify(value));
  assert.deepEqual([value.previewed, value.key, value.invoice.issue_type, value.invoice.direction, value.invoice.number, value.invoice.access_key, value.invoice.recipient.document], [true, key, 'T', '0', '690', key, SUPPLIER]);
  assert.equal(value.total, '27.50', 'the total of the XML, recomputed by the contract of the note');
  assert.equal(await f.scalar('select count(*)::integer v from erp_fiscal_invoices.invoice'), before, 'the preview stores nothing');
  // Only the profiles that write notes, and the same refusals as the import.
  assert.equal((await f.call('/v1/notas-fiscais/importar/previa', 'POST', { xml }, f.users.consulta)).status, 403);
  assert.equal((await f.call('/v1/notas-fiscais/importar/previa', 'POST', { xml: xml.replace('Parafuso sintético', 'Prego') }, f.users.fiscal)).value.refused, 'xml_signature_invalid');
  assert.equal((await f.call('/v1/notas-fiscais/importar/previa', 'POST', { xml: nfce({ number: 691 }).xml }, f.users.fiscal)).value.refused, 'xml_unsupported', 'the NFC-e is not a purchase note');
  assert.equal((await f.call('/v1/notas-fiscais/importar/previa', 'POST', { xml, extra: 1 }, f.users.fiscal)).status, 400);
  // The entry note of the preview is saved by the form as "Emitida por Terceiros" with the key of the supplier.
  const nature = await f.nature({ description: 'Compra editada', direction: '0', crt: '1', presence: '9' });
  const saved = await f.call('/v1/notas-fiscais', 'POST', { command_id: randomUUID(), invoice: { ...value.invoice, nature_id: nature.id } }, f.users.fiscal);
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); assert.deepEqual([saved.value.invoice.issue_type, saved.value.invoice.access_key], ['T', key]);
  assert.equal((await importXml(xml)).value.refused, 'duplicate', 'the import then finds the note of that key');
});
