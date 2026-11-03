import test from 'node:test';
import assert from 'node:assert/strict';
import { lotsProblem, lotsSummary, withoutLot, lotOptionsPath, lotProductsPath } from '../src/lib/document-item-lots.ts';
import { itemCommissions, itemRate } from '../src/lib/document-commissions.ts';
import { applyRead, orderedLines, readsBody, savedStatus, pickingLine } from '../src/lib/sales-checkout-model.ts';
import { quantityDecimalsProblem, quantityPlaces } from '../src/lib/document-seller-rules.ts';
import { pdvReturnMessage } from '../src/lib/pdv-model.ts';
import { EMPTY_LIST_FILTERS, LOT_FILTER, documentListQuery } from '../src/lib/document-list-model.ts';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { DOCUMENT_PREFERENCE_PAGES, documentPreferences } from '../src/lib/document-preferences.ts';
import { customFieldsPayload, printableCustomFields } from '../src/lib/document-custom-fields.ts';
import { documentInput } from '../src/lib/real-documents-model.ts';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { calculateDocument, normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// 202610200287-294 (Documentos, onda G): the models of the screens. Synthetic data only; no network; no date of today.
const LOT_A = 'a1000000-0000-4000-8000-000000000287', LOT_B = 'a2000000-0000-4000-8000-000000000287';
const view = (kind, values = {}) => {
  const page = preferencePage(DOCUMENT_PREFERENCE_PAGES[kind]);
  return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role: 'admin', can_manage: true, directory: storedFields(page).some(f => f.kind === 'users') ? [] : null,
    items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: '2026-10-20T12:00:00Z' } : { key: field.key, value: field.default, version: 0, updated_at: null }) };
};
const contact = 'c0000000-0000-4000-8000-000000000287', product = 'd0000000-0000-4000-8000-000000000287';
function record(kind, data) {
  const normalized = normalizeDocument(kind, { date: '2026-10-20', contact_id: contact, installments: [], ...data });
  return { ...normalized, id: 'b0000000-0000-4000-8000-000000000287', kind, number: '287', version: 3, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
    source_proposal_id: null, contact_snapshot: { id: contact, version: 1, name: 'Contato Onda G', document: null }, effect_flags: { finance_active: false, stock_active: false },
    items: normalized.items.map((item, index) => ({ ...item, id: `e0000000-0000-4000-8000-00000000028${index}`, product_snapshot: null })) };
}

test('Informar lotes: rows with a lot and a quantity, no lot twice, exact sum equal to the item; the rest stays Sem lote', () => {
  assert.equal(lotsProblem([], '3'), null, 'without lots the stock is posted Sem lote');
  assert.equal(lotsProblem([{ lot_id: LOT_A, quantity: '1.25' }, { lot_id: LOT_B, quantity: '1.75' }], '3'), null);
  assert.match(lotsProblem([{ lot_id: LOT_A, quantity: '1.25' }, { lot_id: LOT_B, quantity: '1.7' }], '3'), /A soma dos lotes \(2,95\) precisa ser igual à quantidade do item \(3\)/);
  assert.match(lotsProblem([{ lot_id: LOT_A, quantity: '1' }, { lot_id: LOT_A, quantity: '2' }], '3'), /mais de uma vez/);
  assert.match(lotsProblem([{ lot_id: '', quantity: '3' }], '3'), /Escolha o lote/);
  assert.match(lotsProblem([{ lot_id: LOT_A, quantity: '0.0000001' }], '3'), /seis casas decimais/);
  // 0.1 + 0.2 is exact (BigInt, never floats).
  assert.equal(lotsProblem([{ lot_id: LOT_A, quantity: '0.1' }, { lot_id: LOT_B, quantity: '0.2' }], '0.3'), null);
  assert.equal(withoutLot([{ quantity: '0.1' }], '0.3'), '0,2');
  assert.deepEqual([lotsSummary(null), lotsSummary([{ lot_id: LOT_A, quantity: '1' }]), lotsSummary([{ lot_id: LOT_A, quantity: '1' }, { lot_id: LOT_B, quantity: '2' }])], ['', '1 lote informado', '2 lotes informados']);
  assert.equal(lotProductsPath('sales_orders', [product]), `/v1/documentos/sales_orders/lotes?produtos=${product}`);
  assert.equal(lotOptionsPath('service_orders', product, LOT_A), `/v1/documentos/service_orders/lotes/${product}?deposito=${LOT_A}`);
});

test('Comissões of the items: fixed rate or discount bands, and the Adicionais da base spread by the items in exact cents', () => {
  const kind = 'sales_orders', data = { items: [{ product_id: null, description: 'A', unit: 'UN', quantity: '1', unit_price: '100', discount_percent: '0' }, { product_id: null, description: 'B', unit: 'UN', quantity: '2', unit_price: '25', discount_percent: '10' }], freight: '10', discount_mode: 'amount', discount_value: '0', date: '2026-10-20', contact_id: contact, installments: [] };
  const totals = calculateDocument(normalizeDocument(kind, data));
  const fixed = itemCommissions(data.items, totals, { seller_id: contact, mode: 'fixa', rate: '5.0000', bands: [], additions: ['frete'] });
  // Bases 100.00 and 45.00; the frete of 10.00 is spread 6.90 + 3.10 (cumulative rounding adds up to the document).
  assert.deepEqual(fixed.map(row => [row.base, row.additions, row.rate, row.value]), [['100.00', '6.90', '5.0000', '5.35'], ['45.00', '3.10', '5.0000', '2.41']]);
  const bands = { seller_id: contact, mode: 'descontos', rate: null, bands: [{ discount_up_to: '5.0000', rate: '3.0000' }, { discount_up_to: '20.0000', rate: '1.5000' }], additions: [] };
  assert.deepEqual([itemRate(bands, '0'), itemRate(bands, '10'), itemRate(bands, '25')], [30000n, 15000n, 0n]);
  assert.deepEqual(itemCommissions(data.items, totals, bands).map(row => row.value), ['3.00', '0.68']);
  assert.deepEqual(itemCommissions(data.items, null, bands), [], 'without totals nothing is shown');
});

test('Checkout de pedidos: order by localização, quantities never above the pedido, picking and the resulting situação', () => {
  const line = (key, position, quantity, extra = {}) => ({ key, item_id: key, component_id: null, product_id: null, position, description: `Item ${key}`, code: `C${key}`, unit: 'UN', quantity, gtin: null, gtin_tax: null, location: null, ...extra });
  const lines = [line('1', 1, '2', { location: 'B-2', gtin: '7891000000001' }), line('2', 2, '0.5', { location: 'A-1' }), line('3', 3, '1')];
  assert.deepEqual(orderedLines(lines, { order: 'crescente' }).map(row => row.key), ['2', '1', '3'], 'no localização last');
  assert.deepEqual(orderedLines(lines, { order: 'nao_ordenar' }).map(row => row.key), ['1', '2', '3']);
  let reads = {};
  let result = applyRead(lines, reads, ' 7891000000001 ', '', false);
  assert.equal(result.ok, true); reads = result.reads;
  result = applyRead(lines, reads, 'c1', '1,5', false);
  assert.deepEqual([result.ok, result.message], [false, 'Quantidade lida maior que a do pedido para Item 1: 2,5 de 2.']);
  assert.equal(applyRead(lines, reads, 'X9', '1', false).message, 'Produto não encontrado no pedido: X9.');
  assert.equal(savedStatus(lines, reads), 'checkout_partial');
  const ordered = orderedLines(lines, { order: 'crescente' });
  assert.equal(pickingLine(ordered, reads).key, '2');
  assert.match(applyRead(ordered, reads, 'C3', '1', true).message, /Leia o item indicado: Item 2 \(localização A-1\)/);
  for (const [code, quantity] of [['C2', '0.5'], ['C1', '1'], ['C3', '1']]) { result = applyRead(ordered, reads, code, quantity, true); assert.equal(result.ok, true, code); reads = result.reads; }
  assert.equal(savedStatus(lines, reads), 'verified');
  assert.deepEqual(readsBody(reads).sort((a, b) => a.key.localeCompare(b.key)), [{ key: '1', quantity: '2.000000' }, { key: '2', quantity: '0.500000' }, { key: '3', quantity: '1.000000' }]);
  assert.equal(savedStatus(lines, {}), 'open');
});

test('Número de casas decimais na quantidade: up to the preference (7 to 10 behave as 6), also the lots of the item', () => {
  assert.deepEqual([quantityPlaces(null), quantityPlaces({ quantity_decimals: 2 }), quantityPlaces({ quantity_decimals: 9 })], [6, 2, 6]);
  const items = [{ quantity: '1.25', lots: null }, { quantity: '1.255', lots: null }, { quantity: '2', lots: [{ lot_id: LOT_A, quantity: '1.999' }, { lot_id: LOT_B, quantity: '0.001' }] }];
  const problem = quantityDecimalsProblem({ items }, { quantity_decimals: 2 });
  assert.deepEqual(problem, { message: 'A quantidade aceita até 2 casas decimais (Preferências › Empresa › Geral).', invalid: ['doc-item-qty-1', 'doc-item-qty-2'] });
  assert.equal(quantityDecimalsProblem({ items }, { quantity_decimals: 6 }), null);
  assert.equal(quantityDecimalsProblem({ items: [{ quantity: '1.5' }] }, { quantity_decimals: 0 }).message, 'A quantidade aceita até 0 casas decimais (Preferências › Empresa › Geral).');
});

test('Frente de caixa: the full return says how many contas a receber became Devolvido', () => {
  const money = cents => `R$ ${(Number(cents) / 100).toFixed(2).replace('.', ',')}`;
  const base = { stock: true, refund: false, refund_cents: '0', value_cents: '1500' };
  assert.equal(pdvReturnMessage({ ...base, returned_titles: 2 }, money), 'Devolução registrada. Os produtos voltaram ao estoque. Nenhum valor saiu do caixa (itens de R$ 15,00). 2 contas a receber em aberto da venda ficaram na situação Devolvido.');
  assert.match(pdvReturnMessage({ ...base, returned_titles: 1 }, money), /A conta a receber em aberto da venda ficou na situação Devolvido\.$/);
  assert.doesNotMatch(pdvReturnMessage({ ...base }, money), /Devolvido/);
});

test('Lote and Busca customizada of the lists: validated before the request, sent as lote and busca', () => {
  assert.deepEqual(Object.entries(LOT_FILTER).filter(([, on]) => on).map(([kind]) => kind), ['sales_orders', 'service_orders']);
  const params = documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, lots: ' L-1 ; l-1;L-2 ', search: [{ field: 'total', op: 'ge', value: '10.50' }, { field: 'notes', op: 'contains', value: ' urgente ' }, { field: 'ship_date', op: 'empty', value: null }] });
  assert.equal(params.get('lote'), 'L-1;L-2');
  assert.deepEqual(JSON.parse(params.get('busca')), [{ field: 'total', op: 'ge', value: '10.50' }, { field: 'notes', op: 'contains', value: 'urgente' }, { field: 'ship_date', op: 'empty', value: null }]);
  assert.equal(documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS }).has('busca'), false);
  assert.throws(() => documentListQuery('purchase_orders', { ...EMPTY_LIST_FILTERS, lots: 'L-1' }), /só para pedidos de venda e ordens de serviço/);
  assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, lots: Array.from({ length: 51 }, (_, i) => `L${i}`).join(';') }), /até 50 lotes/);
  for (const bad of [[{ field: 'total', op: 'contains', value: '1' }], [{ field: 'date', op: 'eq', value: '2026-02-30' }], [{ field: 'notes', op: 'eq', value: '' }], [{ field: 'number', op: 'empty', value: null }], [{ field: 'equipment', op: 'eq', value: 'x' }]])
    assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, search: bad }), /Confira a Busca customizada/, JSON.stringify(bad));
  const custom = 'f0000000-0000-4000-8000-000000000289';
  assert.equal(JSON.parse(documentListQuery('service_orders', { ...EMPTY_LIST_FILTERS, search: [{ field: `custom:${custom}`, op: 'eq', value: 'true' }] }).get('busca'))[0].field, `custom:${custom}`);
  assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, search: [{ field: `custom:${custom}`, op: 'eq', value: 'true' }] }), /Confira a Busca customizada/, 'only the OS has campos customizados');
});

test('print: IPI % of the pedido de compra with Exibir IPI, rodapé of the company, image, description at the supplier and the OS custom fields', () => {
  const purchase = record('purchase_orders', { items: [{ product_id: product, description: 'Chapa', unit: 'UN', quantity: '2', unit_price: '50', discount_percent: '0', ipi_rate: '10' }, { product_id: null, description: 'Frete interno', unit: 'UN', quantity: '1', unit_price: '20', discount_percent: '0' }] });
  const off = documentPrintModel(purchase, null, { prefs: documentPreferences('purchase_orders', view('purchase_orders'), null).print });
  assert.equal(off.ipiColumns, false); assert.equal(off.items[0].ipiRate, null); // Leva H (EST-041): a value that is part of the total is printed even with Exibir IPI off.
  assert.deepEqual(off.totals.find(row => row.label === 'Total do IPI'), { label: 'Total do IPI', value: 'R$ 10,00' });
  const on = documentPrintModel(purchase, null, { prefs: documentPreferences('purchase_orders', view('purchase_orders', { 'compras.imprimir_ipi': true }), null).print });
  assert.equal(on.ipiColumns, true);
  assert.deepEqual(on.items.map(item => [item.ipiRate, item.ipiValue]), [['10%', 'R$ 10,00'], [null, null]]);
  assert.deepEqual(on.totals.find(row => row.label === 'Total do IPI'), { label: 'Total do IPI', value: 'R$ 10,00' });
  assert.equal(on.totals.some(row => /ICMS ST/.test(row.label)), false, 'the pedido de compra has no ICMS ST');

  const sale = record('sales_orders', { items: [{ product_id: product, description: 'Parafuso', unit: 'UN', quantity: '1', unit_price: '5', discount_percent: '0' }] });
  const prefs = documentPreferences('sales_orders', view('sales_orders', { 'vendas.imprimir_rodape': true, 'vendas.imprimir_imagem': true, 'vendas.imprimir_descricao_fornecedor': true }), null).print;
  const company = { version: 1, data: { legal_name: 'Empresa Sintética Ltda', trade_name: 'Sintética', cnpj: '11.222.333/0001-81', ie: null, street: 'Rua A', number: '1', complement: null, district: 'Centro', city: 'Piracicaba', municipality_code: '3538709', state: 'SP', postal_code: '13400-000', email: 'contato@sintetica.invalid', phone: null }, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
  const image = 'data:image/png;base64,iVBORw0KGgo=', extras = { images: { [product]: image }, supplierDescriptions: { [sale.items[0].id]: 'Parafuso sextavado' } };
  const model = documentPrintModel(sale, company, { prefs, ...extras });
  assert.equal(model.footer, 'Sintética · CNPJ 11222333000181 · Rua A, 1 · Piracicaba / SP · contato@sintetica.invalid');
  assert.equal(model.items[0].image, null, 'the image goes only in the detailed print of the pedido');
  assert.equal(model.items[0].supplierDescription, 'Parafuso sextavado');
  const detailed = documentPrintModel(sale, company, { prefs, detailed: true, ...extras });
  assert.equal(detailed.items[0].image, image);

  const field = { id: 'f1000000-0000-4000-8000-000000000288', kind: 'service_orders', field_type: 'boolean', name: 'Cliente aguarda', hint: null, info: null, required: false, min_length: null, max_length: null, width: 'medium', options: [], active: true, version: 1, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', documents: 1 };
  const os = record('service_orders', { custom_fields: { [field.id]: 'true' }, items: [{ product_id: null, description: 'Troca de tela', unit: 'UN', quantity: '1', unit_price: '80', discount_percent: '0', warranty_days: '90' }] });
  assert.deepEqual(documentPrintModel(os, null, {}).customFields, [], 'the question was not answered Sim');
  assert.deepEqual(documentPrintModel(os, null, { customFields: [field] }).customFields, printableCustomFields([field], os.custom_fields));
  assert.equal(documentPrintModel(os, null, { customFields: [field] }).customFields[0].label, 'Cliente aguarda');
  assert.equal(documentPrintModel(os, null, {}).items[0].warranty, '90 dias');
});

test('custom fields of the OS and the item extensions travel in the save body', () => {
  const field = (extra) => ({ id: 'f2000000-0000-4000-8000-000000000288', kind: 'service_orders', field_type: 'integer', name: 'Ordem interna', hint: null, info: null, required: true, min_length: null, max_length: null, width: 'medium', options: [], active: true, version: 1, created_at: '', updated_at: '', documents: 0, ...extra });
  assert.deepEqual(customFieldsPayload([field()], { 'f2000000-0000-4000-8000-000000000288': ' 42 ' }, null), { value: { 'f2000000-0000-4000-8000-000000000288': '42' } });
  assert.deepEqual(customFieldsPayload([field({ active: false })], {}, { 'f2000000-0000-4000-8000-000000000288': '7' }), { value: { 'f2000000-0000-4000-8000-000000000288': '7' } }, 'an inactive field keeps the saved value');
  const sale = record('sales_orders', { items: [{ product_id: product, description: 'Parafuso', unit: 'UN', quantity: '3', unit_price: '5', discount_percent: '0', lots: [{ lot_id: LOT_A, quantity: '1' }, { lot_id: LOT_B, quantity: '2' }] }] });
  assert.deepEqual(documentInput(sale).items[0].lots, [{ lot_id: LOT_A, quantity: '1.000000' }, { lot_id: LOT_B, quantity: '2.000000' }], 'the saved lots, as the server keeps them');
  const purchase = record('purchase_orders', { items: [{ product_id: null, description: 'Chapa', unit: 'UN', quantity: '1', unit_price: '5', discount_percent: '0', ipi_rate: '12.5' }] });
  assert.equal(documentInput(purchase).items[0].ipi_rate, '12.5000');
});
