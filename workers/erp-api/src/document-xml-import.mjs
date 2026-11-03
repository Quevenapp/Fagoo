// "Importar › Pedido XML" (202610200167): the XML of an authorized NF-e becomes the draft of a pedido de venda (the company
// emitted it; the customer is the recipient) or of a pedido de compra (the company received it; the supplier is the emitter).
// The XML is read by the same strict parser of the NF-e import (packages/fiscal-xml); nothing is saved here: the database only
// looks up the contact and the products, and the user reviews and saves the pedido in the form.
import { IMPORT_MAX_BYTES, InvoiceImportError, invoiceImportCandidates } from '../../../packages/fiscal-xml/src/invoice-import.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const XML_REFUSALS = Object.freeze(['xml_invalid', 'xml_too_large', 'xml_unsupported', 'xml_not_authorized', 'xml_homologation', 'xml_too_many_items']);
export class XmlImportShapeError extends Error {}
const bad = () => { throw new XmlImportShapeError('XML_IMPORT_INVALID'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = value => value === null || value === undefined ? '0.00' : value;
const cents = value => { const [w, f = ''] = value.split('.'); return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); };
const money = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const decimalText = (value, digits, places) => typeof value === 'string' && new RegExp(`^(0|[1-9]\\d{0,${digits - 1}})(\\.\\d{1,${places}})?$`).test(value);
// Leading zeros of the XML ("0010.50") become the canonical decimal the document validates.
const canonical = value => { if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null; const [w, f] = value.split('.'); const whole = w.replace(/^0+(?=\d)/, ''); return f ? `${whole}.${f}` : whole; };

/** Parses the XML and maps it to the draft; a refusal is an answer (200) with the reason, never an error of the API. */
export function xmlDraft(kind, xml) {
  let parsed;
  try { parsed = invoiceImportCandidates(xml); } catch (error) { if (error instanceof InvoiceImportError) return { refused: error.reason, field: error.field ?? null }; throw error; }
  const note = kind === 'sales_orders' ? parsed.as_emitter : parsed.as_recipient;
  const party = note.recipient ?? {};
  if (note.items.length > 250) return { refused: 'xml_too_many_items', field: 'det' };
  const items = [];
  for (const item of note.items) {
    const quantity = canonical(item.quantity), unitPrice = canonical(item.unit_price);
    if (!decimalText(quantity, 9, 6) || !decimalText(unitPrice, 10, 10) || typeof item.description !== 'string' || !item.description.trim()) return { refused: 'xml_unsupported', field: 'prod' };
    items.push({ code: item.code ?? null, gtin: typeof item.gtin === 'string' && /^(\d{8}|\d{12,14})$/.test(item.gtin) ? item.gtin : null, description: item.description.trim().slice(0, 200), unit: (item.unit ?? 'UN').slice(0, 16), quantity, unit_price: unitPrice, ncm: item.ncm ?? null });
  }
  const installments = (note.payment?.installments ?? []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '') && /^\d{1,13}(\.\d{1,2})?$/.test(row.amount ?? '')).map(row => ({ due_date: row.date, amount: money(cents(row.amount)) }));
  return {
    key: parsed.key, number: note.number, series: note.series, issue_date: note.issue_date, xml_total: /^\d{1,13}\.\d{2}$/.test(parsed.total ?? '') ? parsed.total : null,
    party: { name: (party.name ?? '').slice(0, 200), person_type: party.person_type ?? null, document: party.document ?? null, ie: party.ie ?? null, email: party.email ?? null, phone: party.phone ?? null,
      postal_code: party.postal_code ?? null, street: party.street ?? null, number: party.number ?? null, complement: party.complement ?? null, district: party.district ?? null, city: party.city ?? null, state: party.state ?? null },
    items, freight: money(cents(amount(note.freight))), discount: money(cents(amount(note.discount))), other_expenses: money(cents(amount(note.other_expenses)) + cents(amount(note.insurance))),
    freight_mode: ['0', '1', '2', '3', '4', '9'].includes(note.transport?.freight_by) ? note.transport.freight_by : null, installments, notes: typeof note.additional_info === 'string' ? note.additional_info.slice(0, 4000) : null,
  };
}
/** Body of POST …/importar-xml: one XML string, up to the size of the NF-e import. */
export async function xmlBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !request.body) return null;
  const limit = IMPORT_MAX_BYTES * 2 + 1024, length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return null;
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, text = '';
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) return null; text += decoder.decode(value, { stream: true }); }
    text += decoder.decode(); const input = JSON.parse(text);
    if (!object(input) || Object.keys(input).length !== 1 || typeof input.xml !== 'string' || !input.xml) return null;
    return input.xml;
  } catch { return null; } finally { try { await reader.cancel(); } catch { /* No request data is logged. */ } reader.releaseLock(); }
}
/** The lookups of the database, checked and joined to the draft. */
export function xmlImportResult(value, kind, draft) {
  if (!object(value) || value.kind !== kind || !Array.isArray(value.products) || value.products.length !== draft.items.length) bad();
  const contact = value.contact;
  if (contact !== null && (!object(contact) || !UUID.test(contact.id ?? '') || typeof contact.name !== 'string' || !contact.name)) bad();
  const products = value.products.map(product => {
    if (product === null) return null;
    if (!object(product) || !UUID.test(product.id ?? '') || typeof product.name !== 'string' || !product.name || !['gtin', 'code'].includes(product.by)) bad();
    return { id: product.id, name: product.name, code: typeof product.code === 'string' ? product.code : null, unit: typeof product.unit === 'string' ? product.unit : null, by: product.by };
  });
  return { ...draft, contact: contact === null ? null : { id: contact.id, name: contact.name }, items: draft.items.map((item, index) => ({ ...item, product: products[index] })) };
}
