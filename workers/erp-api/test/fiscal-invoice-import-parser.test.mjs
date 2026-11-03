import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceImportCandidates, InvoiceImportError, IMPORT_MAX_BYTES } from '../../../packages/fiscal-xml/src/invoice-import.mjs';
import { normalizeInvoiceInput, invoiceTotals } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { COMPANY, SUPPLIER, nfeXml } from './helpers/fiscal-import-xml.mjs';

// The XML reader of "Importar XML NF-e" (Worker side, no Node built-ins), on synthetic XMLs only.
const reason = fn => { try { fn(); return null; } catch (error) { assert.ok(error instanceof InvoiceImportError, String(error)); return error.reason; } };

test('reads parties, items, taxes, transport, parcels and the protocol into the field contract', () => {
  const { xml, key, total } = nfeXml({ freight: '1.00', discount: '0.50', items: [{ code: 'A-1', name: 'Item com IPI', quantity: '2.0000', price: '5.5000', ean: '7891234567895', ipi: '1.10' }, { code: 'A-2', name: 'Item sem GTIN', quantity: '1.5000', price: '3.0000' }] });
  const read = invoiceImportCandidates(`﻿${xml}`);
  assert.equal(read.key, key); assert.equal(read.total, total); assert.equal(read.emitter_document, SUPPLIER); assert.equal(read.recipient_document, COMPANY); assert.equal(read.signed, true);
  assert.deepEqual(read.protocol, { number: '135260000000777', received_at: '2026-10-18T09:31:05-03:00', status: '100' });
  const entry = normalizeInvoiceInput(read.as_recipient), exit = normalizeInvoiceInput(read.as_emitter);
  assert.equal(invoiceTotals(entry).totals.total, total); assert.equal(entry.discount, '0.50'); assert.equal(entry.freight, '1.00');
  assert.deepEqual([entry.direction, entry.issue_type, entry.number, entry.series, entry.crt, entry.issue_date, entry.exit_date, entry.exit_time], ['0', 'T', '321', '1', '3', '2026-10-18', '2026-10-18', '10:00']);
  assert.equal(entry.recipient.name, 'Fornecedor sintético S.A.'); assert.equal(entry.recipient.ie_indicator, '1'); assert.equal(entry.recipient.municipality_code, '3550308');
  assert.equal(exit.recipient.email, 'compras@sintetico.invalid'); assert.equal(exit.direction, '1');
  assert.deepEqual(entry.items[0].icms, { origin: '0', situation: '00', bc_mode: '3', base: '11.00', rate: '18.0000', value: '1.98' });
  assert.equal(entry.items[0].ipi.situation, '00'); assert.equal(exit.items[0].ipi.situation, '50', 'the exit reading keeps the XML situation');
  assert.equal(entry.items[1].gtin, 'SEM GTIN'); assert.equal(entry.items[0].info, 'Lote sintético 1'); assert.equal(entry.items[0].others.purchase_order, 'OC-9');
  assert.deepEqual(entry.transport.volumes, { quantity: '2', species: 'caixas', brand: 'Sintética', gross_weight: '11.250', net_weight: '10.500' });
  assert.equal(entry.transport.carrier.document, '98765432000198'); assert.equal(entry.payment.installments[0].method, '15');
  assert.equal(entry.additional_info, 'Pedido do cliente OC-9. Documento sintético.');
});

test('a note without carrier or duplicatas keeps the freight mode and pays by detPag; a CPF recipient is a person', () => {
  const read = invoiceImportCandidates(nfeXml({ transport: false, dup: false, destCpf: '12345678909' }).xml);
  const exit = normalizeInvoiceInput(read.as_emitter);
  assert.deepEqual([exit.transport.mode, exit.transport.freight_by], ['none', '9']);
  assert.deepEqual(exit.payment.installments.map(i => [i.date, i.method]), [['2026-10-18', '15']]);
  assert.deepEqual([exit.recipient.person_type, exit.recipient.document], ['F', '12345678909']); assert.equal(read.recipient_document, '12345678909');
});

test('refuses what the field contract cannot hold, before anything is stored', () => {
  assert.equal(reason(() => invoiceImportCandidates('<?xml version="1.0"?><!DOCTYPE nfeProc [<!ENTITY x SYSTEM "file:///etc/hosts">]><nfeProc>&x;</nfeProc>')), 'xml_invalid');
  assert.equal(reason(() => invoiceImportCandidates(`<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">${' '.repeat(IMPORT_MAX_BYTES)}</nfeProc>`)), 'xml_too_large');
  assert.equal(reason(() => invoiceImportCandidates('<nfeProc xmlns="urn:outro"><NFe/></nfeProc>')), 'xml_invalid');
  assert.equal(reason(() => invoiceImportCandidates(nfeXml({ tpAmb: '2' }).xml)), 'xml_homologation');
  assert.equal(reason(() => invoiceImportCandidates(nfeXml({ cStat: '302' }).xml)), 'xml_not_authorized');
  assert.equal(reason(() => invoiceImportCandidates(nfeXml({ version: '3.10' }).xml)), 'xml_unsupported');
  const noRecipient = invoiceImportCandidates(nfeXml({ dest_block: false }).xml);
  assert.equal(noRecipient.recipient_document, null);
  assert.throws(() => normalizeInvoiceInput(noRecipient.as_emitter), /FISCAL_RECIPIENT_REQUIRED/, 'the Worker sends null for this reading');
});
