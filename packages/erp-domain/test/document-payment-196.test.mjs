import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALLMENT_DETAIL_FIELDS, calculateDocument, normalizeDocument, normalizeInstallmentDetails } from '../src/index.mjs';

// 202610200196 fields (synthetic values): Lista de preço, Destino, Detalhes de pagamento, Forma and details of the parcelas,
// Preço lista, Código no fornecedor and the taxes added to the total. Same rules as erp_documents.normalize (SQL).
const contact = 'c0000000-0000-4000-8000-000000000196', id = n => `a0000000-0000-4000-8000-00000000019${n}`;
const item = extra => ({ description: 'Item', unit: 'UN', quantity: '1', unit_price: '10', ...extra });
const body = extra => ({ date: '2026-10-20', contact_id: contact, items: [item()], ...extra });
const details = extra => ({ ...Object.fromEntries(INSTALLMENT_DETAIL_FIELDS.map(key => [key, null])), ...extra });

test('Lista de preço, Destino and Detalhes de pagamento: kinds that take them', () => {
  const sale = normalizeDocument('sales_orders', body({ price_list_id: id(1).toUpperCase(), payment_account_id: id(2), payment_means: '17', payment_indicator: '1' }));
  assert.deepEqual([sale.price_list_id, sale.payment_account_id, sale.payment_means, sale.payment_indicator], [id(1), id(2), '17', '1']);
  assert.equal(normalizeDocument('service_orders', body({ price_list_id: id(1), payment_account_id: id(2) })).price_list_id, id(1));
  assert.throws(() => normalizeDocument('purchase_orders', body({ price_list_id: id(1) })), /PRICE_LIST_INVALID/);
  assert.throws(() => normalizeDocument('sales_proposals', body({ payment_account_id: id(2) })), /PAYMENT_INVALID/);
  assert.throws(() => normalizeDocument('service_orders', body({ payment_means: '01' })), /PAYMENT_INVALID/);
  assert.throws(() => normalizeDocument('sales_orders', body({ payment_means: '06' })), /PAYMENT_INVALID/);
  assert.throws(() => normalizeDocument('sales_orders', body({ payment_indicator: '2' })), /PAYMENT_INVALID/);
  for (const key of ['price_list_id', 'payment_account_id', 'payment_means', 'payment_indicator']) assert.equal(Object.hasOwn(normalizeDocument('sales_orders', body()), key), false, key);
});

test('Preço lista and Código no fornecedor of the items', () => {
  const sale = normalizeDocument('sales_orders', body({ items: [item({ list_price: '12.345', supplier_code: null })] }));
  assert.deepEqual([sale.items[0].list_price, sale.items[0].supplier_code], ['12.3450', null]);
  assert.equal(normalizeDocument('purchase_orders', body({ items: [item({ supplier_code: ' F-1 ' })] })).items[0].supplier_code, 'F-1');
  assert.throws(() => normalizeDocument('sales_orders', body({ items: [item({ supplier_code: 'F-1' })] })), /SUPPLIER_CODE_INVALID/);
  assert.throws(() => normalizeDocument('sales_orders', body({ items: [item({ list_price: '-1' })] })), /DECIMAL_INVALID/);
  assert.equal(Object.hasOwn(normalizeDocument('sales_orders', body()).items[0], 'list_price'), false, 'kept only when sent');
});

test('Forma and details of the parcelas', () => {
  const sale = normalizeDocument('sales_orders', body({ installments: [{ due_date: '2026-10-21', amount: '10', payment_method_id: id(3), details: details({ account_id: id(2), payment_type: '03', card_brand: '02', integration_type: '1', acquirer_cnpj: '12ABC34501DE35', authorization_code: 'A-1/2', received_amount: '9.5', fee_amount: '0.5' }) }] }));
  assert.deepEqual(sale.installments[0].details, { account_id: id(2), payment_type: '03', card_brand: '02', integration_type: '1', acquirer_cnpj: '12ABC34501DE35', authorization_code: 'A-1/2', received_amount: '9.50', fee_amount: '0.50', commission_fee_amount: null });
  assert.equal(sale.installments[0].payment_method_id, id(3));
  assert.equal(normalizeDocument('sales_proposals', body({ installments: [{ due_date: '2026-10-21', amount: '10', payment_method_id: id(3), details: null }] })).installments[0].details, null);
  assert.throws(() => normalizeDocument('sales_proposals', body({ installments: [{ due_date: '2026-10-21', amount: '10', details: details() }] })), /INSTALLMENT_DETAILS_INVALID/);
  for (const change of [{ fee_amount: '10.01' }, { card_brand: '10' }, { integration_type: '3' }, { acquirer_cnpj: '123' }, { authorization_code: 'com espaço' }, { payment_type: '06' }])
    assert.throws(() => normalizeDocument('sales_orders', body({ installments: [{ due_date: '2026-10-21', amount: '10', details: details(change) }] })), /INSTALLMENT_DETAILS_INVALID|DECIMAL/, JSON.stringify(change));
  assert.throws(() => normalizeInstallmentDetails('sales_orders', { account_id: null }), /COMMERCIAL_FIELDS_REQUIRED|FIELD_INVALID/, 'every key is required');
});

test('Total do IPI and Total do ICMS ST add to the total and the parcelas follow it', () => {
  const totals = calculateDocument({ items: [item({ quantity: '2' })], tax_ipi: '1.10', tax_icms_st: '0.40' });
  assert.deepEqual([totals.ipi, totals.icms_st, totals.total], ['1.10', '0.40', '21.50']);
  assert.equal(Object.hasOwn(calculateDocument({ items: [item()] }), 'ipi'), false, 'absent without taxes');
  assert.equal(normalizeDocument('sales_orders', body({ tax_ipi: '1.5', installments: [{ due_date: '2026-10-21', amount: '11.50' }] })).tax_ipi, '1.50');
  assert.throws(() => normalizeDocument('sales_orders', body({ tax_ipi: '1.5', installments: [{ due_date: '2026-10-21', amount: '10.00' }] })), /INSTALLMENT_TOTAL_MISMATCH/);
  assert.throws(() => normalizeDocument('purchase_orders', body({ tax_ipi: '1.00' })), /TAX_INVALID/);
  assert.equal(normalizeDocument('purchase_orders', body({ tax_ipi: '0' })).tax_ipi, '0.00');
  assert.throws(() => normalizeDocument('sales_orders', body({ tax_ipi: null })), /TAX_INVALID/);
});
