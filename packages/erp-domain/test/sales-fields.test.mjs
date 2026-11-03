import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_FIELDS, normalizeDeliveryAddress, normalizeDocument } from '../src/index.mjs';

// 202610200102 optional fields (synthetic values). Same rules as erp_documents.extension_data.
const contact = 'c0000000-0000-4000-8000-000000000102';
const body = extra => ({ date: '2026-10-20', contact_id: contact, items: [{ description: 'Item', unit: 'UN', quantity: '1', unit_price: '1' }], ...extra });
const address = extra => ({ name: null, postal_code: '13400-000', state: 'sp', city: 'Piracicaba', district: null, street: 'Rua', number: null, complement: null, country: null, ...extra });

test('new fields are optional, kept only when sent and normalized', () => {
  const plain = normalizeDocument('sales_orders', body());
  for (const key of EXTENSION_FIELDS) assert.equal(Object.hasOwn(plain, key), false, key);
  const all = normalizeDocument('service_orders', body({ ship_date: '2026-10-21', finish_date: null, start_time: '00:00', end_time: '23:59', customer_po_number: ' PC ', quote_requested: true, quoted: null, warranty_days: '0', warranty_months: '999', warranty_info: 'a\nb', reception_notes: null, template_name: 'Modelo', delivery_address: address(), order_reference: ' OC-77 ', seller_id: 'A0000000-0000-4000-8000-000000000164', category_id: null, carrier_id: 'B0000000-0000-4000-8000-000000000168' }));
  // 202610200196 fields not sent stay absent.
  assert.deepEqual(Object.fromEntries(EXTENSION_FIELDS.filter(key => Object.hasOwn(all, key)).map(key => [key, all[key]])), { ship_date: '2026-10-21', finish_date: null, start_time: '00:00', end_time: '23:59', customer_po_number: 'PC', quote_requested: true, quoted: null, warranty_days: '0', warranty_months: '999', warranty_info: 'a\nb', reception_notes: null, template_name: 'Modelo',
    delivery_address: { name: null, postal_code: '13400000', state: 'SP', city: 'Piracicaba', district: null, street: 'Rua', number: null, complement: null, country: null }, order_reference: 'OC-77', seller_id: 'a0000000-0000-4000-8000-000000000164', category_id: null, carrier_id: 'b0000000-0000-4000-8000-000000000168' });
  // 202610200164: the native vendedor is an id; pedidos de compra do not take it.
  assert.throws(() => normalizeDocument('purchase_orders', body({ seller_id: 'a0000000-0000-4000-8000-000000000164' })), /SELLER_INVALID/);
  assert.throws(() => normalizeDocument('sales_orders', body({ seller_id: 'vendedor' })), /ID_INVALID/);
  // 202610200168: categoria and transportador are ids; propostas have no categoria.
  assert.throws(() => normalizeDocument('sales_proposals', body({ category_id: 'a0000000-0000-4000-8000-000000000168' })), /CATEGORY_INVALID/);
  assert.equal(normalizeDocument('purchase_orders', body({ category_id: 'A0000000-0000-4000-8000-000000000168' })).category_id, 'a0000000-0000-4000-8000-000000000168');
  assert.throws(() => normalizeDocument('sales_orders', body({ carrier_id: 'transportadora' })), /ID_INVALID/);
  // "Editar contato": refresh_contact travels only as true and never becomes part of the body.
  assert.equal(Object.hasOwn(normalizeDocument('sales_orders', body({ refresh_contact: true })), 'refresh_contact'), false);
  assert.throws(() => normalizeDocument('sales_orders', body({ refresh_contact: false })), /REFRESH_INVALID/);
});

test('invalid values use the document error codes', () => {
  for (const [key, value, code] of [['start_time', '7:00', 'TIME'], ['end_time', '24:00', 'TIME'], ['quoted', 'sim', 'FLAG'], ['warranty_days', '10000', 'WARRANTY'], ['warranty_months', '1000', 'WARRANTY'], ['ship_date', '2026-13-01', 'DATE'], ['customer_po_number', 'x'.repeat(61), 'TEXT'],
    ['delivery_address', address({ postal_code: '1' }), 'DELIVERY_ADDRESS'], ['delivery_address', address({ state: 'ZZ' }), 'DELIVERY_ADDRESS'], ['delivery_address', address({ city: null }), 'DELIVERY_ADDRESS'], ['delivery_address', { street: 'Rua', city: 'X' }, 'COMMERCIAL_FIELDS_REQUIRED']])
    assert.throws(() => normalizeDocument('sales_orders', body({ [key]: value })), error => error.code.includes(code), `${key}=${JSON.stringify(value)}`);
  assert.equal(normalizeDeliveryAddress(null), null);
  assert.throws(() => normalizeDocument('sales_orders', body({ unknown_field: 1 })), /FIELD_INVALID/);
});
