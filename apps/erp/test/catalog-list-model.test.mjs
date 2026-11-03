import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_PAGE_SIZE, EMPTY_CONTACT_FILTERS, EMPTY_PERIOD, EMPTY_PRODUCT_FILTERS, ariaSort, catalogPageParams, catalogWarnings, cloneProductValues, contactRoleFromParam,
  contactRoleParam, inlinePrice, needsWarningCheck, nextSort, priceInputValue, sortLabel, stockCell, warningText,
} from '../src/lib/catalog-model.ts';

const base = { page: 1, sort: 'created_desc', query: '', active: 'true', role: '', contact: EMPTY_CONTACT_FILTERS, product: EMPTY_PRODUCT_FILTERS, period: EMPTY_PERIOD };

test('page parameters: 100 per page, default order omitted, filters only for their own entity', () => {
  assert.equal(CATALOG_PAGE_SIZE, 100);
  assert.deepEqual(Object.fromEntries(catalogPageParams('contacts', base)), { page: '1', size: '100', active: 'true' });
  const contact = { ...base, page: 3, sort: 'name_desc', query: '  joão silva ', active: '', role: 'none', contact: { person_type: 'F', phone: ' (19) 9 ', email: ' a@b ', state: 'sp', city: ' São ' }, product: { ...EMPTY_PRODUCT_FILTERS, stock: 'zero' }, period: { field: 'updated', from: '2026-10-01', to: '' } };
  assert.deepEqual(Object.fromEntries(catalogPageParams('contacts', contact)), { page: '3', size: '100', sort: 'name_desc', q: 'joão silva', role: 'none', person_type: 'F', phone: '(19) 9', email: 'a@b', state: 'SP', city: 'São', period: 'updated', from: '2026-10-01' });
  // Products use the v2 page (migration 120): Situação instead of the shared active, the Origin Tipo and the new filters.
  const product = { ...base, role: 'customer', contact: { ...EMPTY_CONTACT_FILTERS, city: 'x' }, product: { ...EMPTY_PRODUCT_FILTERS, kind: 'P', type: 'services', ncm_presence: 'present', ncm: '7318', brand: ' 100%_Marca ', stock: 'positive', warehouse_id: 'w-1', images: 'yes', tag: 'none', category: 'c-1', item_type: '09', supplier_id: 's-1', supplier_name: 'Fornecedor', supplier_code: ' F-1 ' } };
  assert.deepEqual(Object.fromEntries(catalogPageParams('products', product)), { page: '1', size: '100', situation: 'latest', type: 'services', ncm_presence: 'present', ncm: '7318', brand: '100%_Marca', stock: 'positive', warehouse_id: 'w-1', images: 'yes', tag: 'none', category: 'c-1', item_type: '09', supplier_id: 's-1', supplier_code: 'F-1' });
  assert.deepEqual(Object.fromEntries(catalogPageParams('products', { ...base, active: '', product: { ...EMPTY_PRODUCT_FILTERS, situation: 'deleted' }, period: { field: 'expiry', from: '', to: '2027-01-31' } })), { page: '1', size: '100', situation: 'deleted', period: 'expiry', to: '2027-01-31' });
  assert.deepEqual(Object.fromEntries(catalogPageParams('warehouses', product)), { page: '1', size: '100', active: 'true' });
});

test('ordering: header clicks toggle ascending/descending and the chip uses the Origin wording', () => {
  assert.equal(nextSort('created_desc', 'name'), 'name_asc');
  assert.equal(nextSort('name_asc', 'name'), 'name_desc');
  assert.equal(nextSort('name_desc', 'name'), 'name_asc');
  assert.equal(nextSort('name_desc', 'code'), 'code_asc');
  assert.deepEqual([ariaSort('code_desc', 'code'), ariaSort('code_desc', 'name'), ariaSort('created_desc', 'name')], ['descending', undefined, undefined]);
  assert.equal(sortLabel('contacts', 'created_desc'), 'Exibindo pela ordem de inclusão');
  assert.equal(sortLabel('products', 'name_asc'), 'Exibindo pela ordem de descrição (A-Z)');
  assert.equal(sortLabel('contacts', 'code_desc'), 'Exibindo pela ordem de código (Z-A)');
});

test('contact type in the URL uses readable values and ignores unknown ones', () => {
  assert.deepEqual(['fornecedor', 'cliente', 'transportador', 'sem-tipo', 'vendedor', null].map(contactRoleFromParam), ['supplier', 'customer', 'carrier', 'none', '', '']);
  assert.deepEqual(['supplier', 'none', ''].map(contactRoleParam), ['fornecedor', 'sem-tipo', null]);
});

test('Estoque cell keeps "Sem lançamentos" distinct from a recorded zero and never shows a quantity under review', () => {
  assert.deepEqual(stockCell({ state: 'recorded', quantity: '0.000000', warehouse: null }, false), { text: '0', state: 'recorded' });
  assert.deepEqual(stockCell({ state: 'recorded', quantity: '1234567.125000', warehouse: null }, false), { text: '1.234.567,125', state: 'recorded' });
  assert.deepEqual(stockCell({ state: 'recorded', quantity: '-2.500000', warehouse: null }, false), { text: '−2,5', state: 'recorded' });
  assert.deepEqual(stockCell({ state: 'no_movements', quantity: null, warehouse: null }, false), { text: 'Sem lançamentos', state: 'no_movements' });
  assert.deepEqual(stockCell({ state: 'review_required', quantity: null, warehouse: null }, false), { text: 'Conferência necessária', state: 'review_required' });
  const byWarehouse = { state: 'recorded', quantity: '9.000000', warehouse: { id: 'w', state: 'no_movements', quantity: null } };
  assert.deepEqual(stockCell(byWarehouse, true), { text: 'Sem lançamentos', state: 'no_movements' });
  assert.deepEqual([stockCell(null, false), stockCell(undefined, true)], [{ text: '—', state: null }, { text: '—', state: null }]);
});

test('inline price: exact decimal strings in both directions, without binary floats', () => {
  assert.deepEqual(['1.5000', '1.2345678900', '12345678901234.0000', '0.0000', null, 'x'].map(priceInputValue), ['1,50', '1,23456789', '12345678901234,00', '0,00', '', '']);
  assert.equal(inlinePrice(' 2,75 '), '2.7500');
  assert.equal(inlinePrice('0,1234567891'), '0.1234567891');
  assert.equal(inlinePrice('99999999999999.9999999999'), '99999999999999.9999999999');
  for (const value of ['', ' ', '-1', '1.234,56', '1e3', '0,12345678901', '100000000000000']) assert.throws(() => inlinePrice(value), error => error.field === 'price', value);
});

test('Clonar produto copies the form, clears code and GTINs and never copies identity or version', () => {
  const values = cloneProductValues({ id: 'p-1', entity: 'products', version: 7, active: false, name: 'Parafuso', code: 'PAR-1', gtin: '7891234567895', gtin_tax: '7891234567895', price: '1.5000', ncm: '73181500', unit: 'UN', created_at: 'x', updated_at: 'y', source: { system: 'origin', source_id: '1', state: 'synced' } });
  assert.deepEqual([values.name, values.code, values.gtin, values.gtin_tax, values.price, values.ncm, values.unit, values.brand], ['Parafuso', '', '', '', '1.5000', '73181500', 'UN', '']);
  for (const key of ['id', 'version', 'active', 'source', 'created_at']) assert.equal(key in values, false, key);
});

test('warnings: the client asks the server only when code, GTIN, CPF/CNPJ or tipo da pessoa changed', () => {
  assert.equal(needsWarningCheck('products', { name: 'X', code: null, gtin: null }, null), false);
  assert.equal(needsWarningCheck('products', { code: 'A' }, null), true);
  assert.equal(needsWarningCheck('products', { code: 'A', gtin: 'SEM GTIN' }, { code: 'A' }), false);
  assert.equal(needsWarningCheck('products', { code: 'A', gtin: '7891234567895' }, { code: 'A', gtin: null }), true);
  assert.equal(needsWarningCheck('contacts', { document: '529.982.247-25', person_type: 'F' }, { document: '529.982.247-25', person_type: 'F' }), false);
  assert.equal(needsWarningCheck('contacts', { document: '529.982.247-25', person_type: 'J' }, { document: '529.982.247-25', person_type: 'F' }), true);
  assert.equal(needsWarningCheck('contacts', { document: null, person_type: 'J' }, null), false);
  assert.equal(needsWarningCheck('warehouses', { code: 'A' }, null), false);
  const matches = [{ id: '1', name: 'A', code: 'X', active: true }, { id: '2', name: 'B', code: null, active: false }, { id: '3', name: 'C', code: 'Z', active: true }];
  assert.equal(warningText({ code: 'duplicate_code', field: 'code', total: 7, matches }), 'O código (SKU) informado já está em 7 outros produtos: A (X); B — inativo; C (Z)….');
  assert.equal(warningText({ code: 'duplicate_document', field: 'document', total: 1, matches: [matches[0]] }), 'Este CPF/CNPJ já está em 1 outro contato: A (X).');
  assert.match(warningText({ code: 'invalid_document', field: 'document', expected: 'cnpj' }), /CNPJ informado não confere/);
  assert.match(warningText({ code: 'invalid_document', field: 'document', expected: 'document' }), /Estrangeiro/);
  assert.deepEqual(catalogWarnings({ warnings: [] }), []);
  for (const value of [null, {}, { warnings: [{ code: 'other' }] }, { warnings: [{ code: 'duplicate_code', matches: 'x' }] }, { warnings: Array(5).fill({ code: 'duplicate_code' }) }]) assert.throws(() => catalogWarnings(value));
});
