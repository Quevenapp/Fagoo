import test from 'node:test';
import assert from 'node:assert/strict';
import { contactFormValues, contactPayload, paymentConditionValid, requiredFields, requiredApplies, emailListValid, fieldVisible } from '../src/lib/contact-form-model.ts';
import { contactPageQuery, typeSelectorOptions, typeFromParam, typeParam, visibleColumns, sheetRows, EMPTY_LIST_FILTERS, EMPTY_LIST_PERIOD, SHEET_COLUMNS } from '../src/lib/contact-list-model.ts';
import { importRows, parseCsv, parseXlsx, unzip, decodeText, modelCsv } from '../src/lib/contact-import-model.ts';
import { paymentPayload, paymentForm, sectionsOf } from '../src/lib/payment-method-model.ts';
import { sellerSettingsPayload, EMPTY_SETTINGS } from '../src/lib/seller-model.ts';
import { toXlsx, textCell } from '../src/lib/spreadsheet-export.ts';
import { CatalogValidationError } from '../src/lib/catalog-base.ts';

// Pure rules of the contatos lane UI (same grammar and limits as the SQL of migrations 124-128). Synthetic data only.
const TYPES = [['customer', 'Cliente', true, 1], ['developer', 'Desenvolvedor', true, 2], ['supplier', 'Fornecedor', true, 3], ['default', 'Padrao', true, 4], ['technician', 'Técnico', true, 5], ['carrier', 'Transportador', true, 6],
  ['seller', 'Vendedor', true, 7], ['accountant', 'Contador', false, 8], ['verified_supplier', 'Fornecedor verificado', false, 9]].map(([slug, label, system, position]) => ({ id: `id-${slug}`, slug, label, system, deletable: !system, position, contacts: 0 }));
const field = fn => { try { fn(); } catch (error) { if (error instanceof CatalogValidationError) return error.field; throw error; } return null; };

test('form defaults, person-type fields and the payload follow the server rules', () => {
  const values = contactFormValues(null, '2026-10-20');
  assert.deepEqual([values.person_type, values.taxpayer, values.client_since, values.situation, values.credit_limit_mode], ['F', '9', '2026-10-20', 'A', 'unlimited']);
  assert.equal(fieldVisible('rg', 'F'), true); assert.equal(fieldVisible('rg', 'J'), false); assert.equal(fieldVisible('crt', 'J'), true); assert.equal(fieldVisible('country', 'E'), true);
  const data = contactPayload({ ...values, name: ' Contato ', rg: '1', person_type: 'J', crt: '1', avg_tax_load: '12,5', credit_limit_mode: 'value', credit_limit: '1500,5', email: 'a@b.test; c@d.test' }, ['customer'], [], { today: '2026-10-20' });
  assert.equal(data.name, 'Contato'); assert.equal(data.rg, null, 'RG is cleared for Pessoa Jurídica'); assert.equal(data.avg_tax_load, null); assert.equal(data.crt, '1');
  assert.equal(data.credit_limit, '1500.5'); assert.deepEqual(data.types, ['customer']);
  for (const [change, key] of [[{ name: '' }, 'name'], [{ email: 'errado' }, 'email'], [{ nfe_email: `${'x'.repeat(55)}@a.test` }, 'nfe_email'], [{ website: 'sem ponto' }, 'website'],
    [{ payment_condition: '30 20' }, 'payment_condition'], [{ credit_limit_mode: 'value', credit_limit: '0' }, 'credit_limit'], [{ birth_date: '2030-01-01' }, 'birth_date'], [{ next_visit: '2026-02-30' }, 'next_visit'],
    [{ state: 'XX' }, 'state'], [{ avg_tax_load: '100,5' }, 'avg_tax_load']])
    assert.equal(field(() => contactPayload({ ...values, name: 'Contato', ...change }, [], [], { today: '2026-10-20' })), key, JSON.stringify(change));
  assert.equal(field(() => contactPayload({ ...values, name: 'Contato' }, [], [], { required: requiredFields(['cep', 'rg']), today: '2026-10-20' })), 'postal_code');
  assert.equal(requiredApplies('rg', { person_type: 'J' }), false); assert.equal(requiredApplies('ie', { person_type: 'J', ie_exempt: 'true' }), false);
  for (const [text, ok] of [['30', true], ['30 60 90', true], ['30,60;90', true], ['3x', true], ['15 + 2x', true], ['15 +2x', true], ['30 20', false], ['0x', false], ['abc', false], ['3651', false]]) assert.equal(paymentConditionValid(text), ok, text);
  assert.equal(emailListValid('a@b.test, c@d.test', 254), true); assert.equal(emailListValid('a@b', 254), false);
});

test('listing query, type selector, readable URL values and the custom columns', () => {
  const state = { page: 2, sort: 'name_asc', query: ' ana ', type: 'accountant', filters: { ...EMPTY_LIST_FILTERS, situation: 'E', state: 'sp', seller: { id: 's1', name: 'V', code: null }, sale_statuses: ['fulfilled', 'open'] }, period: { field: 'no_purchases', from: '2026-10-01', to: '2026-10-31' } };
  assert.deepEqual(Object.fromEntries(contactPageQuery(state)), { page: '2', size: '100', sort: 'name_asc', q: 'ana', situation: 'E', type: 'accountant', state: 'SP', seller_id: 's1', period: 'no_purchases', from: '2026-10-01', to: '2026-10-31', sale_statuses: 'open,fulfilled' });
  assert.deepEqual(Object.fromEntries(contactPageQuery({ page: 1, sort: 'created_desc', query: '', type: '', filters: EMPTY_LIST_FILTERS, period: EMPTY_LIST_PERIOD })), { page: '1', size: '100' });
  assert.deepEqual(typeSelectorOptions(TYPES).map(o => o.label), ['Todos', 'Sem tipo definido', 'Cliente', 'Contador', 'Desenvolvedor', 'Fornecedor', 'Fornecedor verificado', 'Transportador', 'Técnico', 'Vendedor']);
  assert.deepEqual(['fornecedor', 'cliente', 'sem-tipo', 'vendedor', 'tparceiro123', 'Ruim!', null].map(typeFromParam), ['supplier', 'customer', 'none', 'seller', 'tparceiro123', '', '']);
  assert.deepEqual(['supplier', 'none', 'seller', '', 'tx1'].map(typeParam), ['fornecedor', 'sem-tipo', 'vendedor', null, 'tx1']);
  assert.deepEqual(visibleColumns('padrao', ['email']), ['code', 'name', 'document', 'city', 'phone']);
  assert.deepEqual(visibleColumns('customizada', ['email', 'unknown', 'seller']), ['name', 'email', 'seller'], 'Nome is always shown; unknown columns are ignored');
});

test('spreadsheet export rows and the import read the same model, in CSV and XLSX', async () => {
  const record = { id: 'r1', name: 'Ana', code: 'C-1', person_type: 'J', document: '11.222.333/0001-81', crt: '3', taxpayer: '1', ie_exempt: true, client_since: '2020-01-02', credit_limit_mode: 'value', credit_limit: '1500.50',
    types: ['customer', 'accountant'], situation: 'S', gender: null, notes: '=SOMA(1)' };
  const rows = sheetRows([record], TYPES);
  assert.equal(rows[0].length, SHEET_COLUMNS.length);
  const cell = header => rows[1][SHEET_COLUMNS.findIndex(([label]) => label === header)];
  assert.deepEqual([cell('Tipo da Pessoa'), cell('Código de regime tributário'), cell('IE Isento'), cell('Cliente desde'), cell('Tipo de Contato'), cell('Situação'), cell('Valor do limite de crédito')],
    [{ text: 'Jurídica' }, { text: 'Regime normal' }, { text: 'Sim' }, { text: '02/01/2020' }, { text: 'Cliente, Contador' }, { text: 'Sem movimento' }, { number: '1500.50' }]);
  const csv = (await import('../src/lib/spreadsheet-export.ts')).toCsv(rows);
  assert.match(csv, /"'=SOMA\(1\)"/, 'formula-like text is neutralized');
  const parsedCsv = importRows(parseCsv(decodeText(new TextEncoder().encode(csv))), TYPES);
  assert.equal(parsedCsv.missingName, false); assert.deepEqual(parsedCsv.unknown, []);
  const data = parsedCsv.rows[0].data;
  assert.deepEqual([data.person_type, data.crt, data.taxpayer, data.ie_exempt, data.client_since, data.types, data.situation, data.credit_limit_mode, data.credit_limit],
    ['J', '3', '1', true, '2020-01-02', ['customer', 'accountant'], 'S', 'value', '1500.50']);
  assert.deepEqual(parsedCsv.rows[0].problems, []);
  const xlsx = toXlsx('Contatos', rows), parsedXlsx = importRows(await parseXlsx(xlsx), TYPES);
  assert.deepEqual(parsedXlsx.rows[0].data, { ...data, credit_limit: '1500.5' }, 'the XLSX written by the export reads back the same (Excel numbers drop trailing zeros)');
  // A real XLSX is deflated: build one entry with CompressionStream and read it back.
  const deflated = new Uint8Array(await new Response(new Blob([new TextEncoder().encode('hello')]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const zip = buildZip('a.txt', deflated, 5);
  assert.equal(new TextDecoder().decode((await unzip(zip)).get('a.txt')), 'hello');
  const odd = importRows([['Nome', 'Coluna estranha', 'Data Nascimento', 'Tipo de Contato', 'Vendedor'], ['Bia', 'x', '31/02/1990', 'Cliente, Inventado', 'Fulano']], TYPES);
  assert.deepEqual(odd.unknown, ['Coluna estranha']); assert.deepEqual(odd.rows[0].problems, ['Data Nascimento: data inválida', 'Tipo de Contato: tipo desconhecido']); assert.deepEqual(odd.rows[0].ignored, ['Vendedor']);
  assert.equal(importRows([['Código'], ['1']], TYPES).missingName, true);
  assert.match(modelCsv(), /^﻿"Código";"Nome"/);
  assert.deepEqual(parseCsv('a,b\n"x, y","z ""q"""\n'), [['a', 'b'], ['x, y', 'z "q"']]);
});
function buildZip(name, data, size) {
  const encoder = new TextEncoder(), file = encoder.encode(name), local = new DataView(new ArrayBuffer(30)), central = new DataView(new ArrayBuffer(46)), end = new DataView(new ArrayBuffer(22));
  local.setUint32(0, 0x04034b50, true); local.setUint16(8, 8, true); local.setUint32(18, data.length, true); local.setUint32(22, size, true); local.setUint16(26, file.length, true);
  central.setUint32(0, 0x02014b50, true); central.setUint16(10, 8, true); central.setUint32(20, data.length, true); central.setUint32(24, size, true); central.setUint16(28, file.length, true); central.setUint32(42, 0, true);
  const centralOffset = 30 + file.length + data.length;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + file.length, true); end.setUint32(16, centralOffset, true);
  const parts = [new Uint8Array(local.buffer), file, data, new Uint8Array(central.buffer), file, new Uint8Array(end.buffer)], out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

test('payment method and seller payloads clear hidden sections and keep exact decimals', () => {
  const form = { ...paymentForm(null), description: 'Cartão', payment_type: '03', card_brand: '01', interest_rate: '1', fee_rate: '2,5', fee_fixed: '1,00', settlement_days: '30' };
  const data = paymentPayload(form);
  assert.deepEqual(sectionsOf('15'), { boleto: true, card: false, pix: false });
  assert.deepEqual([data.card_brand, data.interest_rate, data.fee_rate, data.fee_fixed, data.settlement_days, data.pix_integration], ['01', null, '2.5', null, 30, null], 'Alíquota keeps no fixed value');
  assert.equal(paymentPayload({ ...form, payment_type: '20' }).pix_integration, 'sem');
  assert.equal(paymentPayload({ ...form, destination: 'ficha', account_id: 'x' }).account_id, null);
  assert.equal(field(() => paymentPayload({ ...form, fee_rate: '101' })), 'fee_rate');
  assert.equal(field(() => paymentPayload({ ...form, description: ' ' })), 'description');
  const settings = sellerSettingsPayload({ user_id: '', allow_unregistered_products: true, view_stock: false, access_hours_enabled: true, windows: [{ start: '08:00', end: '12:00', days: [5, 1] }], modules: { clientes: true, inexistente: true },
    commission_rule: 'faturamento', commission_mode: 'descontos', commission_rate: '9', bands: [{ discount_up_to: '10', rate: '1,5' }, { discount_up_to: '5', rate: '3' }], discount_limit: '', notes: ' ' });
  assert.deepEqual(settings, { ...EMPTY_SETTINGS, allow_unregistered_products: true, access_hours_enabled: true, access_windows: [{ start: '08:00', end: '12:00', days: [1, 5] }], modules: { clientes: true },
    commission_rule: 'faturamento', commission_mode: 'descontos', commission_rate: null, commission_bands: [{ discount_up_to: '5', rate: '3' }, { discount_up_to: '10', rate: '1.5' }], discount_limit: '0' });
  assert.equal(field(() => sellerSettingsPayload({ ...settings, user_id: '', windows: [{ start: '12:00', end: '08:00', days: [1] }], access_hours_enabled: true, bands: [], commission_rate: '', discount_limit: '0', notes: '' })), 'window-0');
});

test('import rows: a malformed number or a line break in a one-line field stays a problem of its row', () => {
  const cells = [['Nome', '% carga média', 'Endereço', 'Observações', 'Valor do limite de crédito'], ['Ana', '12,5%', 'Rua A', 'linha 1\nlinha 2', '1.500,50'], ['Bia', '100,01', 'Rua\nB', '', 'abc'], ['Cid', '7', 'Rua C', '', '0']];
  const { rows } = importRows(cells, TYPES);
  assert.deepEqual(rows[0].problems, ['% carga média: número inválido']);
  assert.deepEqual([rows[0].data.notes, rows[0].data.credit_limit, rows[0].data.credit_limit_mode], ['linha 1\nlinha 2', '1500.50', 'value'], 'Observações keep line breaks');
  assert.deepEqual(rows[1].problems, ['Endereço: até 200 caracteres, em uma linha, sem caracteres de controle', '% carga média: número inválido', 'Valor do limite de crédito: número inválido']);
  assert.deepEqual(rows[2].problems, []); assert.deepEqual([rows[2].data.avg_tax_load, rows[2].data.credit_limit], ['7', '0'], 'a zero limit is the server\'s to refuse, per row');
});
